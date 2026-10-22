#!/usr/bin/env node
/* End-to-end check of a Gymly hosted MCP endpoint with the official MCP TypeScript SDK client:
 * OAuth discovery, dynamic registration, PKCE authorization, initialize, tool discovery, reads,
 * and — with --write, on a scratch profile — preview, apply, read-back, undo, a logged workout and
 * its undo, then refresh rotation and revocation.
 *
 *   node mcp/scripts/hosted-smoke.mjs --url https://gymly.example/api/mcp [--write]
 *
 * The consent step is a real browser: the script prints the authorization URL, you sign in and
 * select Allow, and Gymly redirects to the script's loopback listener. For an automated run
 * against a test instance, --consent-cookie 'gymsid=…' answers the consent screen over HTTP with
 * that session instead (never use a real person's session for this).
 *
 * Prints no token. Exits non-zero on the first failed check. */
import http from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const URL_ = arg('--url')
const WRITE = process.argv.includes('--write')
const COOKIE = arg('--consent-cookie')
if (!URL_) { console.error('usage: hosted-smoke.mjs --url https://host/api/mcp [--write] [--consent-cookie gymsid=…]'); process.exit(2) }
const endpoint = new URL(URL_)

let failures = 0
const ok = (cond, what, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; return cond }

/* ---------- discovery, before any client library ---------- */
const unauth = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' })
const challenge = unauth.headers.get('www-authenticate') || ''
ok(unauth.status === 401 && /resource_metadata="/.test(challenge), 'unauthenticated POST is a 401 with an RFC 9728 challenge', challenge)
const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
const prm = prmUrl ? await (await fetch(prmUrl)).json() : {}
ok(prm.resource === endpoint.href.replace(/\/$/, ''), 'protected resource metadata names this endpoint', prm.resource)
const issuer = prm.authorization_servers?.[0]
const asm = issuer ? await (await fetch(new URL('/.well-known/oauth-authorization-server', issuer))).json() : {}
ok(asm.issuer === issuer && asm.code_challenge_methods_supported?.includes('S256'), 'authorization server metadata (issuer, S256)')
ok(asm.client_id_metadata_document_supported === true && asm.authorization_response_iss_parameter_supported === true, 'CIMD and RFC 9207 iss advertised (ChatGPT requirements)')

/* ---------- OAuth with the SDK ---------- */
const listener = http.createServer()
await new Promise(r => listener.listen(0, '127.0.0.1', r))
const redirectUri = `http://127.0.0.1:${listener.address().port}/callback`
let codeWaiter
const codeArrived = new Promise(r => { codeWaiter = r })
listener.on('request', (req, res) => {
  const u = new URL(req.url, redirectUri)
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end(u.searchParams.get('code') ? 'Gymly connected — you can close this tab.' : 'Not connected: ' + (u.searchParams.get('error') || '?'))
  codeWaiter(u)
})

const store = {}
const provider = {
  get redirectUrl() { return redirectUri },
  get clientMetadata() { return { client_name: 'Gymly hosted smoke test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'gymly:read gymly:write' } },
  clientInformation: () => store.client,
  saveClientInformation: c => { store.client = c },
  tokens: () => store.tokens,
  saveTokens: t => { store.tokens = t },
  saveCodeVerifier: v => { store.verifier = v },
  codeVerifier: () => store.verifier,
  redirectToAuthorization: async url => {
    store.authUrl = url
    if (!COOKIE) { console.log('\nOpen this URL, sign in to Gymly and select Allow:\n\n  ' + url.href + '\n'); return }
    const page = await fetch(url, { headers: { Cookie: COOKIE }, redirect: 'manual' })
    const html = await page.text()
    const id = /name="request_id" value="([^"]+)"/.exec(html)?.[1]
    if (!id) { console.error('no consent screen:', page.status, html.slice(0, 300)); process.exit(1) }
    const answer = await fetch(new URL('/api/oauth/authorize', url), {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: COOKIE, 'Content-Type': 'application/x-www-form-urlencoded', Origin: url.origin, 'Sec-Fetch-Site': 'same-origin' },
      body: new URLSearchParams({ request_id: id, decision: 'allow', allow_write: '1' })
    })
    await fetch(answer.headers.get('location'))
  }
}

