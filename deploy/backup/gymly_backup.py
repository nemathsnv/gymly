#!/usr/bin/python3
"""Gymly off-site backup and recovery verification (installed as /usr/local/sbin/gymly-backup).

  gymly-backup backup              consistent copy of data + configuration -> validate -> restic -> read-back -> tag verified
  gymly-backup maintain            freshness -> forget (+ prune on PRUNE_WEEKDAY) -> check (+ restore test on PRUNE_WEEKDAY)
  gymly-backup restore-test        restore the newest verified snapshot into a disposable directory and boot the API on it
  gymly-backup restore <id|latest> <new empty directory>
                                   recovery helper; refuses any target inside /opt/gymly
  gymly-backup verify-bucket       bucket is private, repository objects exist and are encrypted
  gymly-backup init                create the repository (refuses when one exists)
  gymly-backup status              local status and remote snapshots
  gymly-backup secret <name>       store a secret from hidden input: restic-password, spaces, kuma-backup,
                                   kuma-verify, heartbeat-backup, heartbeat-verify

Configuration: /etc/gymly-backup/backup.conf (non-secret). Secrets sit beside it, root 0600, and are never
printed, logged or passed in a process argument. GYMLY_BACKUP_CONF_DIR=<dir> selects a rehearsal
configuration with its own state, work directory and locks; it must not use the production BACKUP_HOST.
Only snapshots tagged "verified" (added once a run's read-back passed) count for freshness and restores.
Exit codes: 0 ok, 1 failure, 75 another run of the same job holds its lock. Root only; Python stdlib only.
"""
import datetime
import errno
import fcntl
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import random
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

DEFAULT_CONF_DIR = Path('/etc/gymly-backup')
CONF_DIR = Path(os.environ.get('GYMLY_BACKUP_CONF_DIR') or DEFAULT_CONF_DIR)
ALTERNATE = CONF_DIR != DEFAULT_CONF_DIR
PRODUCTION_BACKUP_HOST = 'gymly-kvm2'
BASE = Path('/opt/gymly')
DATA = BASE / 'data'
DEPLOY_LOCK = BASE / 'deploy.lock'
if ALTERNATE:
    STATE = CONF_DIR / 'state'
    WORK = CONF_DIR / 'work'
    CACHE = CONF_DIR / 'cache'
    LOCK_PREFIX = f'gymly-backup-{hashlib.sha256(str(CONF_DIR).encode()).hexdigest()[:8]}'
else:
    STATE = Path('/var/lib/gymly-backup')
    WORK = Path('/var/backups/gymly-dr')
    CACHE = Path('/var/cache/gymly-backup')
    LOCK_PREFIX = 'gymly-backup'
LOCK_DIR = Path('/run/lock')
TAG = 'gymly'
MANIFEST = 'MANIFEST.json'
API_IMAGE = 'gymly-api'
# Seconds per retry back-off step (tests set it to 0).
RETRY_SLEEP = 30
DEPLOY_WAIT_S = 45 * 60

# Copied into config/<absolute path> of every snapshot. Required paths missing -> the run fails.
# Deliberately absent: /etc/cloudflared (KVM2's shared tunnel, not Gymly's) and this tool's secrets.
CONFIG_PATHS = [
    ('/etc/gymly/gymly.env', True),
    ('/opt/gymly/deploy', True),
    ('/opt/gymly/current-release', True),
    ('/usr/local/sbin/gymly-deploy', True),
    ('/opt/gymly/previous-release', False),
    ('/opt/gymly/edge', False),
    ('/opt/gymly/.gymly-managed', False),
    ('/usr/local/sbin/gymly-ssh', False),
    ('/etc/sudoers.d/gymly-deploy', False),
    ('/home/gymly-deploy/.ssh/authorized_keys', False),
    ('/usr/local/sbin/gymly-backup', False),
    ('/etc/gymly-backup/backup.conf', False),
    ('/etc/systemd/system/gymly-backup.service', False),
    ('/etc/systemd/system/gymly-backup.timer', False),
    ('/etc/systemd/system/gymly-backup-maintain.service', False),
    ('/etc/systemd/system/gymly-backup-maintain.timer', False),
]

SECRETS = {
    'restic-password': 'restic-password',
    'spaces': 'spaces.env',
    'kuma-backup': 'kuma-backup.url',
    'kuma-verify': 'kuma-verify.url',
    'heartbeat-backup': 'heartbeat-backup.url',
    'heartbeat-verify': 'heartbeat-verify.url',
}
INTEGER_SETTINGS = {
    'MAX_BACKUP_AGE_HOURS': 7, 'KEEP_LAST': 4, 'KEEP_DAILY': 30, 'KEEP_WEEKLY': 12, 'PRUNE_WEEKDAY': 7,
    'CHECK_SUBSET_DENOMINATOR': 7, 'MIN_USERS': 1, 'MIN_FREE_MB': 1024,
}

JOB = '?'
STAGE = 'init'
STARTED = time.time()
CFG = {}


class Failure(Exception):
    pass


class Busy(Exception):
    pass


def log(msg):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    print(f'{stamp} [{JOB}] {msg}', file=sys.stderr, flush=True)


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------- configuration and secrets
def secret_path(name):
    return CONF_DIR / SECRETS[name]


def require_private(path):
    try:
        st = path.stat()
    except FileNotFoundError:
        raise Failure(f'missing {path}') from None
    if st.st_uid != 0 or st.st_mode & 0o077:
        raise Failure(f'{path} must be owned by root with mode 0600')


def read_env_file(path, private=True):
    """KEY=value lines only; values are never evaluated by a shell."""
    if private:
        require_private(path)
    values = {}
    for n, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = re.fullmatch(r'([A-Z_][A-Z0-9_]*)=(.*)', line)
        if not m:
            raise Failure(f'malformed line {n} in {path}')
        values[m[1]] = m[2].strip().strip('"')
    return values


