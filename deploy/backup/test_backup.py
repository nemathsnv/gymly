"""Synthetic backup tests; no restic, Docker, network, credentials or real user data."""
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gymly_backup', Path(__file__).with_name('gymly_backup.py'))
gb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gb)
gb.RETRY_SLEEP = 0


def make_data(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / 'db.json').write_text(json.dumps({'users': [{'id': 'u1'}, {'id': 'u2'}], 'creds': [{}, {}, {}],
                                              'subs': [{}], 'mcpGrants': []}))
    (root / 'db.json.bak').write_text((root / 'db.json').read_text())
    (root / 'secret').write_text('ab' * 32)
    (root / 'vapid.json').write_text(json.dumps({'publicKey': 'p', 'privateKey': 'q'}))
    (root / 'audit.log').write_text('{"e":1}\n')
    (root / 'state-u1.json').write_text(json.dumps({
        'workouts': [{}, {}, {}], 'routines': [{}, {}], 'bodyweight': [{}],
        'habitLog': {'alcohol|def': {}, 'h1|def': {}, 'alcohol|2026-10-01': {}, 'h1|2026-10-02': {}, 'h1|2026-10-03': {}}}))
    (root / 'state-u2.json').write_text(json.dumps({'workouts': [], 'routines': []}))
    (root / 'mcp-journal-u1.json').write_text('[]')
    (root / 'uploads' / 'u1' / '.tmp').mkdir(parents=True, exist_ok=True)
    (root / 'uploads' / 'u1' / ('a' * 64 + '.jpg')).write_bytes(b'jpeg')
    (root / 'uploads' / 'u1' / '.tmp' / 'partial').write_bytes(b'x')
    (root / 'db.json.tmp').write_text('{half')
    (root / '.health-12').write_text('')


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        make_data(self.data)

    def tearDown(self):
        self.temp.cleanup()


class ConsistentCopy(Base):
    def test_listing_skips_in_flight_temporary_files(self):
        files = gb.data_files(self.data)
        self.assertIn('db.json', files)
        self.assertIn(f'uploads/u1/{"a" * 64}.jpg', files)
        self.assertNotIn('db.json.tmp', files)
        self.assertNotIn('.health-12', files)
        self.assertFalse(any('.tmp/' in f for f in files))

    def test_copy_is_complete_and_uploads_are_hard_links(self):
        dest = self.root / 'copy'
        with patch.object(gb, 'deploy_in_progress', return_value=False):
            files = gb.copy_data(dest, self.data)
        self.assertEqual(set(gb.data_files(dest)), set(files))
        self.assertEqual((dest / 'db.json').read_text(), (self.data / 'db.json').read_text())
        upload = f'uploads/u1/{"a" * 64}.jpg'
        self.assertEqual(os.stat(dest / upload).st_ino, os.stat(self.data / upload).st_ino)
        self.assertNotEqual(os.stat(dest / 'db.json').st_ino, os.stat(self.data / 'db.json').st_ino)
        self.assertFalse((dest / 'db.json.tmp').exists())

    def test_a_write_during_the_copy_makes_it_retry(self):
        real = gb.data_files
        calls = []

        def listing(root):
            calls.append(1)
            if len(calls) == 2:   # the listing right after the first copy sees a newer db.json
                (self.data / 'db.json.new').write_text((self.data / 'db.json').read_text())
                os.replace(self.data / 'db.json.new', self.data / 'db.json')
            return real(root)
        with patch.object(gb, 'data_files', side_effect=listing), \
                patch.object(gb, 'deploy_in_progress', return_value=False):
            gb.copy_data(self.root / 'copy', self.data)
        self.assertEqual(len(calls), 4)

    def test_data_that_never_settles_fails(self):
        n = iter(range(100))
        with patch.object(gb, 'data_files', side_effect=lambda root: {'db.json': (next(n), 1, 1)}), \
                patch.object(gb.shutil, 'copy2'), patch.object(gb, 'deploy_in_progress', return_value=False):
            with self.assertRaisesRegex(gb.Failure, 'kept changing'):
                gb.copy_data(self.root / 'copy', self.data, attempts=2)

    def test_a_running_deployment_is_detected_from_proc_locks(self):
        lock = self.root / 'deploy.lock'
        lock.write_text('')
        st = lock.stat()
        dev = f'{os.major(st.st_dev):02x}:{os.minor(st.st_dev):02x}:{st.st_ino}'
        locks = self.root / 'locks'
        locks.write_text(f'1: FLOCK  ADVISORY  WRITE 4242 {dev} 0 EOF\n2: POSIX  ADVISORY  READ 7 00:1a:99 0 EOF\n')
        self.assertTrue(gb.deploy_in_progress(lock, locks))
        locks.write_text('2: POSIX  ADVISORY  READ 7 00:1a:99 0 EOF\n')
        self.assertFalse(gb.deploy_in_progress(lock, locks))
        self.assertFalse(gb.deploy_in_progress(self.root / 'absent.lock', locks))