const connect = async () => {
  const client = new Client({ name: 'gymly-hosted-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }))
  return client
}
let client
try { client = await connect() } catch (e) {
  if (!(e instanceof UnauthorizedError)) throw e
  const back = await codeArrived
  ok(back.searchParams.get('iss') === issuer, 'authorization response carries iss = issuer')
  const t = new StreamableHTTPClientTransport(endpoint, { authProvider: provider })
  await t.finishAuth(back.searchParams.get('code'))
  client = await connect()
}
listener.close()
ok(!!store.tokens?.access_token && /gymly:write|gymly:read/.test(store.tokens.scope || ''), 'tokens issued', `scope "${store.tokens?.scope}", expires_in ${store.tokens?.expires_in}`)
ok(client.getServerVersion()?.name === 'gymly', 'initialize: server is gymly', JSON.stringify(client.getServerVersion()))

const { tools } = await client.listTools()
const names = tools.map(t => t.name)
for (const n of ['list_routines', 'get_routine', 'list_workouts', 'get_workout', 'get_training_progress', 'preview_routine_changes', 'apply_routine_changes', 'create_routine', 'log_workout', 'undo_change']) ok(names.includes(n), `tool ${n} listed`)
ok(tools.every(t => typeof t.annotations?.readOnlyHint === 'boolean'), 'every tool annotated')

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  if (r.isError) console.log(`      ${name} → ${r.content?.[0]?.text?.slice(0, 300)}`)
  return r
}
const routines = await call('list_routines')
ok(!routines.isError, 'list_routines', `${routines.structuredContent?.routines?.length} routine(s)`)
const week = await call('get_week_plan')
ok(!week.isError, 'get_week_plan', `today ${week.structuredContent?.today}`)
const workouts = await call('list_workouts', { limit: 3 })
ok(!workouts.isError, 'list_workouts', `${workouts.structuredContent?.total_count} workout(s)`)
const progress = await call('get_training_progress', { weeks: 8 })
ok(!progress.isError, 'get_training_progress', `${progress.structuredContent?.totals?.sessions} session(s) in 8 weeks`)

if (WRITE) {
  const r0 = routines.structuredContent.routines[0]
  if (!ok(!!r0, 'scratch profile has a routine to edit')) process.exit(1)
  const detail = (await call('get_routine', { routine_id: r0.id })).structuredContent
  const ex = detail.exercises?.[0] || detail.ex?.[0]
  const exId = ex?.id
  const sets0 = ex?.target?.sets ?? ex?.sets
  const newSets = sets0 === 4 ? 5 : 4
  const pv = await call('preview_routine_changes', { operations: [{ op: 'update_exercise', routine_id: r0.id, exercise_id: exId, sets: newSets }] })
  ok(!pv.isError && pv.structuredContent?.tier === 'ordinary', 'preview (ordinary)', pv.structuredContent?.will_change?.join(' | '))
  const ap = await call('apply_routine_changes', { preview_id: pv.structuredContent.preview_id })
  ok(!ap.isError && ap.structuredContent?.applied, 'apply', `rev ${ap.structuredContent?.rev}`)
  const again = await call('apply_routine_changes', { preview_id: pv.structuredContent.preview_id })
  ok(again.structuredContent?.replayed === true, 'apply is idempotent')
  const after = (await call('get_routine', { routine_id: r0.id })).structuredContent
  const ex1 = after.exercises?.[0] || after.ex?.[0]
  ok((ex1?.target?.sets ?? ex1?.sets) === newSets, 'read-back shows the change')
  const un = await call('undo_change', { change_id: ap.structuredContent.change_id })
  ok(!un.isError, 'undo')
  const back = (await call('get_routine', { routine_id: r0.id })).structuredContent
  const ex2 = back.exercises?.[0] || back.ex?.[0]
  ok((ex2?.target?.sets ?? ex2?.sets) === sets0, 'read-back shows the undo')
  const today = week.structuredContent.today
  const wl = await call('preview_workout_log', { date: today, start_time: '00:01', duration_min: 1, name: 'MCP smoke test', exercises: [{ exercise_id: exId, sets: [{ reps: 1, weight: 1 }] }] })
  ok(!wl.isError, 'preview_workout_log')
  const lw = await call('log_workout', { preview_id: wl.structuredContent.preview_id })
  ok(!lw.isError && lw.structuredContent?.logged, 'log_workout')
  const ul = await call('undo_change', { change_id: lw.structuredContent.change_id })
  ok(!ul.isError, 'undo of the logged workout')
}

/* ---------- refresh rotation and revocation, raw ---------- */
const form = f => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) })
const tokenUrl = asm.token_endpoint
const rt = store.tokens.refresh_token
const refreshed = await fetch(tokenUrl, form({ grant_type: 'refresh_token', refresh_token: rt, client_id: store.client.client_id, resource: prm.resource }))
const nt = await refreshed.json()
ok(refreshed.status === 200 && nt.refresh_token && nt.refresh_token !== rt, 'refresh rotates the refresh token')
const replay = await fetch(tokenUrl, form({ grant_type: 'refresh_token', refresh_token: rt, client_id: store.client.client_id }))
ok(replay.status === 400, 'a spent refresh token is refused')
const revoke = await fetch(asm.revocation_endpoint, form({ token: nt.refresh_token, client_id: store.client.client_id }))
ok(revoke.status === 200, 'revocation accepted')
const dead = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + nt.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":9,"method":"tools/list"}' })
ok(dead.status === 401, 'revoked connection is refused at once')

await client.close().catch(() => {})
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
