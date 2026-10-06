param([switch]$Child)
$ErrorActionPreference = 'Stop'
if ($Child) {
    # Extract initialization only. Never execute installation, ACL writes,
    # service commands or task registration from the production script.
    $taskTokens = $null; $taskErrors = $null
    $taskSource = [IO.Path]::Combine($PSScriptRoot, 'service.ps1')
    $taskAst = [Management.Automation.Language.Parser]::ParseFile($taskSource,[ref]$taskTokens,[ref]$taskErrors)
    if ($taskErrors.Count) { throw 'Cannot parse maintenance script' }
    $taskFunction = $taskAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Initialize-MaintenanceEnvironment'},$false)
    if (!$taskFunction) { throw 'Missing maintenance environment initialization' }
    . ([scriptblock]::Create($taskFunction.Extent.Text))
    $taskModuleRoot = [IO.Path]::Combine($PSHOME,'Modules')
    if ($env:PSModulePath.Split(';')[0] -eq $taskModuleRoot) { throw 'Regression did not inherit the polluted module path' }
    Initialize-MaintenanceEnvironment
    if ($env:PSModulePath -ne $taskModuleRoot -or $env:PSModuleAnalysisCachePath) { throw 'Inherited module paths or analysis cache survived initialization' }
    foreach ($taskName in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','CimCmdlets','ScheduledTasks')) {
        $taskModule = Get-Module -Name $taskName
        # Built-in binaries may live in the Windows GAC (CimCmdlets); their
        # module base still identifies the native PowerShell manifest directory.
        if (!$taskModule -or ($taskModule.ModuleBase -ne $PSHOME -and !$taskModule.ModuleBase.StartsWith($PSHOME + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))) { throw ('Module loaded outside Windows PowerShell: ' + $taskName) }
    }
    foreach ($taskName in @('Set-Acl','Get-Service','Start-Service','New-Object','Set-Content','Get-CimInstance','New-ScheduledTaskAction','Register-ScheduledTask','Unregister-ScheduledTask')) {
        $taskCommand = Get-Command -Name $taskName -ErrorAction Stop
        if ($taskCommand.Module.ModuleBase -ne $PSHOME -and !$taskCommand.Module.ModuleBase.StartsWith($PSHOME + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw ('Command loaded outside Windows PowerShell: ' + $taskName) }
    }
    Write-Host 'Windows maintenance modules load from the native PowerShell directory.'
    exit 0
}

if ($PSVersionTable.PSEdition -ne 'Core') { throw 'Run this regression from PowerShell 7 to reproduce inherited module contamination.' }
$taskNative = [IO.Path]::Combine([Environment]::GetFolderPath('System'),'WindowsPowerShell','v1.0','powershell.exe')
$taskSavedPath = $env:PSModulePath
$taskSavedCache = $env:PSModuleAnalysisCachePath
$taskPolluted = [IO.Path]::Combine($PSHOME,'Modules') + ';' + [IO.Path]::Combine([IO.Path]::GetDirectoryName($taskNative),'Modules')
$taskTemp = [IO.Path]::Combine([IO.Path]::GetTempPath(),('spider-watch-modules-' + [Guid]::NewGuid().ToString('N')))
[IO.Directory]::CreateDirectory($taskTemp) | Out-Null
$taskOutput = [IO.Path]::Combine($taskTemp,'stdout.txt')
$taskError = [IO.Path]::Combine($taskTemp,'stderr.txt')
$taskCache = [IO.Path]::Combine($taskTemp,'analysis-cache')
try {
    [Environment]::SetEnvironmentVariable('PSModulePath',$taskPolluted,'Process')
    [Environment]::SetEnvironmentVariable('PSModuleAnalysisCachePath',$taskCache,'Process')
    # Start through cmd.exe, like the installer's intermediate process. Direct
    # pwsh -> powershell invocation normally repairs PSModulePath automatically.
    $taskArguments = '/d /s /c ""' + $taskNative + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Child"'
    $taskProcess = Start-Process -FilePath ([IO.Path]::Combine([Environment]::GetFolderPath('System'),'cmd.exe')) -ArgumentList $taskArguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $taskOutput -RedirectStandardError $taskError
    if ($taskProcess.ExitCode -ne 0) { throw ('Polluted module environment regression failed: ' + $taskProcess.ExitCode + [Environment]::NewLine + [IO.File]::ReadAllText($taskOutput) + [IO.File]::ReadAllText($taskError)) }
    Write-Host ([IO.File]::ReadAllText($taskOutput).Trim())
} finally {
    [Environment]::SetEnvironmentVariable('PSModulePath',$taskSavedPath,'Process')
    [Environment]::SetEnvironmentVariable('PSModuleAnalysisCachePath',$taskSavedCache,'Process')
    foreach ($taskFile in @($taskOutput,$taskError,$taskCache)) { if ([IO.File]::Exists($taskFile)) { [IO.File]::Delete($taskFile) } }
    [IO.Directory]::Delete($taskTemp)
}
