# Vedit — NSIS instalátor (jako FCH-steam-Setup.exe)

Tento instalátor stavím **programem NSIS** úplně stejně jako `FCH-steam-Setup.exe` od kolegů:

> **složka appky (281 MB) → LZMA komprese → český průvodce + branding + zástupce + odinstalátor → 89 MB**

## Co je uvnitř

- **Český průvodce** — první jazyk `Czech` (fallback `English`), všechny stránky v češtině
- **Branding** — ikona Vedit, header `150×57` a welcome `164×314` bitmapy s modrým „V“ (viz `apps/desktop/src-tauri/installer-assets/`)
- **Komprese** — `SetCompressor /SOLID lzma` + `DictSize 32` → typicky **~3× menší** (281 → ~89 MB)
- **Zástupci** — Start menu `Vedit\Vedit.lnk` + `Odinstalovat`, plocha `Vedit.lnk`
- **Odinstalátor** — `uninstall.exe` + zápis do `Přidat nebo odebrat programy` (název, ikona, verze, velikost, příkaz k odinstalaci)

## Dvě cesty k Vedit_installer.exe

### 1) Tauri (doporučeno — jeden příkaz)

Tauri už volá NSIS sám, takže branding a čeština jsou nastavené přímo v `tauri.conf.json`:

```powershell
npm ci
npx tauri build -- --target x86_64-pc-windows-msvc
# → apps/desktop/src-tauri/target/release/bundle/nsis/Vedit_0.1.0_x64-setup.exe
```

Přejmenuj na `Vedit_installer.exe` a hotovo. Tohle je ten soubor, který stahuje `vedit-install.ps1`.

Branding pro Tauri je v:
- `apps/desktop/src-tauri/installer-assets/header.bmp` (150×57, 24-bit BMP)
- `apps/desktop/src-tauri/installer-assets/welcome.bmp` (164×314, 24-bit BMP)
- `apps/desktop/src-tauri/icons/icon.ico`

### 2) Čistý NSIS (jako FCH — ruční balení složky)

Pokud chceš balit jakoukoliv složku `app\` (třeba portable Vedit, nebo jinou aplikaci):

1. Připrav `installer/app/` — zkopíruj do ní celý rozbalený Vedit:
   ```powershell
   # Po Tauri buildu:
   "apps/desktop/src-tauri/target/release/bundle/nsis/Vedit_*_x64-setup.exe" /S /D=C:\tmp\vedit-app
   xcopy C:\tmp\vedit-app installer\app\ /E /I /Y
   # — nebo ručně: Vedit.exe + resources\ + icons\
   ```
2. Nainstaluj [NSIS 3.x](https://nsis.sourceforge.io/Download)
3. Spusť:
   ```powershell
   makensis installer/Vedit_installer.nsi
   # → installer/Vedit_installer.exe  (~89 MB)
   ```

## Automaticky na Windows

Jedním skriptem (i s doinstalováním Node/Rust/MSVC přes winget):

```powershell
powershell -ExecutionPolicy Bypass -File installer/Build-Vedit-Installer.ps1
# nebo rovnou z GitHubu:
irm https://raw.githubusercontent.com/lilrepaer-glitch/Vedit/main/installer/Build-Vedit-Installer.ps1 | iex
```

## Přizpůsobení brandingu

Chceš vlastní barvy/logo jako `forgecheats.com`?
- Vyměň `welcome.bmp` / `header.bmp` za vlastní 24-bit BMP ve stejných rozměrech
- Změň `BrandingText "Vedit — Forged for victory"` v `Vedit_installer.nsi`
- Přegeneruj ikonu `icon.ico` (musí obsahovat 256×256, 48×48, 32×32, 16×16)

Žádné další závislosti nejsou potřeba — NSIS vše zkomprimuje do jednoho `Vedit_installer.exe`.