class Validation(Base):
    def test_counts_cover_accounts_workouts_routines_and_habits(self):
        c = gb.data_counts(self.data)
        self.assertEqual((c['users'], c['passkeys'], c['push_subscriptions']), (2, 3, 1))
        self.assertEqual((c['profiles_with_state'], c['workouts'], c['routines']), (2, 3, 2))
        self.assertEqual((c['habit_definitions'], c['habit_days']), (2, 3))
        self.assertEqual((c['upload_files'], c['upload_bytes']), (1, 4))

    def test_broken_or_incomplete_data_is_refused(self):
        (self.data / 'state-u2.json').write_text('{')
        with self.assertRaisesRegex(gb.Failure, 'state-u2.json'):
            gb.data_counts(self.data)
        make_data(self.data)
        (self.data / 'secret').unlink()
        with self.assertRaisesRegex(gb.Failure, 'secret'):
            gb.data_counts(self.data)
        make_data(self.data)
        (self.data / 'db.json').write_text(json.dumps({'users': []}))
        with self.assertRaisesRegex(gb.Failure, '0 users'):
            gb.data_counts(self.data, min_users=1)

    def test_manifest_detects_changed_missing_and_extra_files(self):
        snap = self.root / 'snap'
        with patch.object(gb, 'deploy_in_progress', return_value=False):
            gb.copy_data(snap / 'data', self.data)
        gb.write_manifest(snap, gb.data_counts(snap / 'data'), 'f' * 40)
        gb.verify_against_manifest(snap)
        (snap / 'data' / 'audit.log').write_text('tampered')
        with self.assertRaisesRegex(gb.Failure, 'checksum'):
            gb.verify_against_manifest(snap)
        (snap / 'data' / 'audit.log').unlink()
        with self.assertRaisesRegex(gb.Failure, '1 missing'):
            gb.verify_against_manifest(snap)

    def test_required_configuration_must_exist(self):
        present = self.root / 'gymly.env'
        present.write_text('RP_ID=x\n')
        gb.copy_config(self.root / 'cfg', [(str(present), True), (str(self.root / 'nope'), False)])
        self.assertTrue((self.root / 'cfg' / str(present).lstrip('/')).is_file())
        with self.assertRaisesRegex(gb.Failure, 'required configuration missing'):
            gb.copy_config(self.root / 'cfg2', [(str(self.root / 'nope'), True)])


class ReadBack(Base):
    def tar_of(self, snap, prefix):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w') as tf:
            for rel, p in gb.tree_files(snap).items():
                tf.add(p, arcname=prefix + rel)
        buf.seek(0)
        return buf

    def test_remote_tar_stream_is_hashed_against_the_manifest(self):
        snap = self.root / 'snap'
        with patch.object(gb, 'deploy_in_progress', return_value=False):
            gb.copy_data(snap / 'data', self.data)
        manifest = gb.write_manifest(snap, {}, 'f' * 40)
        manifest['_sha256'] = gb.sha256_file(snap / gb.MANIFEST)
        for prefix in ('/var/backups/gymly-dr/snapshot/', 'snapshot/', ''):
            self.assertEqual(gb.verify_tar_stream(self.tar_of(snap, prefix), manifest), len(manifest['files']) + 1)
        (snap / 'data' / 'secret').write_text('other')
        with self.assertRaisesRegex(gb.Failure, '1 mismatched'):
            gb.verify_tar_stream(self.tar_of(snap, ''), manifest)


class Maintenance(unittest.TestCase):
    def setUp(self):
        gb.CFG.clear()
        gb.CFG.update({'MAX_BACKUP_AGE_HOURS': 7, 'BACKUP_HOST': 'gymly-test', 'KEEP_LAST': 4, 'KEEP_DAILY': 30,
                       'KEEP_WEEKLY': 12, 'PRUNE_WEEKDAY': 7, 'CHECK_SUBSET_DENOMINATOR': 7})

    def snap(self, hours_ago):
        t = gb.utcnow() - datetime.timedelta(hours=hours_ago)
        return {'id': 'e' * 64, 'time': t.strftime('%Y-%m-%dT%H:%M:%S.123456789Z')}

    def test_restic_times_parse(self):
        t = gb.parse_restic_time('2026-10-23T06:40:01.123456789+00:00')
        self.assertEqual((t.hour, t.microsecond), (6, 123456))
        self.assertEqual(gb.parse_restic_time('2026-10-23T06:40:01Z').tzinfo.utcoffset(None), datetime.timedelta(0))

    def test_freshness(self):
        for hours, stale in ((1, None), (8, 'old'), (-1, 'future')):
            with patch.object(gb, 'latest_verified', return_value=self.snap(hours)):
                result = gb.check_freshness()
                self.assertTrue(result is None if stale is None else stale in result)
        with patch.object(gb, 'latest_verified', return_value=None):
            self.assertEqual(gb.check_freshness(), 'no verified snapshot')

    def run_maintain(self, stale):
        calls = []
        with patch.object(gb, 'check_repo'), patch.object(gb, 'check_freshness', return_value=stale), \
                patch.object(gb, 'restic', side_effect=lambda *a, **k: calls.append(a[0])), \
                patch.object(gb, 'write_status'), patch.object(gb, 'notify'), \
                patch.object(gb, 'restore_test', return_value='x'), patch.dict(os.environ, {'FORCE_PRUNE': '0'}):
            try:
                gb.job_maintain()
            except gb.Failure as exc:
                return calls, exc
        return calls, None

    def test_retention_runs_only_on_fresh_backups_and_stale_fails_after_the_check(self):
        calls, err = self.run_maintain(None)
        self.assertIn('forget', calls)
        self.assertIn('check', calls)
        self.assertIsNone(err)
        calls, err = self.run_maintain('newest verified snapshot is 9h old')
        self.assertNotIn('forget', calls)
        self.assertNotIn('prune', calls)
        self.assertIn('check', calls)
        self.assertIn('9h', str(err))


