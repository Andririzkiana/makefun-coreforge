// GitHub GraphQL v4 surface: a small lexer/parser for the document shapes gh and
// github-mcp-server send (named operations, variables, aliases, inline fragments, input
// objects, batching), and an executor over the same store the REST and git surfaces use.
//
// Error convention: a GraphQL-level failure (unknown field, bad id) is HTTP 200 with an
// `errors` array; an unauthenticated request never reaches here (app.ts answers 401 first).

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  decodeGlobalId,
  globalId,
  isoOfSeq,
  repoById,
  type IssueRec,
  type RepoRec,
  type Store,
} from './store.ts';
import {
  HttpError,
  addComment,
  branchTip,
  createIssue,
  createPullRequest,
  mergePullRequest,
  prFiles,
  prMergeable,
} from './rest.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { t: 'name'; v: string }
  | { t: 'int'; v: string }
  | { t: 'float'; v: string }
  | { t: 'string'; v: string }
  | { t: 'punct'; v: string }
  | { t: 'spread' }
  | { t: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ t: 'spread' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(c)) {
      tokens.push({ t: 'punct', v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ t: 'string', v: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ t: isFloat ? 'float' : 'int', v: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ t: 'name', v: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ t: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<[string, GqlValue]> };

export interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  directives: Record<string, Record<string, GqlValue>>;
  selections: GqlSelection[];
}

export type GqlSelection =
  | { type: 'field'; field: GqlField }
  | { type: 'spread'; name: string }
  | { type: 'inline'; typeCondition: string | null; selections: GqlSelection[] };

export interface GqlOperation {
  opType: 'query' | 'mutation';
  name: string | null;
  varDefaults: Record<string, GqlValue>;
  selections: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Record<string, { typeCondition: string; selections: GqlSelection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expectPunct(v: string): void {
    const token = this.next();
    if (token.t !== 'punct' || token.v !== v) throw new Error(`expected "${v}"`);
  }
  private acceptPunct(v: string): boolean {
    const token = this.peek();
    if (token.t === 'punct' && token.v === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.t !== 'name') throw new Error('expected a name');
    return token.v;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments: GqlDocument['fragments'] = {};
    while (this.peek().t !== 'eof') {
      const token = this.peek();
      if (token.t === 'punct' && token.v === '{') {
        operations.push({ opType: 'query', name: null, varDefaults: {}, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.t !== 'name') throw new Error('expected a definition');
      if (token.v === 'query' || token.v === 'mutation' || token.v === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().t === 'name') name = this.expectName();
        const varDefaults: Record<string, GqlValue> = {};
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.acceptPunct('=')) varDefaults[varName] = this.parseValue();
            this.parseDirectives();
          }
        }
        this.parseDirectives();
        operations.push({ opType: token.v === 'mutation' ? 'mutation' : 'query', name, varDefaults, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.v === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments[fragName] = { typeCondition, selections: this.parseSelectionSet() };
        continue;
      }
      throw new Error(`unexpected definition "${token.v}"`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseDirectives(): Record<string, Record<string, GqlValue>> {
    const directives: Record<string, Record<string, GqlValue>> = {};
    while (this.peek().t === 'punct' && (this.peek() as { v: string }).v === '@') {
      this.next();
      const name = this.expectName();
      directives[name] = this.acceptPunct('(') ? this.parseArgsBody() : {};
    }
    return directives;
  }

  private parseArgsBody(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.acceptPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek().t === 'spread') {
      this.next();
      if (this.peek().t === 'name' && (this.peek() as { v: string }).v === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { type: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().t === 'punct' && (this.peek() as { v: string }).v === '{') {
        return { type: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { type: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.acceptPunct('(') ? this.parseArgsBody() : {};
    const directives = this.parseDirectives();
    let selections: GqlSelection[] = [];
    if (this.peek().t === 'punct' && (this.peek() as { v: string }).v === '{') selections = this.parseSelectionSet();
    return { type: 'field', field: { name, alias, args, directives, selections } };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    switch (token.t) {
      case 'int':
        return { kind: 'int', value: parseInt(token.v, 10) };
      case 'float':
        return { kind: 'float', value: parseFloat(token.v) };
      case 'string':
        return { kind: 'string', value: token.v };
      case 'name':
        if (token.v === 'true') return { kind: 'bool', value: true };
        if (token.v === 'false') return { kind: 'bool', value: false };
        if (token.v === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.v };
      case 'punct':
        if (token.v === '$') return { kind: 'var', name: this.expectName() };
        if (token.v === '[') {
          const items: GqlValue[] = [];
          while (!this.acceptPunct(']')) items.push(this.parseValue());
          return { kind: 'list', items };
        }
        if (token.v === '{') {
          const fields: Array<[string, GqlValue]> = [];
          while (!this.acceptPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push([name, this.parseValue()]);
          }
          return { kind: 'object', fields };
        }
        break;
    }
    throw new Error('unexpected value token');
  }
}

// ---------------------------------------------------------------- values

type Vars = Record<string, unknown>;

function resolveValue(value: GqlValue, vars: Vars): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, vars);
      return out;
    }
  }
}

function resolveArgs(field: GqlField, vars: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, vars);
  return out;
}

// ---------------------------------------------------------------- sources

type Src = Record<string, unknown> & { __typename: string };

const userSrc = (): Src => ({ __typename: 'User', login: VIEWER_LOGIN });
const repoSrc = (repo: RepoRec): Src => ({ __typename: 'Repository', repo });
const issueSrc = (repo: RepoRec, item: IssueRec): Src => ({ __typename: 'Issue', repo, item });
const prSrc = (repo: RepoRec, item: IssueRec): Src => ({ __typename: 'PullRequest', repo, item });
const itemSrc = (repo: RepoRec, item: IssueRec): Src => (item.kind === 'pr' ? prSrc(repo, item) : issueSrc(repo, item));

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionArgs {
  first?: unknown;
  after?: unknown;
  states?: unknown;
  orderBy?: unknown;
}

/** Build a connection source over items already in display order (newest first by default). */
function connection(typename: string, edgeTypename: string, items: Src[], args: ConnectionArgs, numbers: number[]): Src {
  let start = 0;
  if (typeof args.after === 'string') {
    const afterNumber = numberFromCursor(args.after);
    if (afterNumber !== null) {
      const index = numbers.indexOf(afterNumber);
      if (index !== -1) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
  const pageItems = items.slice(start, start + first);
  const pageNumbers = numbers.slice(start, start + first);
  const hasNextPage = start + first < items.length;
  const edges = pageItems.map((node, index) => ({
    __typename: edgeTypename,
    node,
    cursor: cursorOf(pageNumbers[index] as number),
  }));
  return {
    __typename: typename,
    nodes: pageItems,
    edges,
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: pageNumbers.length > 0 ? cursorOf(pageNumbers[0] as number) : null,
      endCursor: pageNumbers.length > 0 ? cursorOf(pageNumbers[pageNumbers.length - 1] as number) : null,
    },
  };
}

function stateFilter(items: IssueRec[], states: unknown, kind: 'issue' | 'pr'): IssueRec[] {
  if (!Array.isArray(states) || states.length === 0) return items;
  const wanted = new Set(states.map((state) => String(state)));
  return items.filter((item) => {
    if (kind === 'issue') return wanted.has(item.state === 'open' ? 'OPEN' : 'CLOSED');
    if (item.merged) return wanted.has('MERGED');
    return wanted.has(item.state === 'open' ? 'OPEN' : 'CLOSED');
  });
}

function orderItems(items: IssueRec[], orderBy: unknown): IssueRec[] {
  let direction = 'DESC';
  if (typeof orderBy === 'object' && orderBy !== null) {
    const dir = (orderBy as Record<string, unknown>)['direction'];
    if (typeof dir === 'string') direction = dir;
  }
  const sorted = [...items].sort((a, b) => a.seq - b.seq || a.number - b.number);
  if (direction !== 'ASC') sorted.reverse();
  return sorted;
}

// ---------------------------------------------------------------- resolvers

type Resolver = (src: Src, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

interface ExecCtx {
  store: Store;
  vars: Vars;
  fragments: GqlDocument['fragments'];
  errors: Array<{ message: string }>;
}

const repoOf = (src: Src): RepoRec => src['repo'] as RepoRec;
const itemOf = (src: Src): IssueRec => src['item'] as IssueRec;

function refSrc(repo: RepoRec, branch: string): Src | null {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  return {
    __typename: 'Ref',
    name: branch,
    prefix: 'refs/heads/',
    target: { __typename: 'Commit', oid: tip, repo },
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userSrc(),
    repository: (_src, args, ctx) => {
      const owner = String(args['owner'] ?? '');
      const name = String(args['name'] ?? '');
      if (owner.toLowerCase() !== VIEWER_LOGIN) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === null ? null : repoSrc(repo);
    },
    node: (_src, args, ctx) => nodeById(ctx, String(args['id'] ?? '')),
    __type: (_src, args) => ({ __typename: '__Type', name: String(args['name'] ?? '') }),
    __schema: () => ({ __typename: '__Schema' }),
  },
  Mutation: {
    createIssue: (_src, args, ctx) => {
      const input = (args['input'] ?? args) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, String(input['repositoryId'] ?? ''));
      const item = createIssue(ctx.store, repo, { title: input['title'], body: input['body'], labels: input['labelIds'] !== undefined ? [] : undefined });
      return { __typename: 'CreateIssuePayload', issue: issueSrc(repo, item), clientMutationId: input['clientMutationId'] ?? null };
    },
    closeIssue: (_src, args, ctx) => {
      const input = (args['input'] ?? args) as Record<string, unknown>;
      const found = itemFromGlobalId(ctx, String(input['issueId'] ?? ''), 'Issue');
      found.item.state = 'closed';
      found.item.restCache = null;
      return { __typename: 'CloseIssuePayload', issue: issueSrc(found.repo, found.item), clientMutationId: input['clientMutationId'] ?? null };
    },
    reopenIssue: (_src, args, ctx) => {
      const input = (args['input'] ?? args) as Record<string, unknown>;
      const found = itemFromGlobalId(ctx, String(input['issueId'] ?? ''), 'Issue');
      found.item.state = 'open';
      found.item.restCache = null;
      return { __typename: 'ReopenIssuePayload', issue: issueSrc(found.repo, found.item), clientMutationId: input['clientMutationId'] ?? null };
    },
    createPullRequest: (_src, args, ctx) => {
      const input = (args['input'] ?? args) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, String(input['repositoryId'] ?? ''));
      const item = createPullRequest(ctx.store, repo, {
        title: input['title'],
        body: input['body'],
        head: input['headRefName'],
        base: input['baseRefName'],
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: prSrc(repo, item), clientMutationId: input['clientMutationId'] ?? null };
    },
    mergePullRequest: (_src, args, ctx) => {
      const input = (args['input'] ?? args) as Record<string, unknown>;
      const found = itemFromGlobalId(ctx, String(input['pullRequestId'] ?? ''), 'PullRequest');
      const methodRaw = typeof input['mergeMethod'] === 'string' ? (input['mergeMethod'] as string) : 'SQUASH';
      const result = mergePullRequest(ctx.store, found.repo, found.item, methodRaw.toLowerCase());
      if (!result.ok) throw new HttpError(200, result.reason);
      return { __typename: 'MergePullRequestPayload', pullRequest: prSrc(found.repo, found.item), clientMutationId: input['clientMutationId'] ?? null };
    },
    addComment: (_src, args, ctx) => {
      const input = (args['input'] ?? args) as Record<string, unknown>;
      const found = itemFromGlobalId(ctx, String(input['subjectId'] ?? ''), null);
      const body = typeof input['body'] === 'string' ? (input['body'] as string) : '';
      if (body === '') throw new HttpError(200, 'Body is required');
      const comment = addComment(ctx.store, found.repo, found.item, body);
      const node: Src = { __typename: 'IssueComment', repo: found.repo, item: found.item, comment };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorOf(comment.id) },
        clientMutationId: input['clientMutationId'] ?? null,
      };
    },
  },
  User: {
    id: () => globalId('User', 0, VIEWER_ID),
    databaseId: () => VIEWER_ID,
    login: () => VIEWER_LOGIN,
    name: () => VIEWER_NAME,
    email: () => VIEWER_EMAIL,
  },
  Repository: {
    id: (src) => globalId('Repository', repoOf(src).id, 0),
    databaseId: (src) => repoOf(src).id,
    name: (src) => repoOf(src).name,
    nameWithOwner: (src) => `${repoOf(src).owner}/${repoOf(src).name}`,
    owner: () => userSrc(),
    description: (src) => (repoOf(src).description === '' ? null : repoOf(src).description),
    isPrivate: (src) => repoOf(src).isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    defaultBranchRef: (src) => refSrc(repoOf(src), repoOf(src).defaultBranch),
    createdAt: (src) => isoOfSeq(repoOf(src).seq),
    updatedAt: (src) => isoOfSeq(repoOf(src).seq),
    issue: (src, args) => {
      const item = repoOf(src).items.get(Number(args['number']));
      return item !== undefined && item.kind === 'issue' ? issueSrc(repoOf(src), item) : null;
    },
    issueOrPullRequest: (src, args) => {
      const item = repoOf(src).items.get(Number(args['number']));
      return item === undefined ? null : itemSrc(repoOf(src), item);
    },
    issues: (src, args) => {
      const repo = repoOf(src);
      const filtered = stateFilter([...repo.items.values()].filter((item) => item.kind === 'issue'), args['states'], 'issue');
      const ordered = orderItems(filtered, args['orderBy']);
      return connection('IssueConnection', 'IssueEdge', ordered.map((item) => issueSrc(repo, item)), args, ordered.map((item) => item.number));
    },
    pullRequest: (src, args) => {
      const item = repoOf(src).items.get(Number(args['number']));
      return item !== undefined && item.kind === 'pr' ? prSrc(repoOf(src), item) : null;
    },
    pullRequests: (src, args) => {
      const repo = repoOf(src);
      const filtered = stateFilter([...repo.items.values()].filter((item) => item.kind === 'pr'), args['states'], 'pr');
      const ordered = orderItems(filtered, args['orderBy']);
      return connection('PullRequestConnection', 'PullRequestEdge', ordered.map((item) => prSrc(repo, item)), args, ordered.map((item) => item.number));
    },
    labels: (src, args) => {
      const repo = repoOf(src);
      const all = [...repo.labels.values()].map((label) => ({ __typename: 'Label', name: label.name, color: label.color, description: label.description }));
      return connection('LabelConnection', 'LabelEdge', all, args, all.map((_label, index) => index + 1));
    },
  },
  Issue: {
    id: (src) => globalId('Issue', repoOf(src).id, itemOf(src).number),
    databaseId: (src) => itemOf(src).id,
    number: (src) => itemOf(src).number,
    title: (src) => itemOf(src).title,
    body: (src) => itemOf(src).body,
    state: (src) => (itemOf(src).state === 'open' ? 'OPEN' : 'CLOSED'),
    author: () => userSrc(),
    repository: (src) => repoSrc(repoOf(src)),
    createdAt: (src) => isoOfSeq(itemOf(src).seq),
    updatedAt: (src) => isoOfSeq(itemOf(src).seq),
    closedAt: (src) => (itemOf(src).state === 'closed' ? isoOfSeq(itemOf(src).seq) : null),
    labels: (src, args) => {
      const repo = repoOf(src);
      const all = itemOf(src).labels.map((name) => {
        const label = repo.labels.get(name);
        return { __typename: 'Label', name, color: label?.color ?? 'ededed', description: label?.description ?? null };
      });
      return connection('LabelConnection', 'LabelEdge', all, args, all.map((_label, index) => index + 1));
    },
    comments: (src, args) => {
      const repo = repoOf(src);
      const item = itemOf(src);
      const all = item.comments.map((comment) => ({ __typename: 'IssueComment', repo, item, comment }));
      return connection('IssueCommentConnection', 'IssueCommentEdge', all, args, all.map((_c, index) => index + 1));
    },
  },
  PullRequest: {
    id: (src) => globalId('PullRequest', repoOf(src).id, itemOf(src).number),
    databaseId: (src) => itemOf(src).id,
    number: (src) => itemOf(src).number,
    title: (src) => itemOf(src).title,
    body: (src) => itemOf(src).body,
    state: (src) => (itemOf(src).merged ? 'MERGED' : itemOf(src).state === 'open' ? 'OPEN' : 'CLOSED'),
    merged: (src) => itemOf(src).merged,
    mergeable: (src) => {
      const item = itemOf(src);
      if (item.state !== 'open') return 'UNKNOWN';
      return prMergeable(repoOf(src), item) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (src) => itemOf(src).headRef,
    baseRefName: (src) => itemOf(src).baseRef,
    headRefOid: (src) => branchTip(repoOf(src), itemOf(src).headRef) ?? itemOf(src).headSha,
    baseRefOid: (src) => branchTip(repoOf(src), itemOf(src).baseRef) ?? itemOf(src).baseSha,
    headRef: (src) => refSrc(repoOf(src), itemOf(src).headRef),
    baseRef: (src) => refSrc(repoOf(src), itemOf(src).baseRef),
    mergeCommit: (src) => (itemOf(src).mergeCommitSha === null ? null : { __typename: 'Commit', oid: itemOf(src).mergeCommitSha, repo: repoOf(src) }),
    author: () => userSrc(),
    repository: (src) => repoSrc(repoOf(src)),
    createdAt: (src) => isoOfSeq(itemOf(src).seq),
    updatedAt: (src) => isoOfSeq(itemOf(src).seq),
    closedAt: (src) => (itemOf(src).state === 'closed' ? isoOfSeq(itemOf(src).seq) : null),
    mergedAt: (src) => (itemOf(src).merged ? isoOfSeq(itemOf(src).mergedSeq) : null),
    files: (src, args) => {
      const repo = repoOf(src);
      const all = prFiles(repo, itemOf(src)).map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      return connection('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', all, args, all.map((_f, index) => index + 1));
    },
  },
  IssueComment: {
    id: (src) => globalId('IssueComment', repoOf(src).id, (src['comment'] as { id: number }).id),
    databaseId: (src) => (src['comment'] as { id: number }).id,
    body: (src) => (src['comment'] as { body: string }).body,
    author: () => userSrc(),
    createdAt: (src) => isoOfSeq((src['comment'] as { seq: number }).seq),
  },
  Label: {
    id: (src) => globalId('Label', 0, 0) + Buffer.from(String(src['name'])).toString('base64'),
    name: (src) => src['name'],
    color: (src) => src['color'],
    description: (src) => src['description'] ?? null,
  },
  Ref: {
    name: (src) => src['name'],
    prefix: (src) => src['prefix'],
    target: (src) => src['target'],
  },
  Commit: {
    id: (src) => globalId('Commit', (src['repo'] as RepoRec).id, 0) + String(src['oid']).slice(0, 8),
    oid: (src) => src['oid'],
    message: (src) => {
      const repo = src['repo'] as RepoRec;
      const object = repo.objects.get(String(src['oid']));
      if (object === undefined) return '';
      const split = object.data.toString('utf8').indexOf('\n\n');
      return split === -1 ? '' : object.data.toString('utf8').slice(split + 2);
    },
    messageHeadline: (src) => {
      const repo = src['repo'] as RepoRec;
      const object = repo.objects.get(String(src['oid']));
      if (object === undefined) return '';
      const text = object.data.toString('utf8');
      const split = text.indexOf('\n\n');
      return split === -1 ? '' : text.slice(split + 2).split('\n')[0] ?? '';
    },
    committedDate: (src) => {
      const repo = src['repo'] as RepoRec;
      const object = repo.objects.get(String(src['oid']));
      if (object === undefined) return isoOfSeq(0);
      const match = / (\d{10}) [+-]\d{4}/.exec(object.data.toString('utf8'));
      return match === null ? isoOfSeq(0) : new Date(Number(match[1]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    },
  },
  __Type: {
    name: (src) => src['name'],
    kind: (src) => typeKind(String(src['name'])),
    description: () => null,
    fields: (src) => (TYPE_FIELDS[String(src['name'])] ?? []).map((name) => ({ __typename: '__Field', name })),
    enumValues: (src) => (ENUM_VALUES[String(src['name'])] ?? []).map((name) => ({ __typename: '__EnumValue', name })),
    inputFields: (src) => (INPUT_FIELDS[String(src['name'])] ?? []).map((name) => ({ __typename: '__InputValue', name })),
    possibleTypes: () => [],
  },
  __Field: {
    name: (src) => src['name'],
    description: () => null,
    args: () => [],
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (src) => src['name'],
    description: () => null,
    isDeprecated: () => false,
  },
  __InputValue: {
    name: (src) => src['name'],
    description: () => null,
  },
  __Schema: {
    queryType: () => ({ __typename: '__Type', name: 'Query' }),
    mutationType: () => ({ __typename: '__Type', name: 'Mutation' }),
    subscriptionType: () => null,
    types: () => Object.keys(TYPE_FIELDS).map((name) => ({ __typename: '__Type', name })),
  },
};

function repoFromGlobalId(ctx: ExecCtx, id: string): RepoRec {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') throw new HttpError(200, `Could not resolve repository id ${id}`);
  const repo = repoById(ctx.store, decoded.repoId);
  if (repo === null) throw new HttpError(200, `Could not resolve repository id ${id}`);
  return repo;
}

function itemFromGlobalId(ctx: ExecCtx, id: string, kind: 'Issue' | 'PullRequest' | null): { repo: RepoRec; item: IssueRec } {
  const decoded = decodeGlobalId(id);
  if (decoded === null) throw new HttpError(200, `Could not resolve id ${id}`);
  if (kind !== null && decoded.kind !== kind && !(kind === 'Issue' && decoded.kind === 'IssueComment')) {
    throw new HttpError(200, `Could not resolve id ${id}`);
  }
  const repo = repoById(ctx.store, decoded.repoId);
  if (repo === null) throw new HttpError(200, `Could not resolve id ${id}`);
  const item = repo.items.get(decoded.number);
  if (item === undefined) throw new HttpError(200, `Could not resolve id ${id}`);
  return { repo, item };
}

function nodeById(ctx: ExecCtx, id: string): Src | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'User') return userSrc();
  if (decoded.kind === 'Repository') {
    const repo = repoById(ctx.store, decoded.repoId);
    return repo === null ? null : repoSrc(repo);
  }
  const repo = repoById(ctx.store, decoded.repoId);
  if (repo === null) return null;
  if (decoded.kind === 'IssueComment') {
    for (const item of repo.items.values()) {
      const comment = item.comments.find((candidate) => candidate.id === decoded.number);
      if (comment !== undefined) return { __typename: 'IssueComment', repo, item, comment };
    }
    return null;
  }
  const item = repo.items.get(decoded.number);
  if (item === undefined) return null;
  return itemSrc(repo, item);
}

// ---------------------------------------------------------------- introspection tables

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'databaseId', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'issueOrPullRequest', 'pullRequest', 'pullRequests', 'labels', 'createdAt', 'updatedAt'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'files', 'author', 'repository', 'mergeCommit', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'tree', 'author'],
  Tree: ['id', 'oid'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  ReopenIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'REBASE', 'SQUASH'],
  FileStatus: ['ADDED', 'DELETED', 'MODIFIED'],
};

const INPUT_FIELDS: Record<string, string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'labelIds', 'clientMutationId'],
  CloseIssueInput: ['issueId', 'stateReason', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'headRefName', 'baseRefName', 'title', 'body', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
  IssueOrder: ['field', 'direction'],
};

const ENUM_TYPES = new Set(Object.keys(ENUM_VALUES));
const INPUT_TYPES = new Set(Object.keys(INPUT_FIELDS));
const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime', 'GitObjectID', 'HTML', 'Base64String', 'GitTimestamp', 'PreciseDateTime', 'X509Certificate', 'BigInt']);

function typeKind(name: string): string {
  if (ENUM_TYPES.has(name)) return 'ENUM';
  if (INPUT_TYPES.has(name)) return 'INPUT_OBJECT';
  if (SCALAR_TYPES.has(name)) return 'SCALAR';
  return 'OBJECT';
}

/** Types a fragment condition may name and still apply to a source of `typename`. */
const IMPLEMENTS: Record<string, string[]> = {
  Issue: ['Node', 'UniformResourceLocatable', 'Reactable', 'Labelable', 'Assignable'],
  PullRequest: ['Node', 'UniformResourceLocatable', 'Reactable', 'Labelable'],
  Repository: ['Node', 'UniformResourceLocatable', 'RepositoryInfo', 'Starrable'],
  User: ['Node', 'Actor', 'RepositoryOwner', 'UniformResourceLocatable'],
  IssueComment: ['Node', 'Reactable'],
  Label: ['Node'],
  Ref: ['Node'],
  Commit: ['Node', 'GitObject'],
  Tree: ['Node', 'GitObject'],
};

// ---------------------------------------------------------------- executor

function directiveAllows(field: GqlField, vars: Vars): boolean {
  for (const [name, args] of Object.entries(field.directives)) {
    if (name === 'include') {
      const cond = resolveValue(args['if'] as GqlValue, vars);
      if (cond !== true) return false;
    }
    if (name === 'skip') {
      const cond = resolveValue(args['if'] as GqlValue, vars);
      if (cond === true) return false;
    }
  }
  return true;
}

function executeSelections(src: Src, typename: string, selections: GqlSelection[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const applyField = (field: GqlField): void => {
    if (!directiveAllows(field, ctx.vars)) return;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typename;
      return;
    }
    const resolver = RESOLVERS[typename]?.[field.name];
    let value: unknown;
    if (resolver !== undefined) {
      try {
        value = resolver(src, resolveArgs(field, ctx.vars), ctx);
      } catch (err) {
        if (err instanceof HttpError) {
          ctx.errors.push({ message: err.message });
          out[key] = null;
          return;
        }
        throw err;
      }
    } else if (field.name in src) {
      value = src[field.name];
    } else {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typename}'` });
      out[key] = null;
      return;
    }
    out[key] = completeValue(value, field, ctx);
  };
  const walk = (list: GqlSelection[]): void => {
    for (const selection of list) {
      if (selection.type === 'field') applyField(selection.field);
      else if (selection.type === 'spread') {
        const fragment = ctx.fragments[selection.name];
        if (fragment !== undefined && (fragment.typeCondition === typename || (IMPLEMENTS[typename] ?? []).includes(fragment.typeCondition))) {
          walk(fragment.selections);
        }
      } else {
        if (selection.typeCondition === null || selection.typeCondition === typename || (IMPLEMENTS[typename] ?? []).includes(selection.typeCondition)) {
          walk(selection.selections);
        }
      }
    }
  };
  walk(selections);
  return out;
}

