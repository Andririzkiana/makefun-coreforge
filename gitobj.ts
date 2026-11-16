// Git object machinery in pure Node stdlib: sha1 object ids, loose-object (de)serialization,
// pack reading (with OFS/REF delta resolution) and writing (plain objects, no deltas), pkt-line
// framing, tree flatten/rebuild, ancestry walks, three-way tree merges and line diffs.
//
// Objects are stored exactly as git stores them logically: `data` is the raw object body (for a
// commit, the header lines plus message; for a tree, the binary entries). The oid is the sha1 of
// "<type> <length>\0" + data.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, RepoRec } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** Split an identity line "Name <email> ts tz" into its display parts. */
export function parseIdentity(line: string): { name: string; email: string; ts: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (match === null) return { name: line.trim(), email: '', ts: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', ts: Number(match[3] ?? 0) };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: names compare as bytes, directories as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {mode, oid}; directories themselves are omitted. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Rebuild nested trees from a flat path map; returns the root tree oid. Stores all subtrees. */
export function buildTreeFromFiles(repo: RepoRec, files: Map<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i] ?? '';
      let next = dir.dirs.get(name);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1] ?? '', entry);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The empty tree's oid (4b825dc642cb6eb9a060e54bf8d69288fbee4904). */
export function emptyTreeOid(repo: RepoRec): string {
  return storeObject(repo, 'tree', Buffer.alloc(0));
}

// ---------------------------------------------------------------- ancestry

export function commitOf(repo: RepoRec, oid: string): CommitInfo | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** All ancestors of `tip` (including itself), via breadth-first walk. */
export function ancestorSet(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (commit !== null) for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

/** Early-exit ancestry search: stops the moment `ancestor` is reached (a push's parent is 1 step). */
export function isAncestor(repo: RepoRec, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Generation (longest path to a root) of every ancestor of `tip`. */
function generations(repo: RepoRec, tip: string): Map<string, number> {
  const gens = new Map<string, number>();
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    order.push(oid);
    const commit = commitOf(repo, oid);
    if (commit !== null) for (const parent of commit.parents) queue.push(parent);
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const oid = order[i] as string;
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    let gen = 0;
    for (const parent of commit.parents) gen = Math.max(gen, (gens.get(parent) ?? 0) + 1);
    gens.set(oid, gen);
  }
  return gens;
}

/** Best common ancestor of two tips (highest generation), or null when unrelated. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const gensA = generations(repo, a);
  const ancestorsB = ancestorSet(repo, b);
  let best: string | null = null;
  let bestGen = -1;
  for (const oid of ancestorsB) {
    const gen = gensA.get(oid);
    if (gen !== undefined && gen > bestGen) {
      best = oid;
      bestGen = gen;
    }
  }
  return best;
}

/** Commits reachable from `tip`, newest first (topological, parents after children). */
export function walkCommits(repo: RepoRec, tip: string): string[] {
  const gens = generations(repo, tip);
  return [...gens.entries()].sort((x, y) => y[1] - x[1]).map(([oid]) => oid);
}

// ---------------------------------------------------------------- three-way merge

export interface MergeOutcome {
  conflict: boolean;
  conflictPaths: string[];
  /** Merged flat file map when conflict is false. */
  files: Map<string, { mode: string; oid: string }>;
}

/** Per-path three-way merge of flat file maps (base = merge-base tree, ours, theirs). */
export function mergeFileMaps(
  base: Map<string, { mode: string; oid: string }>,
  ours: Map<string, { mode: string; oid: string }>,
  theirs: Map<string, { mode: string; oid: string }>,
): MergeOutcome {
  const files = new Map<string, { mode: string; oid: string }>();
  const conflictPaths: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (x: { mode: string; oid: string } | undefined, y: { mode: string; oid: string } | undefined): boolean =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) files.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) files.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) files.set(path, o);
    } else {
      conflictPaths.push(path);
    }
  }
  return { conflict: conflictPaths.length > 0, conflictPaths, files };
}

// ---------------------------------------------------------------- line diff

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS-based line diff counts between two blob bodies. Small inputs only (API fixtures). */
export function diffCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const a = countLines(oldData);
  const b = countLines(newData);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS via dynamic programming over the shorter dimension.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const common = dp[0]![0] ?? 0;
  return { additions: b.length - common, deletions: a.length - common };
}

