// GitHub REST v3 surface, plus the shared domain operations (issue/PR creation, pull-request
// merge, contents commits) that the GraphQL and MCP surfaces reuse so every surface agrees.
//
// Conventions the checks rely on: every error body is {message: string}; statuses are exact
// (201 creates, 204 deletes, 404 unknown owner/repo/number, 409 stale contents sha, 422
// validation); issues and pull requests share one per-repo number sequence.

import {
  EPOCH_SEC,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
  identityLine,
  isoOfSeq,
  type IssueRec,
  type LabelRec,
  type RepoRec,
  type Store,
} from './store.ts';
import {
  buildCommit,
  buildTreeFromFiles,
  commitOf,
  diffFileMaps,
  flattenTree,
  mergeBase,
  mergeFileMaps,
  parseCommit,
  parseIdentity,
  parseTree,
  storeObject,
  walkCommits,
  type FileDiff,
} from './gitobj.ts';

export interface ApiResult {
  status: number;
  json?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const notFound = (): HttpError => new HttpError(404, 'Not Found');

// ---------------------------------------------------------------- shared lookups

export function viewerJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', 0, VIEWER_ID),
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id, 0),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: isoOfSeq(repo.seq),
    updated_at: isoOfSeq(repo.seq),
    pushed_at: isoOfSeq(repo.seq),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://forge.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge.invalid:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_pull_requests: true,
    open_issues_count: [...repo.items.values()].filter((item) => item.state === 'open').length,
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: RepoRec, item: IssueRec): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: item.id,
    node_id: globalId('Issue', repo.id, item.number),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: null })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: item.comments.length,
    created_at: isoOfSeq(item.seq),
    updated_at: isoOfSeq(item.seq),
    closed_at: item.state === 'closed' ? isoOfSeq(item.seq) : null,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${item.number}`,
  };
  if (item.kind === 'pr') {
    json['pull_request'] = { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${item.number}` };
  }
  return json;
}

/** The serialized REST form of an issue, cached on the record (the read workload's hot path). */
export function issueJsonText(repo: RepoRec, item: IssueRec): string {
  if (item.restCache === null) item.restCache = JSON.stringify(issueJson(repo, item));
  return item.restCache;
}

export function prJson(repo: RepoRec, item: IssueRec): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${item.headRef}`) ?? item.headSha;
  const baseTip = repo.refs.get(`refs/heads/${item.baseRef}`) ?? item.baseSha;
  return {
    id: item.id,
    node_id: globalId('PullRequest', repo.id, item.number),
    number: item.number,
    state: item.state,
    title: item.title,
    body: item.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { ref: item.headRef, sha: headTip, label: `${repo.owner}:${item.headRef}` },
    base: { ref: item.baseRef, sha: baseTip, label: `${repo.owner}:${item.baseRef}` },
    merged: item.merged,
    merged_at: item.merged ? isoOfSeq(item.mergedSeq) : null,
    merge_commit_sha: item.mergeCommitSha,
    draft: false,
    created_at: isoOfSeq(item.seq),
    updated_at: isoOfSeq(item.seq),
    closed_at: item.state === 'closed' ? isoOfSeq(item.seq) : null,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${item.number}`,
  };
}

export function commentJson(repo: RepoRec, item: IssueRec, comment: { id: number; body: string; authorLogin: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, comment.id),
    body: comment.body,
    user: { login: comment.authorLogin, id: VIEWER_ID, type: 'User' },
    author: { login: comment.authorLogin, id: VIEWER_ID, type: 'User' },
    created_at: isoOfSeq(comment.seq),
    updated_at: isoOfSeq(comment.seq),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
  };
}

// ---------------------------------------------------------------- refs and trees

/** Resolve a ref-ish string (full ref, branch, tag, HEAD, or sha) to an oid. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Flat file map at a commit oid (empty map when the commit is unknown). */
export function filesAtCommit(repo: RepoRec, commitOid: string | null): Map<string, { mode: string; oid: string }> {
  if (commitOid === null) return new Map();
  const commit = commitOf(repo, commitOid);
  if (commit === null) return new Map();
  return flattenTree(repo, commit.tree);
}

