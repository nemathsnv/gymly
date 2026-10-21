# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Code, Claude Desktop, Cursor, Cline, Continue, etc.) read your Gymly profile:
routines, workouts, body-weight log, estimated 1RMs, and muscle balance.

It is read-only and runs locally as a stdio process spawned by the LLM client, with no new
container. It has two modes:

- **Remote mode** (`GYMLY_URL`): reads your profile from a Gymly server over HTTPS, with a
  personal read-only token you make in **Settings → AI assistant access**. Use this when Gymly
  runs on a server and your AI client on your laptop. **Setup guide: [docs/MCP.md](../docs/MCP.md).**
- **Local mode** (default): reads the `./data` directory directly, for an MCP server on the same
  machine as the data. It needs no authentication; the filesystem is the boundary.

The LLM never sees passkeys, VAPID keys, or session secrets, and in remote mode it never sees
gym membership cards or the AI Coach record either (the server withholds them).

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Phase 1 of a multi-phase plan. Read-only today; long-lived token auth + write tools are
> planned but not shipped yet. See **Roadmap** below.

## Quick start (local mode)

Remote mode, against a Gymly server: follow [docs/MCP.md](../docs/MCP.md) instead.

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## Tools

Nine read-only tools in v1:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **Local mode needs no auth.** The filesystem is the boundary, same as `docker compose`
  running on the user's box. No passkey material, VAPID keys, or session secrets ever cross it.
- **Remote mode uses its own credential.** A read-only, single-profile, expiring, revocable
  token (`api/mcp-access.js`), stored server-side only as a hash. It is accepted by
  `GET /api/mcp/v1/state` and refused by every other route. The client reads it from a 0600
  file, sends it only over HTTPS, never follows a redirect, and never prints it (`src/remote.js`).
- **No telemetry.** Local mode makes no network call at all; remote mode talks only to
  `GYMLY_URL`. The process exits when the LLM client disconnects.

## Tests

```bash
cd mcp && npm test
```

The suite expects `TZ=UTC`, as CI sets it; a few date-sensitive cases in `tools.test.js` fail
in timezones far from UTC. `remote.test.js` covers remote mode against a stub of the server's
route: configuration refusals, token-file permissions, conditional fetches, revocation,
redirects, and that no error or tool result carries the token. `stdio-remote.test.js` drives
the real stdio server with the SDK's client, and, when `api/` has its dependencies installed,
runs it against a real `api/server.js`, including revoking the token mid-session.

58 cases seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on). Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own 92 tests in `frontend/src/lib/*.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Done (Phase 1.6):** remote mode. Per-profile read-only tokens made in Settings,
  `GET /api/mcp/v1/state`, HTTPS-only client.
- **Phase 2:** proposals, not writes: the assistant files a change list, and the owner accepts
  it in Gymly through the AI Coach's review and apply pipeline. Design and remaining steps:
  [docs/dev/MCP_WRITES.md](../docs/dev/MCP_WRITES.md).
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
