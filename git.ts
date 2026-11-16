// Git smart HTTP: info/refs advertisement (protocol v0 and v2), ls-refs, fetch (upload-pack)
// and push (receive-pack), all served from the repo's in-memory object store. No git binary:
// packs are parsed and written by gitobj.ts.

import type { RepoRec, Store } from './store.ts';
import {
  ZERO_OID,
  ancestorSet,
  commitOf,
  hashObject,
  isAncestor,
  parsePack,
  pktDelim,
  pktFlush,
  pktLine,
  pktReader,
  storeObject,
  writePack,
  type GitObject,
} from './gitobj.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';

function textResponse(status: number, text: string): GitResponse {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

// ---------------------------------------------------------------- ref advertisement

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** Every advertised ref: HEAD first (when born), then refs sorted by name, tags peeled. */
function advertisedRefs(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      let target = object;
      let targetOid = oid;
      // Peel nested tags to the first non-tag object.
      for (;;) {
        const match = /^object ([0-9a-f]{40})/m.exec(target.data.toString('utf8'));
        if (match === null) break;
        const next = repo.objects.get(match[1] as string);
        if (next === undefined) break;
        targetOid = match[1] as string;
        target = next;
        if (target.type !== 'tag') break;
      }
      line.peeled = targetOid;
    }
    lines.push(line);
  }
  return lines;
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function uploadCapsV0(repo: RepoRec): string {
  return `multi_ack_detailed no-progress side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
}

function receiveCapsV0(): string {
  return `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
}

export function infoRefs(repo: RepoRec, service: string, protocolV2: boolean): GitResponse {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return textResponse(400, `unknown service ${service}\n`);
  }
  if (protocolV2 && service === 'git-upload-pack') {
    const parts: Buffer[] = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ];
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  const caps = service === 'git-upload-pack' ? uploadCapsV0(repo) : receiveCapsV0();
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = advertisedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD\0${caps}\n`);
      first = false;
    }
    for (const ref of refs) {
      lines.push(first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`);
      first = false;
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
    if (first) {
      // Refs exist but HEAD is unborn and somehow no line carried the capabilities yet.
      lines.unshift(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(pktFlush());
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** The tree+blob closure of one commit (the commit itself not included). */
function treeClosure(repo: RepoRec, commitOid: string, into: Set<string>): void {
  const commit = commitOf(repo, commitOid);
  if (commit === null) return;
  const stack = [commit.tree];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'tree') {
      // Walk entries without a full parseTree import cycle: reuse parse via dynamic subarray scan.
      let offset = 0;
      const data = object.data;
      while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space === -1) break;
        const nul = data.indexOf(0x00, space + 1);
        if (nul === -1 || nul + 21 > data.length) break;
        stack.push(data.toString('hex', nul + 1, nul + 21));
        offset = nul + 21;
      }
    }
  }
}