/** Walk a tree to a path: the entry there (file or subtree), or null. */
export function treeEntryAt(repo: RepoRec, treeOid: string, path: string): { mode: string; oid: string; isDir: boolean } | null {
  if (path === '') {
    const object = repo.objects.get(treeOid);
    return object !== undefined && object.type === 'tree' ? { mode: '40000', oid: treeOid, isDir: true } : null;
  }
  const parts = path.split('/');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid, isDir };
    if (!isDir) return null;
    current = entry.oid;
  }
  return null;
}

/** Create a commit on top of a branch (or as its first commit) and move the branch. */
export function commitOnBranch(repo: RepoRec, branch: string, treeOid: string, message: string): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  repo.commitSeq += 1;
  const identity = identityLine(repo.commitSeq);
  const data = buildCommit({
    tree: treeOid,
    parents: tip === undefined ? [] : [tip],
    author: identity,
    committer: identity,
    message,
  });
  const oid = storeObject(repo, 'commit', data);
  repo.refs.set(ref, oid);
  repo.gitVersion += 1;
  return oid;
}

// ---------------------------------------------------------------- domain operations

export function createIssue(store: Store, repo: RepoRec, input: { title?: unknown; body?: unknown; labels?: unknown }): IssueRec {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const body = typeof input.body === 'string' ? input.body : '';
  const labels: string[] = [];
  if (Array.isArray(input.labels)) {
    for (const entry of input.labels) {
      const name = typeof entry === 'string' ? entry : typeof (entry as { name?: unknown })?.name === 'string' ? ((entry as { name: string }).name as string) : null;
      if (name === null) continue;
      if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
      labels.push(name);
    }
  }
  const item: IssueRec = {
    kind: 'issue',
    id: store.nextItemId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: store.nextSeq(),
    restCache: null,
    headRef: '',
    baseRef: '',
    headSha: '',
    baseSha: '',
    merged: false,
    mergeCommitSha: null,
    mergedSeq: 0,
  };
  repo.items.set(item.number, item);
  item.restCache = JSON.stringify(issueJson(repo, item));
  return item;
}

export function addComment(store: Store, repo: RepoRec, item: IssueRec, body: string): { id: number; body: string; authorLogin: string; seq: number } {
  const comment = { id: store.nextCommentId(), body, authorLogin: VIEWER_LOGIN, seq: store.nextSeq() };
  item.comments.push(comment);
  item.restCache = null;
  return comment;
}

/** Strip an "owner:" prefix from a head ref, as the pulls API accepts. */
function normalizeHeadRef(repo: RepoRec, head: string): string {
  const colon = head.indexOf(':');
  if (colon !== -1 && head.slice(0, colon).toLowerCase() === repo.owner.toLowerCase()) return head.slice(colon + 1);
  return head;
}

export function createPullRequest(store: Store, repo: RepoRec, input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown }): IssueRec {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const headRaw = typeof input.head === 'string' ? input.head : '';
  const baseRaw = typeof input.base === 'string' ? input.base : '';
  const head = normalizeHeadRef(repo, headRaw);
  const base = baseRaw === '' ? repo.defaultBranch : baseRaw;
  const headTip = branchTip(repo, head);
  if (headTip === null) throw new HttpError(422, `Validation Failed: head branch "${headRaw}" does not exist`);
  const baseTip = branchTip(repo, base);
  if (baseTip === null) throw new HttpError(422, `Validation Failed: base branch "${baseRaw}" does not exist`);
  if (head === base) throw new HttpError(422, 'Validation Failed: head and base are the same branch');
  const item: IssueRec = {
    kind: 'pr',
    id: store.nextItemId(),
    number: repo.nextNumber++,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    comments: [],
    seq: store.nextSeq(),
    restCache: null,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergeCommitSha: null,
    mergedSeq: 0,
  };
  repo.items.set(item.number, item);
  return item;
}

/** Whether the PR's head changes merge cleanly onto its base's current tip. */
export function prMergeable(repo: RepoRec, pr: IssueRec): boolean {
  const baseTip = branchTip(repo, pr.baseRef);
  const headTip = branchTip(repo, pr.headRef);
  if (baseTip === null || headTip === null) return false;
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const outcome = mergeFileMaps(filesAtCommit(repo, base), filesAtCommit(repo, baseTip), filesAtCommit(repo, headTip));
  return !outcome.conflict;
}

