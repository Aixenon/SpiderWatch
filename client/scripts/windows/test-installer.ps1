param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This installation test runs only on disposable GitHub-hosted Windows runners.'
}
$taskInstall = Start-Process -FilePath (Resolve-Path $Installer).Path -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' -WindowStyle Hidden -Wait -PassThru
if ($taskInstall.ExitCode -ne 0) { throw 'Installer failed.' }
$taskDir = Join-Path $env:ProgramFiles 'SpiderWatch'
try {
    & (Join-Path $taskDir 'spider-watch.exe') version
    if ($LASTEXITCODE -ne 0) { throw 'Installed executable failed.' }
    if ((Get-Service spider-watch).Status -ne 'Running') { throw 'Service is not running.' }
    if ((Get-CimInstance Win32_Service -Filter "Name='spider-watch'").StartName -ne 'NT AUTHORITY\LocalService') { throw 'Unexpected service privileges.' }
    Get-ScheduledTask 'spider-watch-update' -ErrorAction Stop | Out-Null
} finally {
    $taskUninstall = Start-Process -FilePath (Join-Path $taskDir 'unins000.exe') -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -WindowStyle Hidden -Wait -PassThru
    if ($taskUninstall.ExitCode -ne 0) { throw 'Uninstaller failed.' }
}
if (Get-Service spider-watch -ErrorAction SilentlyContinue) { throw 'Service survived uninstall.' }
if (Get-ScheduledTask 'spider-watch-update' -ErrorAction SilentlyContinue) { throw 'Update task survived uninstall.' }
if (Test-Path -LiteralPath (Join-Path $taskDir 'spider-watch.exe')) { throw 'Executable survived uninstall.' }
