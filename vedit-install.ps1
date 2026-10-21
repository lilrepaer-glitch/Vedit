# Vedit — Windows Installer (One-Command Download & Launch)
#
#   irm https://raw.githubusercontent.com/lilrepaer-glitch/Vedit/main/vedit-install.ps1 | iex
#
# 1) Downloads Vedit_installer.exe from GitHub Releases (latest or newest pre-release) and launches it.
# 2) If not available on GitHub Releases, automatically builds Vedit_installer.exe from source on your PC
#    (installing Node.js / Rust / C++ Build Tools via winget only if missing) and runs it.

& {
    $ErrorActionPreference = "Stop"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = "lilrepaer-glitch/Vedit"
    $exeName = "Vedit_installer.exe"
    $latestUrl = "https://github.com/$repo/releases/latest/download/$exeName"
    $apiReleasesUrl = "https://api.github.com/repos/$repo/releases?per_page=10"
    $work = Join-Path $env:TEMP "vedit-install"
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    function Test-Admin {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }

    function Install-WingetPackage([string]$pkgId, [string]$extraArgs = "") {
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            throw "winget (App Installer) is not available. Please install Node.js (nodejs.org) and Rust (rustup.rs) manually and run the script again."
        }
        Write-Host "  Installing $pkgId (this may take a few minutes)…" -ForegroundColor Yellow
        $wgArgs = @("install", "--id", $pkgId, "-e", "--accept-source-agreements", "--accept-package-agreements", "--silent")
        if ($extraArgs) { $wgArgs += $extraArgs.Split(" ") | Where-Object { $_ } }
        & winget @wgArgs
        if ($LASTEXITCODE -ne 0) { throw "Install of $pkgId failed (exit code $LASTEXITCODE)." }
    }

    function Get-Tool([string]$name) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $user = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = "$machine;$user"
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        return $null
    }

    function Restart-Elevated {
        $self = $PSCommandPath
        if (-not $self) {
            $self = Join-Path $work "vedit-install.ps1"
            Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$repo/main/vedit-install.ps1" -OutFile $self -UseBasicParsing
        }
        Write-Host "  (Administrator privileges required for missing build tools — please confirm UAC prompt)" -ForegroundColor Yellow
        Start-Process -Verb RunAs -FilePath "powershell" -ArgumentList "-ExecutionPolicy", "Bypass", "-File", "`"$self`""
    }

    # ---------- 1) Download prebuilt Vedit_installer.exe from GitHub Releases ----------
    $installer = Join-Path $work $exeName
    Write-Host "Vedit — Preparing Installer" -ForegroundColor Cyan

    $downloadUrl = $latestUrl
    try {
        Write-Host "Downloading prebuilt installer from GitHub Releases…" -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $installer -UseBasicParsing
        } catch {
            # Fallback to newest release (including pre-releases) via GitHub API
            $releases = Invoke-RestMethod -Uri $apiReleasesUrl -Headers @{ "User-Agent" = "Vedit-Installer" } -UseBasicParsing
            $assetUrl = $null
            foreach ($rel in $releases) {
                foreach ($asset in $rel.assets) {
                    if ($asset.name -eq $exeName) {
                        $assetUrl = $asset.browser_download_url
                        break
                    }
                }
                if ($assetUrl) { break }
            }
            if (-not $assetUrl) { throw "No $exeName asset found on GitHub Releases." }
            Invoke-WebRequest -Uri $assetUrl -OutFile $installer -UseBasicParsing
        }

        if ((Get-Item $installer).Length -gt 20MB) {
            Write-Host "Downloaded Vedit_installer.exe successfully. Launching setup wizard…" -ForegroundColor Green
            Start-Process -FilePath $installer -Wait
            Write-Host "Done! Launch Vedit anytime from the Windows Start Menu or Desktop shortcut." -ForegroundColor Green
            return
        }
        Write-Host "Downloaded file is smaller than expected — building from source instead." -ForegroundColor Yellow
    } catch {
        Write-Host "Prebuilt installer unavailable — building from source on this PC." -ForegroundColor Yellow
    }

    # ---------- 2) Build from source ----------
    Write-Host ""
    Write-Host "Checking build toolchain (Node.js, Rust, C++)…" -ForegroundColor Cyan

    if (-not (Get-Tool "node")) {
        Write-Host "Node.js missing — installing LTS…" -ForegroundColor Yellow
        if (-not (Test-Admin)) { Restart-Elevated; return }
        Install-WingetPackage "OpenJS.NodeJS.LTS"
        if (-not (Get-Tool "node")) { throw "Failed to install Node.js. Install manually from nodejs.org." }
    }

    if (-not (Get-Tool "cargo")) {
        Write-Host "Rust missing — installing rustup…" -ForegroundColor Yellow
        if (-not (Test-Admin)) { Restart-Elevated; return }
        Install-WingetPackage "Rustlang.Rustup"
        & rustup default stable
        if (-not (Get-Tool "cargo")) { throw "Failed to install Rust. Install manually from rustup.rs." }
    }

    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $hasMSVC = $false
    if (Test-Path $vswhere) {
        $hasMSVC = [bool](& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
    }
    if (-not $hasMSVC) {
        Write-Host "C++ build tools missing — installing Visual Studio Build Tools (up to 15 minutes)…" -ForegroundColor Yellow
        if (-not (Test-Admin)) { Restart-Elevated; return }
        Install-WingetPackage "Microsoft.VisualStudio.2022.BuildTools" "--override --wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    }

    Write-Host "Downloading Vedit source code…" -ForegroundColor Cyan
    $src = Join-Path $work "src"
    if (Test-Path $src) { Remove-Item -Recurse -Force $src }
    $zip = Join-Path $work "vedit.zip"
    Invoke-WebRequest -Uri "https://codeload.github.com/$repo/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $src -Force
    $root = Get-ChildItem $src | Select-Object -First 1

    Push-Location $root.FullName
    try {
        Write-Host "Installing npm dependencies…" -ForegroundColor Cyan
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }

        Write-Host "Building Vedit Desktop Installer (Tauri/NSIS) — this takes a few minutes…" -ForegroundColor Cyan
        Push-Location "apps/desktop"
        try {
            & npx tauri build
            if ($LASTEXITCODE -ne 0) { throw "tauri build failed." }
        } finally {
            Pop-Location
        }

        $built = Get-ChildItem "apps/desktop/src-tauri/target/release/bundle/nsis/Vedit_*_x64-setup.exe" | Select-Object -First 1
        if (-not $built) { throw "Built installer not found." }

        Write-Host "Build complete! Launching Vedit installer…" -ForegroundColor Green
        Start-Process -FilePath $built.FullName -Wait
        Write-Host "Done! Find Vedit in the Windows Start Menu." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}