def load_config(host_guard=True):
    conf = CONF_DIR / 'backup.conf'
    if not conf.is_file():
        raise Failure(f'missing {conf}')
    raw = read_env_file(conf, private=False)
    cfg = {'RESTIC_REPOSITORY': raw.get('RESTIC_REPOSITORY', ''),
           'BACKUP_HOST': raw.get('BACKUP_HOST') or PRODUCTION_BACKUP_HOST,
           'PRODUCTION_HOSTNAME': raw.get('PRODUCTION_HOSTNAME', 'srv804180')}
    if not cfg['RESTIC_REPOSITORY']:
        raise Failure('RESTIC_REPOSITORY not set in backup.conf')
    for key, default in INTEGER_SETTINGS.items():
        value = raw.get(key, str(default))
        if not re.fullmatch(r'[0-9]+', value):
            raise Failure(f'{key} must be a plain integer')
        cfg[key] = int(value)
    if not (cfg['MAX_BACKUP_AGE_HOURS'] and cfg['CHECK_SUBSET_DENOMINATOR'] and 1 <= cfg['PRUNE_WEEKDAY'] <= 7):
        raise Failure('invalid MAX_BACKUP_AGE_HOURS, CHECK_SUBSET_DENOMINATOR or PRUNE_WEEKDAY')
    if ALTERNATE and cfg['BACKUP_HOST'] == PRODUCTION_BACKUP_HOST:
        raise Failure('a rehearsal configuration must set a non-production BACKUP_HOST')
    # A restored or rehearsal copy of the server must never write to the production repository.
    # Read-only commands (restore, status) stay available on a replacement server.
    if host_guard and cfg['PRODUCTION_HOSTNAME'] and socket.gethostname().split('.')[0] != cfg['PRODUCTION_HOSTNAME']:
        raise Failure(f'this host is not PRODUCTION_HOSTNAME ({cfg["PRODUCTION_HOSTNAME"]}); refusing to run')
    password = secret_path('restic-password')
    require_private(password)
    if not password.read_text().strip():
        raise Failure('restic password file is empty')
    env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
           'TZ': 'UTC', 'LC_ALL': 'C', 'RESTIC_REPOSITORY': cfg['RESTIC_REPOSITORY'],
           'RESTIC_PASSWORD_FILE': str(password), 'RESTIC_CACHE_DIR': str(CACHE / 'restic')}
    if cfg['RESTIC_REPOSITORY'].startswith('s3:'):
        keys = read_env_file(secret_path('spaces'))
        if not keys.get('AWS_ACCESS_KEY_ID') or not keys.get('AWS_SECRET_ACCESS_KEY'):
            raise Failure('Spaces key missing in spaces.env')
        env['AWS_ACCESS_KEY_ID'] = keys['AWS_ACCESS_KEY_ID']
        env['AWS_SECRET_ACCESS_KEY'] = keys['AWS_SECRET_ACCESS_KEY']
    cfg['env'] = env
    for d in (STATE, WORK, CACHE, CACHE / 'restic'):
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
    CFG.clear()
    CFG.update(cfg)
    return cfg


def repo_location(repo):
    """s3:https://fra1.digitaloceanspaces.com/<bucket>/<prefix> -> (host, bucket, prefix)."""
    m = re.fullmatch(r's3:https://([^/]+)/([^/]+)/?(.*)', repo)
    if not m:
        raise Failure('RESTIC_REPOSITORY is not an s3:https://<endpoint>/<bucket>/<prefix> URL')
    return m[1], m[2], m[3].strip('/')


# ---------------------------------------------------------------- restic
def restic(*args, timeout=3600, lock=True, stdout=subprocess.PIPE, check=True):
    cmd = ['restic', *(['--retry-lock', '30m'] if lock else ['--no-lock']), *args]
    proc = subprocess.run(cmd, env=CFG['env'], stdout=stdout, stderr=subprocess.PIPE, timeout=timeout)
    if check and proc.returncode != 0:
        raise Failure(f'restic {args[0]} failed (rc={proc.returncode}): {first_lines(proc.stderr)}')
    return proc


def first_lines(err, n=3):
    text = err.decode('utf-8', 'replace') if isinstance(err, bytes) else (err or '')
    return ' '.join([l.strip() for l in text.splitlines() if l.strip()][:n])[:300]


def classify_repo_error(text):
    rules = [
        (('wrong password', 'no key found'), 'repository password rejected (encryption key mismatch)'),
        (('locked exclusively', 'unable to create lock'), 'repository still locked by another job after 30 min'),
        (('AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'Forbidden', '403'),
         'Spaces authentication/authorization failed'),
        (('NoSuchBucket', 'bucket does not exist'), 'bucket not found'),
        (('unable to open config', 'repository does not exist', 'config file does not exist', 'Is there a repository'),
         'repository not found or not initialised'),
        (('dial tcp', 'connection refused', 'no such host', 'timeout', 'TLS handshake', 'network is unreachable'),
         'repository unreachable (network failure)'),
    ]
    for needles, verdict in rules:
        if any(n in text for n in needles):
            return verdict
    return 'repository unreachable (network or backend error)'


def check_repo():
    global STAGE
    STAGE = 'repo-access'
    proc = restic('cat', 'config', timeout=35 * 60, stdout=subprocess.DEVNULL, check=False)
    if proc.returncode != 0:
        raise Failure(classify_repo_error(proc.stderr.decode('utf-8', 'replace')))


def snapshots(*tags, lock=True):
    args = ['snapshots', '--json', '--host', CFG['BACKUP_HOST']]
    for t in tags:
        args += ['--tag', t]
    return json.loads(restic(*args, timeout=35 * 60, lock=lock).stdout or b'[]') or []


def parse_restic_time(value):
    """restic prints RFC 3339 with nanoseconds; Python 3.10 reads at most microseconds and no 'Z'."""
    m = re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)', value)
    if not m:
        raise ValueError(f'unparseable snapshot time {value!r}')
    frac = (m[2] or '.')[1:7].ljust(6, '0')
    tz = '+00:00' if m[3] == 'Z' else m[3]
    return datetime.datetime.fromisoformat(f'{m[1]}.{frac}{tz}')


