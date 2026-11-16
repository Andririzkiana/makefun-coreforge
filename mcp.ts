// MCP endpoint (POST /mcp): JSON-RPC 2.0, modern-era discovery plus the tool surface the suite
// drives. Stateless per request: every call is answered from the shared store, ids echo back
// untouched, and tools/list is a fixed array so two calls are byte-identical.
//
// Error mapping the client asserts: no Authorization header -> HTTP 401 (app.ts, before this
// module runs); a non-JSON body -> HTTP 400 with a -32700 parse error; an unknown tool or a
// missing required argument -> a JSON-RPC error (-32602 / -32601), never HTTP 500; a tool-level
// failure (unknown repo) -> a result with isError: true.

import { VIEWER_LOGIN, type IssueRec, type RepoRec, type Store } from './store.ts';
import {
  HttpError,
  createIssue,
  createPullRequest,
  issueJson,
  mergePullRequest,
  prJson,
  repoJson,
} from './rest.ts';

export interface McpHttpResult {
  status: number;
  /** JSON body to serialize; undefined means an empty body (notifications). */
  json?: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new RpcError(-32602, `Missing or invalid required argument "${name}"`);
  return value;
}

function repoArg(store: Store, args: Record<string, unknown>): RepoRec {
  const owner = requireString(args, 'owner');
  const name = requireString(args, 'repo');
  if (owner.toLowerCase() !== VIEWER_LOGIN) throw new ToolFailure(`Repository ${owner}/${name} not found`);
  const repo = store.getRepo(owner, name);
  if (repo === null) throw new ToolFailure(`Repository ${owner}/${name} not found`);
  return repo;
}

function itemArg(repo: RepoRec, args: Record<string, unknown>, names: string[]): IssueRec {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) {
      const item = repo.items.get(value);
      if (item !== undefined) return item;
      throw new ToolFailure(`Item ${value} not found in ${repo.owner}/${repo.name}`);
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      const item = repo.items.get(Number(value));
      if (item !== undefined) return item;
      throw new ToolFailure(`Item ${value} not found in ${repo.owner}/${repo.name}`);
    }
  }
  throw new RpcError(-32602, `Missing or invalid required argument "${names[0]}"`);
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

