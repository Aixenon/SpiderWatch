$ErrorActionPreference = 'Stop'
# Load only the pure command helpers. Never execute service.ps1's install body.
$taskTokens = $null; $taskErrors = $null
$taskSource = Join-Path $PSScriptRoot 'service.ps1'
$taskAst = [Management.Automation.Language.Parser]::ParseFile($taskSource,[ref]$taskTokens,[ref]$taskErrors)
if ($taskErrors.Count) { throw ($taskErrors | Out-String) }
$taskNames = @('ConvertTo-NativeArgument','Invoke-MaintenanceProcess')
$taskFunctions = @($taskAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $taskNames},$false))
if ($taskFunctions.Count -ne 2) { throw 'Missing maintenance command helpers' }
foreach ($taskFunction in $taskFunctions) { Invoke-Expression $taskFunction.Extent.Text }

$taskTemp = Join-Path ([IO.Path]::GetTempPath()) ('spider-watch-arguments-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskTemp | Out-Null
$taskProbe = Join-Path $taskTemp 'arguments.exe'
try {
    Add-Type -OutputAssembly $taskProbe -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Text;
public class ArgumentProbe {
    public static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "fail") { Console.Error.WriteLine("expected child failure"); return 23; }
        Console.WriteLine(Convert.ToBase64String(Encoding.Unicode.GetBytes(string.Join("\0", args))));
        return 0;
    }
}
'@
    $taskCommand = '"C:\Program Files\SpiderWatch\spider-watch.exe" service-run --config "C:\ProgramData\spider-watch\state\config.json"'
    $taskCases = @(
        ,@('create','spider-watch','start=','auto','obj=','NT AUTHORITY\LocalService','binPath=',$taskCommand),
        ,@('','space value','quote"value','C:\with space\',('Unicode ' + [char]0x6C49 + [char]0x5B57),'slashes\\"quote')
    )
    foreach ($taskExpected in $taskCases) {
        $taskEncoded = Invoke-MaintenanceProcess $taskProbe $taskExpected
        $taskActual = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($taskEncoded.Trim())).Split([char]0)
        if ($taskActual.Count -ne $taskExpected.Count) { throw 'Native argument count changed' }
        for ($taskIndex=0; $taskIndex -lt $taskExpected.Count; $taskIndex++) {
            if ($taskActual[$taskIndex] -cne $taskExpected[$taskIndex]) { throw ('Native argument changed at index ' + $taskIndex) }
        }
    }
    $taskFailed = $false
    try { Invoke-MaintenanceProcess $taskProbe @('fail') | Out-Null }
    catch { if ($_.Exception.Message -notmatch 'exit 23.*expected child failure') { throw }; $taskFailed = $true }
    if (!$taskFailed) { throw 'Native command failure was ignored' }
    Write-Host 'Windows maintenance arguments and failure propagation passed.'
} finally {
    # Remove only the known probe file in this invocation's GUID directory.
    if (Test-Path -LiteralPath $taskProbe) { Remove-Item -LiteralPath $taskProbe -Force }
    Remove-Item -LiteralPath $taskTemp -Force
}
