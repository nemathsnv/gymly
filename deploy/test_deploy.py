"""Synthetic deployment lifecycle tests; no Docker, SSH, credentials or real user data."""
import importlib.util
import io
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gymly_receiver', Path(__file__).with_name('deploy.py'))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
NEW = 'a' * 40
OLD = 'b' * 40
DIGEST = 'c' * 64


class DeploymentLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.data = self.base / 'data'
        self.data.mkdir()
        (self.data / 'state.json').write_text('existing workout')
        (self.base / 'releases').mkdir()
        (self.base / 'deploy').mkdir()
        (self.base / 'current-release').write_text(OLD + '\n')
        self.events = []
        self.patches = [
            patch.object(receiver, 'BASE', self.base),
            patch.object(receiver, 'DEPLOY', self.base / 'deploy'),
            patch.object(receiver, 'CURRENT', self.base / 'current-release'),
            patch.object(receiver, 'DATA', self.data),
            patch.object(receiver.os, 'geteuid', return_value=0),
            patch.object(receiver.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(9e9, 1e9, 8e9)),
            patch.object(sys, 'argv', ['receiver', f'deploy {NEW} {DIGEST}']),
            patch.object(receiver, 'receive_images', side_effect=self.receive),
            patch.object(receiver, 'compose', side_effect=self.compose),
            patch.object(receiver, 'edge', side_effect=lambda sha, live: self.events.append(('edge', live))),
            patch.object(receiver, 'healthy', side_effect=lambda sha: self.events.append(('healthy', sha))),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def receive(self, sha, digest, release):
        archive = release / 'images.tar.gz'
        archive.write_bytes(b'synthetic images')
        self.events.append(('received', sha))
        return archive

    def compose(self, sha, *args, **kw):
        self.events.append(('compose', sha, args))
        if sha == NEW and args[:1] == ('up',):
            (self.data / 'state.json').write_text('candidate format')

    def test_success_keeps_data_and_pins_current_after_opening_traffic(self):
        receiver.main()
        self.assertEqual((self.base / 'current-release').read_text().strip(), NEW)
        self.assertEqual((self.base / 'previous-release').read_text().strip(), OLD)
        self.assertEqual((self.data / 'state.json').read_text(), 'candidate format')
        self.assertLess(self.events.index(('edge', False)), self.events.index(('healthy', NEW)))
        self.assertLess(self.events.index(('healthy', NEW)), self.events.index(('edge', True)))
        self.assertEqual(len(list(self.base.glob('releases/*/before-data.tar.gz'))), 1)

    def test_unhealthy_candidate_restores_snapshot_and_previous_release(self):
        def health(sha):
            self.events.append(('healthy', sha))
            if sha == NEW:
                raise RuntimeError('synthetic unhealthy API')
        with patch.object(receiver, 'healthy', side_effect=health):
            with self.assertRaisesRegex(RuntimeError, 'unhealthy API'):
                receiver.main()
        self.assertEqual((self.data / 'state.json').read_text(), 'existing workout')
        self.assertEqual((self.base / 'current-release').read_text().strip(), OLD)
        failed = next(self.base.glob('releases/*/failed-data/state.json'))
        self.assertEqual(failed.read_text(), 'candidate format')
        self.assertIn(('healthy', OLD), self.events)
        self.assertEqual(self.events[-1], ('edge', True))

    def test_failure_after_traffic_boundary_never_restores_old_data(self):
        def edge(sha, live):
            if live:
                raise RuntimeError('synthetic edge reload failure')
        with patch.object(receiver, 'edge', side_effect=edge):
            with self.assertRaisesRegex(RuntimeError, 'edge reload'):
                receiver.main()
        self.assertEqual((self.data / 'state.json').read_text(), 'candidate format')
        self.assertFalse(list(self.base.glob('releases/*/failed-data')))

    def test_bad_transport_does_not_touch_running_release(self):
        with patch.object(receiver, 'receive_images', side_effect=RuntimeError('checksum mismatch')):
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                receiver.main()
        self.assertEqual(self.events, [])
        self.assertEqual((self.data / 'state.json').read_text(), 'existing workout')

    def test_shell_commands_are_rejected_before_any_work(self):
        with patch.object(sys, 'argv', ['receiver', 'deploy x; touch /tmp/unsafe']):
            with self.assertRaisesRegex(RuntimeError, 'Only deploy'):
                receiver.main()
        self.assertEqual(self.events, [])


if __name__ == '__main__':
    unittest.main()