/** Diff a flat file map against another: the /pulls/{n}/files surface. */
export function diffFileMaps(
  repo: RepoRec,
  from: Map<string, { mode: string; oid: string }>,
  to: Map<string, { mode: string; oid: string }>,
): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    if (before === undefined && after !== undefined) {
      const data = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
      out.push({ filename: path, status: 'added', additions: countLines(data).length, deletions: 0 });
    } else if (before !== undefined && after === undefined) {
      const data = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: countLines(data).length });
    } else if (before !== undefined && after !== undefined) {
      const oldData = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
      const counts = diffCounts(oldData, newData);
      out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

const TYPE_IDS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Serialize objects into a pack v2 (no deltas), with the sha1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeId = TYPE_IDS[object.type];
    let size = object.data.length;
    const first = ((typeId << 4) | (size & 0x0f) | (size >= 0x10 ? 0x80 : 0)) & 0xff;
    const bytes: number[] = [first];
    size >>= 4;
    while (size > 0) {
      const byte = size & 0x7f;
      size >>= 7;
      bytes.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackObjectAt {
  offset: number;
  type: GitObjectType;
  data: Buffer;
}

/** Apply a git delta buffer to a base body. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size (the base's length; trusted)
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let cpOffset = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOffset |= (delta[offset] ?? 0) << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= (delta[offset] ?? 0) << (8 * (i - 0)); offset += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOffset, cpOffset + cpSize));
      produced += cpSize;
    } else if (op > 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error(`delta produced ${out.length} bytes, expected ${targetSize}`);
  void produced;
  return out;
}

/**
 * Parse a pack buffer into resolved objects. Throws on malformed input (the caller turns that
 * into "unpack <reason>"). `external` resolves REF_DELTA bases the pack itself does not carry.
 */
export function parsePack(pack: Buffer, external?: (oid: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const limit = pack.length - 20;
  let offset = 12;
  const raw: Array<{ offset: number; typeId: number; data?: Buffer; baseOid?: string; baseOffset?: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      // OFS_DELTA: negative offset varint.
      byte = pack[offset] ?? 0;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] ?? 0;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeId === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const rest = pack.subarray(offset, limit);
    const inflated = inflateSync(rest, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = inflated.buffer;
    if (data.length !== size) throw new Error(`pack object size mismatch (${data.length} != ${size})`);
    let consumed = inflated.engine.bytesWritten;
    if (typeof consumed !== 'number' || !Number.isFinite(consumed) || consumed <= 0) {
      // Fallback: binary-search the shortest prefix that inflates (trailing bytes are tolerated,
      // a truncated stream throws), which is exactly the stream's compressed length.
      let lo = 1;
      let hi = rest.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        try {
          inflateSync(rest.subarray(0, mid));
          hi = mid;
        } catch {
          lo = mid + 1;
        }
      }
      consumed = lo;
    }
    offset += consumed;
    // For delta objects (typeId 6/7) `data` holds the delta bytes until resolution below.
    raw.push({ offset: start, typeId, data, baseOid, baseOffset });
  }
  // Verify the trailer checksum.
  const trailer = pack.subarray(limit, limit + 20);
  const digest = createHash('sha1').update(pack.subarray(0, limit)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  // Resolve deltas (bases may appear later in the pack only via REF; OFS bases are earlier).
  const byOffset = new Map<number, PackObjectAt>();
  const resolved: GitObject[] = [];
  const resolveAt = (index: number): PackObjectAt => {
    const entry = raw[index] as (typeof raw)[number];
    const cached = byOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    let out: PackObjectAt;
    if (entry.typeId === 6 || entry.typeId === 7) {
      let base: PackObjectAt | undefined;
      if (entry.typeId === 6) {
        const baseIndex = raw.findIndex((candidate) => candidate.offset === entry.baseOffset);
        if (baseIndex === -1) throw new Error('ofs-delta base not in pack');
        base = resolveAt(baseIndex);
      } else {
        const baseIndex = raw.findIndex((candidate) => candidate.typeId !== 6 && candidate.typeId !== 7 && hashObject(ID_TYPES[candidate.typeId] as GitObjectType, candidate.data as Buffer) === entry.baseOid);
        if (baseIndex !== -1) base = resolveAt(baseIndex);
        else {
          const ext = external?.(entry.baseOid as string);
          if (ext === undefined) throw new Error('ref-delta base not found');
          base = { offset: -1, type: ext.type, data: ext.data };
        }
      }
      const data = applyDelta(base.data, entry.data as Buffer);
      out = { offset: entry.offset, type: base.type, data };
    } else {
      out = { offset: entry.offset, type: ID_TYPES[entry.typeId] as GitObjectType, data: entry.data as Buffer };
    }
    byOffset.set(entry.offset, out);
    return out;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const object = resolveAt(i);
    resolved.push({ type: object.type, data: object.data });
  }
  return resolved;
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line payload (string or bytes); '0000' is pktFlush(). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface PktReader {
  /** Next payload, 'flush', 'delim', 'end', or null when the buffer is exhausted mid-line. */
  next(): Buffer | 'flush' | 'delim' | 'end' | null;
  /** The unconsumed remainder (the pack bytes after a receive-pack command list). */
  rest(): Buffer;
}

export function pktReader(buffer: Buffer): PktReader {
  let offset = 0;
  return {
    next() {
      if (offset >= buffer.length) return null;
      if (offset + 4 > buffer.length) return null;
      const hex = buffer.toString('ascii', offset, offset + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length "${hex}"`);
      const length = parseInt(hex, 16);
      if (length === 0) {
        offset += 4;
        return 'flush';
      }
      if (length === 1) {
        offset += 4;
        return 'delim';
      }
      if (length === 2) {
        offset += 4;
        return 'end';
      }
      if (length < 4 || offset + length > buffer.length) return null;
      const payload = buffer.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
    rest() {
      return buffer.subarray(offset);
    },
  };
}
