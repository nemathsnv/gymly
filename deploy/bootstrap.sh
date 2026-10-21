#!/usr/bin/env bash
# Run on KVM2 as root: bash bootstrap.sh /path/to/gymly-deploy.pub
# Installs only Gymly's directories, forced SSH command and sudo rule. No existing service restarts.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 && $(hostname) == srv804180 ]] || { echo 'Expected root on KVM2 (srv804180)'; exit 1; }
[[ $# == 1 && -f $1 ]] || { echo 'Supply the dedicated deployment public key'; exit 1; }
[[ $(cat "$1") =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+\ gymly-github-actions$ ]] || { echo 'Unexpected public key'; exit 1; }
command -v docker >/dev/null
command -v python3 >/dev/null
python3 -c 'import tarfile; assert hasattr(tarfile, "data_filter"), "Python with tar data filter required"'
docker compose version
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BASE=/opt/gymly
if [[ -e $BASE && ! -f $BASE/.gymly-managed ]]; then
  echo 'Refusing to use an existing unmanaged /opt/gymly'; exit 1
fi
if [[ ! -d $BASE ]]; then
  ! ss -lntH 'sport = :8090' | grep -q . || { echo 'Loopback port 8090 is already used'; exit 1; }
fi
install -d -m 700 "$BASE" "$BASE/data" "$BASE/releases" /etc/gymly
install -d -m 755 "$BASE/deploy" "$BASE/edge"
touch "$BASE/.gymly-managed"
if [[ -f $BASE/deploy/compose.yml ]]; then
  config_backup="$BASE/releases/bootstrap-$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 700 "$config_backup"
  cp -a "$BASE/deploy" "$config_backup/"
  cp -a /usr/local/sbin/gymly-deploy "$config_backup/" 2>/dev/null || true
fi
install -m 644 "$SOURCE_DIR/compose.yml" "$SOURCE_DIR/edge-live.conf" "$SOURCE_DIR/edge-maintenance.conf" "$BASE/deploy/"
install -m 755 "$SOURCE_DIR/deploy.py" /usr/local/sbin/gymly-deploy
install -m 755 "$SOURCE_DIR/ssh-gateway.sh" /usr/local/sbin/gymly-ssh
if [[ ! -f /etc/gymly/gymly.env ]]; then
  docker pull nginx:alpine
  edge_image=$(docker image inspect nginx:alpine --format '{{index .RepoDigests 0}}')
  [[ $edge_image == nginx@sha256:* ]]
  cat > /etc/gymly/gymly.env <<EOF
RP_ID=gymly.churntech.com
ORIGIN=https://gymly.churntech.com
RP_NAME=Gymly
ALLOW_GUEST=1
FIRST_USER_ADMIN=0
INVITE_ONLY=0
GYMLY_EDGE_IMAGE=$edge_image
EOF
  chmod 600 /etc/gymly/gymly.env
fi
if [[ ! -f $BASE/edge/default.conf ]]; then
  install -m 644 "$SOURCE_DIR/edge-maintenance.conf" "$BASE/edge/default.conf"
fi
if ! id gymly-deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/sh gymly-deploy
fi
[[ $(id -nG gymly-deploy) == gymly-deploy ]] || { echo 'Deploy account has unexpected groups'; exit 1; }
install -d -o gymly-deploy -g gymly-deploy -m 700 /home/gymly-deploy/.ssh
authfile=/home/gymly-deploy/.ssh/authorized_keys
key_line="restrict,command=\"/usr/local/sbin/gymly-ssh\" $(cat "$1")"
if [[ -f $authfile ]] && ! grep -qxF "$key_line" "$authfile"; then
  echo 'Deploy account already has a different key; refusing to replace it'; exit 1
fi
printf '%s\n' "$key_line" > "$authfile"
chown gymly-deploy:gymly-deploy "$authfile"
chmod 600 "$authfile"
printf '%s\n' 'gymly-deploy ALL=(root) NOPASSWD: /usr/local/sbin/gymly-deploy *' > /etc/sudoers.d/gymly-deploy
chmod 440 /etc/sudoers.d/gymly-deploy
visudo -cf /etc/sudoers.d/gymly-deploy
python3 -m py_compile /usr/local/sbin/gymly-deploy
echo 'Gymly bootstrap complete. The next main push deploys to loopback 127.0.0.1:8090.'