def latest_verified():
    snaps = snapshots(f'{TAG},verified')
    if not snaps:
        return None
    return max(snaps, key=lambda s: parse_restic_time(s['time']))


def mark_verified(snap_id):
    restic('tag', '--add', 'verified', snap_id, stdout=subprocess.DEVNULL)
    for s in snapshots(f'{TAG},verified'):
        if s.get('original') == snap_id or s['id'] == snap_id:
            return s['id']
    raise Failure(f'could not confirm the verified tag on {snap_id[:8]}')


# ---------------------------------------------------------------- consistent copy of /opt/gymly/data
def is_transient(rel):
    """Temporary files of in-flight writes (atomicWrite's *.tmp, uploads' .tmp/, the health probe)."""
    parts = Path(rel).parts
    return rel.endswith('.tmp') or '.tmp' in parts[:-1] or parts[-1].startswith('.health-')


def data_files(root):
    """{relative path: (inode, size, mtime_ns)} of every regular file the API keeps."""
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != '.tmp')
        for name in sorted(filenames):
            p = Path(dirpath) / name
            rel = str(p.relative_to(root))
            if is_transient(rel):
                continue
            try:
                st = p.lstat()
            except FileNotFoundError:
                continue   # renamed away between readdir and stat; the next listing will differ
            if not stat.S_ISREG(st.st_mode):
                raise Failure(f'unexpected non-regular file in the data directory: {rel}')
            files[rel] = (st.st_ino, st.st_size, st.st_mtime_ns)
    return files


def deploy_in_progress(lock_file=None, proc_locks='/proc/locks'):
    """True while gymly-deploy holds its flock. Read from /proc/locks: taking the lock ourselves would
    make a deploy that starts at that moment fail (it uses LOCK_NB)."""
    lock_file = Path(lock_file or DEPLOY_LOCK)
    try:
        st = lock_file.stat()
    except FileNotFoundError:
        return False
    want = (os.major(st.st_dev), os.minor(st.st_dev), st.st_ino)
    for line in Path(proc_locks).read_text().splitlines():
        fields = line.split()
        if len(fields) < 6 or fields[1].rstrip(':') == '->':
            continue
        dev = fields[5].split(':')
        if len(dev) == 3:
            try:
                if (int(dev[0], 16), int(dev[1], 16), int(dev[2])) == want:
                    return True
            except ValueError:
                continue
    return False


def wait_for_deploy():
    deadline = time.time() + DEPLOY_WAIT_S
    noted = False
    while deploy_in_progress():
        if not noted:
            log('a Gymly deployment is running; waiting for it to finish')
            noted = True
        if time.time() > deadline:
            raise Failure('a Gymly deployment held its lock for 45 min; no backup taken')
        time.sleep(15)


def copy_data(dest, source=None, attempts=5):
    """A copy of the data directory equal to its state at one instant, without pausing the API.

    Every API write is temp file + fsync + rename, so an open() sees one whole version of a file.
    If no file's inode, size or mtime changed between the listings before and after the copy, and no
    deployment started meanwhile, the copy is that instant's state. Otherwise the copy is retried.
    Uploads are content-addressed and never rewritten in place, so they are hard-linked, not copied."""
    source = Path(source or DATA)
    for attempt in range(1, attempts + 1):
        wait_for_deploy()
        before = data_files(source)
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(mode=0o700, parents=True)
        try:
            for rel in before:
                src, dst = source / rel, dest / rel
                dst.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                if rel.startswith('uploads/'):
                    try:
                        os.link(src, dst)
                        continue
                    except OSError as exc:
                        if exc.errno != errno.EXDEV:
                            raise
                shutil.copy2(src, dst)
        except FileNotFoundError:
            changed = True
        else:
            changed = data_files(source) != before or deploy_in_progress()
        if not changed:
            return before
        log(f'data changed while it was being copied (attempt {attempt}); retrying')
        time.sleep(min(attempt, 3) * RETRY_SLEEP / 10)
    raise Failure(f'data kept changing during {attempts} copy attempts')


def size(value):
    return len(value) if isinstance(value, (list, dict)) else 0


def load_json(root, rel):
    try:
        return json.loads((root / rel).read_text('utf-8'))
    except (OSError, ValueError):
        raise Failure(f'{rel} is missing or not valid JSON') from None


