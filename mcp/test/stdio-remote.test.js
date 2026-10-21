// The MCP server as an LLM client sees it: spawned over stdio, spoken to with the SDK's own client,
// in remote mode. First against the stub route, then — when api/ has its dependencies installed —
// against the real api/server.js, with a token made through its real route and revoked through it.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { startStub, fakeToken } from './stub-gymly.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(HERE, '..', 'src', 'index.js')
const API = path.join(HERE, '..', '..', 'api')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gymly-mcp-stdio-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function writeTokenFile(token) {
  const f = path.join(tmp, 'token-' + crypto.randomBytes(4).toString('hex'))
  fs.writeFileSync(f, token, { mode: 0o600 })
  return f
}

// → { client, stderr() }. Only the variables named here reach the child (plus the SDK's own
// short list: PATH, HOME …), the way an LLM client's config passes them.
async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: { TZ: process.env.TZ || 'UTC', ...env }, stderr: 'pipe' })
  let err = ''
  transport.stderr.on('data', d => { err += d })
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(transport)
  return { client, stderr: () => err, close: () => client.close() }
}
const textOf = r => r.content.map(c => c.text).join('\n')
const parsed = r => JSON.parse(textOf(r))

describe('stdio, remote mode, against the stub route', () => {
  const TOKEN = fakeToken('s')
  let stub, mcp
  const S = buildDemoState()
  S.gymCards = [{ id: 'c', code: 'MEMBER-777' }]
  beforeAll(async () => {
    stub = await startStub({ token: TOKEN, state: S, user: { id: 'u_demo', name: 'Demo', created: null } })
    mcp = await connect({ GYMLY_URL: stub.url, GYMLY_MCP_TOKEN_FILE: writeTokenFile(TOKEN), GYMLY_MCP_CACHE_SECONDS: '0' })
  })
  afterAll(async () => { await mcp?.close(); await stub?.close() })

  test('lists the nine read-only tools and answers from the profile', async () => {
    const { tools } = await mcp.client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['estimate_1rm', 'get_bodyweight', 'get_routine', 'get_week_plan', 'get_workout', 'list_routines', 'list_workouts', 'muscle_balance', 'preview_session'])
    const r = await mcp.client.callTool({ name: 'list_routines', arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(parsed(r).routines.map(x => x.id)).toEqual(S.routines.map(x => x.id))
    expect(mcp.stderr()).toMatch(/serving profile Demo \(u_demo\) from 127\.0\.0\.1:\d+ \(read-only token\)/)
  })

  test('invalid parameters are refused before any tool code runs', async () => {
    const before = stub.seen.length
    for (const [name, args] of [['muscle_balance', { period: 'year' }], ['list_workouts', { from: '2026-02-30' }], ['list_workouts', { limit: 0 }], ['get_routine', { routine_id: '' }], ['estimate_1rm', { formula: 'magic' }]]) {
      let r, threw = null
      try { r = await mcp.client.callTool({ name, arguments: args }) } catch (e) { threw = e }
      // The SDK reports a schema failure either as a JSON-RPC error or as an isError result.
      expect(threw || r?.isError, `${name} ${JSON.stringify(args)}`).toBeTruthy()
    }
    expect(stub.seen.length).toBe(before)
  })

  test('a missing record answers ENOENT', async () => {
    const r = await mcp.client.callTool({ name: 'get_workout', arguments: { workout_id: 'nope' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/^ENOENT: /)
  })

  test('a revoked token turns every call into UNAUTHORIZED, and the token is never printed', async () => {
    stub.override = (req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"code":"mcp-token-invalid"}') }
    const r = await mcp.client.callTool({ name: 'list_workouts', arguments: {} })
    stub.override = null
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/^UNAUTHORIZED: /)
    for (const text of [textOf(r), mcp.stderr()]) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(TOKEN.slice(10))
      expect(text).not.toContain('MEMBER-777')
    }
  })

  test('a bad configuration is reported at startup and by every tool, without the token', async () => {
    const leaky = 'sk-live-THIS-IS-NOT-A-GYMLY-TOKEN'
    const bad = await connect({ GYMLY_URL: stub.url, GYMLY_MCP_TOKEN: leaky })
    try {
      const r = await bad.client.callTool({ name: 'list_routines', arguments: {} })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/not a Gymly MCP token/)
      expect(textOf(r) + bad.stderr()).not.toContain(leaky)
      expect(bad.stderr()).toMatch(/EINVAL: the configured token is not a Gymly MCP token/)
    } finally { await bad.close() }
    const insecure = await connect({ GYMLY_URL: 'http://gymly.example.com', GYMLY_MCP_TOKEN: TOKEN })
    try {
      const r = await insecure.client.callTool({ name: 'list_routines', arguments: {} })
      expect(textOf(r)).toMatch(/must be https/)
      expect(textOf(r) + insecure.stderr()).not.toContain(TOKEN)
    } finally { await insecure.close() }
  })
})

