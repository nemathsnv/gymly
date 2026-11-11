# Oura

Connect an Oura ring to Gymly and see Oura's sleep, readiness, activity, heart rate, HRV, stress,
SpO2 and cardiovascular figures, plus the workouts Oura recorded, next to the training you log in
Gymly. It is **read-only** and **optional per profile**, and it is off until the server has Oura
app credentials.

- **Connect:** Settings → Data & backup → Oura → Connect Oura (signed-in browser; the phone app
  does not offer it).
- **See it:** Settings → Data & backup → Oura → Recovery overview (`#/oura`), or Sync now.
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
| Oura health data | **Never written to disk.** The overview is fetched from Oura on demand, reduced to the figures on screen (`api/oura/summarize.js`) and held in the API's memory for up to 10 minutes. It is not in `state-<uid>.json`, so it is not synced, exported or backed up, and the Coach and the MCP tools (which read the state) never see it. Oura workouts are shown beside Gymly's sessions and never added to the Gymly log. |
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
| `GET /api/integrations/oura/overview?days=14` | the overview (1–30 days; heart rate covers the last 7) |
| `POST /api/integrations/oura/sync?days=14` | the same, fetched fresh (a second call within 30 s gets the first one's result) |
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