def data_counts(root, min_users=1):
    """Aggregate counts that prove what a restore brings back; no values, names or ids."""
    root = Path(root)
    for rel in ('db.json', 'secret', 'vapid.json'):
        if not (root / rel).is_file():
            raise Failure(f'data is missing {rel}')
    if not (root / 'secret').read_text().strip():
        raise Failure('session secret is empty')
    vapid = load_json(root, 'vapid.json')
    if not (isinstance(vapid, dict) and vapid.get('publicKey') and vapid.get('privateKey')):
        raise Failure('vapid.json has no key pair')
    db = load_json(root, 'db.json')
    if not isinstance(db, dict) or not isinstance(db.get('users'), list):
        raise Failure('db.json has no users list')
    counts = {'users': size(db['users']), 'passkeys': size(db.get('creds')), 'push_subscriptions': size(db.get('subs')),
              'invites': size(db.get('invites')), 'mcp_tokens': size(db.get('mcpTokens')),
              'mcp_grants': size(db.get('mcpGrants')), 'profiles_with_state': 0, 'workouts': 0, 'routines': 0,
              'habit_definitions': 0, 'habit_days': 0, 'bodyweight_entries': 0, 'json_files': 0,
              'upload_files': 0, 'upload_bytes': 0}
    if counts['users'] < min_users:
        raise Failure(f'db.json has {counts["users"]} users; expected at least {min_users}')
    for p in sorted(root.rglob('*')):
        rel = str(p.relative_to(root))
        if not p.is_file() or is_transient(rel):
            continue
        if rel.startswith('uploads/'):
            counts['upload_files'] += 1
            counts['upload_bytes'] += p.stat().st_size
            continue
        if not rel.endswith('.json'):
            continue
        doc = load_json(root, rel)
        counts['json_files'] += 1
        if re.fullmatch(r'state-[A-Za-z0-9_-]+\.json', rel):
            if not isinstance(doc, dict):
                raise Failure(f'{rel} is not a profile state')
            counts['profiles_with_state'] += 1
            counts['workouts'] += size(doc.get('workouts'))
            counts['routines'] += size(doc.get('routines'))
            counts['bodyweight_entries'] += size(doc.get('bodyweight'))
            habits = doc.get('habitLog') if isinstance(doc.get('habitLog'), dict) else {}
            defs = sum(1 for k in habits if k.endswith('|def'))
            counts['habit_definitions'] += defs
            counts['habit_days'] += len(habits) - defs
    return counts


def copy_config(dest, paths=None):
    missing = []
    for path, required in (paths or CONFIG_PATHS):
        src = Path(path)
        if not src.exists():
            if required:
                missing.append(path)
            continue
        dst = dest / path.lstrip('/')
        dst.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, symlinks=True)
        else:
            shutil.copy2(src, dst)
    if missing:
        raise Failure(f'required configuration missing: {" ".join(missing)}')


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def tree_files(root):
    return {str(p.relative_to(root)): p for p in sorted(Path(root).rglob('*')) if p.is_file() and not p.is_symlink()}


def write_manifest(root, counts, release):
    files = {rel: {'size': p.stat().st_size, 'sha256': sha256_file(p)}
             for rel, p in tree_files(root).items() if rel != MANIFEST}
    manifest = {'format': 1, 'created_utc': utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
                'backup_host': CFG.get('BACKUP_HOST'), 'release': release, 'counts': counts, 'files': files}
    (root / MANIFEST).write_text(json.dumps(manifest, indent=1, sort_keys=True) + '\n')
    os.chmod(root / MANIFEST, 0o600)
    return manifest


def verify_against_manifest(root, manifest=None):
    """Every file the manifest lists is present with its sha256, and nothing else is there."""
    root = Path(root)
    manifest = manifest or load_json(root, MANIFEST)
    present = {rel for rel in tree_files(root) if rel != MANIFEST}
    listed = set(manifest['files'])
    if present != listed:
        raise Failure(f'restored files differ from the manifest: {len(listed - present)} missing, '
                      f'{len(present - listed)} unexpected')
    for rel, meta in manifest['files'].items():
        if sha256_file(root / rel) != meta['sha256']:
            raise Failure(f'checksum mismatch after restore ({len(rel)}-character path)')
    return manifest


def verify_tar_stream(stream, manifest):
    """Hash every file of a `restic dump` tar stream against the manifest without writing it to disk."""
    seen = {}
    with tarfile.open(fileobj=stream, mode='r|') as tf:
        for member in tf:
            if not member.isfile():
                continue
            name = member.name.lstrip('/')
            for prefix in (str(WORK / 'snapshot').lstrip('/') + '/', 'snapshot/'):
                if name.startswith(prefix):
                    name = name[len(prefix):]
                    break
            h = hashlib.sha256()
            f = tf.extractfile(member)
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
            seen[name] = h.hexdigest()
    expected = {rel: meta['sha256'] for rel, meta in manifest['files'].items()}
    expected[MANIFEST] = manifest['_sha256']
    if seen != expected:
        missing = len(set(expected) - set(seen))
        wrong = sum(1 for k in expected if k in seen and seen[k] != expected[k])
        raise Failure(f'remote read-back differs: {missing} missing, {wrong} mismatched, '
                      f'{len(set(seen) - set(expected))} unexpected')
    return len(seen)


# ---------------------------------------------------------------- monitoring
def read_url(name):
    path = secret_path(name)
    if not path.exists():
        return None
    require_private(path)
    lines = path.read_text().split()
    return lines[0].split('?')[0] if lines else None


def http_get(url, attempts=3):
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                r.read(1024)
            return True
        except (urllib.error.URLError, OSError):
            if attempt + 1 < attempts:
                time.sleep(RETRY_SLEEP / 6)
    return False


def notify(kind, ok, msg):
    """Uptime Kuma push monitor (status up/down) and an optional off-host heartbeat (healthchecks.io
    style: GET <url> on success, <url>/fail on failure). URLs are secrets: never logged or in argv."""
    msg = re.sub(r'[^A-Za-z0-9._:=/ -]', '_', msg)[:120]
    kuma = read_url(f'kuma-{kind}')
    if kuma:
        query = urllib.parse.urlencode({'status': 'up' if ok else 'down', 'msg': msg,
                                        'ping': int((time.time() - STARTED) * 1000)})
        log(f'monitor: pushed status={"up" if ok else "down"}' if http_get(f'{kuma}?{query}')
            else 'monitor: push failed; the missing heartbeat will alert')
    else:
        log(f'monitor: no Kuma push URL for {kind}; skipped')
    beat = read_url(f'heartbeat-{kind}')
    if beat:
        log('heartbeat: sent' if http_get(beat if ok else beat.rstrip('/') + '/fail') else 'heartbeat: send failed')