function planFetch(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  clientShallows: ReadonlySet<string>,
  depth: number | null,
): FetchPlan {
  // Exclusion: everything the client provably has.
  const excluded = new Set<string>();
  for (const have of haves) {
    const object = repo.objects.get(have);
    if (object === undefined) continue;
    if (object.type !== 'commit') {
      excluded.add(have);
      continue;
    }
    if (clientShallows.has(have)) {
      excluded.add(have);
      treeClosure(repo, have, excluded);
    } else {
      for (const ancestor of ancestorSet(repo, have)) {
        excluded.add(ancestor);
        treeClosure(repo, ancestor, excluded);
      }
    }
  }

  // Inclusion: breadth-first from the wants, generation-limited by depth. A shallow have is
  // traversed *through* (its parents are candidates when deepening) but never re-sent; a full
  // have stops traversal (the client already holds everything below it).
  const shallowHaves = new Set<string>();
  for (const have of haves) {
    if (clientShallows.has(have) && repo.objects.get(have)?.type === 'commit') shallowHaves.add(have);
  }
  const includedCommits = new Map<string, number>();
  const includedOther = new Set<string>();
  const depthCut = new Set<string>();
  const expanded = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) throw new Error(`unknown want ${want}`);
    if (object.type === 'commit') queue.push({ oid: want, gen: 0 });
    else {
      // A tag/tree/blob want: include it and (for tags/trees) its closure.
      includedOther.add(want);
      if (object.type === 'tag') {
        const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
        if (match !== null) queue.push({ oid: match[1] as string, gen: 0 });
      } else if (object.type === 'tree') {
        treeClosureInto(repo, want, includedOther);
      }
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (excluded.has(oid)) {
      if (shallowHaves.has(oid) && !expanded.has(oid)) {
        expanded.add(oid);
        const commit = commitOf(repo, oid);
        if (commit !== null) for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
      continue;
    }
    const known = includedCommits.get(oid);
    if (known !== undefined && known <= gen) continue;
    if (depth !== null && gen >= depth) {
      depthCut.add(oid);
      continue;
    }
    includedCommits.set(oid, gen);
    const commit = commitOf(repo, oid);
    if (commit !== null) for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  // Boundary: a commit the client now holds (sent, or already held shallow and traversed) whose
  // parent was cut by depth is the new shallow boundary; a previously shallow commit whose
  // parents all arrived is unshallowed.
  const covered = new Set<string>([...includedCommits.keys(), ...expanded]);
  const shallow: string[] = [];
  for (const oid of covered) {
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (depthCut.has(parent)) {
        shallow.push(oid);
        break;
      }
    }
  }
  const shallowSet = new Set(shallow);
  const unshallow: string[] = [];
  for (const oid of clientShallows) {
    if (covered.has(oid) && !shallowSet.has(oid)) unshallow.push(oid);
  }

  const objectOids = new Set<string>();
  for (const oid of includedCommits.keys()) {
    objectOids.add(oid);
    treeClosure(repo, oid, objectOids);
  }
  for (const oid of includedOther) objectOids.add(oid);
  for (const oid of excluded) objectOids.delete(oid);
  // A commit the client already has shallow still needs its own object when re-wanted above.
  const objects: GitObject[] = [];
  for (const oid of objectOids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // Deterministic pack order: commits by generation, then trees, then blobs, then the rest.
  const rank = (object: GitObject): number => (object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'blob' ? 2 : 3);
  objects.sort((a, b) => rank(a) - rank(b) || (hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1));
  return { objects, shallow, unshallow };
}

function treeClosureInto(repo: RepoRec, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'tree') {
      const data = object.data;
      let offset = 0;
      while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space === -1) break;
        const nul = data.indexOf(0x00, space + 1);
        if (nul === -1 || nul + 21 > data.length) break;
        stack.push(data.toString('hex', nul + 1, nul + 21));
        offset = nul + 21;
      }
    }
  }
}