class ToolFailure extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository to create' },
      description: { type: 'string', description: 'A short description of the repository' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
    run: (store, args) => {
      const name = requireString(args, 'name');
      if (store.getRepo(VIEWER_LOGIN, name) !== null) throw new ToolFailure(`Repository ${name} already exists`);
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof args['description'] === 'string' ? (args['description'] as string) : '',
        args['private'] === true,
      );
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository' },
      repo: { type: 'string', description: 'The name of the repository' },
    },
    required: ['owner', 'repo'],
    run: (store, args) => repoJson(repoArg(store, args)),
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    properties: {},
    required: [],
    run: (store) => store.viewerRepos().map(repoJson),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository' },
      repo: { type: 'string', description: 'The name of the repository' },
      title: { type: 'string', description: 'The title of the issue' },
      body: { type: 'string', description: 'The body of the issue' },
      labels: { type: 'array', description: 'Labels to apply to the issue' },
    },
    required: ['owner', 'repo', 'title'],
    run: (store, args) => {
      const repo = repoArg(store, args);
      const item = createIssue(store, repo, { title: args['title'], body: args['body'], labels: args['labels'] });
      return issueJson(repo, item);
    },
  },
  {
    name: 'get_issue',
    description: 'Get details of an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository' },
      repo: { type: 'string', description: 'The name of the repository' },
      issue_number: { type: 'number', description: 'The number of the issue' },
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (store, args) => {
      const repo = repoArg(store, args);
      return issueJson(repo, itemArg(repo, args, ['issue_number', 'number']));
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository' },
      repo: { type: 'string', description: 'The name of the repository' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all' },
    },
    required: ['owner', 'repo'],
    run: (store, args) => {
      const repo = repoArg(store, args);
      const state = typeof args['state'] === 'string' ? (args['state'] as string) : 'open';
      let items = [...repo.items.values()];
      if (state !== 'all') items = items.filter((item) => item.state === state);
      items.sort((a, b) => b.seq - a.seq);
      return items.map((item) => issueJson(repo, item));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository' },
      repo: { type: 'string', description: 'The name of the repository' },
      title: { type: 'string', description: 'The title of the pull request' },
      body: { type: 'string', description: 'The body of the pull request' },
      head: { type: 'string', description: 'The name of the branch to merge from' },
      base: { type: 'string', description: 'The name of the branch to merge into' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (store, args) => {
      const repo = repoArg(store, args);
      const item = createPullRequest(store, repo, { title: args['title'], body: args['body'], head: args['head'], base: args['base'] });
      return prJson(repo, item);
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get details of a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository' },
      repo: { type: 'string', description: 'The name of the repository' },
      pull_number: { type: 'number', description: 'The number of the pull request' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (store, args) => {
      const repo = repoArg(store, args);
      const item = itemArg(repo, args, ['pull_number', 'number']);
      if (item.kind !== 'pr') throw new ToolFailure(`Pull request not found in ${repo.owner}/${repo.name}`);
      return prJson(repo, item);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository' },
      repo: { type: 'string', description: 'The name of the repository' },
      pull_number: { type: 'number', description: 'The number of the pull request' },
      merge_method: { type: 'string', description: 'The merge method: merge, squash, or rebase' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (store, args) => {
      const repo = repoArg(store, args);
      const item = itemArg(repo, args, ['pull_number', 'number']);
      if (item.kind !== 'pr') throw new ToolFailure(`Pull request not found in ${repo.owner}/${repo.name}`);
      const method = typeof args['merge_method'] === 'string' ? (args['merge_method'] as string) : 'merge';
      const result = mergePullRequest(store, repo, item, method.toLowerCase());
      if (!result.ok) throw new ToolFailure(result.reason);
      return { sha: result.sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
];

/** The fixed tools/list payload: built once, so every call serializes byte-identically. */
const TOOLS_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    properties: tool.properties,
    required: tool.required,
  },
}));

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

function toolResult(value: unknown): Record<string, unknown> {
  const structured = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function dispatch(store: Store, method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'server/discover':
      return {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      };
    case 'initialize': {
      const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '2025-11-25';
      return {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS_LIST };
    case 'tools/call': {
      const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new RpcError(-32602, `Unknown tool: ${name}`);
      const args = typeof params['arguments'] === 'object' && params['arguments'] !== null ? (params['arguments'] as Record<string, unknown>) : {};
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === null) {
          throw new RpcError(-32602, `Missing required argument "${required}"`);
        }
      }
      try {
        return toolResult(tool.run(store, args));
      } catch (err) {
        if (err instanceof RpcError) throw err;
        if (err instanceof ToolFailure) return toolErrorResult(err.message);
        if (err instanceof HttpError) return toolErrorResult(err.message);
        throw err;
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp body. Auth has already been enforced by the caller.
 * A notification (no id) is answered 202 with no body; a batch array is answered per entry.
 */
export function handleMcp(store: Store, rawBody: Buffer): McpHttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => answerOne(store, entry)).filter((entry) => entry !== null);
    return { status: 200, json: responses };
  }
  const answer = answerOne(store, parsed);
  if (answer === null) return { status: 202 };
  return { status: 200, json: answer };
}

function answerOne(store: Store, entry: unknown): Record<string, unknown> | null {
  if (typeof entry !== 'object' || entry === null) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const record = entry as Record<string, unknown>;
  const method = typeof record['method'] === 'string' ? (record['method'] as string) : '';
  const hasId = 'id' in record && record['id'] !== undefined;
  const id = hasId ? record['id'] : null;
  const params = typeof record['params'] === 'object' && record['params'] !== null ? (record['params'] as Record<string, unknown>) : {};
  try {
    const result = dispatch(store, method, params);
    if (!hasId) return null;
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (!hasId) return null;
    if (err instanceof RpcError) return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } };
    return { jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
  }
}
