"""Exercise installer registration without network access or system services."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parent.resolve()
SHELL = shutil.which('sh') or os.environ.get('SPIDER_TEST_SHELL')
POWERSHELL = shutil.which('powershell') if os.name == 'nt' else None
SERVER = "https://monitor.example.test/#invite=one'two$()&three"
NETWORK = 'abcd1234EFGH5678'


@unittest.skipUnless(SHELL, 'requires a POSIX shell')
class UnixEnrollmentTests(unittest.TestCase):
    def install(self, registration_exit=0, extra=None):
        with tempfile.TemporaryDirectory(prefix='.installer-test-', dir=ROOT) as directory:
            root = Path(directory)
            binary = root / 'binary'
            binary.write_text('''#!/bin/sh
if [ "$1" = version ]; then printf 'spider-watch 1.2.3\\n'; exit 0; fi
printf '%s\\n' "$@" > "$TEST_ARGUMENTS"
exit "$TEST_REGISTRATION_EXIT"
''', newline='\n')
            checksum = hashlib.sha256(binary.read_bytes()).hexdigest()
            (root / 'checksums').write_text(f'{checksum}  spider-watch-linux-amd64\n')
            probes = r'''uname() { printf 'Linux\n'; }
curl() {
  url=; target=
  while [ "$#" -gt 0 ]; do
    case "$1" in https://*) url=$1; shift;; -o) target=$2; shift 2;; *) shift;; esac
  done
  case "$url" in
    https://github.com/owner/fork/releases/download/v1.2.3/checksums.txt) cp "$TEST_FIXTURES/checksums" "$target";;
    https://github.com/owner/fork/releases/download/v1.2.3/spider-watch-linux-amd64) cp "$TEST_FIXTURES/binary" "$target";;
    *) printf 'Unexpected download URL\n' >&2; return 91;;
  esac
}
script=$TEST_INSTALLER
'''
            arguments = root / 'arguments'
            env = {**os.environ, 'TEST_FIXTURES': str(root).replace('\\', '/'),
                   'TEST_INSTALLER': str(ROOT / 'install.sh').replace('\\', '/'),
                   'TEST_ARGUMENTS': str(arguments).replace('\\', '/'),
                   'TEST_REGISTRATION_EXIT': str(registration_exit)}
            # /... is also required by the installer's prefix check under Git Bash.
            prefix = str(root / 'installed').replace('\\', '/')
            if os.name == 'nt':
                prefix = '/' + prefix[0].lower() + prefix[2:]
            args = ['--repo', 'owner/fork', '--version', 'v1.2.3', '--arch', 'amd64',
                    '--no-service', '--prefix', prefix]
            args += extra if extra is not None else ['--server', SERVER, '--join', NETWORK]
            # Environment values avoid MSYS's additional command-line parsing
            # when launching sh from Windows; the POSIX script still receives
            # each real CLI argument unchanged.
            env.update({f'TEST_ARG{i}': arg for i, arg in enumerate(args)})
            probes += 'set -- ' + ' '.join(f'"$TEST_ARG{i}"' for i in range(len(args))) + '\n. "$script"\n'
            result = subprocess.run([SHELL, '-c', probes, 'installer-test'],
                                    env=env, text=True, encoding='utf-8', errors='replace', capture_output=True)
            return result, arguments.read_text().splitlines() if arguments.exists() else None

    def test_install_downloads_from_selected_fork_and_preserves_invitation(self):
        result, args = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args, ['configure', '--server', SERVER, '--join', NETWORK])

    def test_failed_registration_does_not_report_installation_success(self):
        result, _ = self.install(registration_exit=23)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertNotIn('Installed ', result.stdout)

    def test_registration_arguments_must_be_paired(self):
        for extra in [['--server', SERVER], ['--join', NETWORK]]:
            result, args = self.install(extra=extra)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('must be used together', result.stderr)
            self.assertIsNone(args)

    def test_existing_install_only_and_local_mode(self):
        result, args = self.install(extra=[])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(args)
        result, args = self.install(extra=['--server', 'http://127.0.0.1/#invite=local',
                                         '--join', NETWORK, '--allow-local-http'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args[-1], '--allow-local-http')


@unittest.skipUnless(POWERSHELL, 'requires Windows PowerShell')
class WindowsEnrollmentTests(unittest.TestCase):
    def registration(self, exit_code=0, local=False):
        # Extract only the final registration block, after the installer has
        # completed. The replacement client function performs no installation.
        script = r'''
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Cannot parse Windows installer' }
$blocks = @($ast.FindAll({param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
    $node.Extent.Text.StartsWith('if ($Server)') -and
    $node.Extent.Text.Contains('$taskConfigureArguments =')
}, $true))
if ($blocks.Count -ne 1) { throw 'Cannot find the registration block' }
$Server = $env:TEST_SERVER; $Join = $env:TEST_NETWORK
$AllowLocalHttp = $env:TEST_LOCAL -eq 'yes'
$env:ProgramW6432 = 'C:\Native Program Files'
$env:ProgramFiles = 'C:\Other Program Files'
function Join-Path($Path, $ChildPath) {
    if ($Path -ne 'C:\Native Program Files' -or $ChildPath -ne 'SpiderWatch\spider-watch.exe') { throw 'Incorrect installed executable path' }
    return 'Test-SpiderClient'
}
function Test-SpiderClient {
    $script:CapturedArguments = @($args)
    $global:LASTEXITCODE = [int]$env:TEST_EXIT
}
$failed = $false
try { & ([scriptblock]::Create($blocks[0].Extent.Text)) }
catch { $failed = $true }
Write-Output ('RESULT:' + (@{failed=$failed; arguments=$script:CapturedArguments} | ConvertTo-Json -Compress))
'''
        env = {**os.environ, 'TEST_INSTALLER': str(ROOT / 'install.ps1'), 'TEST_SERVER': SERVER,
               'TEST_NETWORK': NETWORK, 'TEST_EXIT': str(exit_code), 'TEST_LOCAL': 'yes' if local else 'no'}
        result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', script],
                                env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        line = next(line for line in result.stdout.splitlines() if line.startswith('RESULT:'))
        return json.loads(line.removeprefix('RESULT:'))

    def test_registration_uses_native_installed_path_and_preserves_arguments(self):
        result = self.registration()
        self.assertFalse(result['failed'])
        self.assertEqual(result['arguments'], ['configure', '--server', SERVER, '--join', NETWORK])

    def test_registration_failure_propagates(self):
        self.assertTrue(self.registration(exit_code=23)['failed'])

    def test_local_http_option_is_forwarded(self):
        self.assertEqual(self.registration(local=True)['arguments'][-1], '--allow-local-http')


if __name__ == '__main__':
    unittest.main()
