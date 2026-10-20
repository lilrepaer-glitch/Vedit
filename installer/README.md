# Vedit — NSIS Installer (like FCH-steam-Setup.exe)

This installer is built with **NSIS** exactly like `FCH-steam-Setup.exe`:

> **app folder (281 MB) → LZMA compression → multi-language wizard + branding → shortcuts + uninstaller → 89 MB**

## Co je uvnitř

- **Multi-language wizard** — `English` (base) + `German` / `Russian` / `SimpChinese` with language selector
- **Branding** — ikona Vedit, header `150×57` a welcome `164×314` bitmapy s modrým „V“ (viz `apps/desktop/src-tauri/installer-assets/`)
- **Komprese** — `SetCompressor /SOLID lzma` + `DictSize 32` → typicky **~3× menší** (281 → ~89 MB)
- **Zástupci** — Start menu `Vedit\Vedit.lnk` + `Odinstalovat`, plocha `Vedit.lnk`
- **Odinstalátor** — `uninstall.exe` + zápis do `Přidat nebo odebrat programy` (název, ikona, verze, velikost, příkaz k odinstalaci)

## Two Ways to Build Vedit_installer.exe

### 1) Tauri (recommended — one command)

Tauri already invokes NSIS, so branding and languages are configured directly in `tauri.conf.json`:

```powershell
npm ci
npx tauri build -- --target x86_64-pc-windows-msvc
# → apps/desktop/src-tauri/target/release/bundle/nsis/Vedit_0.1.0_x64-setup.exe
```

Rename to `Vedit_installer.exe` — this is the file `vedit-install.ps1` downloads.

Branding pro Tauri je v:
- `apps/desktop/src-tauri/installer-assets/header.bmp` (150×57, 24-bit BMP)
- `apps/desktop/src-tauri/installer-assets/welcome.bmp` (164×314, 24-bit BMP)
- `apps/desktop/src-tauri/icons/icon.ico`

### 2) Plain NSIS (like FCH — manual folder packing)

To pack any `app\` folder (e.g. portable Vedit or any other app):

1. Prepare `installer/app/` — copy the extracted Vedit there:
   ```powershell
   # Po Tauri buildu:
   "apps/desktop/src-tauri/target/release/bundle/nsis/Vedit_*_x64-setup.exe" /S /D=C:\tmp\vedit-app
   xcopy C:\tmp\vedit-app installer\app\ /E /I /Y
   # — nebo ručně: Vedit.exe + resources\ + icons\
   ```
2. Install [NSIS 3.x](https://nsis.sourceforge.io/Download)
3. Run:
   ```powershell
   makensis installer/Vedit_installer.nsi
   # → installer/Vedit_installer.exe  (~89 MB)
   ```

## Automatic on Windows

With one script (auto-installs Node/Rust/MSVC via winget if missing):

```powershell
powershell -ExecutionPolicy Bypass -File installer/Build-Vedit-Installer.ps1
# or directly from GitHub:
irm https://raw.githubusercontent.com/lilrepaer-glitch/Vedit/main/installer/Build-Vedit-Installer.ps1 | iex
```

## Customize Branding

Want custom colors/logo like `forgecheats.com`?
- Replace `welcome.bmp` / `header.bmp` with your own 24-bit BMPs at the same dimensions
- Change `BrandingText "Vedit — AI Video Editor"` in `Vedit_installer.nsi`
- Regenerate `icon.ico` (must contain 256×256, 48×48, 32×32, 16×16)

No extra dependencies — NSIS compresses everything into a single `Vedit_installer.exe`.
