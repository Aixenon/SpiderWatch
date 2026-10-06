import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import build


class BuildRevisionTests(unittest.TestCase):
    def test_revision_requires_a_complete_source_commit(self):
        revision = 'a' * 40
        with patch.dict(os.environ, {'GITHUB_SHA': revision}):
            self.assertEqual(build.source_revision(), revision)
        with patch.dict(os.environ, {}, clear=True), patch.object(build.subprocess, 'check_output', return_value=revision + '\n'):
            self.assertEqual(build.source_revision(), revision)
        for value in ['main', 'a' * 7, 'a' * 39, '../other', 'A' * 40]:
            with self.assertRaises(ValueError):
                build.source_revision(value)

    def assemble_fixture(self, directory, revision):
        for platform in build.PLATFORMS:
            name = build.filename(platform)
            content = name.encode().ljust(1024, b'x')
            (directory / name).write_bytes(content)
            asset = dict(os=platform['os'], arch=platform['arch'], file=name, bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
            (directory / f"{platform['os']}-{platform['arch']}.json").write_text(json.dumps(dict(version='0.7.1', revision=revision, asset=asset)))

    def run_assemble(self, directory, revision):
        args = ['build.py', '--assemble', '--version', '0.7.1', '--revision', revision, '--output', str(directory), '--repository', 'fixture/SpiderWatch']
        with patch.object(sys, 'argv', args), contextlib.redirect_stdout(io.StringIO()):
            build.main()

    def test_complete_matrix_carries_revision_into_both_manifests(self):
        revision = 'a' * 40
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assemble_fixture(directory, revision)
            self.run_assemble(directory, revision)
            for name in ['release-info.json', 'update-manifest.json']:
                self.assertEqual(json.loads((directory / name).read_text())['revision'], revision)
            script = (directory / 'install.sh').read_text()
            self.assertNotIn('__SPIDER_REPOSITORY__', script)
            self.assertNotIn('__SPIDER_VERSION__', script)

    def test_assembly_rejects_artifacts_from_another_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assemble_fixture(directory, 'a' * 40)
            with self.assertRaisesRegex(ValueError, 'Mixed versions or modified matrix artifacts'):
                self.run_assemble(directory, 'b' * 40)


if __name__ == '__main__':
    unittest.main()