def write_status(result, extra=None):
    path = STATE / 'status.json'
    try:
        status = json.loads(path.read_text())
    except (OSError, ValueError):
        status = {}
    now = utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    entry = {**status.get(JOB, {}), 'last_run': now, 'last_result': result, 'last_stage': STAGE,
             'last_duration_s': int(time.time() - STARTED)}
    if result == 'ok':
        entry.update({'last_success': now, **(extra or {})})
    status[JOB] = entry
    tmp = path.with_name('.status.tmp')
    tmp.write_text(json.dumps(status, indent=1, sort_keys=True) + '\n')
    os.chmod(tmp, 0o600)
    tmp.replace(path)


# ---------------------------------------------------------------- jobs
def check_free_space(path, need_mb):
    free = shutil.disk_usage(path).free // (1 << 20)
    if free < need_mb:
        raise Failure(f'insufficient disk space on {path}: need {need_mb} MiB, have {free} MiB')


def restic_backup(snapshot_dir, when):
    """Upload; returns the snapshot id. rc 3 (some input unreadable) still saves a snapshot: that partial
    snapshot is removed and the attempt counts as failed."""
    for attempt in (1, 2, 3):
        proc = restic('backup', '--host', CFG['BACKUP_HOST'], '--tag', TAG, '--time', when, '--json', '--quiet',
                      str(snapshot_dir), timeout=2 * 3600, check=False)
        summary = {}
        for line in proc.stdout.decode('utf-8', 'replace').splitlines():
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get('message_type') == 'summary':
                summary = msg
        snap_id = summary.get('snapshot_id', '')
        if proc.returncode == 0 and re.fullmatch(r'[0-9a-f]{64}', snap_id):
            log(f'restic: files_new={summary.get("files_new")} files_changed={summary.get("files_changed")} '
                f'added_bytes={summary.get("data_added")} total_bytes={summary.get("total_bytes_processed")}')
            return snap_id
        log(f'restic backup attempt {attempt} failed (rc={proc.returncode}): {first_lines(proc.stderr)}')
        if proc.returncode == 3 and re.fullmatch(r'[0-9a-f]{64}', snap_id):
            ok = restic('forget', snap_id, check=False, stdout=subprocess.DEVNULL).returncode == 0
            log(f'partial snapshot {snap_id[:8]} ' + ('removed' if ok else 'could not be removed; it stays unverified'))
        if attempt < 3:
            time.sleep(attempt * RETRY_SLEEP * 2)
    raise Failure('restic backup failed after 3 attempts')


