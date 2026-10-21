# Vedit — Project Plan & Specification

**Vedit** is a professional desktop video-editing app for PC. The user **downloads and installs it** (no web editor) — it runs locally on the user's CPU/GPU, works with offline files on disk and is designed from the ground up to be controlled not only by mouse but also by AI via a **built-in MCP server and direct API**.

> **Vision:** professional PC video editing that you control with mouse and AI — from rough cut through captions and animation to generated footage and motion graphics.

---

## 1. Why a Desktop App (not Web)

| Requirement | Vedit Solution |
|---|---|
| Large 4K/8K files | No cloud upload — read from disk, proxy workflow for smooth editing |
| Performance | GPU acceleration (NVENC / AMF / QSV), real-time preview on user hardware |
| Privacy | Footage stays local; cloud AI only on explicit request |
| Offline | Full editing & export without internet; online only for AI generation/updates |
| Distribution | Downloadable installer (`.exe` / MSI), automatic delta updates |

**Platform:** Windows 10/11 (64-bit) as primary target; macOS & Linux later.
**Distribution:** installer from project website + portable build; auto-update via built-in updater.

---

## 2. Target Users

- **Content Creators** (YouTube, Twitch, TikTok/Reels) — fast cuts, shorts from long videos
- **Freelance Editors & Small Studios** — multi-track NLE, color correction, export
- **Marketers & Social Teams** — motion graphics, ad spots, templates
- **AI-first Users** — want to edit by commands and agent ("cut me a 20s highlight")

---

## 3. Klíčové funkce

### 3.1 Střihové jádro (lidské ovládání)

- **NLE timeline:** neomezený počet stop (video, audio, text, grafika, efekty), drag & drop, snapping, markery
- **Editace:** razor/cut, ripple, roll, slip, slide, trim J/K/L, vícenásobný výběr, skupiny klipů
- **Media pool:** import z disku/karet, automatické **proxy** pro 4K+, správa offline médií, tagy a vyhledávání
- **Obraz:** barevné korekce (kola, křivky, LUT), transformace, masky, chroma key, stabilizace
- **Audio:** mixážní pult, ducking, odšumění, ekvalizace, normalizace hlasitosti
- **Preview:** GPU kompozitor, real-time playback, fullscreen, frame-by-frame
- **Historie:** plné undo/redo, verzování projektu, autosave

### 3.2 Titulky a popisky

- **Automatický přepis** řeči (Whisper-class model lokálně přes ONNX) s časováním na slovo
- Editovatelné titulky, styly, šablony (lower thirds), animované popisky
- **Překlad titulků** (CZ/EN/…), volitelně **dubbing/voiceover přes TTS**
- Burn-in do videa nebo export samostatně (SRT/VTT)

### 3.3 Animace a motion grafika

- **Keyframový engine:** pozice, rotace, měřítko, opacity, masky, křivky s easingem
- Kinetická typografie — animované textové šablony (intra, outttra, CTA)
- Shape vrstvy (obdélníky, kruhy, cesty), vektorový editor, import SVG
- Motion tracking (přiřazení textu/grafiky k pohybujícímu se objektu)
- Knihovna **šablon motion grafiky** s parametry (barvy, text, logo) — včetně AI-generovaných šablon
- Beat-sync animace (přizpůsobení hudbě)

### 3.4 AI operace (přes API a MCP)

AI agent (Claude, ChatGPT, Cursor, vlastní skript…) umí díky API/MCP dělat vše, co uživatel myší:

- **Střih:** „vyhoď ticha a filler slova“, „udělej 20s highlight z tohodle záznamu“, auto-cut podle hudby
- **Sestavení:** výběr scén podle tématu/transkriptu, sestavení reelu, doporučení B-roll z media poolu
- **Titulky a popisky:** přepis, styly, překlad, zvýraznění klíčových slov
- **Animace:** aplikace presetů, generování titulkových animací, motion grafika na klíčová slova
- **Auto-reframe** 16:9 → 9:16 / 1:1 s sledováním hlavního objektu
- **Reporty:** „projdi video a napiš mi chapter markery, popis a thumbnail"