/** Files changed by the PR: merge-base tree -> head tree. */
export function prFiles(repo: RepoRec, pr: IssueRec): FileDiff[] {
  const baseTip = branchTip(repo, pr.baseRef);
  const headTip = branchTip(repo, pr.headRef);
  if (headTip === null) return [];
  const base = baseTip === null ? null : mergeBase(repo, baseTip, headTip);
  return diffFileMaps(repo, filesAtCommit(repo, base), filesAtCommit(repo, headTip));
}

export type MergeResult = { ok: true; sha: string } | { ok: false; conflict: boolean; reason: string };

/** Merge a pull request (squash or merge commit) onto its base branch. */
export function mergePullRequest(store: Store, repo: RepoRec, pr: IssueRec, method: string): MergeResult {
  if (pr.merged) return { ok: false, conflict: false, reason: 'Pull Request is already merged' };
  if (pr.state !== 'open') return { ok: false, conflict: false, reason: 'Pull Request is not open' };
  const baseTip = branchTip(repo, pr.baseRef);
  const headTip = branchTip(repo, pr.headRef);
  if (baseTip === null || headTip === null) return { ok: false, conflict: false, reason: 'A branch for this pull request is missing' };
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return { ok: false, conflict: true, reason: 'No common ancestor between base and head' };
  const outcome = mergeFileMaps(filesAtCommit(repo, base), filesAtCommit(repo, baseTip), filesAtCommit(repo, headTip));
  if (outcome.conflict) return { ok: false, conflict: true, reason: `Merge conflict in ${outcome.conflictPaths.join(', ')}` };
  const treeOid = buildTreeFromFiles(repo, outcome.files);
  let sha: string;
  if (method === 'rebase') {
    // No history rewriting machinery: when the head already contains the base, the base simply
    // advances to the head; otherwise fall through to the squash shape.
    if (mergeBase(repo, headTip, baseTip) === baseTip) {
      repo.refs.set(`refs/heads/${pr.baseRef}`, headTip);
      repo.gitVersion += 1;
      sha = headTip;
    } else {
      sha = commitOnBranch(repo, pr.baseRef, treeOid, `${pr.title} (#${pr.number})`);
    }
  } else if (method === 'merge') {
    repo.commitSeq += 1;
    const identity = identityLine(repo.commitSeq);
    const data = buildCommit({
      tree: treeOid,
      parents: [baseTip, headTip],
      author: identity,
      committer: identity,
      message: `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`,
    });
    sha = storeObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    repo.gitVersion += 1;
  } else {
    sha = commitOnBranch(repo, pr.baseRef, treeOid, `${pr.title} (#${pr.number})${pr.body === '' ? '' : `\n\n${pr.body}`}`);
  }
  pr.state = 'closed';
  pr.merged = true;
  pr.mergeCommitSha = sha;
  pr.mergedSeq = store.nextSeq();
  pr.baseSha = sha;
  pr.headSha = headTip;
  pr.restCache = null;
  return { ok: true, sha };
}

// ---------------------------------------------------------------- HTTP routing

interface Ctx {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  host: string;
}

function jsonBody(ctx: Ctx): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

function pagination(ctx: Ctx): { page: number; perPage: number } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(ctx: Ctx, path: string, page: number, perPage: number, total: number): Record<string, string> {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return {};
  const base = `http://${ctx.host}${path}`;
  const links = [`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`, `<${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`];
  return { link: links.join(', ') };
}

function requireRepo(ctx: Ctx, owner: string, name: string): RepoRec {
  if (owner.toLowerCase() !== VIEWER_LOGIN) throw notFound();
  const repo = ctx.store.getRepo(owner, name);
  if (repo === null) throw notFound();
  return repo;
}

function requireItem(repo: RepoRec, raw: string): IssueRec {
  const number = Number(raw);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (item === undefined) throw notFound();
  return item;
}

export function handleRest(store: Store, method: string, path: string, query: URLSearchParams, body: Buffer, host: string): ApiResult {
  const segments = path
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => decodeURIComponent(piece));
  const ctx: Ctx = { store, method, segments, query, body, host };
  try {
    return route(ctx);
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, json: { message: err.message } };
    throw err;
  }
}

