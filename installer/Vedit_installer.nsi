; Vedit — NSIS instalátor (styl FCH-steam-Setup.exe)
; Workflow: vezmu složku appky (281 MB) → zkomprimuju LZMA → český průvodce + branding → zástupce + odinstalátor → ~89 MB
;
; Použití (na Windows):
;   1) Sestav Vedit:  npm ci && npm run build
;      → zkopíruj výstup do složky "app" vedle tohoto .nsi:
;        - Vedit.exe (z apps/desktop/src-tauri/target/release/vedit-desktop.exe)
;        - složky resources/ (server + bin/ffmpeg), ikony, atd.
;      NEBO použij Tauri bundle: rozbal Vedit_0.1.0_x64-setup.exe /S /D=C:\tmp\vedit-portable → zkopíruj do app\
;   2) Nainstaluj NSIS 3.x (nsis.sourceforge.io) — ujisti se že makensis je v PATH
;   3) Spusť:  makensis installer/Vedit_installer.nsi
;      → vznikne Vedit_installer.exe vedle .nsi (~80–120 MB dle obsahu app\)
;   Nebo jedním příkazem:  powershell -ExecutionPolicy Bypass -File installer/Build-Vedit-Installer.ps1
;
; Tento skript je plně samostatný — nepotřebuje Tauri. Pokud chceš stavět přes Tauri,
; stačí `npx tauri build` v apps/desktop — branding a čeština jsou už nastavené v tauri.conf.json.

Unicode True
SetCompressor /SOLID lzma
SetCompressorDictSize 32

; ---- Základní info ----
!define APPNAME "Vedit"
!define COMPANYNAME "Vedit"
!define DESCRIPTION "Vedit — video editor s AI (desktopová aplikace pro Windows)"
!define VERSIONMAJOR 0
!define VERSIONMINOR 1
!define VERSIONBUILD 0
!define VERSIONSTRING "0.1.0"
!define PUBLISHER "Vedit"
!define URLINFOABOUT "https://github.com/lilrepaer-glitch/Vedit"
!define HELPURL "https://github.com/lilrepaer-glitch/Vedit#readme"

!define INSTALLSIZE 281000  ; KB — informativní pro Přidat/odebrat programy (281 MB)

Name "${APPNAME}"
OutFile "Vedit_installer.exe"
InstallDir "$LOCALAPPDATA\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" ""
RequestExecutionLevel user
BrandingText "Vedit — Forged for victory"

; ---- Ikona a branding ----
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
!define MUI_FINISHPAGE_RUN_TEXT "Spustit Vedit"
!define MUI_FINISHPAGE_RUN_FUNCTION "LaunchVedit"
!define MUI_FINISHPAGE_LINK "Vedit na GitHubu"
!define MUI_FINISHPAGE_LINK_LOCATION "${URLINFOABOUT}"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT

; Stránky instalátoru
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; Stránky odinstalátoru
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

; Jazyky — čeština první = výchozí (jako u FCH-steam-Setup.exe)
!insertmacro MUI_LANGUAGE "Czech"
!insertmacro MUI_LANGUAGE "English"

; Český popis (fallback pro ne-MUI texty)
LangString DESC_SecMain ${LANG_CZECH} "Nainstaluje Vedit včetně zástupců a odinstalátoru."
LangString DESC_SecMain ${LANG_ENGLISH} "Install Vedit with shortcuts and uninstaller."
LangString TEXT_CREATE_SHORTCUTS ${LANG_CZECH} "Vytvářím zástupce…"
LangString TEXT_CREATE_SHORTCUTS ${LANG_ENGLISH} "Creating shortcuts…"
LangString TEXT_REGISTER ${LANG_CZECH} "Zapisuji do systému…"
LangString TEXT_REGISTER ${LANG_ENGLISH} "Registering application…"

; ---- Funkce: spuštění po instalaci ----
Function LaunchVedit
  ExecShell "" "$INSTDIR\Vedit.exe"
FunctionEnd

; ---- Hlavní sekce ----
Section "!${APPNAME}" SecMain
  SectionIn RO

  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; Hlavní obsah — složka app\ vedle .nsi (to je ta "složka appky 281 MB")
  ; Pokud chceš jinou cestu, změň na File /r "C:\cesta\k\app\*.*"
  File /r "app\*.*"

  ; Velikost pro ARP
  ; (NSIS neumí automaticky spočítat, proto fixní odhad — viz INSTALLSIZE)
  
  DetailPrint "$(TEXT_CREATE_SHORTCUTS)"
  ; Start menu — složka Vedit
  CreateDirectory "$SMPROGRAMS\Vedit"
  CreateShortCut "$SMPROGRAMS\Vedit\Vedit.lnk" "$INSTDIR\Vedit.exe" "" "$INSTDIR\Vedit.exe" 0 "" "" "Vedit — video editor s AI"
  CreateShortCut "$SMPROGRAMS\Vedit\Odinstalovat Vedit.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0
  ; Desktop zástupce (volitelně lze přidat checkbox přes MUI)
  CreateShortCut "$DESKTOP\Vedit.lnk" "$INSTDIR\Vedit.exe" "" "$INSTDIR\Vedit.exe" 0 "" "" "Vedit"

  ; Odinstalátor
  WriteUninstaller "$INSTDIR\uninstall.exe"

  DetailPrint "$(TEXT_REGISTER)"
  ; Registry — aby se Vedit objevil v "Přidat nebo odebrat programy" s ikonou, verzí a odinstalátorem
  WriteRegStr HKCU "Software\${APPNAME}" "" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName" "${APPNAME} — video editor s AI"
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

  ; Pro currentUser instalaci není potřeba zapisovat do HKLM
SectionEnd

LangString DESC_Uninstall ${LANG_CZECH} "Odstraní Vedit ze systému."
LangString DESC_Uninstall ${LANG_ENGLISH} "Removes Vedit from your system."

Section "Uninstall"
  ; Zastav běžící proces (pokud existuje) — nevadí když selže
  ExecWait 'taskkill /f /im Vedit.exe /t' 
  Sleep 500

  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\Vedit\Vedit.lnk"
  Delete "$SMPROGRAMS\Vedit\Odinstalovat Vedit.lnk"
  RMDir "$SMPROGRAMS\Vedit"
  Delete "$DESKTOP\Vedit.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKCU "Software\${APPNAME}"
SectionEnd

; Popisky sekcí
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} $(DESC_SecMain)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; Kontrola místa
Function .onInit
  ; Pokud už je nainstalováno, nabídni odinstalaci staré verze
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString"
  StrCmp $R0 "" done
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Vedit je již nainstalován.$\n$\nKlikni OK pro odinstalaci předchozí verze, nebo Storno pro pokračování." IDOK uninst
    Goto done
    uninst:
      ClearErrors
      ExecWait '$R0 _?=$INSTDIR'
  done:
FunctionEnd
