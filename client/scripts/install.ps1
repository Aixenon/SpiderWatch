param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$')][string]$Repository = '__SPIDER_REPOSITORY__',
    [string]$Version = '__SPIDER_VERSION__',
    [ValidateSet('','amd64','arm64','386')][string]$Architecture = '',
    [switch]$Silent,
    [string]$Server = '',
    [string]$Join = '',
    [switch]$AllowLocalHttp
)
$ErrorActionPreference = 'Stop'
$taskWorkerBase = ''
$taskProtocols = '=https'
$taskRedirects = 3
if ($Server -or $Join) {
    if (!$Server -or !$Join) { throw '-Server and -Join must be used together.' }
    if ($Join -notmatch '^(?:[A-Za-z0-9]{16}|[0-9]{12})\z') { throw 'Invalid network code.' }
    $taskServerUri = $null
    if (![Uri]::TryCreate($Server, [UriKind]::Absolute, [ref]$taskServerUri) -or
        ($taskServerUri.Scheme -ne 'https' -and !($AllowLocalHttp -and $taskServerUri.Scheme -eq 'http' -and $taskServerUri.IsLoopback))) {
        throw 'The server must use HTTPS (local HTTP requires -AllowLocalHttp).'
    }
    if ($Server -match '[\x00-\x20\x7f]' -or $taskServerUri.UserInfo -or $taskServerUri.Query -or $taskServerUri.AbsolutePath -ne '/' -or
        $taskServerUri.Fragment -cnotmatch '^#invite=[a-f0-9]{32}\.[0-9]{13}\.(?:[A-Za-z0-9]|%2[BbFf]){43}%3[Dd]\z') {
        throw 'Use the complete invitation URL from the panel.'
    }
    # Preserve the original authority: Windows PowerShell expands IPv6 ::1
    # when GetLeftPart is used, while the panel and client keep the short form.
    $taskWorkerBase = $Server.Substring(0, $Server.IndexOf('#')).TrimEnd('/') + '/bootstrap/install/' + $taskServerUri.Fragment.Substring(8)
    $taskRedirects = 0
    if ($taskServerUri.Scheme -eq 'http') { $taskProtocols = '=http,https' }
    $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $taskPrincipal = [Security.Principal.WindowsPrincipal]::new($taskIdentity)
        if (!$taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'Run this installation command in an Administrator PowerShell terminal.'
        }
    } finally { $taskIdentity.Dispose() }
} else {
    if ($Repository -like '__*') { throw 'Use the installer script attached to a GitHub Release, or specify -Repository OWNER/REPO -Version vX.Y.Z.' }
    if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'A stable vX.Y.Z release version is required.' }
}
if (!$Architecture) {
    $taskMachine = $env:PROCESSOR_ARCHITEW6432
    if (!$taskMachine) { $taskMachine = $env:PROCESSOR_ARCHITECTURE }
    $Architecture = switch ($taskMachine) { 'AMD64' {'amd64'} 'ARM64' {'arm64'} 'x86' {'386'} default { throw 'Unsupported architecture.' } }
}
$taskTemp = Join-Path ([IO.Path]::GetTempPath()) ('spider-watch-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskTemp | Out-Null
$taskSetup = Join-Path $taskTemp 'setup.exe'
$taskChecksums = Join-Path $taskTemp 'checksums.txt'
$taskManifest = Join-Path $taskTemp 'current.json'
$taskName = 'spider-watch-windows-' + $Architecture + '-setup.exe'
$taskBase = 'https://github.com/' + $Repository + '/releases/download/' + $Version
try {
    if ($taskWorkerBase) {
        & curl.exe --proto $taskProtocols --proto-redir $taskProtocols -fLsS --max-redirs $taskRedirects --max-filesize 65536 --connect-timeout 10 --max-time 120 ($taskWorkerBase+'/current.json') -o $taskManifest
        if ($LASTEXITCODE) { throw 'Cannot read the deployed client version.' }
        $taskCurrent = Get-Content -LiteralPath $taskManifest -Raw | ConvertFrom-Json
        if ($taskCurrent.schema -ne 1 -or $taskCurrent.version -isnot [string] -or $taskCurrent.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+\z') { throw 'Invalid deployed client version.' }
        $taskBase = $taskWorkerBase + '/' + $taskCurrent.version
    }
    & curl.exe --proto $taskProtocols --proto-redir $taskProtocols -fLsS --max-redirs $taskRedirects --max-filesize 16384 --connect-timeout 10 --max-time 120 ($taskBase+'/checksums.txt') -o $taskChecksums
    if ($LASTEXITCODE) { throw 'Cannot download release checksums.' }
    $taskMatches = @(Get-Content -LiteralPath $taskChecksums | Where-Object { $_ -match ('^[a-f0-9]{64}  ' + [Regex]::Escape($taskName) + '$') })
    if ($taskMatches.Count -ne 1) { throw 'Missing or duplicate installer checksum.' }
    $taskHash = $taskMatches[0].Substring(0,64)
    & curl.exe --proto $taskProtocols --proto-redir $taskProtocols -fLsS --max-redirs $taskRedirects --max-filesize 26214400 --connect-timeout 10 --max-time 180 ($taskBase+'/'+$taskName) -o $taskSetup
    if ($LASTEXITCODE -or (Get-FileHash -LiteralPath $taskSetup -Algorithm SHA256).Hash -ne $taskHash) { throw 'Installer download or checksum verification failed.' }
    $taskArguments = if ($Silent) { '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' } else { '/NORESTART' }
    $taskProcess = Start-Process -FilePath $taskSetup -ArgumentList $taskArguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($taskProcess.ExitCode -ne 0) { throw ('Installer failed: ' + $taskProcess.ExitCode) }
    if ($Server) {
        # Use the native Program Files path even from 32-bit PowerShell, without
        # relying on the PATH refresh that requires opening another terminal.
        $taskProgramFiles = $env:ProgramW6432
        if (!$taskProgramFiles) { $taskProgramFiles = $env:ProgramFiles }
        $taskClient = Join-Path $taskProgramFiles 'SpiderWatch\spider-watch.exe'
        $taskConfigureArguments = @('configure', '--server', $Server, '--join', $Join)
        if ($AllowLocalHttp) { $taskConfigureArguments += '--allow-local-http' }
        & $taskClient @taskConfigureArguments
        if ($LASTEXITCODE -ne 0) { throw 'Installation succeeded, but registration failed. Request a new invitation and retry the panel registration command.' }
        Write-Host 'Installed and registered. SpiderWatch is running as a system service.'
    } else {
        Write-Host 'Installed. Open a new Administrator terminal and paste the registration command from the panel.'
    }
} finally {
    # Delete only the known files in the GUID directory created by this invocation.
    foreach ($taskFile in @($taskSetup,$taskChecksums,$taskManifest)) { if (Test-Path -LiteralPath $taskFile) { Remove-Item -LiteralPath $taskFile -Force } }
    Remove-Item -LiteralPath $taskTemp -Force
}
