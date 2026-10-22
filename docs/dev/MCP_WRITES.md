# MCP phase 2: editing workouts and plans by natural language

Status: **implemented as the hosted MCP endpoint** (`api/mcp-remote/`, user guide
[docs/MCP.md](../MCP.md)). This note was the design; the section "What shipped" below says where
the implementation follows it and where it deliberately departs. The rest is kept as the
reasoning behind it.

## What shipped

- **Transport and auth.** Not a new scope on the V1 token: a remote MCP server inside the API
  (`POST /api/mcp`, stateless Streamable HTTP) with its own OAuth 2.1 authorization server
  (PKCE S256, CIMD and dynamic registration, resource-bound opaque tokens, rotating refresh
  tokens with replay detection, consent on Gymly's own page with the owner's passkey session).
  Scopes `gymly:read` and `gymly:write`; only profiles in `MCP_OAUTH_USERS` can connect. V1 is
  unchanged.
- **The boundary is the Coach's**, as designed: operations become the closed list of change
  types and pass `validateReview` against the plan as it stands; `weight` (the routine's target
  weight) is the one addition, validated per unit. Nothing else in the document is writable;
  workouts can only be *added* (`log_workout`), never edited or deleted, except that an
  assistant can undo the one it logged.
- **Departure: no in-app approval for ordinary edits.** The design had the owner approve every
  proposal in the app. The owner chose in-conversation confirmation instead (an assistant should
  be able to make a normal adjustment in the chat), so the safety comes from elsewhere:
  - consent once, on Gymly's page, with write access an explicit, untickable choice;
  - every write is a **preview** (saves nothing, returns the exact before → after) and an
    **apply by preview id** — the assistant cannot apply anything it did not show, and clients
    (ChatGPT, Claude) ask the user before running a non-read-only tool;
  - removals and bulk edits (more than 16 changes, or more than 3 existing routines) need a
    separate tool annotated `destructiveHint` and a confirmation phrase;
  - the apply refuses when anything it touches (the routines it names, and the week when it
    reschedules or removes a routine) changed since the preview — compared field for field, sync
    stamps aside — is idempotent, and is journalled with what it touched, so `undo_change`
    restores exactly that (and refuses when a later edit of the same routine would be overwritten);
  - the write goes through the same commit as `PUT /api/data` (`commitState`: stamps, revision,
    write id), as a writer that read the current revision, so every device merges it like an edit
    made elsewhere — no second writer with its own rules.
- **Apply runs on the server**, not the client: `plan-apply.js` is a hand copy of the Coach's
  `CHANGE_APPLY`, pinned to it by `frontend/src/lib/mcp-apply-parity.test.js`. The read tools and
  the app helpers the write side needs run from a committed bundle of `mcp/src` and
  `frontend/src/lib` (`scripts/build-mcp-hosted.mjs`, checked in CI), so the numbers match the app.
- **Audit.** Server: `auth.mcp.consent`/`declined`/`connect`/`disconnect`/`reuse`/`write`/`undo`
  (client name and counts, never content). Profile: `data/mcp-journal-<uid>.json`, the last 25
  changes with their full before/after, readable through `list_recent_changes`.

Not done, on purpose: editing or deleting logged sets (needs PR/1RM recomputation tests in
`frontend/src/lib` first), settings, and any account route.

## What phase 1 already fixed in place

- **Scopes are explicit.** A token record carries `scope`, and `findMcpToken` refuses any scope
  not in `MCP_SCOPES` (`api/mcp-access.js`), which is `['read']` today. A record edited to
  `write`, or written by a later version and then rolled back, opens nothing.
- **MCP tokens are not sessions.** `sessionOf` refuses them by prefix, so no existing route
  (`PUT /api/data` above all) can ever be reached with one. Writes need routes of their own under
  `/api/mcp/v1/`, each of which checks the scope it needs.
- **Tokens die with the account's sessions** (session-version binding plus explicit drops at
  every `sv` bump, disable and delete). A write token inherits that for free.
- **The audit log has an `auth.mcp.*` family** with labels in `frontend/src/lib/audit.js`.
- **The MCP server's tools are a list** (`mcp/src/tools.js`); write tools are added beside the
  read ones and are registered only when the token's scope (from `GET /api/mcp/v1/state`'s
  `scope` field) allows them.

## The rule: the assistant proposes, the owner confirms in Gymly

An LLM must not be able to both decide on a change and approve it. Phase 2 therefore never
writes a profile's document from the MCP route. It **files a proposal**; the owner reviews and
applies it in the app, the same way they already review an AI Coach proposal.

Gymly has that pipeline today:

