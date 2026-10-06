#ifndef Version
  #error Version is required
#endif
#ifndef Arch
  #error Arch is required
#endif
#ifndef BuildDir
  #error BuildDir is required
#endif

[Setup]
AppId=SpiderWatch
AppName=SpiderWatch
AppVersion={#Version}
AppPublisher=SpiderWatch contributors
DefaultDirName={code:InstallDirectory}
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir={#BuildDir}
OutputBaseFilename=spider-watch-windows-{#Arch}-setup
Compression=lzma2/normal
LZMADictionarySize=2048
SolidCompression=yes
PrivilegesRequired=admin
MinVersion=10.0
UninstallDisplayName=SpiderWatch
UninstallDisplayIcon={app}\spider-watch.exe
ChangesEnvironment=yes
CloseApplications=no
RestartApplications=no
#if Arch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#elif Arch == "amd64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#else
ArchitecturesAllowed=x86compatible
ArchitecturesInstallIn64BitMode=x64compatible or arm64
#endif

[Files]
Source: "{#BuildDir}\spider-watch-windows-{#Arch}.exe"; DestDir: "{app}"; DestName: "spider-watch.exe"; Flags: ignoreversion
Source: "service.ps1"; DestDir: "{app}\maintenance"; Flags: ignoreversion

[UninstallDelete]
Type: files; Name: "{app}\update-result.json"
Type: filesandordirs; Name: "{app}\.spider-watch-update"

[Code]
var MaintenanceFailed: Boolean;

function InstallDirectory(Param: String): String;
begin
  if IsWin64 then Result := ExpandConstant('{commonpf64}\SpiderWatch')
  else Result := ExpandConstant('{commonpf32}\SpiderWatch');
end;

function RunMaintenance(Action: String): Boolean;
var Code: Integer;
begin
  Code := -1;
  Result := False;
  try
    Result := ExecAndLogOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\maintenance\service.ps1') + '" -Action ' + Action,
      '', SW_HIDE, ewWaitUntilTerminated, Code, nil) and (Code = 0);
  except
    Log(GetExceptionMessage);
  end;
  if not Result then begin
    MaintenanceFailed := True;
    Log('SpiderWatch maintenance failed: ' + Action + ', exit code ' + IntToStr(Code));
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  if MaintenanceFailed then Result := 1 else Result := 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if CompareText(ExpandConstant('{app}'), InstallDirectory('')) <> 0 then begin
    Result := 'Install SpiderWatch in the default Program Files directory.';
    exit;
  end;
  if FileExists(ExpandConstant('{app}\maintenance\service.ps1')) then
    if not RunMaintenance('Remove') then Result := 'Cannot stop the existing SpiderWatch service.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    if not RunMaintenance('Install') then RaiseException('Service setup failed. Run the installer again as Administrator.');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    if not RunMaintenance('Remove') then RaiseException('Cannot stop SpiderWatch. Uninstall cancelled.');
end;
