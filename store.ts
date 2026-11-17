// The forge's in-memory store: one process, one store, every surface (git smart HTTP, REST v3,
// GraphQL v4, MCP) reading and writing the same records, so an object created through one surface
// is visible through all the others with the same ids.
//
// Determinism: nothing here reads the wall clock. API-created commits and resources take their
// timestamps from a fixed epoch plus a per-store sequence counter, so two runs that receive the
// same requests produce the same bytes.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ORG_LOGIN = 'faint-meadow-org';

/** Fixed epoch (2023-11-14) every generated timestamp derives from. */
export const EPOCH_SEC = 1_700_000_000;

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
  seq: number;
}

export interface IssueRec {
  kind: 'issue' | 'pr';
  /** Global numeric id (issues and pull requests share GitHub's global id space). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  /** Serialized REST issue JSON, cached at mutation time for the read workload. */
  restCache: string | null;
  // Pull-request-only fields.
  headRef: string;
  baseRef: string;
  /** Head/base tip snapshots (creation, refreshed at merge) for display when a branch moves. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  /** Git object store, oid (sha1 hex) -> object. */
  objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/main) -> oid. HEAD is implicit: refs/heads/<defaultBranch>. */
  refs: Map<string, string>;
  /** Issues and pull requests by number (one shared sequence, as on GitHub). */
  items: Map<number, IssueRec>;
  nextNumber: number;
  labels: Map<string, LabelRec>;
  /** Counter for deterministic API-created commit timestamps. */
  commitSeq: number;
  /** Bump-on-mutation counter for git wire state (objects + refs). */
  gitVersion: number;
  /** Cached upload-pack responses (fetch + ls-refs), keyed by request hash, valid at fetchCacheVersion. */
  fetchCache: Map<string, Buffer>;
  fetchCacheVersion: number;
  /** Cached info/refs advertisements, keyed by service + protocol, valid at refsCacheVersion. */
  refsCache: Map<string, Buffer>;
  refsCacheVersion: number;
}

export class Store {
  repos = new Map<string, RepoRec>();
  private repoIdSeq = 0;
  private itemIdSeq = 0;
  private commentIdSeq = 0;
  private seqCounter = 0;

  /** Monotonic sequence for ordering and synthetic timestamps. */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  nextRepoId(): number {
    this.repoIdSeq += 1;
    return this.repoIdSeq;
  }

  nextItemId(): number {
    this.itemIdSeq += 1;
    return this.itemIdSeq;
  }

  nextCommentId(): number {
    this.commentIdSeq += 1;
    return this.commentIdSeq;
  }

  static repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): RepoRec | null {
    return this.repos.get(Store.repoKey(owner, name)) ?? null;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId(),
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      seq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      items: new Map(),
      nextNumber: 1,
      labels: new Map(),
      commitSeq: 0,
      gitVersion: 0,
      fetchCache: new Map(),
      fetchCacheVersion: -1,
      refsCache: new Map(),
      refsCacheVersion: -1,
    };
    this.repos.set(Store.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  /** The viewer's repos in creation order. */
  viewerRepos(): RepoRec[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner.toLowerCase() === VIEWER_LOGIN)
      .sort((a, b) => a.seq - b.seq);
  }
}

/** ISO-8601 timestamp for a sequence number: the fixed epoch plus `seq` seconds. */
export function isoOfSeq(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The git identity line for API-created commits: the viewer, at a deterministic time. */
export function identityLine(seq: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${EPOCH_SEC + seq} +0000`;
}

/** Global ids: opaque, stable, self-decodable. Never the plain database id. */
export function globalId(kind: string, repoId: number, number: number): string {
  return Buffer.from(`v1:${kind}:${repoId}:${number}`, 'utf8').toString('base64');
}

export interface DecodedGlobalId {
  kind: string;
  repoId: number;
  number: number;
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^v1:([A-Za-z]+):(\d+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1] ?? '', repoId: Number(match[2]), number: Number(match[3]) };
  } catch {
    return null;
  }
}

export function repoById(store: Store, repoId: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.id === repoId) return repo;
  return null;
}