def job_backup():
    global STAGE
    check_repo()
    STAGE = 'preflight'
    check_free_space(WORK, CFG['MIN_FREE_MB'])
    work = WORK / '.inprogress'
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(mode=0o700)
    STAGE = 'copy-data'
    when = utcnow().strftime('%Y-%m-%d %H:%M:%S')
    copy_data(work / 'data')
    STAGE = 'validate-data'
    counts = data_counts(work / 'data', CFG['MIN_USERS'])
    STAGE = 'copy-config'
    copy_config(work / 'config')
    release = (BASE / 'current-release').read_text().strip()
    STAGE = 'manifest'
    manifest = write_manifest(work, counts, release)
    manifest['_sha256'] = sha256_file(work / MANIFEST)
    log(f'staged {len(manifest["files"])} files for release {release[:12]}: ' +
        ' '.join(f'{k}={v}' for k, v in counts.items()))
    snapshot_dir = WORK / 'snapshot'
    if snapshot_dir.exists():
        shutil.rmtree(snapshot_dir)
    work.rename(snapshot_dir)
    STAGE = 'upload'
    snap_id = restic_backup(snapshot_dir, when)
    log(f'snapshot {snap_id[:8]} uploaded')
    STAGE = 'remote-verify'
    proc = subprocess.Popen(['restic', '--retry-lock', '30m', 'dump', '--archive', 'tar', snap_id, str(snapshot_dir)],
                            env=CFG['env'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        n = verify_tar_stream(proc.stdout, manifest)
    finally:
        proc.stdout.close()
        err = proc.stderr.read()
        rc = proc.wait(timeout=3600)
    if rc != 0:
        raise Failure(f'restic dump failed (rc={rc}): {first_lines(err)}')
    log(f'remote read-back verified: {n} files match their sha256')
    STAGE = 'mark-verified'
    snap_id = mark_verified(snap_id)
    STAGE = 'finished'
    write_status('ok', {'snapshot': snap_id[:8], 'release': release[:12], 'counts': counts})
    notify('backup', True, f'backup ok {snap_id[:8]} users={counts["users"]} workouts={counts["workouts"]}')


def check_freshness():
    """None when the newest verified snapshot is recent; otherwise a description of the problem."""
    try:
        latest = latest_verified()
    except Failure as exc:
        return f'snapshot listing failed: {exc}'
    if not latest:
        return 'no verified snapshot'
    try:
        age = (utcnow() - parse_restic_time(latest['time'])).total_seconds()
    except ValueError:
        return 'unparseable snapshot time'
    if age < -300:
        return 'newest verified snapshot is dated in the future'
    if age > CFG['MAX_BACKUP_AGE_HOURS'] * 3600:
        return f'newest verified snapshot is {int(age // 3600)}h old'
    log(f'freshness ok: newest verified snapshot {latest["id"][:8]} is {int(age // 60)} min old')
    return None


def job_maintain():
    global STAGE
    check_repo()
    STAGE = 'unlock-stale'
    restic('unlock', check=False, stdout=subprocess.DEVNULL)   # removes stale locks only
    STAGE = 'freshness'
    stale = check_freshness()
    weekday = utcnow().isoweekday()
    if stale:
        # Fail closed: retention never runs while the newest recovery point is missing or old.
        log(f'retention skipped: {stale}')
    else:
        STAGE = 'forget'
        dry = ['--dry-run'] if os.environ.get('RETENTION_DRY_RUN') == '1' else []
        restic('forget', *dry, '--host', CFG['BACKUP_HOST'], '--tag', TAG, '--group-by', 'host,tags',
               '--keep-last', str(CFG['KEEP_LAST']), '--keep-daily', str(CFG['KEEP_DAILY']),
               '--keep-weekly', str(CFG['KEEP_WEEKLY']), stdout=subprocess.DEVNULL)
        log(f'retention applied{" (dry run)" if dry else ""}: last {CFG["KEEP_LAST"]}, '
            f'{CFG["KEEP_DAILY"]} daily, {CFG["KEEP_WEEKLY"]} weekly')
        if not dry and (weekday == CFG['PRUNE_WEEKDAY'] or os.environ.get('FORCE_PRUNE') == '1'):
            STAGE = 'prune'
            restic('prune', '--max-unused', '5%', timeout=3 * 3600, stdout=subprocess.DEVNULL)
            log('prune done')
    STAGE = 'check'
    denom = CFG['CHECK_SUBSET_DENOMINATOR']
    subset = f'{utcnow().timetuple().tm_yday % denom + 1}/{denom}'
    restic('check', '--read-data-subset', subset, timeout=3 * 3600, stdout=subprocess.DEVNULL)
    log(f'repository check ok (data subset {subset})')
    tested = None
    if weekday == CFG['PRUNE_WEEKDAY'] or os.environ.get('FORCE_RESTORE_TEST') == '1':
        tested = restore_test()
    STAGE = 'finished'
    if stale:
        STAGE = 'freshness'
        raise Failure(stale)
    write_status('ok', {'check_subset': subset, **({'restore_test': tested} if tested else {})})
    notify('verify', True, f'verify ok check={subset}' + (f' restore={tested}' if tested else ''))


def restore_snapshot(snap_id, target, lock=True):
    target.mkdir(mode=0o700, parents=True)
    restic('restore', f'{snap_id}:{WORK / "snapshot"}', '--target', str(target), timeout=2 * 3600,
           lock=lock, stdout=subprocess.DEVNULL)
    if not (target / MANIFEST).is_file():
        raise Failure('restored snapshot has no manifest')
    return verify_against_manifest(target)


def boot_api(data_dir, release, name):
    """Start the release's own API image on the restored data, with no network, and ask it for /api/health.
    It refuses to start when db.json and db.json.bak are both unreadable. Returns 'ok' or 'skipped'."""
    image = f'{API_IMAGE}:{release}'
    if subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode != 0:
        log(f'API boot test skipped: image for release {release[:12]} is not on this host')
        return 'skipped'
    subprocess.run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges:true', '--memory', '384m', '--pids-limit', '128',
                    '-e', 'PORT=3000', '-e', 'DATA_DIR=/data', '-v', f'{data_dir}:/data', image],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(45):
        probe = subprocess.run(['docker', 'exec', name, 'wget', '-qO-', 'http://127.0.0.1:3000/api/health'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            try:
                body = json.loads(probe.stdout)
            except ValueError:
                body = {}
            if body.get('ok') is True and body.get('writable') is True:
                break
        time.sleep(2)
    else:
        raise Failure('restored data: the API did not become healthy')
    logs = subprocess.run(['docker', 'logs', name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout
    if b'using db.json.bak' in logs or b'Refusing to start' in logs:
        raise Failure('restored db.json was unreadable; the API fell back to db.json.bak')
    log(f'API {release[:12]} started on the restored data and reported healthy')
    return 'ok'


def restore_test():
    """Restore the newest verified snapshot into a disposable directory, never near /opt/gymly/data."""
    global STAGE
    STAGE = 'restore-test'
    lock = take_lock('restore')
    root = WORK / 'restore-test'
    name = f'gymly-restore-test-{os.getpid()}'

    def cleanup():
        for c in subprocess.run(['docker', 'ps', '-aq', '--filter', 'name=^gymly-restore-test-'],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.split():
            subprocess.run(['docker', 'rm', '-f', '-v', c], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(root, ignore_errors=True)

    cleanup()   # holding the restore lock, anything left is from a killed run
    try:
        check_free_space(WORK, CFG['MIN_FREE_MB'])
        latest = latest_verified()
        if not latest:
            raise Failure('no verified snapshot to restore')
        snap = latest['id']
        log(f'restore test: restoring snapshot {snap[:8]} from the remote repository')
        manifest = restore_snapshot(snap, root / 'restore')
        log(f'restore test: {len(manifest["files"])} files match the manifest checksums')
        counts = data_counts(root / 'restore' / 'data', CFG['MIN_USERS'])
        if counts != manifest['counts']:
            raise Failure('restored data counts differ from the counts recorded at backup time')
        try:
            live = data_counts(DATA, 0)
        except (Failure, OSError) as exc:
            live = {}
            log(f'restore test: live data could not be counted for comparison: {exc}')
        for key in ('users', 'passkeys', 'profiles_with_state', 'workouts', 'routines', 'habit_definitions',
                    'habit_days', 'mcp_grants', 'upload_files'):
            log(f'restore test: {key} backup={counts[key]} live={live.get(key, "?")}')
        boot = boot_api(root / 'restore' / 'data', manifest['release'], name)
        log(f'restore test passed for snapshot {snap[:8]} (API boot: {boot})')
        return f'{snap[:8]}:{boot}'
    finally:
        cleanup()
        lock.close()


def job_restore_test():
    check_repo()
    tested = restore_test()
    write_status('ok', {'restore_test': tested})
    notify('verify', True, f'restore-test ok {tested}')


def job_restore(which, target):
    """Recovery helper: restore one snapshot into a NEW directory and check it. Uses --no-lock, so a
    read-only recovery key is enough. Never restores into /opt/gymly; copying into place is manual."""
    target = Path(target).resolve()
    if target == BASE or BASE in target.parents:
        raise Failure('refusing to restore inside /opt/gymly; restore elsewhere and copy deliberately')
    if target.exists() and any(target.iterdir()):
        raise Failure(f'{target} is not empty')
    if which == 'latest':
        snaps = snapshots(f'{TAG},verified', lock=False)
        if not snaps:
            raise Failure('no verified snapshot')
        which = max(snaps, key=lambda s: parse_restic_time(s['time']))['id']
    if not re.fullmatch(r'[0-9a-f]{8,64}', which):
        raise Failure('snapshot must be "latest" or a snapshot id')
    if target.exists():
        target.rmdir()
    manifest = restore_snapshot(which, target, lock=False)
    counts = data_counts(target / 'data', 0)
    if counts != manifest['counts']:
        raise Failure('restored data counts differ from the backup manifest')
    print(f'Restored snapshot {which[:8]} (release {manifest["release"][:12]}, taken {manifest["created_utc"]}) '
          f'into {target}: {len(manifest["files"])} files verified.')
    print(' '.join(f'{k}={v}' for k, v in counts.items()))
    print(f'Data: {target}/data   Configuration: {target}/config   See DISASTER_RECOVERY.md before copying.')


def job_init():
    bucket = repo_location(CFG['RESTIC_REPOSITORY'])[1] if CFG['RESTIC_REPOSITORY'].startswith('s3:') else None
    proc = restic('cat', 'config', check=False, stdout=subprocess.DEVNULL)
    if proc.returncode == 0:
        raise Failure('repository already initialised; refusing to re-initialise')
    verdict = classify_repo_error(proc.stderr.decode('utf-8', 'replace'))
    if verdict != 'repository not found or not initialised':
        raise Failure(f'cannot initialise: {verdict}')
    restic('init', '--repository-version', '2', stdout=subprocess.DEVNULL)
    repo_id = json.loads(restic('cat', 'config', stdout=subprocess.PIPE).stdout)['id']
    log(f'repository initialised (id {repo_id[:8]}{f", bucket {bucket}" if bucket else ""}); '
        'keep its password and URL in the password manager')


def job_status():
    try:
        print(json.dumps(json.loads((STATE / 'status.json').read_text()), indent=1, sort_keys=True))
    except (OSError, ValueError):
        print('no local status yet')
    for s in sorted(snapshots(TAG, lock=False), key=lambda s: s['time'])[-12:]:
        print(s['short_id'], s['time'][:19], ','.join(s.get('tags') or []))


# ---------------------------------------------------------------- bucket verification (SigV4, stdlib only)
def sigv4_get(host, path, query, region, key_id, secret, now=None):
    now = now or utcnow()
    amz_date, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    q = '&'.join(f'{urllib.parse.quote(k, safe="-_.~")}={urllib.parse.quote(v, safe="-_.~")}'
                 for k, v in sorted(query.items()))
    payload = hashlib.sha256(b'').hexdigest()
    canonical = '\n'.join(['GET', urllib.parse.quote(path, safe='/-_.~'), q,
                           f'host:{host}\nx-amz-content-sha256:{payload}\nx-amz-date:{amz_date}\n',
                           'host;x-amz-content-sha256;x-amz-date', payload])
    scope = f'{day}/{region}/s3/aws4_request'
    to_sign = '\n'.join(['AWS4-HMAC-SHA256', amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    k = ('AWS4' + secret).encode()
    for part in (day, region, 's3', 'aws4_request'):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    headers = {'x-amz-date': amz_date, 'x-amz-content-sha256': payload,
               'Authorization': f'AWS4-HMAC-SHA256 Credential={key_id}/{scope}, '
                                f'SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}'}
    url = f'https://{host}{urllib.parse.quote(path, safe="/-_.~")}' + (f'?{q}' if q else '')
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
        return r.read()


def anonymous_status(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as exc:
        return exc.code


def job_verify_bucket():
    host, bucket, prefix = repo_location(CFG['RESTIC_REPOSITORY'])
    region = host.split('.')[0]
    key_id, secret = CFG['env']['AWS_ACCESS_KEY_ID'], CFG['env']['AWS_SECRET_ACCESS_KEY']
    for what, url in (('anonymous bucket listing', f'https://{host}/{bucket}/'),
                      ('anonymous read of the repository config', f'https://{host}/{bucket}/{prefix}/config')):
        code = anonymous_status(url)
        if code not in (401, 403):
            raise Failure(f'{what} answered HTTP {code}; the bucket must be private')
        log(f'private: {what} refused (HTTP {code})')
    groups, total, token = {}, 0, None
    ns = '{http://s3.amazonaws.com/doc/2006-03-01/}'
    while True:
        query = {'list-type': '2', 'prefix': prefix + '/', **({'continuation-token': token} if token else {})}
        root = ET.fromstring(sigv4_get(host, f'/{bucket}/', query, region, key_id, secret))
        for item in root.iter(f'{ns}Contents'):
            rel = item.find(f'{ns}Key').text[len(prefix) + 1:]
            group = rel.split('/')[0]
            groups[group] = groups.get(group, 0) + 1
            total += int(item.find(f'{ns}Size').text)
        token_el = root.find(f'{ns}NextContinuationToken')
        if root.findtext(f'{ns}IsTruncated') != 'true' or token_el is None:
            break
        token = token_el.text
    for needed in ('config', 'keys', 'snapshots', 'index', 'data'):
        if not groups.get(needed):
            raise Failure(f'repository has no {needed} objects')
    config = sigv4_get(host, f'/{bucket}/{prefix}/config', {}, region, key_id, secret)
    try:
        json.loads(config)
        raise Failure('repository config is readable plaintext JSON; expected ciphertext')
    except ValueError:
        pass
    log(f'bucket {bucket}: ' + ' '.join(f'{k}={v}' for k, v in sorted(groups.items())) +
        f' total_bytes={total}; repository config is ciphertext')


# ---------------------------------------------------------------- secrets from hidden input
def write_secret_file(path, text):
    CONF_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, text.encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def valid_url(url):
    p = urllib.parse.urlsplit(url)
    local = p.hostname in ('127.0.0.1', 'localhost')
    return (p.scheme == 'https' or (p.scheme == 'http' and local)) and bool(p.netloc) and len(url) < 400 \
        and not re.search(r'\s', url)


def job_secret(name, replace=False, ask=getpass.getpass, tty=None):
    if name not in SECRETS:
        raise Failure(f'unknown secret {name!r}; one of: {", ".join(SECRETS)}')
    if not (sys.stdin.isatty() if tty is None else tty):
        raise Failure('run this in an interactive terminal: ssh -t kvm2 sudo gymly-backup secret ' + name)
    path = secret_path(name)
    if name == 'restic-password':
        if path.exists() and not replace:
            raise Failure('a restic password is already stored; changing it would lock out the repository '
                          '(use restic key add/remove, then --replace)')
        first = ask('Restic repository password from your password manager (hidden): ')
        if len(first) < 24 or first != first.strip():
            raise Failure('password must be at least 24 characters, no surrounding spaces')
        if ask('Again, to confirm (hidden): ') != first:
            raise Failure('the two entries differ; nothing stored')
        text = first + '\n'
    elif name == 'spaces':
        key_id = ask('Spaces access key ID (hidden): ').strip()
        secret = ask('Spaces secret key (hidden): ').strip()
        if not re.fullmatch(r'[A-Z0-9]{16,32}', key_id) or not re.fullmatch(r'[A-Za-z0-9+/=]{30,64}', secret):
            raise Failure('that does not look like a Spaces key pair; nothing stored')
        text = f'AWS_ACCESS_KEY_ID={key_id}\nAWS_SECRET_ACCESS_KEY={secret}\n'
    else:
        url = ask('URL (hidden): ').strip().split('?')[0]
        if not valid_url(url):
            raise Failure('expected an https:// URL (or http://127.0.0.1 for the local Uptime Kuma)')
        text = url + '\n'
    write_secret_file(path, text)
    print(f'stored {path} (root, mode 0600)')


# ---------------------------------------------------------------- main
def take_lock(job):
    f = open(LOCK_DIR / f'{LOCK_PREFIX}-{job}.lock', 'a')
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        raise Busy(f'another gymly-backup {job} run holds the lock; exiting without changes') from None
    return f


def on_signal(signum, frame):
    raise Failure(f'interrupted by signal {signum}')


USAGE = __doc__.split('\n\n')[0]


def main(argv):
    global JOB, STAGE
    if not argv or argv[0] not in ('backup', 'maintain', 'restore-test', 'restore', 'verify-bucket', 'init',
                                   'status', 'secret'):
        print(USAGE, file=sys.stderr)
        return 2
    JOB = argv[0]
    if os.geteuid() != 0:
        print('gymly-backup must run as root', file=sys.stderr)
        return 1
    os.umask(0o077)
    kind = {'backup': 'backup', 'maintain': 'verify', 'restore-test': 'verify'}.get(JOB)
    try:
        if JOB == 'secret':
            if len(argv) not in (2, 3) or (len(argv) == 3 and argv[2] != '--replace'):
                raise Failure('usage: gymly-backup secret <name> [--replace]')
            job_secret(argv[1], replace=len(argv) == 3)
            return 0
        lock = take_lock(JOB)
        signal.signal(signal.SIGTERM, on_signal)
        signal.signal(signal.SIGINT, on_signal)
        load_config(host_guard=JOB not in ('restore', 'status'))
        if JOB == 'restore':
            if len(argv) != 3:
                raise Failure('usage: gymly-backup restore <snapshot id|latest> <new empty directory>')
            job_restore(argv[1], argv[2])
            return 0
        if JOB in ('status', 'init', 'verify-bucket'):
            {'status': job_status, 'init': job_init, 'verify-bucket': job_verify_bucket}[JOB]()
            return 0
        repo = re.sub(r'^s3:https?://([^/]+)/.*', r'\1', CFG['RESTIC_REPOSITORY'])
        log(f'start (repository host: {repo if repo != CFG["RESTIC_REPOSITORY"] else "local"})')
        {'backup': job_backup, 'maintain': job_maintain, 'restore-test': job_restore_test}[JOB]()
        log(f'finished in {int(time.time() - STARTED)}s')
        lock.close()
        return 0
    except Busy as exc:
        log(str(exc))
        return 75
    except (Failure, subprocess.SubprocessError, OSError) as exc:
        log(f'ERROR stage={STAGE}: {exc}')
        if kind:
            # Sensitive work files never outlive a failed run.
            shutil.rmtree(WORK / '.inprogress', ignore_errors=True)
            try:
                write_status('failed')
            except OSError:
                pass
            notify(kind, False, f'{JOB} failed at {STAGE}')
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
