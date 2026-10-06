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
$taskStep = 'checking installation options'
function Get-InstallFile {
    param([string]$Url, [string]$Path, [long]$MaxBytes, [int]$Timeout, [string]$Name)
    $script:taskStep = 'downloading ' + $Name
    Write-Host ('[SpiderWatch] Downloading ' + $Name + '...')
    & curl.exe --proto $taskProtocols --proto-redir $taskProtocols --fail --location --show-error --progress-bar --max-redirs $taskRedirects --max-filesize $MaxBytes --connect-timeout 10 --max-time $Timeout $Url -o $Path
    if ($LASTEXITCODE) { throw ('Download failed: ' + $Name + ' (curl exit ' + $LASTEXITCODE + ').') }
    Write-Host ('[SpiderWatch] Downloaded ' + $Name + '.')
}
function Get-InstallBinary {
    param([string]$Url, [string]$Path, [long]$MaxBytes, [string]$Name, [string]$Hash)
    if (!$taskWorkerBase) { Get-InstallFile $Url $Path $MaxBytes 180 $Name; return }
    $taskCurlInfo = (& curl.exe --version 2>$null | Select-Object -First 1)
    $taskModernCurl = $taskCurlInfo -match '^curl (\d+)\.(\d+)\.' -and
        ([int]$Matches[1] -gt 8 -or ([int]$Matches[1] -eq 8 -and [int]$Matches[2] -ge 4))
    if (!$taskModernCurl) {
        Write-Host '[SpiderWatch] curl < 8.4: using single-connection compatibility mode.'
        Get-InstallFile $Url $Path $MaxBytes 180 $Name; return
    }
    $taskSizeFile = Join-Path ([IO.Path]::GetDirectoryName($Path)) 'download-size'
    $taskParts = @(0..3 | ForEach-Object { Join-Path ([IO.Path]::GetDirectoryName($Path)) ('part-' + $_) })
    $taskParallelOK = $false
    try {
        $script:taskStep = 'checking the package size for parallel download'
        Write-Host '[SpiderWatch] Checking the package size for parallel download...'
        if ($Hash -cnotmatch '^[a-f0-9]{64}\z') { throw 'Invalid package checksum.' }
        & curl.exe --fail --silent --show-error --location --max-redirs 0 --proto $taskProtocols --proto-redir $taskProtocols --connect-timeout 10 --max-time 30 --max-filesize 32 -o $taskSizeFile ($taskWorkerBase + '/parts/' + $Hash + '/size')
        $taskSizeExit = $LASTEXITCODE
        [long]$taskBytes = 0
        if (!$taskSizeExit) {
            $taskLength = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($taskSizeFile))
            if ($taskLength -notmatch '^([0-9]{1,8})\n?\z' -or ![long]::TryParse($Matches[1], [ref]$taskBytes) -or $taskBytes -le 0 -or $taskBytes -gt $MaxBytes) {
                throw 'Invalid or oversized package size metadata.'
            }
        } elseif ($taskSizeExit -eq 63) { throw 'Package size metadata exceeds 32 bytes.' }
        if ($taskSizeExit -or $taskBytes -lt 262144) {
            Write-Host '[SpiderWatch] Using a single download connection (small package or unavailable size).'
        } else {
            [long]$taskPartBytes = [Math]::Ceiling($taskBytes / 4.0)
            $script:taskStep = 'downloading ' + $Name + ' with 4 parallel connections'
            Write-Host ('[SpiderWatch] Downloading ' + $Name + ' with 4 parallel connections...')
            $taskCurlArguments = @('--parallel', '--parallel-max', '4', '--parallel-immediate', '--fail-early', '--show-error', '--progress-bar')
            for ($taskIndex = 0; $taskIndex -lt 4; $taskIndex++) {
                $taskPartLimit = if ($taskIndex -eq 3) { $taskBytes - $taskPartBytes * 3 } else { $taskPartBytes }
                if ($taskIndex) { $taskCurlArguments += '--next' }
                $taskCurlArguments += @('--fail', '--location', '--max-redirs', '0', '--proto', $taskProtocols, '--proto-redir', $taskProtocols,
                    '--connect-timeout', '10', '--max-time', '180', '--max-filesize', [string]$taskPartLimit,
                    '--write-out', '%{http_code}\n', '-o', $taskParts[$taskIndex], ($taskWorkerBase + '/parts/' + $Hash + '/' + $taskIndex))
            }
            $taskStatuses = @(& curl.exe @taskCurlArguments)
            $taskParallelExit = $LASTEXITCODE
            $taskParallelOK = !$taskParallelExit -and $taskStatuses.Count -eq 4 -and @($taskStatuses | Where-Object { $_ -ne '200' }).Count -eq 0
            for ($taskIndex = 0; $taskIndex -lt 4; $taskIndex++) {
                $taskPartLimit = if ($taskIndex -eq 3) { $taskBytes - $taskPartBytes * 3 } else { $taskPartBytes }
                if (!(Test-Path -LiteralPath $taskParts[$taskIndex]) -or (Get-Item -LiteralPath $taskParts[$taskIndex]).Length -ne $taskPartLimit) { $taskParallelOK = $false }
            }
            if (!$taskParallelOK) { Write-Host ('[SpiderWatch] Parallel download failed or returned an unexpected part length (curl exit ' + $taskParallelExit + ').') }
        }
        if ($taskParallelOK) {
            $script:taskStep = 'combining the downloaded parts'
            Write-Host '[SpiderWatch] Combining the downloaded parts...'
            $taskOutput = [IO.File]::Open($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write)
            try {
                foreach ($taskPart in $taskParts) {
                    $taskInput = [IO.File]::OpenRead($taskPart)
                    try { $taskInput.CopyTo($taskOutput, 65536) } finally { $taskInput.Dispose() }
                    Remove-Item -LiteralPath $taskPart -Force
                }
            } finally { $taskOutput.Dispose() }
            Write-Host ('[SpiderWatch] Downloaded ' + $Name + '.')
        }
    } finally {
        foreach ($taskPart in @($taskSizeFile) + $taskParts) { if (Test-Path -LiteralPath $taskPart) { Remove-Item -LiteralPath $taskPart -Force } }
    }
    if (!$taskParallelOK) {
        Write-Host '[SpiderWatch] Retrying with a single download connection.'
        Get-InstallFile $Url $Path $MaxBytes 180 $Name
    }
}
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
    $taskWorkerBase = $Server.Substring(0, $Server.IndexOf('#')).TrimEnd('/') + '/downloads'
    $taskRedirects = 0
    if ($taskServerUri.Scheme -eq 'http') { $taskProtocols = '=http,https' }
    Write-Host '[SpiderWatch] Checking administrator permissions...'
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
Write-Host ('[SpiderWatch] Platform: windows/' + $Architecture + '.')
$taskTemp = Join-Path ([IO.Path]::GetTempPath()) ('spider-watch-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskTemp | Out-Null
$taskSetup = Join-Path $taskTemp 'setup.exe'
$taskChecksums = Join-Path $taskTemp 'checksums.txt'
$taskManifest = Join-Path $taskTemp 'current.json'
$taskName = 'spider-watch-windows-' + $Architecture + '-setup.exe'
$taskBase = 'https://github.com/' + $Repository + '/releases/download/' + $Version
try {
    if ($taskWorkerBase) {
        Write-Host '[SpiderWatch] Getting the current client version...'
        Get-InstallFile ($taskWorkerBase+'/current.json') $taskManifest 65536 120 'version metadata'
        $taskStep = 'reading the client version'
        $taskCurrent = Get-Content -LiteralPath $taskManifest -Raw | ConvertFrom-Json
        if ($taskCurrent.schema -ne 1 -or $taskCurrent.version -isnot [string] -or $taskCurrent.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+\z') { throw 'Invalid deployed client version.' }
        $Version = 'v' + $taskCurrent.version
        $taskBase = $taskWorkerBase
    }
    Write-Host ('[SpiderWatch] Client version: ' + $Version.TrimStart('v') + '.')
    Get-InstallFile ($taskBase+'/checksums.txt') $taskChecksums 16384 120 'SHA-256 checksums'
    $taskStep = 'reading the platform checksum'
    $taskMatches = @(Get-Content -LiteralPath $taskChecksums | Where-Object { $_ -match ('^[a-f0-9]{64}  ' + [Regex]::Escape($taskName) + '$') })
    if ($taskMatches.Count -ne 1) { throw 'Missing or duplicate installer checksum.' }
    $taskHash = $taskMatches[0].Substring(0,64)
    Get-InstallBinary ($taskBase+'/'+$taskName) $taskSetup 26214400 $taskName $taskHash
    $taskStep = 'verifying SHA-256'
    Write-Host '[SpiderWatch] Verifying SHA-256...'
    if ((Get-FileHash -LiteralPath $taskSetup -Algorithm SHA256).Hash -ne $taskHash) { throw 'Installer checksum verification failed.' }
    Write-Host '[SpiderWatch] Checksum verified.'
    $taskStep = 'installing the client and Windows service'
    Write-Host '[SpiderWatch] Installing the client and Windows service...'
    $taskStartParameters = @{FilePath=$taskSetup; Verb='RunAs'; Wait=$true; PassThru=$true}
    if ($Silent) { $taskStartParameters.ArgumentList = '/S'; $taskStartParameters.WindowStyle = 'Hidden' }
    else { $taskStartParameters.WindowStyle = 'Normal' }
    $taskProcess = Start-Process @taskStartParameters
    if ($taskProcess.ExitCode -ne 0) { throw ('Installer failed: ' + $taskProcess.ExitCode) }
    Write-Host '[SpiderWatch] Client and Windows service installed.'
    if ($Server) {
        $taskStep = 'registering this device and starting the service'
        Write-Host '[SpiderWatch] Registering this device and starting the service...'
        # Use the native Program Files path even from 32-bit PowerShell, without
        # relying on the PATH refresh that requires opening another terminal.
        $taskProgramFiles = $env:ProgramW6432
        if (!$taskProgramFiles) { $taskProgramFiles = $env:ProgramFiles }
        $taskClient = Join-Path $taskProgramFiles 'SpiderWatch\spider-watch.exe'
        $taskConfigureArguments = @('configure', '--server', $Server, '--join', $Join)
        if ($AllowLocalHttp) { $taskConfigureArguments += '--allow-local-http' }
        & $taskClient @taskConfigureArguments
        if ($LASTEXITCODE -ne 0) { throw 'Installation succeeded, but registration failed. Request a new invitation and retry the panel registration command.' }
        Write-Host '[SpiderWatch] Registration complete.'
        Write-Host 'Installed and registered. SpiderWatch is running as a system service.'
    } else {
        Write-Host 'Installed. Open a new Administrator terminal and paste the registration command from the panel.'
    }
} catch {
    Write-Host ('[SpiderWatch] Failed while ' + $taskStep + '.')
    throw
} finally {
    # Delete only the known files in the GUID directory created by this invocation.
    foreach ($taskFile in @($taskSetup,$taskChecksums,$taskManifest)) { if (Test-Path -LiteralPath $taskFile) { Remove-Item -LiteralPath $taskFile -Force } }
    Remove-Item -LiteralPath $taskTemp -Force
}