/** Chunk a pack into side-band-64k band-1 pkt-lines (each payload: \x01 + at most 65515 bytes). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

// ---------------------------------------------------------------- upload-pack

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Request {
  const reader = pktReader(body);
  let command = '';
  const args: string[] = [];
  let phase: 'command' | 'args' = 'command';
  for (;;) {
    const item = reader.next();
    if (item === null || item === 'flush' || item === 'end') break;
    if (item === 'delim') {
      phase = 'args';
      continue;
    }
    const line = item.toString('utf8').replace(/\n$/, '');
    if (phase === 'command') {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // Other command-section lines are capabilities (agent=, object-format=...): ignored.
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

function lsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  for (const arg of args) {
    if (arg === 'peel') wantPeel = true;
    else if (arg === 'symrefs') wantSymrefs = true;
    else if (arg === 'unborn') wantUnborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('ref-prefix=')) prefixes.push(arg.slice('ref-prefix='.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (wantSymrefs) line += ` symref-target:${target}`;
      parts.push(pktLine(`${line}\n`));
    } else if (wantUnborn) {
      let line = 'unborn HEAD';
      if (wantSymrefs || wantUnborn) line += ` symref-target:${target}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV2(repo: RepoRec, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallows = new Set<string>();
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallows.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (arg === 'done') done = true;
  }
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    const acks: string[] = [];
    for (const have of haves) if (repo.objects.has(have)) acks.push(have);
    parts.push(pktLine('acknowledgments\n'));
    if (acks.length === 0) parts.push(pktLine('NAK\n'));
    else {
      for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
      if (!done) parts.push(pktLine('ready\n'));
    }
    parts.push(pktFlush());
    if (!done) return Buffer.concat(parts);
  }
  const plan = planFetch(repo, wants, haves, clientShallows, depth);
  if (depth !== null || plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  const pack = writePack(plan.objects);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoRec, body: Buffer): Buffer {
  const reader = pktReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallows = new Set<string>();
  let depth: number | null = null;
  let caps = '';
  let section: 'want' | 'have' = 'want';
  for (;;) {
    const item = reader.next();
    if (item === null || item === 'end') break;
    if (item === 'flush') {
      if (section === 'want') section = 'have';
      else break;
      continue;
    }
    if (item === 'delim') continue;
    let line = item.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallows.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const plan = planFetch(repo, wants, haves, clientShallows, depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = writePack(plan.objects);
  if (caps.includes('side-band')) {
    parts.push(...sidebandPackets(pack));
    parts.push(pktFlush());
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

export function uploadPack(repo: RepoRec, body: Buffer, protocolV2: boolean): GitResponse {
  try {
    if (protocolV2) {
      const request = parseV2Request(body);
      if (request.command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, request.args) };
      }
      if (request.command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, request.args) };
      }
      return textResponse(400, `unknown command ${request.command}\n`);
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, body) };
  } catch (err) {
    // A malformed body must never take the server down; answer plainly and keep serving.
    return textResponse(400, `upload-pack error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: RepoRec, body: Buffer): GitResponse {
  try {
    return receivePackInner(repo, body);
  } catch (err) {
    return textResponse(400, `receive-pack error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function receivePackInner(repo: RepoRec, body: Buffer): GitResponse {
  const reader = pktReader(body);
  const commands: PushCommand[] = [];
  let caps = '';
  for (;;) {
    const item = reader.next();
    if (item === null || item === 'flush' || item === 'end') break;
    if (item === 'delim') continue;
    let line = item.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length >= 3) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
    }
  }
  const pack = reader.rest();
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      const objects = parsePack(pack, (oid) => repo.objects.get(oid));
      for (const object of objects) storeObject(repo, object.type, object.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    results.push(applyPushCommand(repo, command));
  }

  const reportParts: Buffer[] = [];
  reportParts.push(pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  reportParts.push(pktFlush());
  const report = Buffer.concat(reportParts);

  let responseBody: Buffer;
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + CHUNK))])));
    }
    parts.push(pktFlush());
    responseBody = Buffer.concat(parts);
  } else if (caps.includes('report-status')) {
    responseBody = report;
  } else {
    responseBody = pktFlush();
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

function applyPushCommand(repo: RepoRec, command: PushCommand): { ref: string; ok: boolean; reason?: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // Delete: the ref must be where the client thinks it is.
    if (current === oldOid || current === ZERO_OID) {
      repo.refs.delete(ref);
      return { ref, ok: true };
    }
    return { ref, ok: false, reason: 'reference does not exist' };
  }
  const object = repo.objects.get(newOid);
  if (object === undefined) return { ref, ok: false, reason: 'new object not found' };
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return { ref, ok: false, reason: 'already exists' };
    repo.refs.set(ref, newOid);
    return { ref, ok: true };
  }
  if (current !== oldOid) return { ref, ok: false, reason: 'non-fast-forward' };
  if (ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit') return { ref, ok: false, reason: 'branch target is not a commit' };
    if (!isAncestor(repo, oldOid, newOid)) return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true };
}
