# Gymly — Backup and Disaster Recovery Runbook

Off-site, encrypted, verified backups of Gymly production (`https://gymly.churntech.com`, KVM2) to
DigitalOcean Spaces. Independent of every other application on KVM2 and of QR Rapid's backups:
own bucket, own keys, own restic repository and password, own monitors.

## 1. What exists and where

| What | Where | In the backup |
|---|---|---|
| Accounts, passkeys, push subscriptions, invites, MCP tokens/clients/grants | `/opt/gymly/data/db.json` (+ `db.json.bak`, the copy of the last save) | yes |
| Per-profile data: workouts, routines, settings, body weight, measurements, habit definitions (`habitLog["<id>\|def"]`) and habit days (`habitLog["<id>\|YYYY-MM-DD"]`) | `/opt/gymly/data/state-<profile id>.json` | yes |
| Session-cookie HMAC key (without it every session ends; passkeys still work) | `/opt/gymly/data/secret` | yes |
| Web Push VAPID key pair (without it push subscriptions stop working) | `/opt/gymly/data/vapid.json` | yes |
| MCP undo journal, Coach records, uploaded photos/videos | `/opt/gymly/data/mcp-journal-*.json`, `coach.json`, `coach/`, `uploads/` (when present) | yes |
| Sign-in / admin audit trail | `/opt/gymly/data/audit.log` | yes |
| Server environment (`RP_ID`, `ORIGIN`, `MCP_OAUTH_USERS`, pinned edge image digest, …) | `/etc/gymly/gymly.env` | yes (`config/`) |
| Deployment receiver, compose file, edge config, release markers | `/opt/gymly/deploy/`, `/opt/gymly/edge/`, `/opt/gymly/{current,previous}-release`, `/usr/local/sbin/gymly-{deploy,ssh}`, `/etc/sudoers.d/gymly-deploy`, `/home/gymly-deploy/.ssh/authorized_keys` | yes (`config/`) |
| This backup system's settings and units | `/etc/gymly-backup/backup.conf`, `/etc/systemd/system/gymly-backup*` | yes (`config/`); its **secrets are not** |
| Application images `gymly-api:<sha>`, `gymly-web:<sha>` | Docker on KVM2 | no — rebuilt from Git by the deploy workflow |
| Cloudflare Tunnel credential | `/etc/cloudflared/` (KVM2's tunnel, shared with other sites) | no — Cloudflare dashboard |
| Pre-deploy snapshots | `/opt/gymly/releases/<UTC>-<sha>/before-data.tar.gz` (local, root-only) | no — unchanged, still made by every deploy |

## 2. Backup system

```
 every 6 h (00:40 06:40 12:40 18:40 UTC)
 /opt/gymly/data ──consistent copy──▶ /var/backups/gymly-dr/snapshot/{data,config,MANIFEST.json}
 Gymly configuration ──copy─────────▶        │
                                             ▼
                     restic (AES-256 + Poly1305, client-side) ──▶ Spaces fra1, private bucket gymly-dr-backups/restic
                                             │
              read back the whole snapshot from Spaces, sha256 of every file == MANIFEST ──▶ tag "verified"
 daily 04:20 UTC: freshness ▸ forget (fresh only) ▸ prune (Sun) ▸ check --read-data-subset n/7 ▸ restore test (Sun)
 every job ──▶ Uptime Kuma push monitor (Discord) + optional off-host heartbeat
```

* **Code:** `deploy/backup/` in this repository — `gymly_backup.py` (installed as `/usr/local/sbin/gymly-backup`),
  `install.sh`, `systemd/`, `test_backup.py` (run in CI). Python 3 standard library only; restic 0.19.1
  installed by `install.sh` from the official release, pinned by SHA-256 (release signature checked).
* **Repository:** `s3:https://fra1.digitaloceanspaces.com/gymly-dr-backups/restic`, format v2 (compressed,
  deduplicated). Snapshots: host `gymly-kvm2`, tag `gymly`, plus `verified` once the run's read-back passed.
  Only `verified` snapshots count for freshness, the restore test and `restore latest`.
* **Contents of a snapshot** (`/var/backups/gymly-dr/snapshot`): `data/` (the data directory), `config/<absolute
  path>` (configuration above) and `MANIFEST.json` (release SHA, sha256 + size of every file, aggregate counts:
  users, passkeys, profiles, workouts, routines, habit definitions/days, uploads — no names, ids or content).
* **Consistency without pausing Gymly:** the API writes every file as temp file + fsync + rename (`api/durable.js`),
  so opening a file always yields one whole version. The job lists inode/size/mtime of every file, copies,
  lists again, and retries (up to 5 times) if anything changed — the copy is then the state at one instant.
  In-flight temporaries (`*.tmp`, `uploads/*/.tmp/`, `.health-*`) are skipped. Uploads are content-addressed
  and never rewritten, so they are hard-linked, not copied. A running deployment is detected through
  `/proc/locks` (the job never takes `deploy.lock` itself, so it can never make a deploy fail) and waited for.
* **Validation before upload:** `db.json`, `secret`, `vapid.json` present; every JSON file parses; `db.json`
  has at least `MIN_USERS` users; required configuration present. Otherwise nothing is uploaded and the run fails.
* **Encryption:** restic encrypts and authenticates everything client-side with a key derived from the
  🔐 restic password. Spaces stores only ciphertext (`verify-bucket` checks that the repository config object
  is not readable plaintext, and that anonymous listing/reads are refused).

### Schedule (UTC) and retention

| Timer | When | Does |
|---|---|---|
| `gymly-backup.timer` | 00:40, 06:40, 12:40, 18:40 (+ ≤ 2 min random) | backup + full remote read-back + `verified` tag |
| `gymly-backup-maintain.timer` | 04:20 daily (+ ≤ 2 min) | stale-lock cleanup; freshness; `forget --keep-last 4 --keep-daily 30 --keep-weekly 12` grouped by host+tags; `prune --max-unused 5%` on Sundays; `check --read-data-subset n/7` daily (all data read weekly); restore test on Sundays |

Both are `Persistent=true`: a run missed while the server was down starts at boot. **RPO ≤ 6 h.** Writes made
after the newest snapshot are lost in a disaster; the local pre-deploy snapshots cover deploy-time problems.

### Safety properties

* One `flock` per job (`/run/lock/gymly-backup-<job>.lock`); a second run of the same job exits 75 without
  changes (systemd treats that as success). One restore test at a time. Different jobs coordinate through
  restic's repository locks (`--retry-lock 30m`).
* Fail-closed retention: when the newest verified snapshot is missing, older than 7 h, dated in the future or
  cannot be listed, `forget`/`prune` are skipped, the integrity check still runs, and the job fails (alert).
* A restic run that could not read some input (exit 3) still saves a snapshot; the job removes it and
  retries (3 attempts with back-off). Unverified snapshots form their own retention group and can never push
  verified points out of the daily/weekly slots.
* `PRODUCTION_HOSTNAME=srv804180`: backup, maintain, init and verify-bucket refuse to run on any other host, so
  a restored or rehearsal copy of the server cannot write to the repository. `restore` and `status` are
  read-only and allowed anywhere.
* The restore test and `gymly-backup restore` only write to `/var/backups/gymly-dr/restore-test` or a new empty
  directory; `restore` refuses any target inside `/opt/gymly`. The restore test boots the release's own API
  image on the restored copy in a container with `--network none` and all capabilities dropped, checks
  `/api/health`, then removes the container and the restored copy.
* Logs (`journalctl -u 'gymly-backup*'`) hold stages, counts, sizes and short snapshot ids — never secrets,
  URLs of monitors, names, e-mail addresses or workout content.

### Monitoring

| Uptime Kuma push monitor (KVM2) | Pushed by | Heartbeat interval | Retries |
|---|---|---|---|
| Gymly — Backup | `backup` | 25200 s (7 h) | **0** |
| Gymly — Backup Verification | `maintain`, `restore-test` | 93600 s (26 h) | **0** |

Success pushes `up` (snapshot prefix, counts); failure pushes `down` with the failed stage; a run that never
happens alerts when the heartbeat interval expires. Both monitors use the existing **Discord Alert**
notification. **Retries must be 0**: with Retries ≥ 1 a single `down` push only makes the monitor PENDING,
which notifies nobody, and the later `up` sends no recovery message (found on QR Rapid, 2026-10-12).

Uptime Kuma runs **on KVM2 itself**. If KVM2 is lost entirely, Kuma is lost with it and cannot report the
missing heartbeats. The optional off-host heartbeat covers that: the job also calls a dead-man's-switch URL
(`gymly-backup secret heartbeat-backup` / `heartbeat-verify`; healthchecks.io-style: `<url>` on success,
`<url>/fail` on failure) whose service alerts when pings stop.

Status: `sudo gymly-backup status`. Logs: `journalctl -u gymly-backup.service -u gymly-backup-maintain.service`.

## 3. Credentials (🔐 password manager — never only on the server)

| Secret | Where it lives | Purpose |
|---|---|---|
| Restic repository password | 🔐 password manager; `/etc/gymly-backup/restic-password` (root 0600) | Decrypts every backup. **Without it the backups are unreadable.** |
| Repository URL | here and in `backup.conf` | `s3:https://fra1.digitaloceanspaces.com/gymly-dr-backups/restic` |
| Spaces key `gymly-backup-kvm2` (Read/Write/Delete, **only** `gymly-dr-backups`) | `/etc/gymly-backup/spaces.env` (root 0600); optionally 🔐 | Used by the scheduled jobs |
| Spaces key `gymly-backup-recovery` (Read, **only** `gymly-dr-backups`) | 🔐 password manager only | Restore from any machine when KVM2 is gone |
| Uptime Kuma push URLs / heartbeat URLs | `/etc/gymly-backup/*.url` (root 0600) | Monitoring; recreate if lost |
| DigitalOcean, Cloudflare, Hostinger, GitHub, Uptime Kuma logins | 🔐 | Rebuild infrastructure |

Secrets are written only with `ssh -t kvm2 sudo gymly-backup secret <name>` (hidden input, root 0600, nothing
echoed or logged). Keep an exported copy of this runbook next to them in the password manager.

## 4. Routine operations

```bash
sudo gymly-backup status                                  # last runs + recent snapshots
sudo systemctl start gymly-backup.service                 # ad-hoc backup (same path as the timer)
sudo FORCE_RESTORE_TEST=1 gymly-backup maintain           # isolated restore test now
sudo RETENTION_DRY_RUN=1 gymly-backup maintain            # show what retention would remove
sudo gymly-backup verify-bucket                           # bucket private, objects present, ciphertext only
journalctl -u gymly-backup.service -n 50
```

Normal Gymly deployments need **no manual backup**: every deploy still makes its local pre-deploy snapshot,
and the newest off-site snapshot is at most 6 h old. Before a risky data-format change, an extra ad-hoc backup
(`systemctl start gymly-backup.service`) narrows the window further.

**Upgrading this tool:** from a checkout of the reviewed commit on KVM2, `sudo bash deploy/backup/install.sh`
(never overwrites `backup.conf` or secrets; leaves timers as they are). **Disabling** (keeps all backup data):
`sudo systemctl disable --now gymly-backup.timer gymly-backup-maintain.timer`.

## 5. Recovering data while KVM2 is still running

Never restore over the running application, and never automatically. Restore into a new directory, inspect,
then copy deliberately during a maintenance window:

```bash
sudo gymly-backup status                                          # pick a snapshot (or "latest")
sudo gymly-backup restore <snapshot-id|latest> /root/gymly-restore-$(date -u +%Y%m%dT%H%M%SZ)
```

The command verifies every file against the manifest and prints the counts. To put data back (this loses every
write since that snapshot; for one profile, copy only its `state-<id>.json`):

```bash
cd /opt/gymly/deploy && R=$(cat /opt/gymly/current-release)
sudo GYMLY_RELEASE=$R docker compose --env-file /etc/gymly/gymly.env -p gymly -f compose.yml stop web api
sudo mv /opt/gymly/data /opt/gymly/data.before-restore-$(date -u +%Y%m%dT%H%M%SZ)
sudo cp -a /root/gymly-restore-<stamp>/data /opt/gymly/data && sudo chmod 700 /opt/gymly/data
sudo GYMLY_RELEASE=$R docker compose --env-file /etc/gymly/gymly.env -p gymly -f compose.yml up -d api web
curl -fsS http://127.0.0.1:8090/api/health
```

## 6. Recovery when KVM2 is permanently lost

Order matters: restore the data first (it tells you the release), then rebuild the host, then let CI deploy.

1. **Provision** an Ubuntu 22.04/24.04 server. Install Docker Engine + compose plugin, `python3`, `curl`,
   `bzip2`. Set its hostname to `srv804180` (`hostnamectl set-hostname srv804180`): `bootstrap.sh`,
   `install.sh` and `PRODUCTION_HOSTNAME` all check it.
2. **Install the backup tool** from a clone of `github.com/nemathsnv/gymly` (main):
   `sudo bash deploy/backup/install.sh` (no `--enable`). It installs restic 0.19.1 and the default `backup.conf`.
3. **Enter recovery credentials** from the password manager:
   `sudo gymly-backup secret restic-password` and `sudo gymly-backup secret spaces` (use the **read-only
   recovery key** for now).
4. **Restore** into a new directory: `sudo gymly-backup restore latest /root/gymly-restore`. Note the release
   SHA and counts it prints. (Without the tool: `restic -r s3:https://fra1.digitaloceanspaces.com/gymly-dr-backups/restic
   --no-lock restore <id>:/var/backups/gymly-dr/snapshot --target /root/gymly-restore`, with
   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` and `RESTIC_PASSWORD_FILE` set in the shell, or the
   `restic/restic:0.19.1` Docker image.)
5. **Put configuration back** before bootstrapping, so `bootstrap.sh` keeps the real environment:
   `sudo install -d -m 700 /etc/gymly && sudo cp -a /root/gymly-restore/config/etc/gymly/gymly.env /etc/gymly/`.
6. **Bootstrap** with the restored deploy public key (the private key is still the `GYMLY_SSH_KEY` GitHub
   secret): extract the `ssh-ed25519 … gymly-github-actions` part of
   `/root/gymly-restore/config/home/gymly-deploy/.ssh/authorized_keys` into `/root/gymly-deploy.pub`, then
   `sudo bash deploy/bootstrap.sh /root/gymly-deploy.pub`. (If the key may be compromised, make a new pair and
   replace the secret instead.)
7. **Put data back** (nothing is running yet): `sudo rm -rf /opt/gymly/data && sudo cp -a /root/gymly-restore/data /opt/gymly/data && sudo chmod 700 /opt/gymly/data`.
8. **Cloudflare:** install `cloudflared` with a tunnel token from the Cloudflare dashboard (KVM2's tunnel or a new
   one) and route `gymly.churntech.com` → `http://127.0.0.1:8090`. Keep the hostname: passkeys are bound to
   `RP_ID=gymly.churntech.com`, so the same domain keeps every passkey working.
9. **Deploy:** update GitHub variables `GYMLY_SSH_HOST` (new IP) and `GYMLY_KNOWN_HOSTS` (the new host key,
   verified out of band), then Actions → *Gymly checks and deploy* → *Run workflow* on `main`. The receiver
   snapshots the (restored) data, starts the release and verifies it.
10. **Verify:** `curl -fsS https://gymly.churntech.com/api/health` (`ok`, `writable`); sign in with a real passkey
    on a phone; check that workouts, routines, habits and settings are there; compare with the counts from step 4.
11. **Resume backups:** replace the recovery key with a new Read/Write/Delete key for the server
    (`sudo gymly-backup secret spaces`; revoke the old server key in DigitalOcean), store the monitor URLs,
    `sudo bash deploy/backup/install.sh --enable`, `sudo systemctl start gymly-backup.service`, and recreate the
    Kuma monitors (§2, Retries 0) if Kuma was lost too.

Expected time: 1.5–3 h, most of it provisioning and DNS/tunnel.

## 7. Verification status

Commissioned 2026-10-23 on KVM2 (release `a40225036046`), restic 0.19.1, repository id `872866aa`.

| Check | Result |
|---|---|
| Rehearsal against a disposable local repository (init, 2 backups, retention, prune, check, restore test, `restore` helper) | passed; rehearsal copy deleted |
| Failure paths: wrong restic password; second concurrent run; `restore` into `/opt/gymly` | classified as key mismatch (exit 1, `down`); exit 75, no changes; refused |
| First real backup (`systemctl start gymly-backup.service`, 03:25 UTC) | 29 files, read back from Spaces with matching sha256; tagged `verified` as `5b786fc5`; Kuma `up` |
| `verify-bucket` | anonymous listing and anonymous read of `restic/config` refused (HTTP 403); config, keys, index, data, snapshots objects present; config is ciphertext |
| `maintain` with forced restore test | freshness ok, retention, `check --read-data-subset 3/7` ok; restore of `5b786fc5` from Spaces: 28 files match the manifest; users 2/2, passkeys 2/2, profiles 2/2, workouts 31/31, routines 5/5, habit definitions 2/2, habit days 7/7, MCP grants 1/1 (backup/live); API `a40225036046` booted on the restored copy with no network and reported healthy; copy and container removed |
| Independent comparison of a fresh restore with live data | all 8 data files byte-identical to production; per-profile settings keys identical; `gymly.env` identical; 20 configuration files restored |
| Alerting | Kuma monitors 13 (Gymly — Backup, 25200 s) and 14 (Gymly — Backup Verification, 93600 s): Push, Retries 0, Discord Alert. `TEST ONLY` down and up pushes on both were recorded as important (notifications sent) |
| Production | unchanged throughout: same containers, `/api/health` ok and writable, no deploy, local pre-deploy snapshots untouched |
| Timers | `gymly-backup.timer` and `gymly-backup-maintain.timer` enabled 2026-10-23 03:30 UTC |

Still to confirm: the first timer-started `maintain` (04:20 UTC) and `backup` (06:40 UTC) runs, and that Discord
received the four `TEST ONLY` messages. Not yet in place: an off-host heartbeat (§2) and a password-manager copy
of this runbook.

## 8. Known limits

* The server's Spaces key can delete objects (DigitalOcean has no upload-only key and no Object Lock), so a
  fully compromised KVM2 could destroy the off-site repository. Mitigation for later: a pull-based second
  copy (`restic copy` from another machine with its own read key and its own destination).
* Uptime Kuma shares KVM2 with Gymly; only the optional off-host heartbeat detects the loss of the whole host.
* Application images are not backed up; recovery rebuilds them from Git through the deploy workflow.
* RPO 6 h; audit log lines written during a copy that is then retried are simply taken on the retry.