function route(ctx: Ctx): ApiResult {
  const s = ctx.segments;
  const { method } = ctx;

  if (s.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        json: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}', issue_url: '/api/v3/repos/{owner}/{repo}/issues' },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    throw notFound();
  }
  if (s[0] === 'meta' && s.length === 1 && method === 'GET') {
    return { status: 200, json: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }
  if (s[0] === 'user' && s.length === 1 && method === 'GET') return { status: 200, json: viewerJson() };
  if (s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST' && s.length === 2) return createRepoRoute(ctx);
    if (method === 'GET' && s.length === 2) {
      const { page, perPage } = pagination(ctx);
      const all = ctx.store.viewerRepos();
      const items = paginate(all, page, perPage).map(repoJson);
      return { status: 200, json: items, headers: linkHeader(ctx, '/api/v3/user/repos', page, perPage, all.length) };
    }
  }
  if (s[0] === 'repos' && s.length >= 3) {
    const repo = requireRepo(ctx, s[1] as string, s[2] as string);
    return repoRoute(ctx, repo, s.slice(3));
  }
  throw notFound();
}

function createRepoRoute(ctx: Ctx): ApiResult {
  const body = jsonBody(ctx);
  const name = typeof body['name'] === 'string' ? (body['name'] as string) : '';
  if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
  if (ctx.store.getRepo(VIEWER_LOGIN, name) !== null) {
    return {
      status: 422,
      json: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    };
  }
  const description = typeof body['description'] === 'string' ? (body['description'] as string) : '';
  const isPrivate = body['private'] === true;
  const repo = ctx.store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
  if (typeof body['default_branch'] === 'string' && (body['default_branch'] as string) !== '') {
    repo.defaultBranch = body['default_branch'] as string;
  }
  return { status: 201, json: repoJson(repo) };
}

