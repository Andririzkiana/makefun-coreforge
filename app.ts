// The forge's HTTP server: one process serving git smart HTTP, the REST v3 API, GraphQL v4 and
// the MCP endpoint from one in-memory store (store.ts). main.ts owns the env lifecycle; this file
// owns routing and auth.
//
// Auth model: MAKEFUN_SHOP_TOKEN is the viewer's bearer token. Every surface except /healthz and
// the REST API root requires it; a missing or wrong token is a 401, and a repository under any
// other owner is a 404 (never a 403), matching the suite's expectations.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { handleRest, type ApiResult } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, headers);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(store, req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is gone; nothing more to do.
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  return server;
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  // The env's boot check calls this twice: 200 {"ok":true}. No auth: the env sends no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    if (!authed(req)) {
      sendBuffer(res, 401, Buffer.from('Unauthorized\n', 'utf8'), 'text/plain; charset=utf-8');
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const repo = store.getRepo(owner, name);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const kind = gitMatch[3] as string;
    if (kind === 'info/refs' && method === 'GET') {
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && protocol.includes('version=2');
      const result = infoRefs(repo, url.searchParams.get('service') ?? '', v2);
      sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    if (kind === 'git-upload-pack' && method === 'POST') {
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && protocol.includes('version=2');
      const body = await readBody(req);
      const result = uploadPack(repo, body, v2);
      sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    if (kind === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const result = receivePack(repo, body);
      sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
      return;
    }
    sendJson(res, 200, executeGraphQL(store, parsed));
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const body = await readBody(req);
    const result = handleMcp(store, body);
    if (result.json === undefined) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    sendJson(res, result.status, result.json);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const isRoot = path === '/api/v3' || path === '/api/v3/';
    if (!isRoot && !authed(req)) {
      sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': nextRequestId() });
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const result: ApiResult = handleRest(store, method, path, url.searchParams, body, req.headers.host ?? 'entry');
    const headers: Record<string, string> = { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) };
    if (result.status === 204) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (result.raw !== undefined) {
      sendBuffer(res, result.status, Buffer.from(result.raw, 'utf8'), JSON_TYPE, headers);
      return;
    }
    sendJson(res, result.status, result.json ?? {}, headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter}`;
}
