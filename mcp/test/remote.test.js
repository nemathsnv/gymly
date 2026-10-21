// Remote mode (src/remote.js): configuration, the request it makes, the answers it accepts, and
// that the token never comes back out — not in an error, not in a tool result. Against a stub of
// the Gymly route on 127.0.0.1 (stub-gymly.mjs); the real route has its own tests in api/.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { remoteConfig, createRemoteSource, withhold, WITHHELD } from '../src/remote.js'
import { _useRemoteForTests, _seedStateForTests, refresh, getState, getUser } from '../src/state.js'
import { TOOLS } from '../src/tools.js'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { startStub, fakeToken } from './stub-gymly.mjs'

const TOKEN = fakeToken('k')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gymly-mcp-remote-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
function tokenFile(content = TOKEN, mode = 0o600) {
  const f = path.join(tmp, 'tok-' + Math.random().toString(36).slice(2))
  fs.writeFileSync(f, content + '\n', { mode })
  fs.chmodSync(f, mode)
  return f
}
// Every error this module raises is checked for the token, whole and in part.
function expectNoToken(text) {
  expect(String(text)).not.toContain(TOKEN)
  expect(String(text)).not.toContain(TOKEN.slice('gymly_mcp_'.length))
}
async function rejects(promise, code) {
  let err = null
  try { await promise } catch (e) { err = e }
  expect(err, 'expected a rejection').not.toBeNull()
  expect(err.code).toBe(code)
  expectNoToken(err.message)
  return err
}
function throws(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  expect(err, 'expected a throw').not.toBeNull()
  expect(err.code).toBe(code)
  expectNoToken(err.message)
  return err
}

