# Vedit

**Vedit** je desktopová aplikace pro střih a tvorbu videa na PC se **vestavěným MCP serverem a přímým API** — editor umí ovládat člověk i AI agent (střih, titulky a popisky, animace, motion grafika, generování videa).

📖 **[PLAN.md](./PLAN.md)** — plán a popis projektu (vize, funkce, architektura, roadmapa).

> **Stav: F0 + F1 + F2 hotovo** — jádro s undo/redo a plnou editací, REST/WS API, MCP server (45+ tools), CLI, UI timeline, reálný FFmpeg render export a **AI titulky: TTS voiceover (espeak-ng, cs/en/…) + přepis řeči (pocketsphinx / VEDIT_ASR_CMD pro Whisper)**. Generování videa modely přijde ve F4.

## Struktura repozitáře

```
src/core/        jádro: datový model (.vedit JSON), operace timeline, undo/redo
src/server/      REST API + WebSocket (localhost, bearer token)
src/mcp/         MCP server — stdio + Streamable HTTP (tools pro AI agenty)
src/cli/         příkazová řádka `vedit`
test/            testy (vitest) — core, API, MCP
apps/desktop/    UI aplikace (React + Vite) + Tauri scaffold (Windows instalátor)
```

## Rychlý start

```bash
npm install
npm test            # testy jádra, API i MCP
npm run build       # překlad TypeScriptu do dist/

# API server (REST + WS) — http://127.0.0.1:47000, token se vytiskne
npm run dev:api

# Desktop UI — http://localhost:5173 (dev server s proxy na API)
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

Vedit se registruje jako MCP server s tooly podle PLAN.md §4.1 (`timeline.cut`, `captions.generate`, `animation.apply_preset`, `gen.video`, `export.render`, …).

Ukázka pro Claude Desktop / Cursor (`mcpServers`):

```json
{
  "vedit": {
    "command": "npx",
    "args": ["tsx", "/cesta/k/repo/src/mcp/stdio.ts"],
    "env": { "VEDIT_PROJECT": ".vedit/project.vedit" }
  }
}
```

Nebo přes HTTP: `npm exec -- tsx src/cli/index.ts mcp-http` → `http://127.0.0.1:47001/mcp`.

## API (výběr)

| Endpoint | Popis |
|---|---|
| `GET /api/v1/health` | stav serveru |
| `GET/POST /api/v1/projects` | projekty |
| `POST /api/v1/projects/:id/clips` | přidat klip |
| `POST .../clips/:clipId/split` | razor / rozdělení klipu |
| `GET .../assets/:assetId/frame?t=` | reálný JPEG snímek z média |
| `GET .../assets/:assetId/waveform` | audio waveform peaks |
| `POST .../captions/from-text` | titulky z segmentů |
| `POST .../gen/video` | generování videa (F0: simulovaný job) |
| `POST .../export` | **reálný render přes FFmpeg** (F1) |
| `GET /api/v1/jobs/:jobId/output` | stažení render výstupu |
| `POST .../undo` / `redo` | historie |

WebSocket `ws://127.0.0.1:47000/ws` vysílá události `change` a `job`.

## AI titulky (F2)

- **TTS voiceover** — `POST /api/v1/projects/:id/voiceover` (skript → audio + klip + titulky s přesným časováním), CLI `vedit tts | voiceover`, MCP `gen.audio (kind: voice)` / `captions.from_script`
- **Přepis řeči** — `POST .../assets/:id/transcribe`, CLI `vedit transcribe`, MCP `captions.transcribe` (pocketsphinx en; Whisper a další přes `VEDIT_ASR_CMD`)
- Speech enginy běží v Python sidecar (`python/speech_tool.py`): `python3 -m venv .venv-ai && .venv-ai/bin/pip install -r python/requirements.txt` (Node si venv najde automaticky; lze přepsat přes `VEDIT_PYTHON`)
- Dostupnost enginů: `GET /api/v1/ai/capabilities` / MCP `ai.capabilities`

## Desktop build (Tauri)

UI běží samostatně přes Vite; finální Windows instalátor (`.exe`/MSI) se skládá přes Tauri 2 (`apps/desktop/src-tauri/`) a vyžaduje Rust toolchain — viz PLAN.md §6.

## License

MIT
