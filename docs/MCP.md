# Connect an AI assistant to your Gymly data (MCP)

Gymly ships an [MCP](https://modelcontextprotocol.io) server that lets an AI assistant —
Claude Code, Claude Desktop, Cursor, or any other MCP client — answer questions from your real
training data: "what did I bench last week?", "which muscles have I neglected this month?",
"what will Push Day ask of me tomorrow?".

**It is read-only.** The assistant can read your routines, workouts, body weight, estimated 1RMs,
muscle balance and week plan. It cannot change anything. Editing by natural language is planned
as a separate, opt-in step ([design notes](dev/MCP_WRITES.md)).

## How it works

```
your laptop                                   your Gymly server
┌───────────────────────────────┐   HTTPS    ┌──────────────────────────────┐
│ Claude Code ──stdio──▶ mcp/   │──────────▶ │ GET /api/mcp/v1/state        │
│        (spawns it)    server  │  Bearer    │   ↳ your profile, read-only  │
└───────────────────────────────┘  token     └──────────────────────────────┘
```

The MCP server runs on your computer, started by your AI client. It fetches **your** profile
from your Gymly server with a personal, read-only token. The numbers it answers with come from
the same code the app's Stats screen uses.

The token:

- opens one route (`GET /api/mcp/v1/state`) for one profile, yours. It cannot sync, sign in,
  change settings, or reach the admin dashboard, even on an admin's account;
- is stored on the server only as a hash, and shown to you once;
- expires after 90 days, and can be revoked at any time in Settings;
- stops working the moment you use **Sign out everywhere**, set a new password, or an admin
  disables or deletes the account;
- is never sent your gym membership cards, your AI Coach record, or your reminder settings.

## Set it up (Claude Code)

You need Node.js 22 or newer and a copy of this repository on the computer that runs Claude.

### 1. Install the MCP server

```bash
git clone https://github.com/nemathsnv/gymly.git ~/gymly
```

```bash
npm --prefix ~/gymly/mcp ci --omit=dev
```

### 2. Make a token in Gymly

Open Gymly in your browser, signed in, then go to **Settings → Account → AI assistant access**.
Give the token a name (e.g. "Claude Code, work laptop") and tap **Create token**, then
**Copy token**. It is shown only once.

### 3. Save it to a file only you can read

Paste it from the clipboard straight into a file. Don't put it in a command line, a chat, a
config file you commit, or a screenshot.

macOS:

```bash
mkdir -p ~/.config/gymly && (umask 077 && pbpaste > ~/.config/gymly/mcp-token)
```

Linux (Wayland: `wl-paste`; X11: `xclip -o -selection clipboard`):

```bash
mkdir -p ~/.config/gymly && (umask 077 && wl-paste > ~/.config/gymly/mcp-token)
```

The MCP server refuses to start from a token file that other users of the computer can read
(`chmod 600 ~/.config/gymly/mcp-token` fixes that).

### 4. Register the server with Claude Code

```bash
claude mcp add gymly --scope user -e GYMLY_URL=https://gymly.churntech.com -e GYMLY_MCP_TOKEN_FILE="$HOME/.config/gymly/mcp-token" -- node "$HOME/gymly/mcp/src/index.js"
```

Swap `GYMLY_URL` for your own instance's address if you self-host. `--scope user` keeps the entry
in your own Claude config (`~/.claude.json`), not in any project's `.mcp.json`. The config holds
only the *path* to the token, never the token.

Check it with `claude mcp list`, or `/mcp` inside a Claude Code session. Then ask:

> What did I train this week, and which muscles did I skip?

### Claude Desktop, Cursor and other clients

Same three values, in the client's MCP config. Claude Desktop
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "gymly": {
      "command": "node",
      "args": ["/Users/you/gymly/mcp/src/index.js"],
      "env": {
        "GYMLY_URL": "https://gymly.churntech.com",
        "GYMLY_MCP_TOKEN_FILE": "/Users/you/.config/gymly/mcp-token"
      }
    }
  }
}
```

If your client can't find `node`, give the full path from `which node` as `command`.

## Settings

| Variable | Meaning |
|---|---|
| `GYMLY_URL` | Your Gymly address. Must be `https://`; plain `http://` is accepted only for `localhost`. |
| `GYMLY_MCP_TOKEN_FILE` | Path to the token file (recommended). Must not be readable by other users. |
| `GYMLY_MCP_TOKEN` | The token itself, as an alternative to the file. Avoid it where you can: environment variables show up in more places than a 0600 file. |
| `GYMLY_MCP_CACHE_SECONDS` | How long one fetch answers tool calls before checking again (default 15, 0 to 300). Also the longest a revoked token can keep answering from what it already fetched. |

Without `GYMLY_URL`, the server runs in **local mode** and reads a Gymly `./data` folder on the
same machine instead (`OPENGYM_DATA`, `OPENGYM_UID`). See [mcp/README.md](../mcp/README.md).

## Keeping the token secret

- Never paste it into a chat with an assistant, an issue, or a commit. If you did, revoke it
  in Settings and make a new one; that takes ten seconds.
- The MCP server never prints the token. Its errors and its stderr log name the host and a
  reason ("the token was refused"), never the token.
- It sends the token only to `GYMLY_URL`, only over HTTPS, and never follows a redirect, so a
  misconfigured proxy cannot bounce it elsewhere. Don't set `NODE_TLS_REJECT_UNAUTHORIZED=0`;
  the server warns if you do.
- Settings shows each token's last four characters, when it was made, when it was last used,
  and when it expires. A token you don't recognise: revoke it.
- Server admins see `auth.mcp.create`, `auth.mcp.revoke` and refused tokens (`auth.mcp.fail`)
  in the activity log, with the token's name and never its value.

## Troubleshooting

| What you see | What to do |
|---|---|
| `UNAUTHORIZED: Gymly refused the MCP token` | It expired, was revoked, or you signed out everywhere. Make a new one, overwrite the file. |
| `EPERM: … can be read by other users` | `chmod 600 ~/.config/gymly/mcp-token` |
| `EINVAL: the configured token is not a Gymly MCP token` | The file holds something else (a stray newline is fine). Copy the token again. |
| `EINVAL: GYMLY_URL must be https://` | Use the `https://` address. |
| `UPSTREAM: this Gymly server has no MCP access route` | The server is older than this feature, or `GYMLY_URL` points somewhere else. |
| `RATE_LIMITED` | More than 120 requests a minute from your address. Wait, or raise `GYMLY_MCP_CACHE_SECONDS`. |

The full HTTP contract is in [`api/openapi.yaml`](../api/openapi.yaml), under the `mcp` tag.