### 3.5 Generování videa a zvuku (AI)

- **Text-to-video, image-to-video, video-to-video** přes jednotnou vrstvu **Vedit Gen**
  - cloudové modely (aktuální nabídka 2026: Google Veo 3.1, Kling 3.0, Seedance 2.x, Runway Gen-4.5, Luma Ray 3, MiniMax Hailuo/H3, Wan aj.)
  - agregátory (fal.ai, Replicate) pro šíři modelů jedním rozhraním
  - **lokální open-source modely** (Wan, Hunyuan Video) pro výkonné GPU uživatele — volitelně, offline
- Generované klipy se **hned vloží do timeline** jako běžné assety (s metadata o promptu/modelu)
- Generování hudby a SFX, **TTS voiceover**, odstranění hluku
- Režie záběrů: kamerové pohyby, keyframy v promptu, návaznost záběrů (continuity)

### 3.6 Export a sdílení

- H.264 / H.265 / ProRes / WebM, až 4K/8K, HDR
- Předvolby pro YouTube, TikTok, Instagram Reels, LinkedIn; batch export a fronta renderů
- Watch-foldery (automatický render při přidání souboru), CLI export pro skripty

---

## 4. MCP podpora (Model Context Protocol)

Vedit má **vestavěný lokální MCP server** — jakýkoliv MCP klient (Claude Desktop, Claude Code, Cursor, VS Code, ChatGPT…) se připojí a získá editor jako sadu nástrojů.

- **Přenos:** stdio (pro lokální klienty) + streamable HTTP na `localhost` (s tokenem)
- **Registrace:** oficiální jméno v MCP registru (např. `io.vedit/desktop`), specifikace MCP v aktuální revizi včetně nativních mediálních typů
- **Guardrails:** preflight validace vstupů, potvrzení destruktivních operací, audit log, vše přes undo

### 4.1 Přehled tools (výběr)

| Kategorie | Tools |
|---|---|
| Projekt | `project.create`, `project.open`, `project.save`, `project.get_state` |
| Import | `media.import`, `media.list`, `media.get_info`, `media.get_frames` |
| Timeline | `timeline.add_clip`, `timeline.cut`, `timeline.trim`, `timeline.move`, `timeline.split`, `timeline.delete`, `timeline.ripple_delete`, `timeline.get_timeline` |
| Titulky | `captions.generate`, `captions.edit`, `captions.translate`, `captions.style`, `captions.export` |
| Animace | `animation.apply_preset`, `animation.set_keyframes`, `text.animate`, `motion.track` |
| Efekty | `effect.apply`, `color.grade`, `audio.enhance`, `audio.duck` |
| Generování | `gen.video`, `gen.image`, `gen.music`, `gen.sfx`, `gen.voice`, `gen.job_status` |
| Export | `export.render`, `export.queue_status`, `export.download` |
| Systém | `undo`, `redo`, `project.diff`, `health` |

### 4.2 Resources a prompts

- **Resources:** timeline projektu (JSON), náhledy snímků (mediální typy MCP), transkripty, fronta úloh
- **Prompts:** předpřipravené workflow — „highlight reel", „shorts z dlouhého videa", „promo spot s motion grafikou", „titulky + překlad + export"

---

## 5. Přímé API

Mimo MCP nabízí Vedit **přímé REST API + WebSocket** pro vlastní integrace a skripty.

- **REST** na `http://localhost:<port>/api/v1` — projekty, timeline, assety, úlohy, export
- **WebSocket** — realtime události (změny timeline, progress renderu/generování, chyby)
- **Autentizace:** lokální API token z nastavení aplikace (vygenerovaný klíč, uložený v systémovém úložišti); volitelně vzdálený přístup přes pár zařízení + OAuth
- **Job system:** dlouhé operace (render, generování videa) jako asynchronní úlohy s pollingem/webhooky
- **SDK a CLI:** Python a TypeScript SDK, příkazová řádka `vedit` (import, střih, render z terminálu/CI)
- REST i MCP sdílejí **stejné jádro operací** — vše, co jde přes API, jde i přes MCP, a naopak

