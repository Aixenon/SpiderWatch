!ifndef Version
  !error "Version is required"
!endif
!ifndef Arch
  !error "Arch is required"
!endif
!ifndef BinaryFile
  !error "BinaryFile is required"
!endif
!ifndef OutputFile
  !error "OutputFile is required"
!endif

Unicode true
ManifestSupportedOS all
RequestExecutionLevel admin
CRCCheck force
AllowSkipFiles off
SetCompressor /SOLID lzma
SetCompressorDictSize 2
Name "SpiderWatch"
Caption "SpiderWatch ${Version} Setup"
OutFile "${OutputFile}"
InstallDir "$PROGRAMFILES\SpiderWatch"
ShowInstDetails show
ShowUninstDetails show

!include MUI2.nsh
!include LogicLib.nsh
!include WinVer.nsh
!include x64.nsh

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpiderWatch"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE English

Var PowerShell
Var MaintenanceAction

!macro RequireSuccess message
  ${If} ${Errors}
    DetailPrint "${message}"
    MessageBox MB_OK|MB_ICONSTOP "${message}" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro Initialize prefix callback
Function ${callback}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "SpiderWatch requires Windows 10 or newer." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
!if "${Arch}" == "arm64"
  ${IfNot} ${IsNativeARM64}
    MessageBox MB_OK|MB_ICONSTOP "This installer requires Windows ARM64." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
!else if "${Arch}" == "amd64"
  ${IfNot} ${IsNativeAMD64}
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_OK|MB_ICONSTOP "This installer requires Windows x64." /SD IDOK
      SetErrorLevel 1
      Quit
    ${ElseIfNot} ${AtLeastBuild} 22000
      MessageBox MB_OK|MB_ICONSTOP "Windows ARM64 requires the ARM64 installer on Windows 10." /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
!endif
  SetShellVarContext all
  ${If} ${RunningX64}
    SetRegView 64
    StrCpy $INSTDIR "$PROGRAMFILES64\SpiderWatch"
    StrCpy $PowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    SetRegView 32
    StrCpy $INSTDIR "$PROGRAMFILES\SpiderWatch"
    StrCpy $PowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  ; Both setup and uninstall are confined to the native Program Files directory.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  ${If} $0 != -1
    IntOp $0 $0 & 0x400
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Refusing a redirected installation directory." /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

Function ${prefix}Maintenance
  ClearErrors
  ExecWait '"$PowerShell" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\maintenance\service.ps1" -Action $MaintenanceAction' $0
  ${If} ${Errors}
  ${OrIf} $0 != 0
    DetailPrint "SpiderWatch service maintenance failed: $MaintenanceAction ($0)."
    MessageBox MB_OK|MB_ICONSTOP "Cannot complete service maintenance. Retry as Administrator." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd
!macroend

!insertmacro Initialize "" ".onInit"
!insertmacro Initialize "un." "un.onInit"

Section "SpiderWatch"
  IfFileExists "$INSTDIR\maintenance\service.ps1" 0 install_files
    StrCpy $MaintenanceAction Remove
    Call Maintenance
  install_files:
  ClearErrors
  SetOutPath "$INSTDIR"
  !insertmacro RequireSuccess "Cannot create the installation directory."
  File /oname=spider-watch.exe "${BinaryFile}"
  !insertmacro RequireSuccess "Cannot replace SpiderWatch. Close programs using it and retry."
  SetOutPath "$INSTDIR\maintenance"
  !insertmacro RequireSuccess "Cannot create the maintenance directory."
  File "service.ps1"
  !insertmacro RequireSuccess "Cannot write service maintenance files."
  ; Leave a working uninstaller even if a subsequent service operation fails.
  WriteUninstaller "$INSTDIR\uninstall.exe"
  !insertmacro RequireSuccess "Cannot write the uninstaller."
  WriteRegStr HKLM "${UNINSTALL_KEY}" DisplayName "SpiderWatch"
  WriteRegStr HKLM "${UNINSTALL_KEY}" DisplayVersion "${Version}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" Publisher "SpiderWatch contributors"
  WriteRegStr HKLM "${UNINSTALL_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" DisplayIcon "$INSTDIR\spider-watch.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" UninstallString '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" QuietUninstallString '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" NoModify 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" NoRepair 1
  !insertmacro RequireSuccess "Cannot register the installed application."
  StrCpy $MaintenanceAction Install
  Call Maintenance
  ; Remove only the previous installer's own records after a successful upgrade.
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpiderWatch_is1"
  Delete "$INSTDIR\unins000.exe"
  Delete "$INSTDIR\unins000.dat"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  SetErrorLevel 0
SectionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\maintenance\service.ps1" 0 service_removed
    StrCpy $MaintenanceAction Remove
    Call un.Maintenance
  service_removed:
  SetOutPath "$TEMP"
  ClearErrors
  Delete "$INSTDIR\spider-watch.exe"
  !insertmacro RequireSuccess "Cannot remove SpiderWatch. Close programs using it and retry uninstall."
  ; Keep maintenance and uninstall registration until the main executable is gone.
  Delete "$INSTDIR\maintenance\service.ps1"
  !insertmacro RequireSuccess "Cannot remove service maintenance files. Retry uninstall."
  RMDir "$INSTDIR\maintenance"
  ClearErrors
  Delete "$INSTDIR\update-result.json"
  IfFileExists "$INSTDIR\.spider-watch-update\*.*" 0 update_files_removed
    RMDir /r "$INSTDIR\.spider-watch-update"
  update_files_removed:
  !insertmacro RequireSuccess "Cannot remove update files. Retry uninstall."
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  !insertmacro RequireSuccess "Cannot remove application registration. Retry uninstall."
  ; In-place CI runs keep this locked; normal uninstall runs a temporary copy.
  Delete "$INSTDIR\uninstall.exe"
  ; ProgramData device identity is deliberately retained for a reinstall.
  RMDir "$INSTDIR"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  SetErrorLevel 0
SectionEnd
