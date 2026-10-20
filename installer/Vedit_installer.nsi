; Vedit — NSIS installer (FCH-steam-Setup.exe style)
; Workflow: take app folder (281 MB) → compress with LZMA → multi-language wizard + branding → shortcuts + uninstaller → ~89 MB
;
; Usage (Windows):
;   1) Build Vedit:  npm ci && npm run build
;      → copy output to "app" folder next to this .nsi:
;        - Vedit.exe (from apps/desktop/src-tauri/target/release/vedit-desktop.exe)
;        - resources/ (server + bin/ffmpeg), icons, etc.
;      OR use Tauri bundle: extract Vedit_0.1.0_x64-setup.exe /S /D=C:\tmp\vedit-portable → copy to app\
;   2) Install NSIS 3.x (nsis.sourceforge.io) — ensure makensis is in PATH
;   3) Run:  makensis installer/Vedit_installer.nsi
;      → creates Vedit_installer.exe next to .nsi (~80–120 MB depending on app\)
;   Or in one command:  powershell -ExecutionPolicy Bypass -File installer/Build-Vedit-Installer.ps1
;
; This script is standalone — does not require Tauri. To build via Tauri,
; just run `npx tauri build` in apps/desktop — branding and languages are configured in tauri.conf.json.

Unicode True
SetCompressor /SOLID lzma
SetCompressorDictSize 32

; ---- Basic info ----
!define APPNAME "Vedit"
!define COMPANYNAME "Vedit"
!define DESCRIPTION "Vedit — AI-powered video editor (desktop app for Windows)"
!define VERSIONMAJOR 0
!define VERSIONMINOR 1
!define VERSIONBUILD 0
!define VERSIONSTRING "0.1.0"
!define PUBLISHER "Vedit"
!define URLINFOABOUT "https://github.com/lilrepaer-glitch/Vedit"
!define HELPURL "https://github.com/lilrepaer-glitch/Vedit#readme"

!define INSTALLSIZE 281000  ; KB — for Add/Remove Programs (281 MB)

Name "${APPNAME}"
OutFile "Vedit_installer.exe"
InstallDir "$LOCALAPPDATA\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" ""
RequestExecutionLevel user
BrandingText "Vedit — AI Video Editor"

; ---- Icon and branding ----
Icon "..\apps\desktop\src-tauri\icons\icon.ico"
UninstallIcon "..\apps\desktop\src-tauri\icons\icon.ico"
!define MUI_ICON "..\apps\desktop\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\apps\desktop\src-tauri\icons\icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "..\apps\desktop\src-tauri\installer-assets\header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "..\apps\desktop\src-tauri\installer-assets\welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "..\apps\desktop\src-tauri\installer-assets\welcome.bmp"

; ---- MUI2 ----
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Run Vedit"
!define MUI_FINISHPAGE_RUN_FUNCTION "LaunchVedit"
!define MUI_FINISHPAGE_LINK "Vedit on GitHub"
!define MUI_FINISHPAGE_LINK_LOCATION "${URLINFOABOUT}"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT

; Installer pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; Uninstaller pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

; Languages — English is base / default (FCH-style FCH-steam-Setup but international)
; User selects: English (base) → German → Russian → Chinese (Simplified)
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "German"
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "SimpChinese"

; ---- Localized strings (EN base, then DE/RU/ZH) ----
LangString DESC_SecMain ${LANG_ENGLISH} "Install Vedit with shortcuts and uninstaller."
LangString DESC_SecMain ${LANG_GERMAN} "Installiert Vedit mit Verknüpfungen und Deinstallation."
LangString DESC_SecMain ${LANG_RUSSIAN} "Устанавливает Vedit с ярлыками и деинсталлятором."
LangString DESC_SecMain ${LANG_SIMPCHINESE} "安装 Vedit 并创建快捷方式和卸载程序。"

