"""Download real HTTP fixtures without installing services or running a setup.exe."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

try:
    from .test_install_enrollment import ROOT, SHELL, SHELL_ENV, POWERSHELL, TOKEN, NETWORK
except ImportError:
    from test_install_enrollment import ROOT, SHELL, SHELL_ENV, POWERSHELL, TOKEN, NETWORK

NAME = 'spider-watch-linux-amd64'
DATA = b'#!/bin/sh\nif [ "$1" = version ]; then printf "spider-watch 1.2.3\\n"; fi\nexit 0\n' + b'# padding\n' * 30000
INVALID_SIZE_MODES = ['invalid_size', 'zero_size', 'large_size', 'long_size']


def modern_curl(path):
    if not path:
        return False
    result = subprocess.run([path, '--version'], text=True, capture_output=True)
    match = re.match(r'curl (\d+)\.(\d+)\.', result.stdout)
    return bool(match and (int(match[1]), int(match[2])) >= (8, 4))


UNIX_MODERN_CURL = modern_curl(shutil.which('curl', path=SHELL_ENV.get('PATH')))
WINDOWS_MODERN_CURL = modern_curl(shutil.which('curl.exe')) if os.name == 'nt' else False


class DownloadServer:
    def __init__(self, mode='ok'):
        self.mode = mode
        self.data = DATA.split(b'# padding', 1)[0] if mode == 'small_size' else DATA
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.part_bytes = (len(self.data) + 3) // 4
        self.requests = []
        self.active = 0
        self.peak = 0
        self.lock = threading.Lock()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_HEAD(self):
                with fixture.lock:
                    fixture.requests.append(('HEAD', self.path))
                self.send_error(405)

            def do_GET(self):
                with fixture.lock:
                    fixture.requests.append(('GET', self.path))
                part_prefix = '/downloads/parts/' + fixture.digest + '/'
                if self.path == part_prefix + 'size':
                    if fixture.mode == 'missing_size':
                        self.send_error(404)
                        return
                    size = {'invalid_size': b'not-a-size\n', 'zero_size': b'0\n',
                            'large_size': b'99999999\n', 'long_size': b'9' * 40 + b'\n'}
                    # Production Static Assets does not provide Content-Length.
                    try:
                        self.respond(size.get(fixture.mode, f'{len(fixture.data)}\n'.encode()), content_length=False)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass
                    return
                is_part = self.path.startswith(part_prefix)
                if is_part:
                    index = int(self.path.rsplit('/', 1)[1])
                    with fixture.lock:
                        fixture.active += 1
                        fixture.peak = max(fixture.peak, fixture.active)
                    try:
                        # Keep each response open long enough to observe actual overlap.
                        time.sleep(.15)
                        body = fixture.data[index * fixture.part_bytes:(index + 1) * fixture.part_bytes]
                        if index == 2:
                            if fixture.mode == 'missing':
                                self.send_error(404)
                                return
                            if fixture.mode == 'short':
                                body = body[:-1]
                            if fixture.mode == 'oversized':
                                body = fixture.data
                            if fixture.mode == 'oversized_stream':
                                self.respond(fixture.data, content_length=False)
                                return
                            if fixture.mode == 'corrupt':
                                body = b'!' + body[1:]
                        self.respond(body)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass
                    finally:
                        with fixture.lock:
                            fixture.active -= 1
                elif self.path == '/downloads/current.json':
                    self.respond(json.dumps({'schema': 1, 'version': '1.2.3'}).encode())
                elif self.path == '/downloads/checksums.txt':
                    self.respond(f'{fixture.digest}  {NAME}\n'.encode())
                elif self.path == '/downloads/' + NAME:
                    self.respond(fixture.data)
                else:
                    self.send_error(404)

            def respond(self, body, content_length=True):
                self.send_response(200)
                if content_length:
                    self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)

    def __enter__(self):
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


@unittest.skipUnless(SHELL and shutil.which('curl', path=SHELL_ENV.get('PATH')), 'requires POSIX shell and curl')
class UnixParallelInstallTests(unittest.TestCase):
    def install(self, mode='ok', legacy=False):
        if not legacy and not UNIX_MODERN_CURL:
            self.skipTest('parallel transfer checks require curl 8.4 or later')
        with tempfile.TemporaryDirectory(prefix='.parallel-test-', dir=ROOT) as directory, DownloadServer(mode) as fixture:
            prefix = str(Path(directory) / 'installed').replace('\\', '/')
            if os.name == 'nt':
                prefix = '/' + prefix[0].lower() + prefix[2:]
            arguments = ['--arch', 'amd64', '--no-service', '--prefix', prefix, '--allow-local-http',
                         '--server', fixture.origin + '/#invite=' + TOKEN, '--join', NETWORK]
            env = {**SHELL_ENV, 'TEST_SCRIPT': str(ROOT / 'install.sh').replace('\\', '/'),
                   'TEST_LEGACY': 'yes' if legacy else 'no'}
            env.update({f'TEST_ARG{i}': arg for i, arg in enumerate(arguments)})
            script = '''uname() { printf 'Linux\\n'; }
curl() {
  if [ "$TEST_LEGACY" = yes ] && [ "$1" = --version ]; then printf 'curl 7.88.1\\n'; else command curl "$@"; fi
}
'''
            script += 'set -- ' + ' '.join(f'"$TEST_ARG{i}"' for i in range(len(arguments))) + '\n. "$TEST_SCRIPT"\n'
            result = subprocess.run([SHELL, '-c', script], env=env, text=True, capture_output=True, timeout=45)
            installed = Path(directory) / 'installed' / 'spider-watch'
            if mode == 'corrupt':
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(installed.exists())
                self.assertIn('SHA-256 mismatch', result.stderr)
            elif mode in INVALID_SIZE_MODES:
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(installed.exists())
                self.assertIn('size metadata', result.stderr)
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(installed.read_bytes(), fixture.data)
            self.assertEqual(list((Path(directory) / 'installed').glob('.spider-watch-install.*')), [])
            self.assertNotIn(TOKEN, result.stdout + result.stderr)
            self.assertFalse(any(method == 'HEAD' for method, _ in fixture.requests))
            return result, fixture.requests, fixture.peak

    def test_four_parts_overlap_and_reassemble_without_a_full_get(self):
        result, requests, peak = self.install()
        self.assertIn('4 parallel connections', result.stderr)
        self.assertEqual(peak, 4)
        self.assertNotIn(('GET', '/downloads/' + NAME), requests)

    def test_missing_short_and_oversized_parts_cleanly_fall_back(self):
        for mode in ['missing', 'short', 'oversized', 'oversized_stream']:
            with self.subTest(mode=mode):
                result, requests, _ = self.install(mode)
                self.assertIn('Retrying with a single download connection', result.stderr)
                self.assertIn(('GET', '/downloads/' + NAME), requests)

    def test_corrupt_same_length_parts_never_install(self):
        self.install('corrupt')

    def test_small_package_or_missing_size_uses_serial_compatibility(self):
        for mode in ['small_size', 'missing_size']:
            with self.subTest(mode=mode):
                result, requests, peak = self.install(mode)
                self.assertIn('small package or unavailable size', result.stderr)
                self.assertEqual(peak, 0)
                self.assertIn(('GET', '/downloads/' + NAME), requests)

    def test_invalid_or_oversized_size_never_downloads_the_package(self):
        for mode in INVALID_SIZE_MODES:
            with self.subTest(mode=mode):
                _, requests, peak = self.install(mode)
                self.assertEqual(peak, 0)
                self.assertNotIn(('GET', '/downloads/' + NAME), requests)

    def test_older_curl_keeps_working_without_parts(self):
        result, requests, peak = self.install(legacy=True)
        self.assertIn('curl < 8.4', result.stderr)
        self.assertEqual(peak, 0)
        self.assertIn(('GET', '/downloads/' + NAME), requests)


@unittest.skipUnless(POWERSHELL and shutil.which('curl.exe'), 'requires Windows PowerShell and curl.exe')
class WindowsParallelInstallTests(unittest.TestCase):
    def download(self, mode='ok'):
        if not WINDOWS_MODERN_CURL:
            self.skipTest('parallel transfer checks require curl 8.4 or later')
        with tempfile.TemporaryDirectory(prefix='.parallel-test-', dir=ROOT) as directory, DownloadServer(mode) as fixture:
            script = r'''
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TEST_SCRIPT,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Cannot parse installer' }
foreach ($function in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $true)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
$taskWorkerBase = $env:TEST_ORIGIN + '/downloads'
$taskProtocols = '=http,https'; $taskRedirects = 0
Get-InstallBinary ($taskWorkerBase + '/spider-watch-linux-amd64') $env:TEST_OUTPUT 16777216 'test package' $env:TEST_HASH
if ((Get-FileHash -LiteralPath $env:TEST_OUTPUT -Algorithm SHA256).Hash -ne $env:TEST_HASH) { throw 'SHA-256 mismatch' }
Write-Output 'RESULT_SUCCESS'
'''
            output = Path(directory) / 'download'
            env = {**os.environ, 'TEST_SCRIPT': str(ROOT / 'install.ps1'), 'TEST_ORIGIN': fixture.origin,
                   'TEST_OUTPUT': str(output), 'TEST_HASH': fixture.digest}
            result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', script],
                                    env=env, text=True, capture_output=True, timeout=45)
            if mode == 'corrupt':
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('RESULT_SUCCESS', result.stdout)
                self.assertIn('SHA-256 mismatch', result.stderr)
            elif mode in INVALID_SIZE_MODES:
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
                self.assertNotIn('RESULT_SUCCESS', result.stdout)
                self.assertIn('size metadata', result.stderr)
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output.read_bytes(), fixture.data)
                self.assertIn('RESULT_SUCCESS', result.stdout)
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), [] if mode in INVALID_SIZE_MODES else ['download'])
            self.assertFalse(any(method == 'HEAD' for method, _ in fixture.requests))
            return result, fixture.requests, fixture.peak

    def test_four_parts_overlap_and_reassemble_without_a_full_get(self):
        result, requests, peak = self.download()
        self.assertIn('4 parallel connections', result.stdout)
        self.assertEqual(peak, 4)
        self.assertNotIn(('GET', '/downloads/' + NAME), requests)

    def test_missing_short_and_oversized_parts_cleanly_fall_back(self):
        for mode in ['missing', 'short', 'oversized', 'oversized_stream']:
            with self.subTest(mode=mode):
                result, requests, _ = self.download(mode)
                self.assertIn('Retrying with a single download connection', result.stdout)
                self.assertIn(('GET', '/downloads/' + NAME), requests)

    def test_corrupt_same_length_parts_fail_checksum(self):
        self.download('corrupt')

    def test_small_package_or_missing_size_uses_serial_compatibility(self):
        for mode in ['small_size', 'missing_size']:
            with self.subTest(mode=mode):
                result, requests, peak = self.download(mode)
                self.assertIn('small package or unavailable size', result.stdout)
                self.assertEqual(peak, 0)
                self.assertIn(('GET', '/downloads/' + NAME), requests)

    def test_invalid_or_oversized_size_never_downloads_the_package(self):
        for mode in INVALID_SIZE_MODES:
            with self.subTest(mode=mode):
                _, requests, peak = self.download(mode)
                self.assertEqual(peak, 0)
                self.assertNotIn(('GET', '/downloads/' + NAME), requests)


if __name__ == '__main__':
    unittest.main()
