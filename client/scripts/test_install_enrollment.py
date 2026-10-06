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
SHELL = os.environ.get('SPIDER_TEST_SHELL') or shutil.which('sh')
SHELL_ENV = dict(os.environ)
if os.name == 'nt' and SHELL:
    shell_directory = Path(SHELL).resolve().parent
    tool_directories = [shell_directory, shell_directory.parent / 'usr' / 'bin']
    SHELL_ENV['PATH'] = os.pathsep.join([str(path) for path in tool_directories if path.is_dir()]
                                      + [SHELL_ENV.get('PATH', '')])
POWERSHELL = shutil.which('powershell') if os.name == 'nt' else None
TOKEN = 'a' * 32 + '.1791288000000.' + 'b' * 41 + '%2B%2F%3D'
SERVER = 'https://monitor.example.test/#invite=' + TOKEN
NETWORK = 'abcd1234EFGH5678'


@unittest.skipUnless(SHELL, 'requires a POSIX shell')
class UnixEnrollmentTests(unittest.TestCase):
    def install(self, registration_exit=0, extra=None, checksum_duplicate=False,
                manifest_version='1.2.3', elevate=False, download_exit=0):
        with tempfile.TemporaryDirectory(prefix='.installer-test-', dir=ROOT) as directory:
            root = Path(directory)
            binary = root / 'binary'
            binary.write_text('''#!/bin/sh
if [ "$1" = version ]; then printf 'spider-watch 1.2.3\\n'; exit 0; fi
printf '%s\\n' "$@" > "$TEST_ARGUMENTS"
exit "$TEST_REGISTRATION_EXIT"
''', newline='\n')
            checksum = hashlib.sha256(binary.read_bytes()).hexdigest()
            checksums = f'{checksum}  spider-watch-linux-amd64\n'
            (root / 'checksums').write_text(checksums * (2 if checksum_duplicate else 1))
            (root / 'manifest').write_text(json.dumps({'schema': 1, 'version': manifest_version}))
            probes = r'''uname() { printf 'Linux\n'; }
curl() {
  if [ "$1" = --version ]; then printf 'curl 7.88.1\n'; return 0; fi
  url=; target=; redirects=; protocols=
  while [ "$#" -gt 0 ]; do
    case "$1" in https://*|http://*) url=$1; shift;; -o) target=$2; shift 2;; --max-redirs) redirects=$2; shift 2;; --proto) protocols=$2; shift 2;; *) shift;; esac
  done
  printf '%s\n' "$url" >> "$TEST_FIXTURES/downloads"
  [ "$TEST_DOWNLOAD_EXIT" = 0 ] || return "$TEST_DOWNLOAD_EXIT"
  case "$url" in
    https://github.com/owner/fork/releases/download/v1.2.3/checksums.txt) cp "$TEST_FIXTURES/checksums" "$target";;
    https://github.com/owner/fork/releases/download/v1.2.3/spider-watch-linux-amd64) cp "$TEST_FIXTURES/binary" "$target";;
    https://monitor.example.test/install.sh) cp "$TEST_INSTALLER" "$target";;
    https://monitor.example.test/downloads/*|http://127.0.0.1/downloads/*|http://\[::1\]:8788/downloads/*)
      [ "$redirects" = 0 ] || return 93
      case "$url" in http://*) [ "$protocols" = '=http,https' ] || return 94;; *) [ "$protocols" = '=https' ] || return 95;; esac
      case "$url" in
        */current.json) cp "$TEST_FIXTURES/manifest" "$target";;
        */downloads/checksums.txt) cp "$TEST_FIXTURES/checksums" "$target";;
        */downloads/spider-watch-linux-amd64) cp "$TEST_FIXTURES/binary" "$target";;
        *) return 92;;
      esac;;
    *) printf 'Unexpected download URL\n' >&2; return 91;;
  esac
}
id() { printf '1000\n'; }
sudo() {
  [ "$1" = sh ] && [ -s "$2" ] || return 96
  cmp "$2" "$TEST_INSTALLER" || return 97
  shift 2
  printf '%s\n' "$@" > "$TEST_ARGUMENTS"
}
script=$TEST_INSTALLER
'''
            arguments = root / 'arguments'
            env = {**SHELL_ENV, 'TEST_FIXTURES': str(root).replace('\\', '/'),
                   'TEST_INSTALLER': str(ROOT / 'install.sh').replace('\\', '/'),
                   'TEST_ARGUMENTS': str(arguments).replace('\\', '/'),
                   'TEST_REGISTRATION_EXIT': str(registration_exit),
                   'TEST_DOWNLOAD_EXIT': str(download_exit)}
            # /... is also required by the installer's prefix check under Git Bash.
            prefix = str(root / 'installed').replace('\\', '/')
            if os.name == 'nt':
                prefix = '/' + prefix[0].lower() + prefix[2:]
            args = ['--repo', 'owner/fork', '--version', 'v1.2.3', '--arch', 'amd64']
            if not elevate:
                args += ['--no-service', '--prefix', prefix]
            args += extra if extra is not None else ['--server', SERVER, '--join', NETWORK]
            # Environment values avoid MSYS's additional command-line parsing
            # when launching sh from Windows; the POSIX script still receives
            # each real CLI argument unchanged.
            env.update({f'TEST_ARG{i}': arg for i, arg in enumerate(args)})
            probes += 'set -- ' + ' '.join(f'"$TEST_ARG{i}"' for i in range(len(args))) + '\n. "$script"\n'
            result = subprocess.run([SHELL, '-c', probes, 'installer-test'],
                                    env=env, text=True, encoding='utf-8', errors='replace', capture_output=True)
            self.downloads = (root / 'downloads').read_text().splitlines() if (root / 'downloads').exists() else []
            return result, arguments.read_text().splitlines() if arguments.exists() else None

    def test_panel_install_downloads_only_from_worker_and_preserves_invitation(self):
        result, args = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args, ['configure', '--server', SERVER, '--join', NETWORK])
        base = 'https://monitor.example.test/downloads'
        self.assertEqual(self.downloads, [base + '/current.json', base + '/checksums.txt',
                                         base + '/spider-watch-linux-amd64'])
        self.assertTrue(all(TOKEN not in url and 'invite' not in url for url in self.downloads))
        output = result.stdout + result.stderr
        for stage in ['Platform: linux/amd64', 'Getting the current client version',
                      'Downloaded version metadata', 'Client version: 1.2.3',
                      'Downloading spider-watch-linux-amd64', 'Checksum and executable version verified',
                      'Installing the client', 'Registering this device', 'Registration complete']:
            self.assertIn(stage, output)
        self.assertNotIn(TOKEN, output)
        self.assertNotIn(SERVER, output)

    def test_failed_registration_does_not_report_installation_success(self):
        result, _ = self.install(registration_exit=23)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertNotIn('Installed ', result.stdout)
        self.assertIn('Failed while Registering this device (exit 23)', result.stderr)
        self.assertNotIn('Registration complete', result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

    def test_failed_download_keeps_exit_code_and_identifies_stage(self):
        result, args = self.install(download_exit=22)
        self.assertEqual(result.returncode, 22)
        self.assertIsNone(args)
        self.assertIn('Download failed: version metadata (curl exit 22)', result.stderr)
        self.assertIn('Failed while Downloading version metadata (exit 22)', result.stderr)
        self.assertNotIn('Downloaded version metadata', result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

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
        self.assertTrue(all(url.startswith('https://github.com/owner/fork/') for url in self.downloads))
        for origin in ['http://127.0.0.1', 'http://[::1]:8788']:
            result, args = self.install(extra=['--server', origin + '/#invite=' + TOKEN,
                                             '--join', NETWORK, '--allow-local-http'])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(args[-1], '--allow-local-http')

    def test_untrusted_invitation_urls_fail_before_download(self):
        for server in [SERVER.replace('https:', 'http:'),
                       SERVER.replace('monitor.example.test', 'name:secret@monitor.example.test'),
                       SERVER.replace('/#', '/other/#'), SERVER + '&other=1',
                       SERVER.replace('%2B', '%252B'), SERVER + '\nhttps://other.test/',
                       "https://monitor.example.test/#invite=one'two$()&three"]:
            result, args = self.install(extra=['--server', server, '--join', NETWORK, '--allow-local-http'])
            self.assertNotEqual(result.returncode, 0, server)
            self.assertIsNone(args)
            self.assertEqual(self.downloads, [])

    def test_duplicate_checksums_and_malformed_versions_are_rejected(self):
        result, args = self.install(checksum_duplicate=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(args)
        self.assertIn('duplicate SHA-256', result.stderr)
        for version in ['1.2.3-dev', '1.2.3/../../other', '1.2.3\n9.9.9']:
            result, args = self.install(manifest_version=version)
            self.assertNotEqual(result.returncode, 0)
            self.assertIsNone(args)

    def test_nonroot_pipeline_elevates_a_complete_same_origin_script(self):
        result, args = self.install(elevate=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.downloads, ['https://monitor.example.test/install.sh'])
        self.assertEqual(args[-4:], ['--server', SERVER, '--join', NETWORK])

    def test_truncated_pipeline_never_starts_installation(self):
        script = (ROOT / 'install.sh').read_text()
        partial = script[:script.index('    procd)')]
        result = subprocess.run([SHELL], input=partial, env=SHELL_ENV, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')


@unittest.skipUnless(POWERSHELL, 'requires Windows PowerShell')
class WindowsEnrollmentTests(unittest.TestCase):
    def download_log(self, exit_code=0):
        script = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Cannot parse Windows installer' }
$function = $ast.Find({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-InstallFile'
}, $true)
if (!$function) { throw 'Cannot find the download function' }
. ([scriptblock]::Create($function.Extent.Text))
$taskProtocols = '=https'; $taskRedirects = 0
function curl.exe { $global:LASTEXITCODE = [int]$env:TEST_EXIT }
$message = ''
try { Get-InstallFile $env:TEST_SERVER 'unused.tmp' 65536 120 'version metadata' }
catch { $message = $_.Exception.Message }
Write-Output ('RESULT:' + (@{error=$message; step=$taskStep} | ConvertTo-Json -Compress))
'''
        env = {**os.environ, 'TEST_INSTALLER': str(ROOT / 'install.ps1'),
               'TEST_SERVER': SERVER, 'TEST_EXIT': str(exit_code)}
        result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', script],
                                env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        line = next(line for line in result.stdout.splitlines() if line.startswith('RESULT:'))
        return result.stdout, json.loads(line.removeprefix('RESULT:'))

    def test_windows_download_logs_success_and_failure_without_credentials(self):
        output, result = self.download_log()
        self.assertEqual(result['error'], '')
        self.assertIn('Downloading version metadata', output)
        self.assertIn('Downloaded version metadata', output)
        output, result = self.download_log(exit_code=22)
        self.assertIn('curl exit 22', result['error'])
        self.assertEqual(result['step'], 'downloading version metadata')
        self.assertNotIn('Downloaded version metadata', output)

    def download_source(self, server=SERVER, local=False):
        script = r'''
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $env:TEST_INSTALLER -Raw
$boundary = $source.IndexOf('    $taskIdentity =')
if ($boundary -lt 0) { throw 'Cannot find the installer privilege boundary' }
# Run the real argument and URL validation before any privilege or file work.
$source = $source.Substring(0, $boundary) + "`n}`n" + @'
Write-Output ('RESULT:' + (@{base=$taskWorkerBase; protocols=$taskProtocols; redirects=$taskRedirects} | ConvertTo-Json -Compress))
'@
try { & ([scriptblock]::Create($source)) -Server $env:TEST_SERVER -Join $env:TEST_NETWORK -AllowLocalHttp:($env:TEST_LOCAL -eq 'yes') }
catch { Write-Output 'RESULT:{"failed":true}' }
'''
        env = {**os.environ, 'TEST_INSTALLER': str(ROOT / 'install.ps1'), 'TEST_SERVER': server,
               'TEST_NETWORK': NETWORK, 'TEST_LOCAL': 'yes' if local else 'no'}
        result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', script],
                                env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        line = next(line for line in result.stdout.splitlines() if line.startswith('RESULT:'))
        return json.loads(line.removeprefix('RESULT:'))

    def test_panel_invitation_selects_worker_origin_without_redirects(self):
        result = self.download_source()
        self.assertEqual(result, {'base': 'https://monitor.example.test/downloads',
                                  'protocols': '=https', 'redirects': 0})
        result = self.download_source('http://[::1]:8788/#invite=' + TOKEN, local=True)
        self.assertEqual(result['base'], 'http://[::1]:8788/downloads')
        self.assertEqual(result['protocols'], '=http,https')

    def test_invalid_windows_download_origins_are_rejected(self):
        for server in [SERVER.replace('https:', 'http:'), SERVER + '&other=1',
                       SERVER.replace('/#', '/other/#'),
                       SERVER.replace('monitor.example.test', 'name:secret@monitor.example.test')]:
            self.assertTrue(self.download_source(server, local=True)['failed'])

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
        self.registration_logs = '\n'.join(line for line in result.stdout.splitlines()
                                           if not line.startswith('RESULT:')) + result.stderr
        line = next(line for line in result.stdout.splitlines() if line.startswith('RESULT:'))
        return json.loads(line.removeprefix('RESULT:'))

    def test_registration_uses_native_installed_path_and_preserves_arguments(self):
        result = self.registration()
        self.assertFalse(result['failed'])
        self.assertEqual(result['arguments'], ['configure', '--server', SERVER, '--join', NETWORK])
        self.assertIn('Registering this device', self.registration_logs)
        self.assertIn('Registration complete', self.registration_logs)
        self.assertNotIn(TOKEN, self.registration_logs)

    def test_registration_failure_propagates(self):
        self.assertTrue(self.registration(exit_code=23)['failed'])

    def test_local_http_option_is_forwarded(self):
        self.assertEqual(self.registration(local=True)['arguments'][-1], '--allow-local-http')


if __name__ == '__main__':
    unittest.main()