LangString TEXT_CREATE_SHORTCUTS ${LANG_ENGLISH} "Creating shortcuts…"
LangString TEXT_CREATE_SHORTCUTS ${LANG_GERMAN} "Verknüpfungen werden erstellt…"
LangString TEXT_CREATE_SHORTCUTS ${LANG_RUSSIAN} "Создание ярлыков…"
LangString TEXT_CREATE_SHORTCUTS ${LANG_SIMPCHINESE} "正在创建快捷方式…"

LangString TEXT_REGISTER ${LANG_ENGLISH} "Registering application…"
LangString TEXT_REGISTER ${LANG_GERMAN} "Anwendung wird registriert…"
LangString TEXT_REGISTER ${LANG_RUSSIAN} "Регистрация приложения…"
LangString TEXT_REGISTER ${LANG_SIMPCHINESE} "正在注册应用程序…"

; ---- Launch after install ----
Function LaunchVedit
  ExecShell "" "$INSTDIR\Vedit.exe"
FunctionEnd

; ---- Main section ----
Section "!${APPNAME}" SecMain
  SectionIn RO

  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; Main content — app\ folder next to .nsi (the "281 MB app folder")
  ; If you need a different path, change to File /r "C:\path\to\app\*.*"
  File /r "app\*.*"

  DetailPrint "$(TEXT_CREATE_SHORTCUTS)"
  ; Start menu — Vedit folder
  CreateDirectory "$SMPROGRAMS\Vedit"
  CreateShortCut "$SMPROGRAMS\Vedit\Vedit.lnk" "$INSTDIR\Vedit.exe" "" "$INSTDIR\Vedit.exe" 0 "" "" "Vedit — AI-powered video editor"
  CreateShortCut "$SMPROGRAMS\Vedit\Uninstall Vedit.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0
  ; Desktop shortcut (can add checkbox via MUI if needed)
  CreateShortCut "$DESKTOP\Vedit.lnk" "$INSTDIR\Vedit.exe" "" "$INSTDIR\Vedit.exe" 0 "" "" "Vedit"

  ; Uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  DetailPrint "$(TEXT_REGISTER)"
  ; Registry — so Vedit appears in Add/Remove Programs with icon, version and uninstaller
  WriteRegStr HKCU "Software\${APPNAME}" "" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName" "${APPNAME} — AI Video Editor"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayIcon" "$INSTDIR\Vedit.exe,0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayVersion" "${VERSIONSTRING}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "URLInfoAbout" "${URLINFOABOUT}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "HelpLink" "${HELPURL}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "EstimatedSize" ${INSTALLSIZE}

SectionEnd

LangString DESC_Uninstall ${LANG_ENGLISH} "Remove Vedit from your system."
LangString DESC_Uninstall ${LANG_GERMAN} "Entfernt Vedit von Ihrem System."
LangString DESC_Uninstall ${LANG_RUSSIAN} "Удаляет Vedit с вашего компьютера."
LangString DESC_Uninstall ${LANG_SIMPCHINESE} "从系统中移除 Vedit。"

Section "Uninstall"
  ; Stop running process if any — ignore failure
  ExecWait 'taskkill /f /im Vedit.exe /t' 
  Sleep 500

  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\Vedit\Vedit.lnk"
  Delete "$SMPROGRAMS\Vedit\Uninstall Vedit.lnk"
  RMDir "$SMPROGRAMS\Vedit"
  Delete "$DESKTOP\Vedit.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKCU "Software\${APPNAME}"
SectionEnd

; Section descriptions
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} $(DESC_SecMain)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; Check for existing install
Function .onInit
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString"
  StrCmp $R0 "" done
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Vedit is already installed.$\n$\nClick OK to uninstall the previous version first, or Cancel to continue." IDOK uninst
    Goto done
    uninst:
      ClearErrors
      ExecWait '$R0 _?=$INSTDIR'
  done:
FunctionEnd
