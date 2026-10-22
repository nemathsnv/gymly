# Gymly operations

## Installed layout

- Host: KVM2, `srv804180`, SSH alias `kvm2` (`147.93.121.98`).
- Application: `https://gymly.churntech.com` → existing Cloudflare Tunnel → `http://127.0.0.1:8090`.
- Compose project: `gymly`; services: `edge`, `web`, `api`.
- Persistent user data: `/opt/gymly/data` (includes login secrets, profiles, uploads).
- Server-only configuration: `/etc/gymly/gymly.env` (root, mode 0600).
- Installed deployment configuration: `/opt/gymly/deploy`.
- Current and previous SHA: `/opt/gymly/current-release`, `/opt/gymly/previous-release`.
- Per-release evidence and pre-update backups: `/opt/gymly/releases/<UTC>-<SHA>/` (root only).
- Root receiver: `/usr/local/sbin/gymly-deploy`; restricted SSH account: `gymly-deploy`.

Only edge publishes a host port, bound to loopback. The existing tunnel terminates HTTPS.
Do not expose port 8090 to the Internet or point the hostname directly at the API.
The images have CPU/memory limits and bounded container logs.

## First server setup

Inspect the host, free loopback port 8090, and existing `/opt/gymly` before proceeding.
Copy this `deploy/` directory and a dedicated Ed25519 public key (comment
`gymly-github-actions`) onto KVM2, then run as root:

```sh
bash /path/to/deploy/bootstrap.sh /path/to/gymly-deploy.pub
```

The script stops on the wrong host or an unmanaged existing directory. It preserves existing
Gymly environment settings and creates no public first-user-admin race. It adds only Gymly's
SSH account, forced command, sudo rule, directories, and a pinned nginx edge image.
It does not restart unrelated services. Install the private key as repository secret
`GYMLY_SSH_KEY`. Configure repository variables `GYMLY_SSH_HOST=147.93.121.98`,
`GYMLY_SSH_USER=gymly-deploy`, and `GYMLY_KNOWN_HOSTS` with the host's independently
verified Ed25519 host-key line. Never use runtime `ssh-keyscan` as the trust decision.

Add only `gymly.churntech.com` to the existing KVM2 tunnel, with service
`http://127.0.0.1:8090` and its proxied tunnel CNAME. Preserve all other ingress and DNS records.

## Check a release

```sh
ssh kvm2 'sudo cat /opt/gymly/current-release; curl -fsS http://127.0.0.1:8090/version.json; curl -fsS http://127.0.0.1:8090/api/health'
curl -fsS https://gymly.churntech.com/version.json
```

The revision must equal the deployed GitHub commit, and health must report `ok: true`,
`writable: true`. These checks do not prove a real person's passkey registration or
cross-device workout sync: verify those using an actual account on the final HTTPS domain.
No administrator is automatically assigned. After the owner creates a profile, use their
Settings → Account ID to set `ADMIN_UIDS` in `/etc/gymly/gymly.env`, if admin access is wanted,
and recreate only Gymly's API. Do not enable `FIRST_USER_ADMIN` on a public instance.

## Hosted MCP (ChatGPT / Claude connector)

Off until enabled. After a release containing it is deployed and verified, add the owner's
profile id to `/etc/gymly/gymly.env` and recreate only the API:

```sh
MCP_OAUTH_USERS=<founder profile id>
```

Then check from outside: `curl -fsS https://gymly.churntech.com/.well-known/oauth-authorization-server`
answers JSON with `"issuer": "https://gymly.churntech.com"`, and an unauthenticated
`POST /api/mcp` answers 401 with a `WWW-Authenticate: Bearer resource_metadata=…` header. No
tunnel, port or edge change is needed: the web image routes the two discovery paths to the API.
To switch it off again, remove the line and recreate the API; connections stay in `db.json`
but are refused while the variable is unset. Connections and the undo journal
(`data/mcp-journal-*.json`) are part of the normal data snapshot.

## Failed deployments and recovery

Before the new release can receive traffic, the receiver gates edge with HTTP 503, stops old
writers and snapshots all of `data/`. If the new API/web fails verification, it stops those
writers, preserves their directory as `failed-data`, restores the snapshot, starts the
previous images and verifies them before reopening traffic. A first deployment with no
previous release stays in maintenance if it fails.

After traffic may have reached the new version, **there is no automatic data restoration**:
that could erase new workouts. Keep all failed data and backups. Inspect compatibility and
choose either a forward fix or a coordinated recovery. Never restore an old data snapshot
over a running instance. Backups contain credentials and personal workout data; keep them
root-only and arrange off-server backups separately. Local pre-deploy snapshots alone do not
protect against loss of the VPS.

For a compatible code-only rollback, revert the offending change in Git and push the revert
to `main`, using the same tested deployment path. Avoid resetting or force-pushing history.
For a data-format change, assess the stored format before rolling code back.

## Maintenance

The server keeps prior image tags, before-update data archives and failed-release evidence.
No global Docker pruning or automatic backup deletion is performed. The receiver stops
before deployment if less than 3 GiB is free; review old Gymly backups/images deliberately.
An image transfer failure happens before maintenance and leaves the current app running.
The workflow retries SSH transport failures up to three times; application failures stop
for inspection instead of repeatedly restarting the app.

Deployment configuration changes in this directory need a reviewed bootstrap update on the
server. A normal `main` push updates application images automatically; it cannot replace
the root receiver, sudo rule, persistent data or server environment file through SSH.

Upstream's mirror, Pages, CLA, catalogue-write and image-publication workflows are retained
as reference under `docs/upstream-workflows/` and are not active in this fork.
