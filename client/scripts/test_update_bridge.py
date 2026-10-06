"""Check privileged bridge definitions without installing services or tasks."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
import plistlib

ROOT = Path(__file__).resolve().parent
SCRIPT = (ROOT / 'install.sh').read_text()
SHELL = os.environ.get('SPIDER_TEST_SHELL') or shutil.which('sh')
SHELL_ENV = dict(os.environ)
if os.name == 'nt' and SHELL:
    directory = Path(SHELL).resolve().parent
    SHELL_ENV['PATH'] = os.pathsep.join([str(directory), str(directory.parent / 'usr' / 'bin'), SHELL_ENV.get('PATH', '')])


def bridge_definition(path):
    match = re.search(r"bridge_file " + re.escape(path) + r" <<'EOF'\n(.*?)\nEOF", SCRIPT, re.S)
    if not match:
        raise AssertionError('Missing fixed bridge definition: ' + path)
    return match[1]


class BridgeDefinitionTests(unittest.TestCase):
    def test_systemd_consumes_only_fixed_request_marker(self):
        unit = bridge_definition('/etc/systemd/system/spider-watch-update-request.service')
        self.assertIn('Type=oneshot\n', unit)
        self.assertIn('ExecStart=/opt/spider-watch/spider-watch update --requested --config /var/lib/spider-watch/state/config.json\n', unit)
        self.assertIn('TimeoutStartSec=300\n', unit)
        path = bridge_definition('/etc/systemd/system/spider-watch-update-request.path')
        self.assertIn('PathExists=/var/lib/spider-watch/state/update-request\n', path)
        self.assertIn('Unit=spider-watch-update-request.service\n', path)
        self.assertIn('OnUnitActiveSec=6h', SCRIPT)

    def test_launchd_watches_only_request_and_keeps_automatic_interval(self):
        text = bridge_definition('/Library/LaunchDaemons/io.spiderwatch.update-request.plist')
        plist = plistlib.loads(text.encode())
        self.assertEqual(plist['ProgramArguments'], ['/opt/spider-watch/spider-watch', 'update', '--requested', '--config', '/var/lib/spider-watch/state/config.json'])
        self.assertEqual(plist['WatchPaths'], ['/var/lib/spider-watch/state/update-request'])
        self.assertTrue(plist['RunAtLoad'])
        self.assertEqual(plist['KeepAlive'], {'PathState': {'/var/lib/spider-watch/state/update-request': True}})
        self.assertIn('<key>StartInterval</key><integer>21600</integer>', SCRIPT)

    def test_cron_wakes_only_for_pending_local_marker(self):
        self.assertIn("printf '* * * * * [ ! -e /var/lib/spider-watch/state/update-request ] || /opt/spider-watch/spider-watch update --requested --config /var/lib/spider-watch/state/config.json", SCRIPT)
        self.assertIn("printf '17 */6 * * * /opt/spider-watch/spider-watch update --automatic", SCRIPT)


@unittest.skipUnless(SHELL, 'requires a POSIX shell')
class BridgeFileTests(unittest.TestCase):
    def write_bridge(self, path):
        start = SCRIPT.index('bridge_file() {')
        end = SCRIPT.index('\n}\n', start) + 3
        # Only ownership probes are mocked; all writes operate in a temp dir.
        body = "set -eu\ngoos=linux\ndie() { printf '%s\\n' \"$*\" >&2; exit 1; }\nstat() { printf '0 755\\n'; }\nchown() { :; }\n"
        body += SCRIPT[start:end]
        body += '\nprintf new-definition | bridge_file "$TEST_BRIDGE_TARGET"\n'
        return subprocess.run([SHELL, '-c', body], env={**SHELL_ENV, 'TEST_BRIDGE_TARGET': str(path).replace('\\', '/')}, text=True, capture_output=True)

    def test_replacement_does_not_modify_hardlinked_file(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / 'original'
            target = Path(directory) / 'bridge'
            original.write_text('unchanged')
            os.link(original, target)
            result = self.write_bridge(target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(original.read_text(), 'unchanged')
            self.assertEqual(target.read_text(), 'new-definition')

    def test_refuses_directory_target(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.write_bridge(Path(directory))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Unsafe update bridge file', result.stderr)


if __name__ == '__main__':
    unittest.main()
