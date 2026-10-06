param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This installation test runs only on disposable GitHub-hosted Windows runners.'
}
& (Join-Path $PSScriptRoot 'test-maintenance-environment.ps1')
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'test-service-arguments.ps1')
if ($LASTEXITCODE) { throw 'Windows PowerShell maintenance argument test failed.' }
$taskNativeProgramFiles = $env:ProgramW6432
if (!$taskNativeProgramFiles) { $taskNativeProgramFiles = $env:ProgramFiles }
$taskDir = Join-Path $taskNativeProgramFiles 'SpiderWatch'
$taskStateSentinel = Join-Path $env:ProgramData 'spider-watch\state\installer-retention-test.txt'
$taskUninstallKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SpiderWatch'
$taskLegacyKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SpiderWatch_is1'
$taskMaintenanceBackup = $null
try {
    $taskInstall = Start-Process -FilePath (Resolve-Path $Installer).Path -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($taskInstall.ExitCode -ne 0) { throw ('Installer failed: ' + $taskInstall.ExitCode) }
    & (Join-Path $taskDir 'spider-watch.exe') version
    if ($LASTEXITCODE -ne 0) { throw 'Installed executable failed.' }
    if ((Get-Service spider-watch).Status -ne 'Running') { throw 'Service is not running.' }
    if ((Get-CimInstance Win32_Service -Filter "Name='spider-watch'").StartName -ne 'NT AUTHORITY\LocalService') { throw 'Unexpected service privileges.' }
    Get-ScheduledTask 'spider-watch-update' -ErrorAction Stop | Out-Null
    if ((Get-ItemProperty -LiteralPath $taskUninstallKey).InstallLocation -ne $taskDir) { throw 'Incorrect native installation directory.' }
    Set-Content -LiteralPath $taskStateSentinel -Value 'retained-identity'
    New-Item -Path $taskLegacyKey -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $taskDir 'unins000.dat') -Value 'legacy-uninstaller'
    $taskUpgrade = Start-Process -FilePath (Resolve-Path $Installer).Path -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($taskUpgrade.ExitCode -ne 0 -or (Get-Service spider-watch).Status -ne 'Running') { throw 'Reinstall failed to restart the service.' }
    if (!(Test-Path -LiteralPath $taskStateSentinel)) { throw 'Reinstall removed device state.' }
    if ((Test-Path -LiteralPath $taskLegacyKey) -or (Test-Path -LiteralPath (Join-Path $taskDir 'unins000.dat'))) { throw 'Legacy installer records survived migration.' }
    $taskMaintenancePath = Join-Path $taskDir 'maintenance\service.ps1'
    $taskMaintenanceBackup = [IO.File]::ReadAllBytes($taskMaintenancePath)
    Set-Content -LiteralPath $taskMaintenancePath -Value 'exit 23'
    $taskFailedRemoval = Start-Process -FilePath (Join-Path $taskDir 'uninstall.exe') -ArgumentList ('/S _?=' + $taskDir) -WindowStyle Hidden -Wait -PassThru
    if ($taskFailedRemoval.ExitCode -eq 0 -or !(Test-Path -LiteralPath (Join-Path $taskDir 'spider-watch.exe'))) { throw 'Uninstall ignored a maintenance failure.' }
    [IO.File]::WriteAllBytes($taskMaintenancePath, $taskMaintenanceBackup)
    $taskMaintenanceBackup = $null
    # A held read handle blocks replacement and deletion, but permits service startup.
    $taskBinaryLock = [IO.File]::Open((Join-Path $taskDir 'spider-watch.exe'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $taskBlockedInstall = Start-Process -FilePath (Resolve-Path $Installer).Path -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
        if ($taskBlockedInstall.ExitCode -eq 0) { throw 'Installation reported success with a locked executable.' }
        $taskBlockedUninstall = Start-Process -FilePath (Join-Path $taskDir 'uninstall.exe') -ArgumentList ('/S _?=' + $taskDir) -WindowStyle Hidden -Wait -PassThru
        if ($taskBlockedUninstall.ExitCode -eq 0) { throw 'Uninstall reported success with a locked executable.' }
        if (!(Test-Path -LiteralPath $taskUninstallKey) -or !(Test-Path -LiteralPath $taskMaintenancePath)) { throw 'Failed removal discarded retry information.' }
    } finally { $taskBinaryLock.Dispose() }
} finally {
    if ($null -ne $taskMaintenanceBackup) { [IO.File]::WriteAllBytes((Join-Path $taskDir 'maintenance\service.ps1'), $taskMaintenanceBackup) }
    $taskUninstaller = Join-Path $taskDir 'uninstall.exe'
    if (Test-Path -LiteralPath $taskUninstaller) {
        # _?= avoids a detached temporary child so CI waits for the real exit code.
        $taskUninstall = Start-Process -FilePath $taskUninstaller -ArgumentList ('/S _?=' + $taskDir) -WindowStyle Hidden -Wait -PassThru
        if ($taskUninstall.ExitCode -ne 0) {
            throw ('Uninstaller failed: ' + $taskUninstall.ExitCode)
        }
    }
}
if (Get-Service spider-watch -ErrorAction SilentlyContinue) { throw 'Service survived uninstall.' }
if (Get-ScheduledTask 'spider-watch-update' -ErrorAction SilentlyContinue) { throw 'Update task survived uninstall.' }
if (Test-Path -LiteralPath (Join-Path $taskDir 'spider-watch.exe')) { throw 'Executable survived uninstall.' }
if (Test-Path -LiteralPath $taskUninstallKey) { throw 'Uninstall registration survived removal.' }
if (!(Test-Path -LiteralPath $taskStateSentinel)) { throw 'Uninstall removed device state.' }
Remove-Item -LiteralPath $taskStateSentinel -Force