---

## 6. Architektura

```
┌─────────────────────────────────────────────────────┐
│  UI: Tauri + React/TypeScript (timeline, preview)    │
├─────────────────────────────────────────────────────┤
│  Jádro (Rust): timeline model, GPU kompozitor (wgpu),│
│  FFmpeg bindings, render pipeline (NVENC/AMF/QSV)   │
├──────────────┬──────────────────┬───────────────────┤
│ MCP server   │ REST/WS API      │ AI orkestrátor    │
│ (stdio+HTTP) │ (localhost)      │ (plánování úkolů) │
├──────────────┴──────────────────┴───────────────────┤
│  Sidecar (Python/ONNX): přepis, TTS, analýza scén,  │
│  lokální gen modely │ Cloud Gen: Veo/Kling/Seedance…│
├─────────────────────────────────────────────────────┤
│  Úložiště: .vedit projekt (JSON) + assety na disku  │
│  + cache (proxy, audio peaks, náhledy)               │
└─────────────────────────────────────────────────────┘
```

- **Jádro v Rustu** — výkon, bezpečnost vláken, přímé FFmpeg/GPU operace
- **UI v Tauri + React** — moderní vzhled, malý instalátor (oproti Electronu), WebGPU preview
- **Python sidecar** — ML modely (Whisper-class přepis, TTS, detekce scén) přes ONNX lokálně
- **MCP a API nad stejným operačním jádrem** — jednotný model operací, transakční změny (commit/rollback), undo zásobník

### Datový model (zkráceně)

```
Project → Sequence[] → Track[] → Clip[]
  Clip: source asset, in/out, transform, efekty[], keyframy[]
  Track: typ (video/audio/text/graphics), mute/solo, lock
Asset: soubor na disku, proxy, metadata, transcript
Caption[]: text + timecode + styl
RenderJob / GenJob: fronta, stav, výstup
History: undo/redo, verze projektu
```

Projekt je **otevřený formát** (JSON + relativní odkazy na assety) — verzovatelný v Gitu, přenositelný mezi stroji.

---

## 7. Roadmapa

| Fáze | Obsah | Horizont |
|---|---|---|
| **F0 — Kostra** | Instalátor, projekt/formát, import, preview, základní timeline | ~2 měsíce |
| **F1 — Střih** | Plná editace (ripple/roll/slip…), audio mixáž, barevné korekce, export, proxy | ~3–4 měsíce |
| **F2 — Titulky + API** | Automatický přepis, titulky/TTS, REST+WS API, CLI, **MCP server (edit tools)** | ~3 měsíce |
| **F3 — AI střih + animace** | Highlight/auto-cut/reframe, keyframový animační engine, motion grafika, šablony | ~3 měsíce |
| **F4 — Generování** | Vedit Gen (cloud + lokální modely), gen hudby/SFX/voiceover, AI motion šablony | ~3 měsíce |
| **F5 — Rozšíření** | Kolaborace, marketplace šablon/pluginů, macOS/Linux, firemní licence | průběžně |

---

## 8. Systémové požadavky

| | Minimum | Doporučeno |
|---|---|---|
| OS | Windows 10 64-bit | Windows 11 |
| RAM | 16 GB | 32 GB |
| GPU | 4 GB VRAM (akcelerace preview) | 8 GB+ VRAM (NVENC/AMF/QSV, lokální AI) |
| Disk | 2 GB aplikace + cache | SSD, 10 GB+ pro cache/proxy |
| CPU | 4 jádra | 8+ jader |

Instalátor: ~150 MB (GPU kodeky a ML modely se stahují dle potřeby). Portable verze bez instalace.

---

## 9. Bezpečnost a soukromí

