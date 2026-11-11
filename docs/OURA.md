# Oura

Connect an Oura ring to Gymly and see Oura's sleep, readiness, activity, heart rate, HRV, stress,
SpO2 and cardiovascular figures, plus the workouts Oura recorded, next to the training you log in
Gymly. It is **read-only** and **optional per profile**, and it is off until the server has Oura
app credentials.

- **Connect:** Settings → Data & backup → Oura → Connect Oura (signed-in browser; the phone app
  does not offer it).
- **See it:** Settings → Data & backup → Oura → Training & recovery (`#/oura`), or Sync now.
- **Check it:** Settings → Data & backup → Oura → Check connection. It lists, per data type, whether
  Oura shares it and whether records arrive, and whether a token refresh works. It never shows a
  value.
- **Disconnect:** same place. Gymly revokes its token at Oura and deletes everything it holds
  for the connection, at once.

## Set up the server

1. In Oura's developer portal (<https://developer.ouraring.com>), open the application and
   register this **redirect URI**, character for character:

   ```
   https://gymly.churntech.com/api/integrations/oura/callback
   ```

   For another instance it is `<ORIGIN>/api/integrations/oura/callback`. Under a subpath, set
   `OURA_REDIRECT_URI` to the full callback address and register that one instead.

2. Put the credentials in the API's environment and nowhere else.

   **Production (KVM2).** The API reads `/etc/gymly/gymly.env` (root, 0600). Open it with an
   editor as root, so the secret never appears on a command line or in your shell history:

   ```sh
   ssh kvm2
   sudo -e /etc/gymly/gymly.env
   ```

   Add the two lines. Paste the values straight from the portal, and don't echo or `cat` them
   afterwards:

   ```sh
   OURA_CLIENT_ID=<client id>
   OURA_CLIENT_SECRET=<client secret>
   ```

   Check the mode and recreate **only the API**. The variables are read at start:

   ```sh
   sudo stat -c '%a %U' /etc/gymly/gymly.env     # 600 root
   sudo sh -c 'cd /opt/gymly/deploy && GYMLY_RELEASE=$(cat /opt/gymly/current-release) \
     docker compose --env-file /etc/gymly/gymly.env -p gymly -f compose.yml up -d --no-deps --force-recreate api'
   ```

   **docker compose from this repository.** Add the two lines to `.env` (see `.env.example`)
   and run `docker compose up -d api`.

3. Verify it is on, without printing anything secret:

   ```sh
   curl -fsS https://gymly.churntech.com/api/health
   ```

   Then, signed in, open Settings → Data & backup. The Oura card says **Connect Oura** instead of
   "Not set up on this server". Its status (`GET /api/integrations/oura/status`) reports
   `configured: true` and the `redirectUri` the server will send to Oura. That URI must match the
   portal exactly.

The credentials are never printed. They never reach the browser, and they don't appear in logs,
`/api/config` or the status route. Rotating `OURA_CLIENT_SECRET` makes stored tokens unreadable
(they are encrypted with a key derived from it). Every connected profile then shows as
disconnected and connects again.

Until Oura approves the application, Oura limits it to 10 users. Oura's API also needs an active
Oura Membership on Gen3 or later rings.

## What is requested, and what is kept

| | |
| --- | --- |
| Scopes | `daily heartrate workout spo2 heart_health` (`OURA_SCOPES` to change). Never `email` or `personal`. The person can switch any scope off on Oura's consent screen. That data type then shows as "not available", and the rest still loads. |
| Flow | Authorization code + PKCE (S256), single-use `state` tied to the profile that started it (10 minutes), code exchanged server side with the client secret. |
| Tokens | `DATA_DIR/oura/<profile id>.json`, 0600 in a 0700 folder. AES-256-GCM, with the key derived (HKDF) from the instance `secret` **and** `OURA_CLIENT_SECRET`, so a copy of the data folder alone cannot decrypt them. Refresh tokens are single-use: refreshes are serialised per profile, and each new pair is stored before it is used. |
| Oura health data | **Never written to disk.** Reduced to the figures on screen (`api/oura/summarize.js`) and held in the API's memory only (`api/oura/sync.js`): at most 90 days (heart rate 7), only for a profile whose Training & recovery screen was opened in the last 14 days, then dropped. A restart drops everything. It is not in `state-<uid>.json`, so it is not synced, exported, sent by webhooks or backed up, and the Coach and the MCP tools (which read the state) never see it. Oura workouts are shown beside Gymly's sessions and never added to the Gymly log. |
| Sync | First look: a backfill of 90 days. After that it is incremental: from 3 days before the last synced day up to tomorrow, each data type's days replaced wholesale, so revisions and deletions in Oura carry over and nothing doubles. **Automatic:** every 3 hours for profiles in use (a 15-minute tick). Sync now also triggers one, with a 30 s minimum gap. A look after an hour syncs first. Failures: a rate limit waits for `Retry-After`; other errors back off 15 min, 30, 60… up to 6 h. A transient 502/503/504 or dropped connection is retried once. A type that fails alone keeps its previous days. A type no longer shared is cleared. A refused grant disconnects. `lastSync` and the last error's code (no data) are kept on the connection file. |
| Time zones | The app sends the device's IANA zone. Heart-rate samples (UTC) are put on the person's own days in that zone, daylight saving included. Daily documents keep the day Oura gives them. Gymly's sessions keep their own local date. |
| Disconnect / delete | Revoke at Oura (best effort), delete the token file, drop the memory copy: immediate. An admin deleting a profile does the same. A grant revoked in the Oura app is noticed on the next request, and its tokens are deleted. |

