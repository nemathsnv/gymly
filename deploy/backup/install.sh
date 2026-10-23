#!/usr/bin/env bash
# Run on KVM2 as root from a checkout of the reviewed commit: bash deploy/backup/install.sh [--enable]
# Installs restic (pinned, checksum-verified), /usr/local/sbin/gymly-backup, the systemd units and the
# runbook. Never overwrites /etc/gymly-backup/backup.conf or any secret. Touches no Gymly container,
# no data and no other service. Without --enable the timers stay as they are.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 && $(hostname) == srv804180 ]] || { echo 'Expected root on KVM2 (srv804180)'; exit 1; }
[[ $# == 0 || $* == --enable ]] || { echo 'usage: install.sh [--enable]'; exit 2; }
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
RESTIC_VERSION=0.19.1
# From the release's SHA256SUMS, whose signature by the restic release key
# CF8F18F2844575973F79D4E191A6868BD3F7A907 was verified on 2026-10-23.
RESTIC_SHA256=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c

python3 -c 'import sys; assert sys.version_info >= (3, 10)'
command -v docker bzip2 curl >/dev/null

if [[ $(/usr/local/bin/restic version 2>/dev/null | awk '{print $2}') != "$RESTIC_VERSION" ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --max-time 300 -o "$tmp/restic.bz2" \
    "https://github.com/restic/restic/releases/download/v$RESTIC_VERSION/restic_${RESTIC_VERSION}_linux_amd64.bz2"
  echo "$RESTIC_SHA256  $tmp/restic.bz2" | sha256sum -c --quiet
  bunzip2 "$tmp/restic.bz2"
  install -m 0755 "$tmp/restic" /usr/local/bin/restic
fi
/usr/local/bin/restic version

install -d -m 0700 /etc/gymly-backup /var/lib/gymly-backup /var/backups/gymly-dr /var/cache/gymly-backup
if [[ ! -f /etc/gymly-backup/backup.conf ]]; then
  install -m 0600 "$SOURCE_DIR/backup.conf.example" /etc/gymly-backup/backup.conf
fi
install -m 0750 "$SOURCE_DIR/gymly_backup.py" /usr/local/sbin/gymly-backup
python3 -m py_compile /usr/local/sbin/gymly-backup
for unit in gymly-backup.service gymly-backup.timer gymly-backup-maintain.service gymly-backup-maintain.timer; do
  install -m 0644 "$SOURCE_DIR/systemd/$unit" "/etc/systemd/system/$unit"
done
install -d -m 0755 /usr/local/share/doc/gymly-backup
install -m 0644 "$SOURCE_DIR/DISASTER_RECOVERY.md" /usr/local/share/doc/gymly-backup/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/gymly-backup*.service /etc/systemd/system/gymly-backup*.timer

if [[ $* == --enable ]]; then
  for s in restic-password spaces.env; do
    [[ -f /etc/gymly-backup/$s ]] || { echo "Missing /etc/gymly-backup/$s; store it with gymly-backup secret first"; exit 1; }
  done
  systemctl enable --now gymly-backup.timer gymly-backup-maintain.timer
fi
systemctl list-timers 'gymly-backup*' --all --no-pager
echo 'gymly-backup installed.'