function repoRoute(ctx: Ctx, repo: RepoRec, rest: string[]): ApiResult {
  const { method } = ctx;
  const s = rest;

  if (s.length === 0) {
    if (method === 'GET') return { status: 200, json: repoJson(repo) };
    if (method === 'PATCH') {
      const body = jsonBody(ctx);
      if (typeof body['description'] === 'string') repo.description = body['description'] as string;
      if (typeof body['private'] === 'boolean') repo.isPrivate = body['private'] as boolean;
      if (typeof body['name'] === 'string' && (body['name'] as string) !== '') {
        const newName = body['name'] as string;
        if (ctx.store.getRepo(repo.owner, newName) !== null && newName.toLowerCase() !== repo.name.toLowerCase()) {
          throw new HttpError(422, 'name already exists on this account');
        }
        ctx.store.repos.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`);
        repo.name = newName;
        ctx.store.repos.set(`${repo.owner.toLowerCase()}/${newName.toLowerCase()}`, repo);
      }
      if (typeof body['default_branch'] === 'string' && (body['default_branch'] as string) !== '') {
        const branch = body['default_branch'] as string;
        if (repo.refs.size > 0 && branchTip(repo, branch) === null) throw new HttpError(422, `default branch "${branch}" does not exist`);
        repo.defaultBranch = branch;
        repo.gitVersion += 1;
      }
      return { status: 200, json: repoJson(repo) };
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    throw notFound();
  }

  if (s[0] === 'labels') return labelsRoute(ctx, repo, s.slice(1));
  if (s[0] === 'issues') return issuesRoute(ctx, repo, s.slice(1));
  if (s[0] === 'pulls') return pullsRoute(ctx, repo, s.slice(1));
  if (s[0] === 'contents') return contentsRoute(ctx, repo, s.slice(1).join('/'));
  if (s[0] === 'branches') return branchesRoute(ctx, repo, s.slice(1));
  if (s[0] === 'commits') return commitsRoute(ctx, repo, s.slice(1));
  if (s[0] === 'git' && s[1] === 'refs') return gitRefsRoute(ctx, repo, s.slice(2).join('/'));
  throw notFound();
}

// ---------------------------------------------------------------- labels

function labelsRoute(ctx: Ctx, repo: RepoRec, s: string[]): ApiResult {
  const { method } = ctx;
  if (s.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(ctx);
      const name = typeof body['name'] === 'string' ? (body['name'] as string) : '';
      if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" already exists`);
      const label: LabelRec = {
        name,
        color: typeof body['color'] === 'string' ? (body['color'] as string).replace(/^#/, '') : 'ededed',
        description: typeof body['description'] === 'string' ? (body['description'] as string) : null,
      };
      repo.labels.set(name, label);
      return { status: 201, json: labelJson(label) };
    }
    if (method === 'GET') return { status: 200, json: [...repo.labels.values()].map(labelJson) };
  }
  if (s.length === 1) {
    const label = repo.labels.get(s[0] as string);
    if (label === undefined) throw notFound();
    if (method === 'GET') return { status: 200, json: labelJson(label) };
    if (method === 'DELETE') {
      repo.labels.delete(label.name);
      return { status: 204 };
    }
  }
  throw notFound();
}

// ---------------------------------------------------------------- issues

function issuesRoute(ctx: Ctx, repo: RepoRec, s: string[]): ApiResult {
  const { method } = ctx;
  if (s.length === 0) {
    if (method === 'POST') {
      const item = createIssue(ctx.store, repo, jsonBody(ctx));
      return { status: 201, raw: issueJsonText(repo, item) };
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      const labelFilter = (ctx.query.get('labels') ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
      let items = [...repo.items.values()];
      if (state !== 'all') items = items.filter((item) => item.state === state);
      if (labelFilter.length > 0) items = items.filter((item) => labelFilter.every((name) => item.labels.includes(name)));
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, perPage } = pagination(ctx);
      const pageItems = paginate(items, page, perPage);
      return { status: 200, json: pageItems.map((item) => JSON.parse(issueJsonText(repo, item))) };
    }
  }
  if (s.length >= 1) {
    const item = requireItem(repo, s[0] as string);
    if (s.length === 1) {
      if (method === 'GET') return { status: 200, raw: issueJsonText(repo, item) };
      if (method === 'PATCH') {
        const body = jsonBody(ctx);
        if (typeof body['title'] === 'string') item.title = body['title'] as string;
        if (typeof body['body'] === 'string') item.body = body['body'] as string;
        if (body['state'] === 'open' || body['state'] === 'closed') item.state = body['state'] as 'open' | 'closed';
        if (Array.isArray(body['labels'])) {
          const labels: string[] = [];
          for (const entry of body['labels'] as unknown[]) {
            const name = typeof entry === 'string' ? entry : null;
            if (name === null) continue;
            if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
            labels.push(name);
          }
          item.labels = labels;
        }
        item.restCache = null;
        return { status: 200, raw: issueJsonText(repo, item) };
      }
    }
    if (s.length === 2 && s[1] === 'comments') {
      if (method === 'POST') {
        const body = jsonBody(ctx);
        const text = typeof body['body'] === 'string' ? (body['body'] as string) : '';
        if (text === '') throw new HttpError(422, 'Validation Failed: body is required');
        const comment = addComment(ctx.store, repo, item, text);
        return { status: 201, json: commentJson(repo, item, comment) };
      }
      if (method === 'GET') {
        const { page, perPage } = pagination(ctx);
        return { status: 200, json: paginate(item.comments, page, perPage).map((comment) => commentJson(repo, item, comment)) };
      }
    }
  }
  throw notFound();
}

// ---------------------------------------------------------------- pulls

function pullsRoute(ctx: Ctx, repo: RepoRec, s: string[]): ApiResult {
  const { method } = ctx;
  if (s.length === 0) {
    if (method === 'POST') {
      const item = createPullRequest(ctx.store, repo, jsonBody(ctx));
      return { status: 201, json: prJson(repo, item) };
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let items = [...repo.items.values()].filter((item) => item.kind === 'pr');
      if (state !== 'all') items = items.filter((item) => item.state === state);
      const headFilter = ctx.query.get('head');
      const baseFilter = ctx.query.get('base');
      if (headFilter !== null) items = items.filter((item) => item.headRef === headFilter || `${repo.owner}:${item.headRef}` === headFilter);
      if (baseFilter !== null) items = items.filter((item) => item.baseRef === baseFilter);
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, perPage } = pagination(ctx);
      return { status: 200, json: paginate(items, page, perPage).map((item) => prJson(repo, item)) };
    }
  }
  if (s.length >= 1) {
    const item = requireItem(repo, s[0] as string);
    if (item.kind !== 'pr') throw notFound();
    if (s.length === 1) {
      if (method === 'GET') return { status: 200, json: prJson(repo, item) };
      if (method === 'PATCH') {
        const body = jsonBody(ctx);
        if (typeof body['title'] === 'string') item.title = body['title'] as string;
        if (typeof body['body'] === 'string') item.body = body['body'] as string;
        if (body['state'] === 'open' || body['state'] === 'closed') {
          if (!(item.merged && body['state'] === 'closed')) item.state = body['state'] as 'open' | 'closed';
        }
        if (typeof body['base'] === 'string' && branchTip(repo, body['base'] as string) !== null) item.baseRef = body['base'] as string;
        return { status: 200, json: prJson(repo, item) };
      }
    }
    if (s.length === 2 && s[1] === 'files' && method === 'GET') {
      const { page, perPage } = pagination(ctx);
      const files = prFiles(repo, item).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.additions + file.deletions,
      }));
      return { status: 200, json: paginate(files, page, perPage) };
    }
    if (s.length === 2 && s[1] === 'merge') {
      if (method === 'GET') return item.merged ? { status: 204 } : { status: 404, json: { message: 'Not Found' } };
      if (method === 'PUT') {
        const body = jsonBody(ctx);
        const shaGuard = typeof body['sha'] === 'string' ? (body['sha'] as string) : null;
        const headTip = branchTip(repo, item.headRef);
        if (shaGuard !== null && headTip !== null && shaGuard !== headTip) {
          throw new HttpError(409, 'Head branch was modified. Review and try the merge again.');
        }
        const methodName = typeof body['merge_method'] === 'string' ? (body['merge_method'] as string) : 'merge';
        const result = mergePullRequest(ctx.store, repo, item, methodName);
        if (!result.ok) throw new HttpError(405, result.reason);
        return { status: 200, json: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
      }
    }
  }
  throw notFound();
}