class Secrets(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(gb, 'CONF_DIR', Path(self.temp.name))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def store(self, name, *answers, **kw):
        it = iter(answers)
        return gb.job_secret(name, ask=lambda prompt: next(it), tty=True, **kw)

    def test_password_is_confirmed_and_never_silently_replaced(self):
        with self.assertRaisesRegex(gb.Failure, 'differ'):
            self.store('restic-password', 'x' * 40, 'y' * 40)
        with self.assertRaisesRegex(gb.Failure, '24'):
            self.store('restic-password', 'short', 'short')
        self.store('restic-password', 'p' * 40, 'p' * 40)
        f = Path(self.temp.name) / 'restic-password'
        self.assertEqual(f.stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(gb.Failure, 'already stored'):
            self.store('restic-password', 'q' * 40, 'q' * 40)

    def test_spaces_keys_and_urls_are_validated(self):
        with self.assertRaisesRegex(gb.Failure, 'Spaces key'):
            self.store('spaces', 'not a key', 'secret')
        self.store('spaces', 'DO00ABCDEFGHIJKLMNOP', 'A' * 43)
        env = (Path(self.temp.name) / 'spaces.env').read_text()
        self.assertIn('AWS_ACCESS_KEY_ID=DO00ABCDEFGHIJKLMNOP\n', env)
        with self.assertRaisesRegex(gb.Failure, 'https'):
            self.store('kuma-backup', 'http://example.com/api/push/abc')
        self.store('kuma-backup', 'http://127.0.0.1:3001/api/push/abc?status=up&msg=OK&ping=')
        self.assertEqual((Path(self.temp.name) / 'kuma-backup.url').read_text(), 'http://127.0.0.1:3001/api/push/abc\n')

    def test_refuses_without_a_terminal(self):
        with self.assertRaisesRegex(gb.Failure, 'interactive'):
            gb.job_secret('spaces', ask=lambda p: '', tty=False)


class Guards(unittest.TestCase):
    def test_restore_never_targets_production(self):
        for target in ('/opt/gymly', '/opt/gymly/data', '/opt/gymly/restore'):
            with self.assertRaisesRegex(gb.Failure, 'inside /opt/gymly'):
                gb.job_restore('latest', target)

    def test_config_refuses_another_host_and_rehearsals_on_the_production_host_name(self):
        with tempfile.TemporaryDirectory() as d:
            conf = Path(d) / 'backup.conf'
            conf.write_text('RESTIC_REPOSITORY=/tmp/repo\nPRODUCTION_HOSTNAME=srv804180\n')
            with patch.object(gb, 'CONF_DIR', Path(d)), patch.object(gb.socket, 'gethostname', return_value='other'):
                with self.assertRaisesRegex(gb.Failure, 'PRODUCTION_HOSTNAME'):
                    gb.load_config()
            conf.write_text('RESTIC_REPOSITORY=/tmp/repo\nPRODUCTION_HOSTNAME=\n')
            with patch.object(gb, 'CONF_DIR', Path(d)), patch.object(gb, 'ALTERNATE', True):
                with self.assertRaisesRegex(gb.Failure, 'non-production BACKUP_HOST'):
                    gb.load_config()
            conf.write_text('RESTIC_REPOSITORY=/tmp/repo\nKEEP_DAILY=30d\n')
            with patch.object(gb, 'CONF_DIR', Path(d)):
                with self.assertRaisesRegex(gb.Failure, 'plain integer'):
                    gb.load_config()

    def test_secret_files_must_be_private_to_root(self):
        with tempfile.NamedTemporaryFile() as f:
            os.chmod(f.name, 0o644)
            with self.assertRaisesRegex(gb.Failure, 'mode 0600'):
                gb.require_private(Path(f.name))

    def test_repository_errors_are_classified(self):
        self.assertIn('password', gb.classify_repo_error('Fatal: wrong password or no key found'))
        self.assertIn('authorization', gb.classify_repo_error('AccessDenied: Access Denied'))
        self.assertIn('not found', gb.classify_repo_error('Fatal: unable to open config file: Stat: ...'
                                                          ' Is there a repository at the following location?'))


if __name__ == '__main__':
    unittest.main()