- **Lokálně jako výchozí** — střih, titulky (přepis) a export běží bez internetu
- Cloudové AI modely a telemetrie **jen se souhlasem** uživatele, v nastavení vypnutelné
- AI operace mají guardrails: preflight validace, potvrzení zásadních změn, audit log, spolehlivé undo
- API tokeny v systémovém úložišti hesel, sandbox pro generovaný obsah
- Licenční čistota: vlastní fonty/šablony, otevřené kodeky tam, kde licence hrozí

---

## 10. Konkurence a pozice

| Produkt | Vedit proti němu |
|---|---|
| DaVinci Resolve / Premiere Pro | Vedit je **AI-native**: střih, titulky i generování z jednoho místa; MCP/API first |
| CapCut desktop | Vedit míří i na profesionální střih (NLE operace, ProRes, otevřené API) |
| Webové AI editory | Vedit je **desktop ke stažení** — výkon, offline, soukromí, lokální soubory |
| Čistě AI generátory videa | Vedit generuje **a rovnou stříhá** — generovaný klip je součástí skutečné timeline |

**Hlavní diferenciační prvek:** otevřené MCP + API, přes které AI agent reálně ovládá plnohodnotný editor — ne jen generuje izolované klipy.

---

## 11. Monetizace (návrh)

- **Free** — základní střih, titulky (manuální), export 1080p, lokální API/MCP (omezeně)
- **Pro (předplatné)** — AI střihové operace, automatické titulky/překlady, motion grafika šablony, 4K/8K export, prioritní render
- **Kredity na generování** — AI video/hudba/voiceover (účtováno dle spotřebovaného modelu; lokální modely bez kreditů)

---

## 12. Rizika a otevřené otázky

1. **Výkon timeline v UI** — rozhodnutí Tauri vs. nativní (Qt) padne po F0 prototypu preview
2. **Náklady na generování** — kreditový model, fronty a limity cloudových API; fallback na lokální modely
3. **Licence kodeků** (H.264/H.265, ProRes) — ověřit patentové podmínky pro distribuci instalátoru
4. **MCP ekosystém** — držet krok s revizemi specifikace (nativní mediální typy), publikovat server do registru
5. **ML modely v instalátoru** — stahovat na vyžádání (přepis, TTS), držet instalátor malý

---

---

## 13. Stav implementace