// ---------------------------------------------------------------- contents

function contentsRoute(ctx: Ctx, repo: RepoRec, path: string): ApiResult {
  const { method } = ctx;
  if (method === 'PUT') {
    const body = jsonBody(ctx);
    const message = typeof body['message'] === 'string' ? (body['message'] as string) : '';
    if (message === '') throw new HttpError(422, 'Validation Failed: message is required');
    if (typeof body['content'] !== 'string') throw new HttpError(422, 'Validation Failed: content is required');
    const content = Buffer.from((body['content'] as string).replace(/[\r\n\t ]+/g, ''), 'base64');
    const branch = typeof body['branch'] === 'string' ? (body['branch'] as string) : repo.defaultBranch;
    const sha = typeof body['sha'] === 'string' ? (body['sha'] as string) : null;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined && branch !== repo.defaultBranch) throw new HttpError(404, 'Branch not found');
    const files = filesAtCommit(repo, tip ?? null);
    const existing = files.get(path);
    if (existing !== undefined) {
      if (sha === null) throw new HttpError(422, 'Validation Failed: sha is required when updating an existing file');
      if (sha !== existing.oid) throw new HttpError(409, 'The sha does not match the current blob');
    } else if (sha !== null) {
      throw new HttpError(422, 'Validation Failed: sha supplied for a file that does not exist');
    }
    const blobOid = storeObject(repo, 'blob', content);
    files.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
    const treeOid = buildTreeFromFiles(repo, files);
    const commitOid = commitOnBranch(repo, branch, treeOid, message);
    const created = existing === undefined;
    return {
      status: created ? 201 : 200,
      json: {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
        },
        commit: { sha: commitOid, message },
      },
    };
  }
  if (method === 'GET') {
    const refParam = ctx.query.get('ref');
    const tip = refParam !== null ? resolveRef(repo, refParam) : branchTip(repo, repo.defaultBranch);
    if (tip === null) throw notFound();
    const commit = commitOf(repo, tip);
    if (commit === null) throw notFound();
    const entry = treeEntryAt(repo, commit.tree, path);
    if (entry === null) throw notFound();
    if (!entry.isDir) {
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) throw notFound();
      return {
        status: 200,
        json: {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: entry.oid,
          size: blob.data.length,
          encoding: 'base64',
          content: blob.data.toString('base64'),
        },
      };
    }
    const entries = parseTree(repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0))
      .map((child) => {
        const isDir = child.mode === '40000' || child.mode === '040000';
        const childPath = path === '' ? child.name : `${path}/${child.name}`;
        const size = isDir ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0);
        return { type: isDir ? 'dir' : 'file', name: child.name, path: childPath, sha: child.oid, size };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { status: 200, json: entries };
  }
  if (method === 'DELETE') {
    const body = jsonBody(ctx);
    const message = typeof body['message'] === 'string' ? (body['message'] as string) : '';
    if (message === '') throw new HttpError(422, 'Validation Failed: message is required');
    const sha = typeof body['sha'] === 'string' ? (body['sha'] as string) : null;
    if (sha === null) throw new HttpError(422, 'Validation Failed: sha is required');
    const branch = typeof body['branch'] === 'string' ? (body['branch'] as string) : repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (tip === null) throw notFound();
    const files = filesAtCommit(repo, tip);
    const existing = files.get(path);
    if (existing === undefined) throw notFound();
    if (sha !== existing.oid) throw new HttpError(409, 'The sha does not match the current blob');
    files.delete(path);
    const treeOid = buildTreeFromFiles(repo, files);
    const commitOid = commitOnBranch(repo, branch, treeOid, message);
    return { status: 200, json: { content: null, commit: { sha: commitOid, message } } };
  }
  throw notFound();
}

