#!/usr/bin/env node
/* openGym MCP server — stdio transport. The LLM client (Claude Code, Claude Desktop, Cursor, …)
   spawns this process locally, talks JSON-RPC over stdin/stdout, tears it down when the session
   ends. No extra container. Local mode reads a ./data folder on this machine and makes no network
   call; remote mode (GYMLY_URL) reads one profile from a Gymly server with a read-only token. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'
import { init, getUser, refresh, isRemote, remoteHost } from './state.js'

const server = new McpServer({
  name: 'opengym',
  version: '0.1.0'
})

// Fail fast on bad config so a misnamed OPENGYM_DATA doesn't silently answer every call with
// the no-state sentinel. Always register every tool so the LLM sees the full list at
// handshake, even when state didn't resolve.
// In remote mode the first fetch is tried here too, so a wrong URL or a revoked token is on stderr
// at startup; the token itself never is (remote.js builds every message without it).
try {
  init()
  if (isRemote()) {
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      console.error('[opengym-mcp] warning: NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks — the token can be read by anyone in the middle')
    }
    await refresh()
  }
  const u = getUser()
  console.error(`[opengym-mcp] serving profile ${u.name} (${u.id})${isRemote() ? ' from ' + remoteHost() + ' (read-only token)' : ''}`)
} catch (e) {
  console.error(`[opengym-mcp] ${e.code ? e.code + ': ' : ''}${e.message}`)
  // Don't exit — keep the tool listings up so the user sees a useful error after fixing their
  // env and restarting.
}

for (const t of TOOLS) {
  server.tool(
    t.name,
    t.description,
    t.schema,
    async (params) => {
      try {
        await refresh()
        const result = t.handler(params || {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const code = err.code || 'ERROR'
        return {
          isError: true,
          content: [{ type: 'text', text: `${code}: ${err.message}` }]
        }
      }
    }
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
