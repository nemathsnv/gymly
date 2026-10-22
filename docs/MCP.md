# Connect an AI assistant to your Gymly data (MCP)

Gymly speaks [MCP](https://modelcontextprotocol.io), so an AI assistant — ChatGPT, Claude,
Claude Code, Cursor or any other MCP client — can answer from your real training data ("what did
I bench last week?") and, if you allow it, change your plan for you ("make Monday's bench press
4 × 8 at 60 kg").

There are two ways in:

| | Hosted (recommended) | Local bridge (V1) |
|---|---|---|
| Address | `https://<your Gymly>/api/mcp` | a process on your computer (`mcp/`) |
| Sign-in | OAuth: you approve the assistant on Gymly's own page | a read-only token you paste into a file |
| Can change things | yes, if you allow it: every change is previewed in the chat, then applied, and can be undone | no |
| Works without your computer on | yes | no |
| Clients | ChatGPT, Claude (web, desktop, mobile), Claude Code, any MCP client with OAuth | Claude Code, Claude Desktop, Cursor… |

## Hosted MCP

### What the assistant can do

Read (`gymly:read`): your routines and week plan, workouts, body weight, estimated 1RMs and
training progress, muscle balance, what a session will ask of you, and exercise search.

Change (`gymly:write`, only if you leave "Change your routines and log workouts" ticked when you
connect):

- edit an exercise in a routine — sets, reps, rep range, weight, hold time, cardio target,
  increment, progression;
- add, replace, reorder, superset or remove exercises; create, rename or remove routines; set
  what each weekday trains — "create a four-day routine", "replace leg press with hack squat";
- log a workout you did without the app;
- undo any of those.

Every change works the same way: the assistant **previews** it (nothing is saved), shows you the
exact before → after, and only applies it when you agree. Removing exercises or routines, or
changing many things at once, needs an extra, explicit confirmation. Changes are checked by the
same validation as the AI Coach's, reach your phone on its next sync like an edit on another
device, and can be undone (`undo_change`). A change computed against a plan you have since
edited elsewhere is refused, not forced. Routines are templates: changing "tomorrow's bench press"
changes that routine from tomorrow on, and the assistant says so.

It cannot see or change your passkeys, password, gym cards, AI Coach settings or account, and
cannot delete logged workouts (other than one it logged itself, by undo).

### Connect ChatGPT

Custom MCP servers are a ChatGPT feature that OpenAI makes available by plan and workspace
policy (not on Free; on Business/Enterprise an admin may have to allow it). If you do not see
the option below, that is a ChatGPT account restriction, not a Gymly problem. As of October 2026:

1. Open [chatgpt.com/plugins](https://chatgpt.com/plugins) on the web, select **+**, then
   **Add custom MCP server**.
2. Name: `Gymly`. Description: `My gym routines and workouts`.
3. Connection: **Public endpoint**, URL `https://gymly.churntech.com/api/mcp` (your own Gymly
   address followed by `/api/mcp`).
4. Authentication: **OAuth**. Leave client registration automatic: ChatGPT identifies itself
   with its client metadata document, and Gymly needs no client id or secret from you.
5. Read the risk notice and confirm, then **Create**.
6. ChatGPT opens Gymly's sign-in page. Sign in with your passkey, check the consent screen (it
   names ChatGPT and where it sends you back), and select **Allow**.
7. In a chat, pick Gymly from the plugins (or @-mention it) and ask, for example: "What's on my
   plan this week?" ChatGPT asks you to confirm each write before it runs it.

### Connect Claude (claude.ai, Desktop, mobile)

Settings → **Connectors** → **Add custom connector** → URL `https://gymly.churntech.com/api/mcp`
→ **Add**, then **Connect** and approve on Gymly's page. Connectors added on claude.ai are also
available in the Claude desktop and mobile apps.

### Connect Claude Code

```bash
claude mcp add --transport http gymly https://gymly.churntech.com/api/mcp
```

Then `/mcp` in a Claude Code session → **gymly** → **Authenticate**: your browser opens Gymly's
consent page.

### Who can connect, and how to disconnect

Connecting is off on a Gymly server unless its operator lists the profiles allowed to connect
assistants (`MCP_OAUTH_USERS`, see [SELF_HOSTING.md](SELF_HOSTING.md)). Anyone else gets "not
available for this profile".

**Settings → Account → AI assistant access** lists the connected assistants, shows the address
to give one, and disconnects one immediately. **Sign out everywhere**, a new password, or an
admin disabling the account disconnects all of them. A connection otherwise lasts until it has
not been used for 30 days, and at most 180 days; then you approve it again.

### How it is secured

- OAuth 2.1 authorization code flow with PKCE (S256 only), resource indicators (tokens are bound
  to `/api/mcp` and accepted nowhere else), issuer identification (`iss`) on every answer.
- You sign in with your passkey on Gymly's own page; the assistant never sees a password or a
  session. The consent screen names the client (marked unverified unless it comes from a known
  host), shows where the answer goes, and cannot be framed.
- Access tokens last an hour; refresh tokens rotate on every use, and a stolen one used again
  ends the whole connection. Tokens are random, stored only as hashes, and never logged.
- Every tool checks the scope it needs and acts on your profile only; no tool takes a profile or
  user id. Writes go through the AI Coach's validator, a preview id bound to the connection, a
  stale-plan check, idempotent apply, an undo journal and the normal sync path.
- The server's activity log records connections, disconnections, refused tokens and each write
  (with a count, never content).

Discovery for clients: `/.well-known/oauth-protected-resource/api/mcp` and
`/.well-known/oauth-authorization-server`. The full HTTP contract is in
[`api/openapi.yaml`](../api/openapi.yaml), tag `mcp`.

### Troubleshooting

| What you see | What to do |
|---|---|
| "Not available for this profile" | Your profile id is not in the server's `MCP_OAUTH_USERS`. |
| The assistant says a change is "stale" | The plan changed since its preview (you edited it on a device). Ask it to preview again. |
| "insufficient_scope" | You connected read-only. Disconnect it in Settings and connect again with changes allowed. |
| The connection stopped working | It was disconnected, or you signed out everywhere. Connect again. |
| ChatGPT has no "Add custom MCP server" | Your ChatGPT plan or workspace does not allow custom MCP servers. |
| Cloudflare challenges the assistant | Skip bot checks for `/api/mcp`, `/api/oauth/*` and `/.well-known/oauth-*` (the consent page itself is a normal browser page). |

## Local bridge (V1): read-only, runs on your computer

### How it works

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

### Set it up (Claude Code)

You need Node.js 22 or newer and a copy of this repository on the computer that runs Claude.

#### 1. Install the MCP server

```bash
git clone https://github.com/nemathsnv/gymly.git ~/gymly
```

```bash
npm --prefix ~/gymly/mcp ci --omit=dev
```

#### 2. Make a token in Gymly

Open Gymly in your browser, signed in, then go to **Settings → Account → AI assistant access**.
Give the token a name (e.g. "Claude Code, work laptop") and tap **Create token**, then
**Copy token**. It is shown only once.

#### 3. Save it to a file only you can read

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

#### 4. Register the server with Claude Code

```bash
claude mcp add gymly --scope user -e GYMLY_URL=https://gymly.churntech.com -e GYMLY_MCP_TOKEN_FILE="$HOME/.config/gymly/mcp-token" -- node "$HOME/gymly/mcp/src/index.js"
```

Swap `GYMLY_URL` for your own instance's address if you self-host. `--scope user` keeps the entry
in your own Claude config (`~/.claude.json`), not in any project's `.mcp.json`. The config holds
only the *path* to the token, never the token.

Check it with `claude mcp list`, or `/mcp` inside a Claude Code session. Then ask:

> What did I train this week, and which muscles did I skip?

#### Claude Desktop, Cursor and other clients

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

### Settings

| Variable | Meaning |
|---|---|
| `GYMLY_URL` | Your Gymly address. Must be `https://`; plain `http://` is accepted only for `localhost`. |
| `GYMLY_MCP_TOKEN_FILE` | Path to the token file (recommended). Must not be readable by other users. |
| `GYMLY_MCP_TOKEN` | The token itself, as an alternative to the file. Avoid it where you can: environment variables show up in more places than a 0600 file. |
| `GYMLY_MCP_CACHE_SECONDS` | How long one fetch answers tool calls before checking again (default 15, 0 to 300). Also the longest a revoked token can keep answering from what it already fetched. |

Without `GYMLY_URL`, the server runs in **local mode** and reads a Gymly `./data` folder on the
same machine instead (`OPENGYM_DATA`, `OPENGYM_UID`). See [mcp/README.md](../mcp/README.md).

### Keeping the token secret

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

### Troubleshooting

| What you see | What to do |
|---|---|
| `UNAUTHORIZED: Gymly refused the MCP token` | It expired, was revoked, or you signed out everywhere. Make a new one, overwrite the file. |
| `EPERM: … can be read by other users` | `chmod 600 ~/.config/gymly/mcp-token` |
| `EINVAL: the configured token is not a Gymly MCP token` | The file holds something else (a stray newline is fine). Copy the token again. |
| `EINVAL: GYMLY_URL must be https://` | Use the `https://` address. |
| `UPSTREAM: this Gymly server has no MCP access route` | The server is older than this feature, or `GYMLY_URL` points somewhere else. |
| `RATE_LIMITED` | More than 120 requests a minute from your address. Wait, or raise `GYMLY_MCP_CACHE_SECONDS`. |

The full HTTP contract is in [`api/openapi.yaml`](../api/openapi.yaml), under the `mcp` tag.