// ---------------------------------------------------------------- branches, commits, git refs

function branchesRoute(ctx: Ctx, repo: RepoRec, s: string[]): ApiResult {
  const { method } = ctx;
  if (s.length === 0 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, json: branches };
  }
  const name = s.join('/');
  if (method === 'GET') {
    const tip = branchTip(repo, name);
    if (tip === null) throw notFound();
    return { status: 200, json: { name, commit: { sha: tip }, protected: false } };
  }
  throw notFound();
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') throw notFound();
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  const toJson = (identity: { name: string; email: string; ts: number }): Record<string, unknown> => ({
    name: identity.name,
    email: identity.email,
    date: new Date(identity.ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  return {
    sha: oid,
    node_id: globalId('Commit', repo.id, 0) + oid.slice(0, 8),
    commit: {
      author: toJson(author),
      committer: toJson(committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function commitsRoute(ctx: Ctx, repo: RepoRec, s: string[]): ApiResult {
  const { method } = ctx;
  if (s.length === 1 && method === 'GET') return { status: 200, json: commitJson(repo, s[0] as string) };
  if (s.length === 0 && method === 'GET') {
    const shaParam = ctx.query.get('sha');
    const tip = shaParam !== null ? resolveRef(repo, shaParam) : branchTip(repo, repo.defaultBranch);
    if (tip === null) return { status: 200, json: [] };
    const commit = commitOf(repo, tip);
    if (commit === null) return { status: 200, json: [] };
    const { page, perPage } = pagination(ctx);
    const all = walkCommits(repo, tip);
    return { status: 200, json: paginate(all, page, perPage).map((oid) => commitJson(repo, oid)) };
  }
  throw notFound();
}

function gitRefsRoute(ctx: Ctx, repo: RepoRec, refPath: string): ApiResult {
  const { method } = ctx;
  if (refPath === '' && method === 'POST') {
    const body = jsonBody(ctx);
    const ref = typeof body['ref'] === 'string' ? (body['ref'] as string) : '';
    const sha = typeof body['sha'] === 'string' ? (body['sha'] as string) : '';
    if (!ref.startsWith('refs/')) throw new HttpError(422, 'Validation Failed: ref must start with refs/');
    if (!repo.objects.has(sha)) throw new HttpError(422, 'Validation Failed: sha does not identify an object');
    if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    repo.gitVersion += 1;
    const object = repo.objects.get(sha);
    return { status: 201, json: { ref, object: { sha, type: object?.type ?? 'commit' } } };
  }
  if (refPath === '' && method === 'GET') {
    const all = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } }));
    return { status: 200, json: all };
  }
  const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  if (method === 'GET') {
    const oid = repo.refs.get(full);
    if (oid === undefined) throw notFound();
    return { status: 200, json: { ref: full, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } } };
  }
  if (method === 'DELETE') {
    if (!repo.refs.has(full)) throw notFound();
    repo.refs.delete(full);
    repo.gitVersion += 1;
    return { status: 204 };
  }
  throw notFound();
}

export { EPOCH_SEC };
