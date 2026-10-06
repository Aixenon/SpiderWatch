$ErrorActionPreference = 'Stop'
# Extract and exercise only registration logic with mocked scheduler objects.
# No task, service, account or ACL on this computer is accessed or changed.
$taskTokens = $null; $taskErrors = $null
$taskAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'service.ps1'),[ref]$taskTokens,[ref]$taskErrors)
if ($taskErrors.Count) { throw ($taskErrors | Out-String) }
$taskFunction = $taskAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Register-RequestedUpdateTask'},$false)
if (!$taskFunction) { throw 'Missing requested update task registration' }
Invoke-Expression $taskFunction.Extent.Text

function New-ScheduledTaskAction($Execute, $Argument, $WorkingDirectory) {
    @{ Execute=$Execute; Argument=$Argument; WorkingDirectory=$WorkingDirectory }
}
function Register-ScheduledTask($TaskName, $Action, $Principal, $Settings, [switch]$Force) {
    $script:capturedTask = @{ Name=$TaskName; Action=$Action; Principal=$Principal; Settings=$Settings; Force=$Force.IsPresent }
    if ($args.Count) { throw 'Requested task unexpectedly has a scheduled trigger or extra arguments' }
}
$taskMock = [pscustomobject]@{}
$taskMock | Add-Member ScriptMethod SetSecurityDescriptor { param($sddl,$flags) $script:capturedSecurity=$sddl; if ($flags -ne 0x10) { throw 'Unexpected ACL flags' } }
$folderMock = [pscustomobject]@{}
$folderMock | Add-Member ScriptMethod GetTask { param($name) if ($name -cne 'spider-watch-update-request') { throw 'Unexpected ACL target' }; return $taskMock }
$schedulerMock = [pscustomobject]@{}
$schedulerMock | Add-Member ScriptMethod Connect { $script:connected=$true }
$schedulerMock | Add-Member ScriptMethod GetFolder { param($name) if ($name -cne '\') { throw 'Unexpected task folder' }; return $folderMock }
function New-Object($ComObject) { if ($ComObject -cne 'Schedule.Service') { throw 'Unexpected COM object' }; return $schedulerMock }
$principal = [pscustomobject]@{ UserId='SYSTEM'; LogonType='ServiceAccount'; RunLevel='Highest' }
$settings = [pscustomobject]@{ MultipleInstances='IgnoreNew'; ExecutionTimeLimit='PT5M' }
Register-RequestedUpdateTask 'C:\Program Files\SpiderWatch\spider-watch.exe' 'C:\ProgramData\spider-watch\state\config.json' 'C:\Program Files\SpiderWatch' $principal $settings
if (!$connected -or $capturedTask.Name -cne 'spider-watch-update-request' -or !$capturedTask.Force) { throw 'Incorrect task registration' }
if ($capturedTask.Principal -ne $principal -or $capturedTask.Settings -ne $settings) { throw 'Task changed privileged principal or bounded settings' }
if ($capturedTask.Action.Execute -cne 'C:\Program Files\SpiderWatch\spider-watch.exe' -or $capturedTask.Action.Argument -cne 'update --requested --config "C:\ProgramData\spider-watch\state\config.json"') { throw 'Incorrect fixed updater action' }
$security = [Security.AccessControl.RawSecurityDescriptor]::new($capturedSecurity)
if (($security.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or $security.DiscretionaryAcl.Count -ne 3) { throw 'Task DACL is not exact and protected' }
$expected = @{ 'S-1-5-18'=0x1f01ff; 'S-1-5-32-544'=0x1f01ff; 'S-1-5-19'=0xa0000000L }
foreach ($ace in $security.DiscretionaryAcl) {
    $sid = $ace.SecurityIdentifier.Value
    if (!$expected.ContainsKey($sid) -or ($ace.AccessMask -band 0xffffffffL) -ne $expected[$sid] -or $ace.AceQualifier -ne 'AccessAllowed') { throw ('Unexpected task permission: ' + $sid) }
}
Write-Host 'Requested update task action and restricted LocalService ACL passed.'