/* ---------- against the real api/server.js ---------- */

const apiReady = fs.existsSync(path.join(API, 'node_modules', '@simplewebauthn'))
const SECRET = crypto.randomBytes(32).toString('hex')
const session = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`
  return 'gymsid=' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}

describe.skipIf(!apiReady)('stdio, remote mode, against the real Gymly API', () => {
  let api, child, dataDir
  const S = buildDemoState()
  S.unit = 'kg'
  S.gymCards = [{ id: 'c', code: 'MEMBER-REAL-API' }]
  const OTHER = { unit: 'lb', routines: [{ id: 'r-other', name: 'OTHER-PROFILE-ROUTINE', ex: [] }], workouts: [] }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymly-mcp-e2e-'))
    fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 })
    const now = new Date().toISOString()
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'u_me', name: 'Me', created: now }, { id: 'u_other', name: 'Other', created: now }], creds: [], subs: [], invites: [] }))
    fs.writeFileSync(path.join(dataDir, 'state-u_me.json'), JSON.stringify(S))
    fs.writeFileSync(path.join(dataDir, 'state-u_other.json'), JSON.stringify(OTHER))
    child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } })
    let log = ''
    const port = await new Promise((resolve, reject) => {
      const give = setTimeout(() => reject(new Error('api never started:\n' + log)), 20000)
      child.stdout.on('data', d => { log += d; const m = /gym-api on :(\d+)/.exec(log); if (m) { clearTimeout(give); resolve(+m[1]) } })
      child.stderr.on('data', d => { log += d })
      child.once('exit', c => { clearTimeout(give); reject(new Error(`api exited ${c}:\n${log}`)) })
    })
    api = `http://127.0.0.1:${port}`
  }, 30000)
  afterAll(() => { child?.kill('SIGKILL'); if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }) })

  test('a token made in Settings reads that profile through MCP until it is revoked', async () => {
    const made = await (await fetch(api + '/api/account/mcp-tokens', { method: 'POST', headers: { Cookie: session('u_me'), 'Content-Type': 'application/json' }, body: '{"name":"Claude Code"}' })).json()
    expect(made.token).toMatch(/^gymly_mcp_/)
    const mcp = await connect({ GYMLY_URL: api, GYMLY_MCP_TOKEN_FILE: writeTokenFile(made.token), GYMLY_MCP_CACHE_SECONDS: '0' })
    try {
      expect(mcp.stderr()).toMatch(/serving profile Me \(u_me\)/)
      const routines = parsed(await mcp.client.callTool({ name: 'list_routines', arguments: {} }))
      expect(routines.routines.map(r => r.id)).toEqual(S.routines.map(r => r.id))
      const workouts = parsed(await mcp.client.callTool({ name: 'list_workouts', arguments: { limit: 200 } }))
      expect(workouts.workouts.length).toBe(S.workouts.length)
      const one = parsed(await mcp.client.callTool({ name: 'get_workout', arguments: { workout_id: S.workouts[0].id } }))
      expect(one.id).toBe(S.workouts[0].id)
      expect(one.date).toBe(S.workouts[0].d)
      expect(one.entries.length).toBe(S.workouts[0].entries.length)
      for (const r of [routines, workouts, one]) {
        const text = JSON.stringify(r)
        expect(text).not.toContain('OTHER-PROFILE-ROUTINE')
        expect(text).not.toContain('MEMBER-REAL-API')
      }

      const del = await fetch(api + '/api/account/mcp-tokens?id=' + made.id, { method: 'DELETE', headers: { Cookie: session('u_me') } })
      expect(del.status).toBe(200)
      const after = await mcp.client.callTool({ name: 'list_routines', arguments: {} })
      expect(after.isError).toBe(true)
      expect(textOf(after)).toMatch(/^UNAUTHORIZED: /)
      expect(mcp.stderr() + textOf(after)).not.toContain(made.token)
    } finally { await mcp.close() }
  }, 30000)
})
