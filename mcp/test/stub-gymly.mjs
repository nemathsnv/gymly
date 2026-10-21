// A stand-in for a Gymly server's MCP route (GET /api/mcp/v1/state), on 127.0.0.1, recording
// every request it gets. The real route is tested against the real server in
// api/test/server-mcp.test.js; this one lets the client's side be tested without the api's
// dependencies installed.
import http from 'node:http'

export async function startStub({ token, user = { id: 'u_me', name: 'Me', created: '2026-01-01T00:00:00.000Z' }, state = {} } = {}) {
  const stub = {
    seen: [], status: null, rev: 1, user, state,
    // Set to a function (req, res) to answer one way for the rest of the test.
    override: null
  }
  const server = http.createServer((req, res) => {
    stub.seen.push({ method: req.method, url: req.url, headers: { ...req.headers } })
    if (stub.override) return stub.override(req, res)
    if (req.url !== '/api/mcp/v1/state' || req.method !== 'GET') { res.writeHead(404); return res.end('{}') }
    if (req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="gymly-mcp"' })
      return res.end(JSON.stringify({ error: 'the MCP token is missing, wrong, expired or revoked', code: 'mcp-token-invalid' }))
    }
    const etag = `"m1-${stub.rev}-"`
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end() }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ user: stub.user, scope: 'read', rev: stub.rev, state: stub.state }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  stub.url = `http://127.0.0.1:${server.address().port}`
  stub.close = () => new Promise(r => { server.closeAllConnections?.(); server.close(r) })
  return stub
}

export const fakeToken = (fill = 'A') => 'gymly_mcp_' + fill.repeat(43)
