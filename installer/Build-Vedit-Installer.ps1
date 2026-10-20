# Build-Vedit-Installer.ps1 — builds Vedit_installer.exe like FCH-steam-Setup.exe
# Workflow: app folder (281 MB) → NSIS LZMA → multi-language wizard + branding → shortcuts + uninstaller → ~89 MB
#
# Run on Windows (PowerShell):
#   powershell -ExecutionPolicy Bypass -File installer/Build-Vedit-Installer.ps1
# Nebo z kořene repa:  irm https://raw.githubusercontent.com/lilrepaer-glitch/Vedit/main/installer/Build-Vedit-Installer.ps1 | iex
#
# What the script does:
# 1) Check Node.js + Rust (auto-install via winget if missing — like vedit-install.ps1)
# 2) npm ci + npx tauri build (sestaví Vedit.exe + resources)
# 3) Copy output to installer/app/
# 4) Run makensis → Vedit_installer.exe

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not $repoRoot -or -not (Test-Path "$repoRoot\package.json")) {
  # při irm|iex nemáme cestu — stáhni repo jako zip
  $tmp = Join-Path $env:TEMP "vedit-build-installer"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Write-Host "Stahuji zdrojáky Vedit…" -ForegroundColor Cyan
  $zip = Join-Path $tmp "vedit.zip"
  Invoke-WebRequest -Uri "https://codeload.github.com/lilrepaer-glitch/Vedit/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $repoRoot = Get-ChildItem $tmp | Select-Object -First 1 | ForEach-Object FullName
}
Set-Location $repoRoot
Write-Host "Repo: $repoRoot" -ForegroundColor Gray

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-Tool([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $machine = [Environment]::GetEnvironmentVariable("Path","Machine")
  $user = [Environment]::GetEnvironmentVariable("Path","User")
  $env:Path = "$machine;$user"
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}
function Install-WingetPackage([string]$pkgId, [string]$extra="") {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "winget není k dispozici — nainstaluj Node.js/Rust ručně." }
  $wgArgs = @("install","--id",$pkgId,"-e","--accept-source-agreements","--accept-package-agreements","--silent")
  if ($extra) { $wgArgs += $extra.Split(" ") | Where-Object { $_ } }
  & winget @wgArgs
  if ($LASTEXITCODE -ne 0) { throw "Instalace $pkgId selhala (kód $LASTEXITCODE)" }
}

Write-Host "`nChecking tools…" -ForegroundColor Cyan
if (-not (Get-Tool "node")) {
  Write-Host "Node.js missing — installing LTS…" -ForegroundColor Yellow
  Install-WingetPackage "OpenJS.NodeJS.LTS"
}
if (-not (Get-Tool "cargo")) {
  Write-Host "Rust missing — installing…" -ForegroundColor Yellow
  Install-WingetPackage "Rustlang.Rustup"
  & rustup default stable
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMSVC = $false
if (Test-Path $vswhere) { $hasMSVC = [bool](& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) }
if (-not $hasMSVC) {
  Write-Host "VS Build Tools missing — installing (may take 15 min)…" -ForegroundColor Yellow
  Install-WingetPackage "Microsoft.VisualStudio.2022.BuildTools" "--override --wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
}

Write-Host "`nInstalling dependencies…" -ForegroundColor Cyan
& npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm ci selhalo" }

Write-Host "Building Vedit (Tauri build)…" -ForegroundColor Cyan
Push-Location "apps/desktop"
try {
  & npx tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build selhal" }
} finally { Pop-Location }

# Tauri už vyrobil Vedit_installer.exe — ale pro FCH-styl workflow ho přebalíme přes NSIS
$tauriExe = Get-ChildItem "apps/desktop/src-tauri/target/release/bundle/nsis/Vedit_*_x64-setup.exe" | Select-Object -First 1
if ($tauriExe) {
  $dest = Join-Path $repoRoot "installer\Vedit_installer.exe"
  Copy-Item $tauriExe.FullName $dest -Force
  Write-Host "`n✓ Done (Tauri NSIS): $dest" -ForegroundColor Green
  Write-Host "  Size: $([math]::Round((Get-Item $dest).Length/1MB,1)) MB — multi-language wizard + branding + uninstaller included." -ForegroundColor Gray
  # Pokud chceš ruční NSIS přebalení (jako FCH — 281 MB → 89 MB), pokračuj:
  Write-Host "`nPro ruční NSIS přebalení (jako FCH-steam-Setup.exe):" -ForegroundColor Cyan
  Write-Host "  1) Extract installer:  `"$($tauriExe.FullName)` /S /D=C:\tmp\vedit-app""
  Write-Host "  2) Copy C:\tmp\vedit-app to installer\app\"
  Write-Host "  3) Run:  makensis installer\Vedit_installer.nsi  → Vedit_installer.exe (~89 MB)"
  exit 0
}

# Fallback: pokud Tauri bundle není k dispozici, zkus ruční NSIS
$nsis = Get-Tool "makensis"
if (-not $nsis) {
  $nsis = "C:\Program Files (x86)\NSIS\makensis.exe"
  if (-not (Test-Path $nsis)) { $nsis = "C:\Program Files\NSIS\makensis.exe" }
}
if (Test-Path $nsis) {
  Write-Host "Running NSIS (makensis)…" -ForegroundColor Cyan
  & $nsis "$repoRoot\installer\Vedit_installer.nsi"
  if ($LASTEXITCODE -ne 0) { throw "makensis selhal" }
  Write-Host "`n✓ Done: installer\Vedit_installer.exe" -ForegroundColor Green
} else {
  Write-Host "`nNSIS not installed. Install from https://nsis.sourceforge.io/ and run again:" -ForegroundColor Yellow
  Write-Host "  makensis installer\Vedit_installer.nsi"
}