describe('remoteConfig', () => {
  test('no GYMLY_URL is local mode', () => {
    expect(remoteConfig({})).toBeNull()
    expect(remoteConfig({ GYMLY_URL: '  ', GYMLY_MCP_TOKEN: TOKEN })).toBeNull()
  })

  test('https anywhere, plain http only to this machine', () => {
    expect(remoteConfig({ GYMLY_URL: 'https://gymly.example.com/', GYMLY_MCP_TOKEN: TOKEN })).toEqual({ base: 'https://gymly.example.com', host: 'gymly.example.com', token: TOKEN, ttlMs: 15000 })
    expect(remoteConfig({ GYMLY_URL: 'https://example.com/gym//', GYMLY_MCP_TOKEN: TOKEN }).base).toBe('https://example.com/gym')
    for (const u of ['http://localhost:8080', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(remoteConfig({ GYMLY_URL: u, GYMLY_MCP_TOKEN: TOKEN }).token).toBe(TOKEN)
    }
    for (const u of ['http://gymly.example.com', 'http://192.168.1.10:8080', 'ftp://x', 'file:///etc/passwd', 'not a url', 'https://user:pw@gymly.example.com', 'https://gymly.example.com/?a=1', 'https://gymly.example.com/#x']) {
      throws(() => remoteConfig({ GYMLY_URL: u, GYMLY_MCP_TOKEN: TOKEN }), 'EINVAL')
    }
  })

  test('the token comes from a file only its owner can read, or the environment', () => {
    expect(remoteConfig({ GYMLY_URL: 'https://g.example', GYMLY_MCP_TOKEN_FILE: tokenFile() }).token).toBe(TOKEN)
    // The file wins over the environment.
    expect(remoteConfig({ GYMLY_URL: 'https://g.example', GYMLY_MCP_TOKEN_FILE: tokenFile(), GYMLY_MCP_TOKEN: fakeToken('z') }).token).toBe(TOKEN)
    if (process.platform !== 'win32') {
      const err = throws(() => remoteConfig({ GYMLY_URL: 'https://g.example', GYMLY_MCP_TOKEN_FILE: tokenFile(TOKEN, 0o644) }), 'EPERM')
      expect(err.message).toMatch(/chmod 600/)
      throws(() => remoteConfig({ GYMLY_URL: 'https://g.example', GYMLY_MCP_TOKEN_FILE: tokenFile(TOKEN, 0o640) }), 'EPERM')
    }
    throws(() => remoteConfig({ GYMLY_URL: 'https://g.example', GYMLY_MCP_TOKEN_FILE: path.join(tmp, 'missing') }), 'EINVAL')
    throws(() => remoteConfig({ GYMLY_URL: 'https://g.example', GYMLY_MCP_TOKEN_FILE: tmp }), 'EINVAL')
    throws(() => remoteConfig({ GYMLY_URL: 'https://g.example' }), 'EINVAL')
  })

  test('the cache window is configurable within bounds', () => {
    const cfg = v => remoteConfig({ GYMLY_URL: 'https://g.example', GYMLY_MCP_TOKEN: TOKEN, GYMLY_MCP_CACHE_SECONDS: v })
    expect(cfg('0').ttlMs).toBe(0)
    expect(cfg('300').ttlMs).toBe(300000)
    expect(cfg('').ttlMs).toBe(15000)
    for (const v of ['-1', '301', '1.5', 'abc']) throws(() => cfg(v), 'EINVAL')
  })

  test('something that is not an MCP token is refused without being repeated', () => {
    // A session token pasted by mistake, an API key of something else, a truncated copy.
    const wrong = ['u_1:1999999999999:0.abcdefghijklmnop', 'sk-ant-api03-SECRETSECRETSECRET', TOKEN.slice(0, -2), TOKEN + 'x', 'gymly_mcp_short']
    for (const t of wrong) {
      const err = throws(() => remoteConfig({ GYMLY_URL: 'https://g.example', GYMLY_MCP_TOKEN: t }), 'EINVAL')
      expect(err.message).not.toContain(t)
    }
  })
})

describe('createRemoteSource against a Gymly route', () => {
  let stub
  const STATE = { unit: 'kg', routines: [{ id: 'r1', name: 'Push' }], workouts: [], gymCards: [{ code: 'MEMBER-1234' }], coach: { x: 1 }, _prior: { y: 1 } }
  beforeAll(async () => { stub = await startStub({ token: TOKEN, state: STATE }) })
  afterAll(() => stub.close())
  beforeEach(() => { stub.seen.length = 0; stub.override = null; stub.rev = 1 })

  test('sends the token in the Authorization header, to the MCP route, and nowhere else', async () => {
    const src = createRemoteSource({ base: stub.url, token: TOKEN })
    await src.refresh()
    expect(stub.seen).toHaveLength(1)
    expect(stub.seen[0].url).toBe('/api/mcp/v1/state')
    expect(stub.seen[0].method).toBe('GET')
    expect(stub.seen[0].headers.authorization).toBe('Bearer ' + TOKEN)
    expect(src.user).toEqual(stub.user)
    expect(src.state.routines).toEqual(STATE.routines)
  })

  test('withholds membership cards, the Coach record and sync notes even if a server sends them', async () => {
    const src = createRemoteSource({ base: stub.url, token: TOKEN })
    await src.refresh()
    for (const k of WITHHELD) expect(src.state).not.toHaveProperty(k)
    expect(JSON.stringify(src.state)).not.toContain('MEMBER-1234')
    expect(withhold(null)).toBeNull()
    expect(withhold([1])).toBeNull()
  })

  test('caches for the TTL, then revalidates with the ETag and keeps the copy on a 304', async () => {
    let t = 1000
    const src = createRemoteSource({ base: stub.url, token: TOKEN, ttlMs: 5000, now: () => t })
    await src.refresh()
    await src.refresh()
    expect(stub.seen).toHaveLength(1)
    t += 5000
    await src.refresh()
    expect(stub.seen).toHaveLength(2)
    expect(stub.seen[1].headers['if-none-match']).toBe('"m1-1-"')
    expect(src.state.routines).toEqual(STATE.routines)
    // A change on the server is picked up at the next revalidation.
    stub.rev = 2
    stub.state = { ...STATE, routines: [{ id: 'r2', name: 'Pull' }] }
    t += 5000
    await src.refresh()
    expect(src.state.routines).toEqual([{ id: 'r2', name: 'Pull' }])
    stub.state = STATE
  })

  test('a refused token is an UNAUTHORIZED error, and the cached copy goes with it', async () => {
    let t = 0
    const src = createRemoteSource({ base: stub.url, token: TOKEN, ttlMs: 10, now: () => t })
    await src.refresh()
    expect(src.loaded).toBe(true)
    stub.override = (req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"x","code":"mcp-token-invalid"}') }
    t += 10
    const err = await rejects(src.refresh(), 'UNAUTHORIZED')
    expect(err.message).toMatch(/Settings → AI assistant access/)
    expect(src.loaded).toBe(false)
    expect(src.state).toBeUndefined()
    // A token the server never knew answers the same.
    const wrong = createRemoteSource({ base: stub.url, token: fakeToken('w') })
    stub.override = null
    await rejects(wrong.refresh(), 'UNAUTHORIZED')
  })

  test('every other failure is named without the token', async () => {
    const src = () => createRemoteSource({ base: stub.url, token: TOKEN })
    const answer = (status, body = '{}', headers = {}) => { stub.override = (req, res) => { res.writeHead(status, headers); res.end(body) } }
    answer(429, '{}', { 'Retry-After': '17' })
    expect((await rejects(src().refresh(), 'RATE_LIMITED')).message).toMatch(/17 seconds/)
    answer(404)
    await rejects(src().refresh(), 'UPSTREAM')
    answer(500)
    await rejects(src().refresh(), 'UPSTREAM')
    answer(503)
    await rejects(src().refresh(), 'UPSTREAM')
    answer(200, 'not json')
    await rejects(src().refresh(), 'UPSTREAM')
    answer(200, '{"state":{}}')
    await rejects(src().refresh(), 'UPSTREAM')
    answer(200, `{"user":{"id":5},"state":{}}`)
    await rejects(src().refresh(), 'UPSTREAM')
  })

  test('a redirect is not followed, so the token never reaches the place it points at', async () => {
    const elsewhere = []
    const other = http.createServer((req, res) => { elsewhere.push(req.headers); res.end('{}') })
    await new Promise(r => other.listen(0, '127.0.0.1', r))
    try {
      for (const status of [301, 302, 307, 308]) {
        stub.override = (req, res) => { res.writeHead(status, { Location: `http://127.0.0.1:${other.address().port}/steal` }); res.end() }
        await rejects(createRemoteSource({ base: stub.url, token: TOKEN }).refresh(), 'NETWORK')
      }
      expect(elsewhere).toHaveLength(0)
    } finally { other.close() }
  })

  test('nothing listening, or too slow, is a NETWORK error', async () => {
    const dead = http.createServer()
    await new Promise(r => dead.listen(0, '127.0.0.1', r))
    const port = dead.address().port
    await new Promise(r => dead.close(r))
    await rejects(createRemoteSource({ base: `http://127.0.0.1:${port}`, token: TOKEN }).refresh(), 'NETWORK')
    stub.override = () => { /* never answers */ }
    const err = await rejects(createRemoteSource({ base: stub.url, token: TOKEN, timeoutMs: 100 }).refresh(), 'NETWORK')
    expect(err.message).toMatch(/timed out/)
  })
})

describe('the tools in remote mode', () => {
  let stub
  const S = buildDemoState()
  S.unit = 'kg'
  S.gymCards = [{ id: 'c1', name: 'Gym', code: 'MEMBER-55555' }]
  S.lastGymCardId = 'c1'
  S.coach = { pending: { summary: 'COACH-ONLY-TEXT' } }
  const firstWorkout = S.workouts[0]
  const calls = [
    ['list_routines', {}], ['get_routine', { routine_id: S.routines[0].id }], ['get_week_plan', {}],
    ['list_workouts', {}], ['get_workout', { workout_id: firstWorkout.id }], ['get_bodyweight', {}],
    ['estimate_1rm', {}], ['muscle_balance', { period: 'all' }], ['preview_session', { routine_id: S.routines[0].id }]
  ]
  const run = (name, params) => TOOLS.find(t => t.name === name).handler(params)

  beforeAll(async () => { stub = await startStub({ token: TOKEN, state: JSON.parse(JSON.stringify(S)), user: { id: 'u_demo', name: 'Demo', created: null } }) })
  afterAll(() => { stub.close(); _seedStateForTests(null) })

  test('every tool answers exactly what it answers from the same profile on disk', async () => {
    expect(calls.map(c => c[0]).sort()).toEqual(TOOLS.map(t => t.name).sort())
    // Local mode first, on a copy with what the server withholds already gone, as it is remotely.
    _seedStateForTests(Object.assign(JSON.parse(JSON.stringify(withhold(S)))))
    const local = calls.map(([n, p]) => run(n, p))
    _useRemoteForTests(createRemoteSource({ base: stub.url, token: TOKEN }))
    expect(() => getState()).toThrow(/not been fetched/)
    await refresh()
    expect(getUser()).toEqual({ id: 'u_demo', name: 'Demo', created: null })
    const remote = calls.map(([n, p]) => run(n, p))
    expect(remote).toEqual(local)
  })

  test('no tool result carries a membership card, the Coach record or the token', async () => {
    _useRemoteForTests(createRemoteSource({ base: stub.url, token: TOKEN }))
    await refresh()
    for (const [n, p] of calls) {
      const text = JSON.stringify(run(n, p))
      expect(text, n).not.toContain('MEMBER-55555')
      expect(text, n).not.toContain('COACH-ONLY-TEXT')
      expectNoToken(text)
    }
  })

  test('a missing record is a coded error, not someone else\'s data', async () => {
    _useRemoteForTests(createRemoteSource({ base: stub.url, token: TOKEN }))
    await refresh()
    for (const [n, p] of [['get_routine', { routine_id: 'no-such-routine' }], ['get_workout', { workout_id: 'no-such-workout' }]]) {
      let err = null
      try { run(n, p) } catch (e) { err = e }
      expect(err?.code, n).toBe('ENOENT')
      expect(err.message, n).not.toContain(firstWorkout.id)
    }
  })
})
