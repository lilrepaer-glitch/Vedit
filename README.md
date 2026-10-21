# Vedit

**Vedit** is a native desktop video editor for PC with a **built-in MCP server and REST/WebSocket API** — edit on the timeline manually, automate workflows via CLI, or let AI agents drive full productions end-to-end.

📖 **[PLAN.md](./PLAN.md)** — architecture & roadmap specification (**F0 – F5 complete**).

> **Status: v0.1.0 — F0, F1, F2, F3, F4 & F5 Complete**
> Multi-track non-destructive editor with full undo/redo, real FFmpeg multi-codec render pipeline (**H.264, H.265/HEVC, Apple ProRes 422 `.mov`, WebM VP9 `.webm`**), batch export queue & watch folders, **AI Voiceover + Speech-to-Text Captions**, **AI Editing** (silence removal, highlight reels, beat-sync, motion tracking & auto-reframe), **Vedit Gen Studio** (Veo 3.1, Kling 3.0, Seedance, Runway, Luma, MiniMax, Wan, Hunyuan + offline FFmpeg synth), **Marketplace** (parametric templates & `.veditpack.json` plugins), **Team Collaboration** (version checkpoints, structural `project.diff`, multi-editor merge, timecoded review notes, YouTube chapters, audit log), **MCP Server** (tools + resources + workflow prompts), and **NSIS Windows Installer (`Vedit_installer.exe`)**.

## Repository Structure

```
src/core/        Core engine: data model (.vedit JSON), timeline editing, undo/redo, FFmpeg probing
src/render/      Multi-codec FFmpeg render pipeline (H.264, H.265, ProRes 422, VP9 + presets)
src/ai/          Speech (TTS/ASR), AI editing (silences/highlights/beats/motion), Vedit Gen
src/ext/         Collaboration/diff/merge, Marketplace packs, Batch Queue & Watch Folders
src/server/      Local REST API + WebSocket server (bearer token auth)
src/mcp/         MCP server — stdio + Streamable HTTP (tools, resources & workflow prompts)
src/cli/         CLI `vedit`
apps/desktop/    English Desktop Editor UI (React + Vite) + Tauri v2 native desktop shell
test/            End-to-end Vitest suite (Core, Server, Render, Media, Speech, AI Edit, Gen, F5)
```

## Windows Installer (`Vedit_installer.exe`)

Install Vedit on Windows in one PowerShell command:

```powershell
irm https://raw.githubusercontent.com/lilrepaer-glitch/Vedit/main/vedit-install.ps1 | iex
```

Or download **`Vedit_installer.exe`** directly from **[GitHub Releases](https://github.com/lilrepaer-glitch/Vedit/releases/latest)** (per-user NSIS LZMA installer with `English`, `German`, `Russian`, and `Simplified Chinese` setup wizard, bundled Node.js sidecar, and bundled FFmpeg/ffprobe binaries — zero external setup required).

## Quick Start (Development)

```bash
npm ci
npm test                        # Run full Vitest test suite
npm run build                   # Compile TypeScript backend + CLI + MCP to dist/
npm run dev:api                 # Start REST + WS server on http://127.0.0.1:47000
npm run dev:ui                  # Start Desktop UI dev server on http://localhost:5173
npm run dist:desktop            # Build native desktop bundle for current OS
```

## CLI Examples

```bash
npx tsx src/cli/index.ts init "My Project"
npx tsx src/cli/index.ts import clip.mp4 --kind video
npx tsx src/cli/index.ts timeline
npx tsx src/cli/index.ts cut <clipId> --at 4.5
npx tsx src/cli/index.ts export-presets
npx tsx src/cli/index.ts batch-export --out-dir ./renders --presets youtube-1080p,tiktok-reels
npx tsx src/cli/index.ts watch --inbox ./inbox --out-dir ./rendered --preset youtube-1080p
npx tsx src/cli/index.ts marketplace
npx tsx src/cli/index.ts apply-template tpl-youtube-intro
npx tsx src/cli/index.ts diff --snapshot <snapshotId>
npx tsx src/cli/index.ts serve
npx tsx src/cli/index.ts mcp
```

## MCP Server (Claude Desktop / Cursor / AI Agents)

```json
{
  "mcpServers": {
    "vedit": {
      "command": "node",
      "args": ["/path/to/Vedit/dist/mcp/stdio.js"],
      "env": { "VEDIT_PROJECT": ".vedit/project.vedit" }
    }
  }
}
```

Or Streamable HTTP transport: `node dist/cli/index.js mcp-http` → `http://127.0.0.1:47001/mcp`.

## License

MIT