function completeValue(value: unknown, field: GqlField, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (typeof value === 'object') {
    const src = value as Src;
    if (typeof src.__typename === 'string') {
      if (field.selections.length === 0) return null;
      return executeSelections(src, src.__typename, field.selections, ctx);
    }
    return value;
  }
  return value;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(store: Store, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) return body.map((entry) => executeOne(store, entry));
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): GraphQLResult {
  if (typeof body !== 'object' || body === null) return { errors: [{ message: 'Request body must be a JSON object' }] };
  const record = body as Record<string, unknown>;
  const query = typeof record['query'] === 'string' ? (record['query'] as string) : '';
  if (query === '') return { errors: [{ message: 'Query is required' }] };
  let document: GqlDocument;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: `Parse error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const operationName = typeof record['operationName'] === 'string' ? (record['operationName'] as string) : null;
  const operation = document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const vars: Vars = {};
  if (typeof record['variables'] === 'object' && record['variables'] !== null) {
    Object.assign(vars, record['variables'] as Record<string, unknown>);
  }
  for (const [name, defaultValue] of Object.entries(operation.varDefaults)) {
    if (vars[name] === undefined) vars[name] = resolveValue(defaultValue, vars);
  }
  const ctx: ExecCtx = { store, vars, fragments: document.fragments, errors: [] };
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const root: Src = { __typename: rootType };
  // Query/Mutation resolvers live under their own keys; alias them for lookup.
  const data = executeSelections(root, rootType, operation.selections, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
