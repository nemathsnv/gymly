/* POST /api/mcp — the Streamable HTTP transport (MCP 2025-11-25), stateless.
 *
 * Every request stands alone: the bearer token is resolved, a server is built for that caller
 * (tools.js), the SDK's web-standard transport answers the one JSON-RPC message in JSON (no SSE,
 * no session id), and the server is thrown away. Nothing about a connection lives in this process
 * between requests except the previews, which are bound to the grant.
 *
 * Order of checks, cheapest and least revealing first: an Origin that is not Gymly's own (DNS
 * rebinding from a browser page), then the token (401 with the RFC 9728 challenge that starts
 * an MCP client's OAuth flow), then the per-connection rate limit, and only then the body, read
 * up to MAX_MCP_BODY and parsed here so a batch or a malformed body is refused before the SDK. */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { buildServer } from './tools.js';
import { bearerChallenge } from './oauth.js';

export const MAX_MCP_BODY = 256 * 1024;
const BEARER_RE = /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)$/i;

function rpcError(res, status, code, message, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** Reads at most `max` bytes; null when the body is larger. */
export function readCapped(req, max) {
  const declared = req.headers['content-length'];
  if (declared != null && (!/^\d+$/.test(declared) || +declared > max)) {
    req.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', d => {
      if (over) return;
      size += d.length;
      if (size > max) { over = true; chunks.length = 0; resolve(null); return; }
      chunks.push(d);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', e => reject(Object.assign(e, { clientGone: true })));
  });
}

/**
 * `ctx`: origin (ORIGIN), allowedOrigins (Set), config ({ issuer, resource }), oauth (oauth.js
 * store), limit(grantId) → seconds to wait or 0, toolDeps (buildServer's deps), log(event).
 */
export async function handleMcpPost(req, res, ctx) {
  const origin = req.headers.origin;
  if (origin && !ctx.allowedOrigins.has(origin.replace(/\/+$/, ''))) return rpcError(res, 403, -32600, 'Origin not allowed');

  const m = BEARER_RE.exec(String(req.headers.authorization || '').trim());
  const resolved = m ? ctx.oauth.resolve(m[1]) : null;
  if (!resolved || resolved.error) {
    if (m) ctx.log('mcp.auth.fail', {});
    res.writeHead(401, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'WWW-Authenticate': m ? bearerChallenge(ctx.config, 'invalid_token', 'The access token is invalid, expired or revoked') : bearerChallenge(ctx.config)
    });
    return res.end(JSON.stringify({ error: m ? 'invalid_token' : 'unauthorized' }));
  }
  const actor = resolved;
  const wait = ctx.limit(actor.grant.id);
  if (wait) return rpcError(res, 429, -32000, 'Too many requests', { 'Retry-After': String(wait) });

  const raw = await readCapped(req, MAX_MCP_BODY);
  if (!raw) return rpcError(res, 413, -32600, 'Request body too large');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return rpcError(res, 400, -32700, 'Parse error'); }
  // Batching left MCP in 2025-06-18, and a batch would multiply every limit above.
  if (Array.isArray(body)) return rpcError(res, 400, -32600, 'Batch requests are not supported');
  if (!body || typeof body !== 'object') return rpcError(res, 400, -32600, 'Invalid Request');

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null || k === 'authorization' || k === 'cookie' || k === 'host' || k === 'content-length') continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  const request = new Request(ctx.config.resource, { method: 'POST', headers, body: raw });
  const server = buildServer(actor, ctx.toolDeps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      parsedBody: body,
      authInfo: { token: 'redacted', clientId: actor.grant.clientId, scopes: actor.scopes, extra: { grantId: actor.grant.id } }
    });
    const out = { 'Cache-Control': 'no-store' };
    response.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
    if (body.method === 'tools/call') ctx.log('mcp.tool', { user: actor.user, msg: `${actor.grant.clientName}: ${String(body.params?.name || '').slice(0, 64)}` });
  } finally {
    server.close().catch(() => {});
  }
}
