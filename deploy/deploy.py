#!/usr/bin/python3
"""Root-owned, forced-command receiver. Only installs Gymly image pairs, never shell commands."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time

BASE = Path('/opt/gymly')
DEPLOY = BASE / 'deploy'
CURRENT = BASE / 'current-release'
DATA = BASE / 'data'
MAX_ARCHIVE = 1024 * 1024 * 1024


def run(args, **kw):
    return subprocess.run(args, check=True, text=True, **kw)


def compose(sha, *args, **kw):
    return run(['docker', 'compose', '--env-file', '/etc/gymly/gymly.env',
                '-p', 'gymly', '-f', str(DEPLOY / 'compose.yml'), *args],
               env={**os.environ, 'GYMLY_RELEASE': sha}, **kw)


def atomic(path, text):
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(text)
    tmp.replace(path)


def edge(sha, live):
    source = DEPLOY / ('edge-live.conf' if live else 'edge-maintenance.conf')
    atomic(BASE / 'edge/default.conf', source.read_text())
    compose(sha, 'up', '-d', '--no-deps', 'edge')
    compose(sha, 'exec', '-T', 'edge', 'nginx', '-t')
    compose(sha, 'exec', '-T', 'edge', 'nginx', '-s', 'reload')
    # nginx reload is asynchronous. Confirm that NEW connections see the requested state.
    import urllib.request
    import urllib.error
    expected = 200 if live else 503
    for _ in range(30):
        try:
            status = urllib.request.urlopen('http://127.0.0.1:8090/', timeout=3).status
        except urllib.error.HTTPError as exc:
            status = exc.code
        except OSError:
            status = 0
        if status == expected:
            # Let in-flight requests drain before any data snapshot.
            if not live:
                time.sleep(2)
            return
        time.sleep(1)
    raise RuntimeError(f'Edge did not reach HTTP {expected}')


def healthy(sha):
    # Check the API THROUGH the actual web proxy, including a writeability probe in /api/health.
    for attempt in range(60):
        try:
            result = compose(sha, 'exec', '-T', 'web', 'wget', '-qO-',
                             'http://127.0.0.1:8080/api/health', capture_output=True)
            body = json.loads(result.stdout)
            if body.get('ok') is not True or body.get('writable') is not True:
                raise RuntimeError('API data directory is not writable')
            version = compose(sha, 'exec', '-T', 'web', 'wget', '-qO-',
                              'http://127.0.0.1:8080/version.json', capture_output=True)
            if json.loads(version.stdout).get('revision') != sha:
                raise RuntimeError('Wrong web revision')
            html = compose(sha, 'exec', '-T', 'web', 'wget', '-qO-',
                           'http://127.0.0.1:8080/', capture_output=True).stdout
            if '<title>Gymly</title>' not in html:
                raise RuntimeError('Gymly branding is missing')
            return
        except (subprocess.CalledProcessError, ValueError, RuntimeError):
            if attempt == 59:
                raise
            time.sleep(2)


def receive_images(sha, digest, release):
    archive = release / 'images.tar.gz'
    pending = release / 'images.part'
    h = hashlib.sha256()
    total = 0
    with pending.open('wb') as stream:
        while chunk := sys.stdin.buffer.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_ARCHIVE:
                raise RuntimeError('Release archive exceeds 1 GiB')
            stream.write(chunk)
            h.update(chunk)
    if h.hexdigest() != digest:
        raise RuntimeError('Release checksum mismatch')
    pending.replace(archive)
    # Inspect, do not extract the transport archive onto the host.
    with tarfile.open(archive, 'r:gz') as tf:
        info = tf.getmember('manifest.json')
        if info.size > 65536 or not info.isfile():
            raise RuntimeError('Invalid image manifest')
        manifest = json.load(tf.extractfile(info))
        tags = [tag for item in manifest for tag in item.get('RepoTags', [])]
        if len(manifest) != 2 or sorted(tags) != [f'gymly-api:{sha}', f'gymly-web:{sha}']:
            raise RuntimeError('Archive must contain exactly the two Gymly release images')
    run(['docker', 'load', '-i', str(archive)])
    for kind in ('api', 'web'):
        image = json.loads(run(['docker', 'image', 'inspect', f'gymly-{kind}:{sha}'], capture_output=True).stdout)[0]
        if image['Config']['Labels'].get('org.opencontainers.image.revision') != sha:
            raise RuntimeError('Image revision label mismatch')
    return archive


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise RuntimeError('Use the installed forced-command SSH gateway')
    match = re.fullmatch(r'deploy ([0-9a-f]{40}) ([0-9a-f]{64})', sys.argv[1])
    if not match:
        raise RuntimeError('Only deploy <commit SHA> <archive SHA256> is accepted')
    sha, digest = match.groups()
    with (BASE / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deploy_release(sha, digest)


def deploy_release(sha, digest):
    previous = CURRENT.read_text().strip() if CURRENT.exists() else None
    if previous and not re.fullmatch('[0-9a-f]{40}', previous):
        raise RuntimeError('Invalid current-release marker')
    if shutil.disk_usage(BASE).free < 3 * 1024 ** 3:
        raise RuntimeError('Less than 3 GiB free; retain backups and free space before retrying')
    release = BASE / 'releases' / f'{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}-{sha}'
    release.mkdir(mode=0o700)
    archive = receive_images(sha, digest, release)
    compose(sha, 'config', '--quiet')
    backup = release / 'before-data.tar.gz'
    gated = False
    stopped = False
    started = False
    exposed = False
    try:
        edge(sha, False)
        gated = True
        compose(previous or sha, 'stop', '-t', '30', 'web', 'api')
        stopped = True
        with tarfile.open(backup, 'w:gz') as tf:
            tf.add(DATA, arcname='data')
        started = True
        compose(sha, 'up', '-d', '--no-build', '--pull', 'never', 'api', 'web')
        healthy(sha)
        # This boundary is deliberate: after opening traffic, never auto-restore stale data.
        exposed = True
        edge(sha, True)
        if previous:
            atomic(BASE / 'previous-release', previous + '\n')
        atomic(CURRENT, sha + '\n')
        atomic(DEPLOY / 'release.env', f'GYMLY_RELEASE={sha}\n')
        (release / 'deployment.json').write_text(json.dumps({
            'revision': sha, 'previous': previous, 'status': 'healthy',
            'url': 'https://gymly.churntech.com', 'archive_sha256': digest,
        }, indent=2) + '\n')
        # Images are loaded and retained by Docker; keep a checksum, not a redundant archive.
        (release / 'archive.sha256').write_text(digest + '\n')
        archive.unlink()
        print(f'Gymly deployed and verified: {sha}', flush=True)
    except BaseException:
        if exposed:
            print('Traffic may have reached this release. Data was NOT automatically restored.', file=sys.stderr)
            print(f'Inspect {release} and use the recovery runbook.', file=sys.stderr)
            raise
        if gated:
            if started:
                compose(sha, 'stop', '-t', '30', 'web', 'api')
                DATA.rename(release / 'failed-data')
                # This archive was just created locally after old writers stopped.
                with tarfile.open(backup) as tf:
                    tf.extractall(BASE, filter='data')
            if previous and stopped:
                compose(previous, 'up', '-d', '--no-build', '--pull', 'never', 'api', 'web')
                healthy(previous)
            if previous:
                edge(previous, True)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'DEPLOY FAILED: {exc}', file=sys.stderr)
        sys.exit(1)
