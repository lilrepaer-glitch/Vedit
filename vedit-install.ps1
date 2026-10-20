# Vedit — instalátor pro Windows (stažení + spuštění jedním příkazem)
#
#   irm https://raw.githubusercontent.com/lilrepaer-glitch/Vedit/main/vedit-install.ps1 | iex
#
# 1) Stáhne Vedit_installer.exe z GitHub Releases (pokud existuje) a spustí ho.
# 2) Pokud ještě není na Releases, postaví instalátor ze zdrojáků na tvém PC
#    (doinstaluje Node.js/Rust jen pokud chybí) a spustí ho.

& {
    $ErrorActionPreference = "Stop"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = "lilrepaer-glitch/Vedit"
    $exeName = "Vedit_installer.exe"
    $releaseUrl = "https://github.com/$repo/releases/latest/download/$exeName"
    $work = Join-Path $env:TEMP "vedit-install"
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    function Test-Admin {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }

    function Install-WingetPackage([string]$pkgId, [string]$extraArgs = "") {
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            throw "winget (Instalátor aplikací) není k dispozici. Nainstaluj prosím ručně Node.js (nodejs.org) a Rust (rustup.rs) a spusť skript znovu."
        }
        Write-Host "  Instaluji $pkgId (může to chvíli trvat)…" -ForegroundColor Yellow
        $wgArgs = @("install", "--id", $pkgId, "-e", "--accept-source-agreements", "--accept-package-agreements", "--silent")
        if ($extraArgs) { $wgArgs += $extraArgs.Split(" ") | Where-Object { $_ } }
        & winget @wgArgs
        if ($LASTEXITCODE -ne 0) { throw "Instalace $pkgId selhala (kód $LASTEXITCODE)." }
    }

    function Get-Tool([string]$name) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        # po winget instalaci obnov PATH z registru
        $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $user = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = "$machine;$user"
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        return $null
    }

    function Restart-Elevated {
        # při běhu přes irm|iex nemáme soubor — stáhneme ho a spustíme znovu jako admin
        $self = $PSCommandPath
        if (-not $self) {
            $self = Join-Path $work "vedit-install.ps1"
            Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$repo/main/vedit-install.ps1" -OutFile $self -UseBasicParsing
        }
        Write-Host "  (vyžaduje administrátorská práva — potvrď UAC okno)" -ForegroundColor Yellow
        Start-Process -Verb RunAs -FilePath "powershell" -ArgumentList "-ExecutionPolicy", "Bypass", "-File", "`"$self`""
    }

    # ---------- 1) Zkus stáhnout hotový instalátor z GitHub Releases ----------
    $installer = Join-Path $work $exeName
    Write-Host "Vedit — instalace" -ForegroundColor Cyan
    try {
        Write-Host "Stahuji hotový instalátor z GitHub Releases…" -ForegroundColor Cyan
        Invoke-WebRequest -Uri $releaseUrl -OutFile $installer -UseBasicParsing
        if ((Get-Item $installer).Length -gt 20MB) {
            Write-Host "Staženo. Spouštím instalátor Vedit…" -ForegroundColor Green
            Start-Process -FilePath $installer -Wait
            Write-Host "Hotovo! Vedit najdeš v Start menu." -ForegroundColor Green
            return
        }
        Write-Host "Stažený soubor není platný instalátor — zkusím sestavit ze zdrojáků." -ForegroundColor Yellow
    } catch {
        Write-Host "Hotový instalátor zatím není ke stažení — postavím ho ze zdrojáků na tomhle PC." -ForegroundColor Yellow
    }

    # ---------- 2) Sestavení ze zdrojáků ----------
    Write-Host ""
    Write-Host "Kontroluji nástroje (Node.js, Rust)…" -ForegroundColor Cyan

    if (-not (Get-Tool "node")) {
        Write-Host "Node.js chybí — instaluji LTS…" -ForegroundColor Yellow
        if (-not (Test-Admin)) { Restart-Elevated; return }
        Install-WingetPackage "OpenJS.NodeJS.LTS"
        if (-not (Get-Tool "node")) { throw "Node.js se nepodařilo nainstalovat. Zkus to ručně z nodejs.org." }
    }

    if (-not (Get-Tool "cargo")) {
        Write-Host "Rust chybí — instaluji rustup…" -ForegroundColor Yellow
        if (-not (Test-Admin)) { Restart-Elevated; return }
        Install-WingetPackage "Rustlang.Rustup"
        & rustup default stable
        if (-not (Get-Tool "cargo")) { throw "Rust se nepodařilo nainstalovat. Zkus to ručně z rustup.rs." }
    }

    # C++ build tools pro linkování (jen pokud chybí)
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $hasMSVC = $false
    if (Test-Path $vswhere) {
        $hasMSVC = [bool](& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
    }
    if (-not $hasMSVC) {
        Write-Host "C++ build tools chybí — instaluji Visual Studio Build Tools (velké, klidně 15 minut)…" -ForegroundColor Yellow
        if (-not (Test-Admin)) { Restart-Elevated; return }
        Install-WingetPackage "Microsoft.VisualStudio.2022.BuildTools" "--override --wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    }

    Write-Host "Stahuji zdrojáky Vedit…" -ForegroundColor Cyan
    $src = Join-Path $work "src"
    if (Test-Path $src) { Remove-Item -Recurse -Force $src }
    $zip = Join-Path $work "vedit.zip"
    Invoke-WebRequest -Uri "https://codeload.github.com/$repo/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $src -Force
    $root = Get-ChildItem $src | Select-Object -First 1

    Push-Location $root.FullName
    try {
        Write-Host "Instaluji závislosti (npm)…" -ForegroundColor Cyan
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci selhalo." }

        Write-Host "Sestavuji Vedit (Tauri/NSIS) — tohle trvá pár minut…" -ForegroundColor Cyan
        Push-Location "apps/desktop"
        try {
            & npx tauri build
            if ($LASTEXITCODE -ne 0) { throw "tauri build selhal." }
        } finally {
            Pop-Location
        }

        $built = Get-ChildItem "apps/desktop/src-tauri/target/release/bundle/nsis/Vedit_*_x64-setup.exe" | Select-Object -First 1
        if (-not $built) { throw "Sestavený instalátor nebyl nalezen." }

        Write-Host "Sestaveno. Spouštím instalátor Vedit…" -ForegroundColor Green
        Start-Process -FilePath $built.FullName -Wait
        Write-Host "Hotovo! Vedit najdeš v Start menu." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}
