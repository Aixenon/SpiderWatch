param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This installation test runs only on disposable GitHub-hosted Windows runners.'
}
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'test-service-arguments.ps1')
if ($LASTEXITCODE) { throw 'Windows PowerShell maintenance argument test failed.' }
$taskInstallLog = Join-Path $env:RUNNER_TEMP 'spider-watch-install.log'
$taskUninstallLog = Join-Path $env:RUNNER_TEMP 'spider-watch-uninstall.log'
$taskDir = Join-Path $env:ProgramFiles 'SpiderWatch'
try {
    $taskInstall = Start-Process -FilePath (Resolve-Path $Installer).Path -ArgumentList ('/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOG="' + $taskInstallLog + '"') -WindowStyle Hidden -Wait -PassThru
    if ($taskInstall.ExitCode -ne 0) { throw ('Installer failed: ' + $taskInstall.ExitCode) }
    & (Join-Path $taskDir 'spider-watch.exe') version
    if ($LASTEXITCODE -ne 0) { throw 'Installed executable failed.' }
    if ((Get-Service spider-watch).Status -ne 'Running') { throw 'Service is not running.' }
    if ((Get-CimInstance Win32_Service -Filter "Name='spider-watch'").StartName -ne 'NT AUTHORITY\LocalService') { throw 'Unexpected service privileges.' }
    Get-ScheduledTask 'spider-watch-update' -ErrorAction Stop | Out-Null
} catch {
    if (Test-Path -LiteralPath $taskInstallLog) { Get-Content -LiteralPath $taskInstallLog | Write-Host }
    throw
} finally {
    $taskUninstaller = Join-Path $taskDir 'unins000.exe'
    if (Test-Path -LiteralPath $taskUninstaller) {
        $taskUninstall = Start-Process -FilePath $taskUninstaller -ArgumentList ('/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="' + $taskUninstallLog + '"') -WindowStyle Hidden -Wait -PassThru
        if ($taskUninstall.ExitCode -ne 0) {
            if (Test-Path -LiteralPath $taskUninstallLog) { Get-Content -LiteralPath $taskUninstallLog | Write-Host }
            throw ('Uninstaller failed: ' + $taskUninstall.ExitCode)
        }
    }
}
if (Get-Service spider-watch -ErrorAction SilentlyContinue) { throw 'Service survived uninstall.' }
if (Get-ScheduledTask 'spider-watch-update' -ErrorAction SilentlyContinue) { throw 'Update task survived uninstall.' }
if (Test-Path -LiteralPath (Join-Path $taskDir 'spider-watch.exe')) { throw 'Executable survived uninstall.' }
