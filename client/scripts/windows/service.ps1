param([ValidateSet('Install','Remove')][string]$Action = 'Install')
$ErrorActionPreference = 'Stop'

function Initialize-MaintenanceEnvironment {
    # Setup is an intermediate process: Windows PowerShell can inherit PS7's
    # module paths instead of rebuilding its own. Load only the native modules.
    if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Windows PowerShell is required for service maintenance' }
    $taskModules = [IO.Path]::Combine($PSHOME, 'Modules')
    [Environment]::SetEnvironmentVariable('PSModulePath', $taskModules, 'Process')
    [Environment]::SetEnvironmentVariable('PSModuleAnalysisCachePath', $null, 'Process')
    foreach ($taskModule in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','CimCmdlets','ScheduledTasks')) {
        $taskManifest = [IO.Path]::Combine($taskModules, $taskModule, ($taskModule + '.psd1'))
        if (![IO.File]::Exists($taskManifest)) { throw ('Required Windows module is missing: ' + $taskModule) }
        Import-Module -Name $taskManifest -Scope Global -Force -ErrorAction Stop
    }
}

function ConvertTo-NativeArgument([AllowEmptyString()][string]$Value) {
    # Windows PowerShell 5 drops embedded quotes in native argument arrays.
    # Escape the command line explicitly, including trailing backslashes.
    '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-MaintenanceProcess([string]$FilePath, [string[]]$Arguments) {
    $taskStart = New-Object Diagnostics.ProcessStartInfo
    $taskStart.FileName = $FilePath
    $taskStart.Arguments = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    $taskProcess = New-Object Diagnostics.Process
    $taskProcess.StartInfo = $taskStart
    try {
        if (!$taskProcess.Start()) { throw 'Cannot start maintenance command' }
        $taskOutputRead = $taskProcess.StandardOutput.ReadToEndAsync()
        $taskErrorRead = $taskProcess.StandardError.ReadToEndAsync()
        $taskProcess.WaitForExit()
        $taskOutput = $taskOutputRead.Result
        $taskError = $taskErrorRead.Result
        if ($taskProcess.ExitCode -ne 0) {
            throw ('Maintenance command failed (exit ' + $taskProcess.ExitCode + '): ' + $taskOutput + $taskError)
        }
        $taskOutput
    } finally { $taskProcess.Dispose() }
}

Initialize-MaintenanceEnvironment
$taskSC = Join-Path $env:SystemRoot 'System32\sc.exe'
$taskProgramDir = Split-Path -Parent $PSScriptRoot
$taskBinary = Join-Path $taskProgramDir 'spider-watch.exe'
$taskRoot = Join-Path $env:ProgramData 'spider-watch'
$taskState = Join-Path $taskRoot 'state'
$taskConfig = Join-Path $taskState 'config.json'
$taskService = Get-Service 'spider-watch' -ErrorAction SilentlyContinue
if ($taskService -and $taskService.Status -ne 'Stopped') {
    Stop-Service 'spider-watch' -ErrorAction Stop
    $taskService.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}
if ($Action -eq 'Remove') {
    Unregister-ScheduledTask -TaskName 'spider-watch-update' -Confirm:$false -ErrorAction SilentlyContinue
    if ($taskService) { Invoke-MaintenanceProcess $taskSC @('delete','spider-watch') | Out-Null }
    # Preserve device identity for reinstall. Remove the installation marker so
    # a portable copy does not mistake retained state for a running service.
    $taskMarker = Join-Path $taskRoot 'service-installed'
    if (Test-Path -LiteralPath $taskMarker) { Remove-Item -LiteralPath $taskMarker -Force }
    $taskPath = [Environment]::GetEnvironmentVariable('Path','Machine')
    $taskEntries = @($taskPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $taskProgramDir.TrimEnd('\') })
    [Environment]::SetEnvironmentVariable('Path',($taskEntries -join ';'),'Machine')
    exit 0
}
if (!(Test-Path -LiteralPath $taskBinary -PathType Leaf)) { throw 'Installed executable is missing' }
foreach ($taskDirectory in @($taskProgramDir,$taskRoot,$taskState)) {
    if (Test-Path -LiteralPath $taskDirectory) {
        if ((Get-Item -LiteralPath $taskDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a redirected installation directory' }
    } else { New-Item -ItemType Directory -Path $taskDirectory | Out-Null }
}
$taskRootAcl = [Security.AccessControl.DirectorySecurity]::new()
$taskRootAcl.SetSecurityDescriptorSddlForm('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;S-1-5-19)(A;OICI;GRGX;;;BU)')
Set-Acl -LiteralPath $taskProgramDir -AclObject $taskRootAcl
$taskRootAcl.SetSecurityDescriptorSddlForm('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;S-1-5-19)')
Set-Acl -LiteralPath $taskRoot -AclObject $taskRootAcl
$taskStateAcl = [Security.AccessControl.DirectorySecurity]::new()
$taskStateAcl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;S-1-5-19)')
Set-Acl -LiteralPath $taskState -AclObject $taskStateAcl
$taskCommand = '"' + $taskBinary + '" service-run --config "' + $taskConfig + '"'
$taskVerb = if ($taskService) { 'config' } else { 'create' }
Invoke-MaintenanceProcess $taskSC @($taskVerb,'spider-watch','start=','auto','obj=','NT AUTHORITY\LocalService','binPath=',$taskCommand) | Out-Null
$taskRegistered = Get-CimInstance Win32_Service -Filter "Name='spider-watch'" -ErrorAction Stop
if (!$taskRegistered -or $taskRegistered.PathName -ne $taskCommand -or $taskRegistered.StartName -ne 'NT AUTHORITY\LocalService') { throw 'Service registration did not preserve the executable path or service account' }
Invoke-MaintenanceProcess $taskSC @('description','spider-watch','SpiderWatch network monitor') | Out-Null
Invoke-MaintenanceProcess $taskSC @('failure','spider-watch','reset=','86400','actions=','restart/60000/restart/300000/restart/900000') | Out-Null
Invoke-MaintenanceProcess $taskSC @('failureflag','spider-watch','1') | Out-Null
Set-Content -LiteralPath (Join-Path $taskRoot 'service-installed') -Value 'state-v2' -Encoding ascii
$taskUpdate = New-ScheduledTaskAction -Execute $taskBinary -Argument ('update --automatic --config "' + $taskConfig + '"') -WorkingDirectory $taskProgramDir
$taskTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes((Get-Random -Minimum 1 -Maximum 16))) -RepetitionInterval (New-TimeSpan -Hours 6)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'spider-watch-update' -Action $taskUpdate -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
$taskPath = [Environment]::GetEnvironmentVariable('Path','Machine')
if (@($taskPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $taskProgramDir.TrimEnd('\') }).Count -eq 0) {
    [Environment]::SetEnvironmentVariable('Path',($taskPath.TrimEnd(';') + ';' + $taskProgramDir),'Machine')
}
Start-Service spider-watch