| Fáze | Stav | Poznámka |
|---|---|---|
| **F0 — Kostra** | ✅ hotovo | Datový model `.vedit` (JSON), engine operací (cut/trim/move/ripple…), undo/redo, REST+WS API, **MCP server (40+ tools, stdio + HTTP)**, CLI `vedit`, UI timeline (React) + Tauri scaffold. |
| **F1 — Střih + render** | ✅ hotovo | **Reálné dekódování médií přes FFmpeg/ffprobe** (npm binárky `@ffmpeg-installer`/`@ffprobe-installer`): probe při importu, JPEG snímky pro preview, waveform, 640p proxy. **Skutečný render export** (trim/concat, overlay s transformacemi a keyframovými animacemi x/y, efekty blur/color/grayscale, burn-in titulků přes libass, audio mix) s průběhem jobu a stažením výstupu. Plná editace: roll/slip/slide. UI náhled ukazuje reálné snímky. |
| **F2 — AI titulky** | ✅ hotovo | **TTS voiceover** (espeak-ng přes Python sidecar, cs/en/sk/de/…): skript → reálné audio + klip na timeline + titulky s přesným časováním (per-fráze syntéza), transakční undo. **Přepis řeči**: pocketsphinx (en) + externí Whisper přes `VEDIT_ASR_CMD`, VAD/segmentace. MCP: `gen.audio(kind:voice)`, `captions.transcribe`, `captions.from_script`, `ai.capabilities`. CLI `tts/voiceover/transcribe`, UI panel AI titulků. |
| F3 — AI střih + animace | ✅ hotovo (AI střih) | **Vyhoď ticha** (silencedetect + ripple collapse), **highlight reel** (skórování oken: pohyb + energie + scény), **beat-sync střih** (detekce beatů → split klipu), **auto-reframe + motion tracking** (těžiště pohybu → pan keyframy). REST `analyze/*` + `edit/*`, MCP `analysis.*` + `edit.*` (9 nástrojů), CLI `analyze/cut-silence/highlight/beats/track`, UI tlačítka v AI panelu. Čistý signálový processing. Animace/šablony klíčových snímků: hotovo v F1 (presety). |
| **F4 — Generování** | ✅ hotovo | **Vedit Gen (`src/ai/gen.ts`)** — jednotná vrstva pro cloud (`fal.ai` queue→poll→download, `Replicate` predictions, `Google Veo 3.1`, `Kling 3.0`, `Seedance 2.x`, `Runway Gen-4.5`, `Luma Ray 3`, `MiniMax`, `Wan Cloud`), lokální open-source GPU (`wan-local` ComfyUI/HTTP, `hunyuan-local`) i offline FFmpeg syntézu; režie záběrů (`CAMERA_MOVES`, keyframy v promptu), návaznost záběrů (extrakce posledního snímku přes FFmpeg), vložení přímo na timeline s metadaty a atomickým undo, MCP nástroje `gen.providers/video/image/music/sfx/voice/job_status` a UI panel **Vedit Gen**. |
| **F5 — Rozšíření** | ✅ hotovo | **Kolaborace & verzování (`src/ext/collab.ts`):** pojmenované checkpointy/snapshoty, strukturální `project.diff`, nedestruktivní sloučení projektů (`collab.merge`), časově ukotvené revizní komentáře, kapitolové značky pro YouTube a audit log. **Marketplace šablon a pluginů (`src/ext/marketplace.ts`):** parametrické šablony motion grafiky + pluginy + instalace vlastních `.veditpack.json` balíčků. **Pro Delivery (`src/render/export.ts`, `src/ext/delivery.ts`):** H.264 / H.265 / Apple ProRes 422 / WebM VP9, platformní presety (YouTube 1080p/4K, TikTok/Reels, Instagram, LinkedIn), dávkový multi-export, `export.queue_status` a automatické **watch-foldery**. **MCP Resources & Prompts (`PLAN §4.2`)** + multiplatformní desktop podpora (Windows / macOS / Linux). |
| **F6 — Pro Studio, VFX, Pro Audio & GPU Engine** | ✅ hotovo | **Hardwarové GPU enkodéry (`src/render/hwaccel.ts`):** detekce a 1-frame validace NVENC / AMF / QSV / VideoToolbox / VAAPI s bezpečným CPU fallbackem. **Pro VFX & Speed (`src/pro/fx.ts`, `src/render/export.ts`):** Chroma Key + despill, Speed Control (`0.1×–8×` + zřetězené `atempo`), Color Grading presety (`color.grade`), doostření, vinětace, ořez a přechody `fade`. **Pro Audio DSP (`src/pro/audio.ts`):** `audio.enhance` (highpass + FFT `afftdn` + vokální EQ + kompresor + `-16 LUFS`) a `audio.duck` (automatické ztišení hudby pod řečí) + master EBU R128 `loudnorm`. **PC Desktop UX:** HTTP `206` real-time video/audio stream + transport `Space`/`J`/`K`/`L`/fullscreen, Drag & Drop import souborů a `.vedit` Save/Open na disk. |

**Poznámka k F0 stacku:** kostra je implementovaná v TypeScriptu (běží jako server/CLI/MCP i UI); nativní Rust/Tauri jádro z plánu §6 zůstává cílem pro F1+ (v sandboxu není Rust toolchain). Rozhraní vrstev je připravené tak, aby jádro šlo vyměnit bez změny API/MCP toolů.

*Stav dokumentu: plán (v1.5, 2026-10-20) — doplněn stav implementace F0 + F1 + F2 + F3; Windows instalátor (Tauri/NSIS) se skládá v CI (`.github/workflows/release.yml` → `Vedit_installer.exe` na GitHub Releases).* 