These choices follow the Oura API and MCP Agreement (effective 8 June 2026). Data is minimised
and not retained beyond need (§3(m), §4(c)). Revocation and deletion are immediate, well within
72 hours (§5(f)). Oura data is never used with any AI model (§4(d), §6(g)), and it is not
disclosed or used for advertising (§4(a)). The published [Privacy Policy](https://gymly.churntech.com/privacy#oura)
says the same to users.

## Routes

`api/oura/routes.js`, documented in `api/openapi.yaml` under *integrations*:

| Route | |
| --- | --- |
| `GET /api/integrations/oura/status` | configured / connected / last sync / granted scopes |
| `POST /api/integrations/oura/connect` | the consent URL to send the browser to |
| `GET /api/integrations/oura/callback` | Oura's redirect back; redirects to Settings with `?oura=connected\|denied\|expired\|mismatch\|config\|error\|off` |
| `GET /api/integrations/oura/overview?days=14&tz=…` | what is held for the window (1–90 days); backfills on first look |
| `POST /api/integrations/oura/sync?days=14&tz=…` | an incremental sync now, then the same (a second call within 30 s gets the first one's result) |
| `GET /api/integrations/oura/diagnostics?refresh=1` | per data type `status` + `records` (boolean), token lifetime, refresh test: **no values** |
| `POST /api/integrations/oura/disconnect` | revoke and delete |

## Troubleshooting

| You see | Meaning |
| --- | --- |
| "Not set up on this server" | `OURA_CLIENT_ID` or `OURA_CLIENT_SECRET` is missing from the API's environment, or the API was not recreated after adding them. |
| Oura shows an error page instead of the consent screen | The redirect URI the server sends (status → `redirectUri`) is not registered in the portal exactly. |
| "Oura refused this server's app credentials" | Wrong client ID or secret. |
| "The Oura sign-in took too long" | More than 10 minutes on Oura's screen, or the API restarted in between. Connect again. |
| "Sign in to Gymly with the same profile" | The browser that came back from Oura was signed in as a different profile, or signed out. |
| "Oura needs to be connected again" | Access was revoked in the Oura app, or the refresh token was refused. |
| A data type "not available" | That scope was switched off on Oura's screen, or the ring or membership does not provide it. |

## Training & recovery screen

It shows your Gymly training next to your Oura readings. It is meant to complement the Oura app,
not copy it:

- **Latest readings.** Each value carries the day it was measured. When last night's sleep has
  not synced yet, the screen shows yesterday's, labelled as yesterday's.
- **HRV and lowest night-time heart rate.** Each shows a 7-day average against the 30 days before.
- **Training load by week**, from the Gymly log: sessions, working sets, hard sets (RIR ≤ 3),
  average RIR and volume, with that week's Oura readiness and sleep averages beside them.
- **Day by day:** planned routines (from the current schedule), what you logged, sets and RIR,
  readiness, sleep, HRV, heart rate and steps.
- **One list of workouts and cardio.** A session logged in Gymly that Oura also detected appears
  once.

Gymly stays the record of exercises, sets, reps, weights and RIR. Nothing on this screen changes a
plan or suggests a weight from an Oura score.

## Getting Gymly workouts into Oura

The Oura API has no write endpoint for workouts (spec 1.43: every `usercollection` route is
`GET`), so Gymly never writes to Oura. The supported route goes through the phone's health store:

- **Android:** turn on Settings → Data & backup → Health Connect in the Gymly app, which writes
  finished workouts to Health Connect. Oura imports "Exercise" from Health Connect
  ([Oura support](https://support.ouraring.com/hc/en-us/articles/10786105824531-Health-Connect-by-Android-Integration)).
  Oura says it shows an activity detected twice only once, and that imported activity outranks
  auto-detected activity
  ([Automatic Activity Detection](https://support.ouraring.com/hc/en-us/articles/360063022993-Automatic-Activity-Detection)).
  Not verified with Gymly yet: which Oura activity type a Gymly strength session maps to, and
  whether Oura imports past days.
- **iOS:** Oura imports workouts from Apple Health, but Gymly does not write to Apple Health
  (there is no HealthKit integration), so there is no route on iPhone today.

## AI assistants and Oura

The Oura API and MCP Agreement (8 June 2026) §4(d) says Oura data may be used with a large
language model "solely through the MCP Server", meaning Oura's own. It also says the Oura API
must not be used to "prompt, or otherwise provide input or data to any AI Model". Gymly therefore
never gives Oura data to its AI Coach, its MCP tools (V1 and hosted) or any model, and its MCP
tools continue to read and write Gymly's own workouts as before.

To have ChatGPT or Claude look at both, connect them separately. Gymly's MCP server serves the
training ([docs/MCP.md](MCP.md)), Oura's MCP server serves the Oura data, and the assistant
combines them under your control. Any plan change still goes through Gymly's own preview and
apply, approved by you.

What is known about Oura's MCP server (checked 2026-11-11):

- `https://api.ouraring.com/v2/mcp` exists. It answers `401` with
  `WWW-Authenticate: Bearer realm="mcp", resource_metadata="https://api.ouraring.com/v2/.well-known/oauth-protected-resource"`.
  The resource metadata names `https://api.ouraring.com` as its authorization server.
- That server's metadata (`/.well-known/oauth-authorization-server`) lists PKCE (S256), scopes
  `extapi:daily`, `extapi:heartrate`, `extapi:workout`, `extapi:spo2`, `extapi:stress`,
  `extapi:heart_health` and others, and a registration endpoint that itself needs a bearer token.
  So it is **not** open dynamic client registration.
- Oura publishes no documentation, setup guide or connector listing for it. Its tools, whether
  Claude or ChatGPT can connect to it (for example with client credentials entered by hand) and
  what membership it needs are **unverified**. Until Oura documents it, there is no tested,
  supported way to connect an AI assistant to your Oura data, and Gymly does not provide one.