| Piece | Where | Reused for |
|---|---|---|
| Change contract `{ id, type, target, before, after, why }` | `api/coach/core/validate.js` `CHANGE_TYPES` | the shape of every MCP change |
| Server-side validation with ranges (sets 1–10, reps, seconds 5–3600, increments ≤ 50, known exercise ids, known routines) | `validateReview` | validating an MCP proposal before it is stored |
| A pending proposal per profile, resolved by accept/reject per change | `api/coach/jobs.js`, `POST /api/coach/pending/resolve` | holding the MCP proposal until the owner decides |
| Atomic apply with a restorable snapshot ("Before the Coach's changes") | `frontend/src/lib/coach.js` `applyChangeSet`, `pushSnapshot` | applying, and undoing |
| Decisions log | `appendLog` in the same file | the per-profile trail of what was proposed and what was accepted |

Applying stays on the client. The change then reaches the server through normal sync
(`PUT /api/data` with `baseRev`, `sync-stamps.js`), so no new server-side writer competes with
the app's read-modify-write of `state-<uid>.json`. That race is the reason the original roadmap
called for a write-lock, and this design avoids needing one.

### Flow

1. The owner makes a token with scope `read+propose`. This needs `proveOwner` (a passkey
   assertion or the current password), the same as adding a passkey. A write-capable token
   should expire sooner (30 days by default).
2. The assistant calls `propose_changes` with a change list, plus the `rev` it read (from
   `GET /api/mcp/v1/state`).
3. `POST /api/mcp/v1/proposals` (scope `propose`) validates the list with `validateReview`
   against the **current** document. It refuses with 409 if `rev` moved, and with 400 and every
   validation error otherwise. It caps the size (e.g. 20 changes, 3 removals) and stores the
   proposal as pending, with a 7-day expiry. Audited as `auth.mcp.propose`.
4. The tool returns the server's own before → after summary, so the assistant can show the user
   exactly what was filed.
5. The app shows the pending proposal (push notification and banner) in the existing review
   sheet, labelled as coming from the named token. The owner accepts or rejects each change;
   `applyChangeSet` applies the accepted ones atomically and snapshots first.
6. The assistant can read the outcome back with `get_proposal`: pending, applied (with which
   changes), rejected or expired.

### Risk tiers

| Tier | Examples | Confirmation |
|---|---|---|
| Plan tweaks | sets, reps, rep range, seconds, increment, progression policy, reorder | Accept in app (one tap for all) |
| Structural | add/swap/remove exercise, add/rename/remove routine, week assignment | Accept in app, each change shown separately; removals listed first in red |
| **History** | editing a logged set's weight/reps, deleting a workout | Not in the first write release. Needs new change types (`workout-set`, `workout-remove`), and the app has to show the old and new set side by side; PRs and 1RMs recompute on apply. |

Two things are **never** reachable through MCP: account, credentials and settings outside
training, and any bulk "replace the document" operation.

### Validation the server adds on top of the Coach validator

- An exercise id must exist in the catalogue or the profile's `customEx`. A name alone is
  refused: the assistant first resolves names with a read tool.
- Weights stay in the profile's unit, are > 0 and ≤ 1000 kg (or the lb equivalent), and land on
  the profile's load step (`inc`).
- `before` must match the current document. A stale `before` makes the change `stale`, as the
  Coach does today, so the owner never approves an edit computed against an old plan.
- Text fields (names, `why`) are length-capped and stripped of control characters, and are
  shown as text, never as HTML.

### Audit trail

- Server: `auth.mcp.propose` (token name, number of changes), `auth.mcp.proposal.resolve`
  (accepted/rejected counts). Counts only, never content.
- Profile: the decisions log (`appendLog`) keeps the full before/after of every change, who
  proposed it (`source: 'mcp'`, token id and name) and the owner's decision. The snapshot taken
  by `pushSnapshot` is the undo.

### Optional later: direct apply for plan tweaks

Only if in-app confirmation proves too slow for small adjustments ("make it 4 sets"), and only
for the plan-tweak tier. It would be a separate `apply` scope, opt-in per token, with step-up at
creation. The server would apply with `baseRev`/`baseWid` optimistic concurrency through the
same stamping `PUT /api/data` uses, with a per-token rate limit and a server-side snapshot for
undo. Not recommended for the first write release.

## Remaining steps

1. Decouple pending proposals from the Coach's gating (`guard` in `coach/routes.js` requires the
   Coach to be configured). Proposals need a home that exists without a provider.
2. Add `scope` values `propose` (and later `apply`) to `MCP_SCOPES`, with a step-up on creation
   (`proveOwner`) and a shorter default expiry. Show the scope in Settings.
3. Add `POST /api/mcp/v1/proposals` and `GET /api/mcp/v1/proposals/{id}`, plus openapi entries
   and route tests: scope checks, 409 on a moved `rev`, size caps, validation errors, another
   profile's proposal id → 404, read-only token → 403.
4. App: label MCP proposals in the review sheet; add a notification and banner.
5. MCP server: `propose_changes` and `get_proposal` tools, registered only for a token whose
   scope allows them. Their descriptions must tell the model that nothing changes until the
   owner accepts in Gymly.
6. Tests for every change type: validate → store → accept → apply → sync → read back through
   MCP, plus undo via the snapshot.
7. Only after all that: history edits (new change types, review UI, PR recomputation tests in
   `frontend/src/lib`).
