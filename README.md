# Vedit

**Vedit** is a desktop video-editing app for PC with a **built-in MCP server and direct API** — you can control the editor by hand or let an AI agent drive it (cutting, captions & callouts, animation, motion graphics, video generation).

📖 **[PLAN.md](./PLAN.md)** — project plan & spec (vision, features, architecture, roadmap).

> **Status: F0 + F1 + F2 + F3 done** — core with undo/redo and full editing, REST/WS API, MCP server (68 tools), CLI, UI timeline, real FFmpeg render export, **AI captions (TTS voiceover + speech-to-text)** and **AI editing (remove silences, highlight, beat-sync, motion tracking / auto-reframe)**. Model-based video generation comes in F4.

## Repository Structure

```
src/core/        core: data model (.vedit JSON), timeline ops, undo/redo
src/server/      REST API + WebSocket (localhost, bearer token)
src/mcp/         MCP server — stdio + Streamable HTTP (tools for AI agents)
src/cli/         CLI `vedit`
test/            tests (vitest) — core, API, MCP
apps/desktop/    Desktop UI (React + Vite) + Tauri shell (Windows installer)
```

## Quick Start

```bash
npm install
npm test            # testy jádra, API i MCP
npm run build       # překlad TypeScriptu do dist/

# API server (REST + WS) — http://127.0.0.1:47000, token is printed on start
npm run dev:api

# Desktop UI — http://localhost:5173 (dev server proxied to API)
npm run dev:ui
```

## CLI

```bash
npx tsx src/cli/index.ts init "Můj projekt"
npx tsx src/cli/index.ts import video.mp4 --kind video --duration 30
npx tsx src/cli/index.ts timeline
npx tsx src/cli/index.ts cut <clipId> --at 4.5
npx tsx src/cli/index.ts presets
npx tsx src/cli/index.ts serve     # REST+WS API
npx tsx src/cli/index.ts mcp       # MCP stdio server
```

## MCP — připojení AI agenta

Vedit registers as an MCP server with tools per PLAN.md §4.1 (`timeline.cut`, `captions.generate`, `animation.apply_preset`, `gen.video`, `export.render`, …).

Example for Claude Desktop / Cursor (`mcpServers`):

```json
{
  "vedit": {
    "command": "npx",
    "args": ["tsx", "/cesta/k/repo/src/mcp/stdio.ts"],
    "env": { "VEDIT_PROJECT": ".vedit/project.vedit" }
  }
}
```

Or via HTTP: `npm exec -- tsx src/cli/index.ts mcp-http` → `http://127.0.0.1:47001/mcp`.

## API (selection)

| Endpoint | Popis |
|---|---|
| `GET /api/v1/health` | server health |
| `GET/POST /api/v1/projects` | projects |
| `POST /api/v1/projects/:id/clips` | add clip |
| `POST .../clips/:clipId/split` | razor / split clip |
| `GET .../assets/:assetId/frame?t=` | real JPEG frame from media |
| `GET .../assets/:assetId/waveform` | audio waveform peaks |
| `POST .../captions/from-text` | captions from segments |
| `POST .../gen/video` | video generation (F0: simulated job) |
| `POST .../export` | **real FFmpeg render** (F1) |
| `GET /api/v1/jobs/:jobId/output` | download render output |
| `POST .../undo` / `redo` | history |

WebSocket `ws://127.0.0.1:47000/ws` emits `change` and `job` events.

## AI Captions (F2)

- **TTS voiceover** — `POST /api/v1/projects/:id/voiceover` (script → audio + clip + captions with precise timing), CLI `vedit tts | voiceover`, MCP `gen.audio (kind: voice)` / `captions.from_script`
- **Speech-to-text** — `POST .../assets/:id/transcribe`, CLI `vedit transcribe`, MCP `captions.transcribe` (pocketsphinx en; Whisper etc. via `VEDIT_ASR_CMD`)
- Speech engines run in Python sidecar (`python/speech_tool.py`): `python3 -m venv .venv-ai && .venv-ai/bin/pip install -r python/requirements.txt` (Node finds venv automatically; override via `VEDIT_PYTHON`)
- Engine availability: `GET /api/v1/ai/capabilities` / MCP `ai.capabilities`

## AI Editing (F3)

- **Remove silences** — `POST /api/v1/projects/:id/edit/remove-silences`, CLI `vedit cut-silence`, MCP `edit.remove_silences` — silence detection (silencedetect) + ripple collapse on track
- **Highlight reel** — `POST .../edit/highlight`, CLI `vedit highlight`, MCP `edit.highlight` — window scoring (motion + audio energy + scene cuts) → best parts to a new track
- **Beat-sync editing** — `POST .../clips/:clipId/beat-sync`, CLI `vedit beats`, MCP `edit.beat_sync` — splits clip exactly on music beats (PCM energy detection)
- **Auto-reframe / motion tracking** — `POST .../clips/:clipId/auto-reframe` / `track-motion`, CLI `vedit track`, MCP `edit.auto_reframe` / `edit.track_motion` — motion centroid → pan keyframes (9:16 crop, graphics follow object)
- **Analysis** — `POST .../analyze/{silences,scenes,beats,motion,energy}`, CLI `vedit analyze`, MCP `analysis.silences|scenes|beats|motion` — pure signal processing (FFmpeg decode + PCM/frame analysis), no ML models
- All operations are transactional (one `undo` reverts the whole AI edit)

## Desktop Build (Tauri)

UI runs standalone via Vite; **Windows installer (`Vedit_installer.exe`)** is built automatically in CI via Tauri 2 (`apps/desktop/src-tauri/`) — see workflow `.github/workflows/release.yml` and the "Windows Installer" section. Local final build requires Rust toolchain.

## Windows Installer (Vedit_installer.exe)

Vedit is a **desktop app for Windows**. Easiest install — one PowerShell command:

```powershell
irm https://raw.githubusercontent.com/lilrepaer-glitch/Vedit/main/vedit-install.ps1 | iex
```

The `vedit-install.ps1` script downloads and runs the installer from [Releases](https://github.com/lilrepaer-glitch/Vedit/releases); if not yet there, it **builds it from source** on your PC (installs Node.js/Rust only if missing). Or download `Vedit_installer.exe` directly from Releases and run it (current-user install, no admin → Vedit in Start menu).

The installer is built with **NSIS** — same as `FCH-steam-Setup.exe`:

> **app folder (281 MB) → LZMA compression → multi-language wizard + branding → shortcuts + uninstaller → 89 MB**

- **Multi-language wizard** — NSIS `English` (base) + `German` / `Russian` / `SimpChinese` with language selector; `BrandingText "Vedit"`
- **Branding** — icon + header `150×57` + welcome `164×314` (`apps/desktop/src-tauri/installer-assets/`) with blue "V"
- **Compression** — `lzma /SOLID` + `DictSize 32` → ~3× smaller file
- **Shortcuts** — Start menu `Vedit` + Desktop + uninstaller in "Add or Remove Programs"

The installer contains:
- Tauri shell + React UI (timeline, preview, AI panels)
- **REST+WS API server** as sidecar (auto-starts on `127.0.0.1:47000`, token `dev`)
- **FFmpeg/ffprobe** binaries (decoding, render export)
- Node.js runtime — no extra install needed

**Optional:** TTS/ASR (espeak-ng + pocketsphinx via Python) are installed separately per AI Captions section — without them features are hidden/disabled (app reports `unavailable`).

Build — two options:

```powershell
# 1) Tauri (recommended) — has branding and multi-language already in tauri.conf.json:
npm ci
npx tauri build              # → src-tauri/target/release/bundle/nsis/Vedit_*_x64-setup.exe → rename to Vedit_installer.exe

# 2) Plain NSIS like FCH — pack any app\ folder:
makensis installer/Vedit_installer.nsi   # → installer/Vedit_installer.exe (~89 MB)
# automaticky i s buildem:
powershell -ExecutionPolicy Bypass -File installer/Build-Vedit-Installer.ps1
```

See [`installer/README.md`](./installer/README.md) for details.

## License

MIT
