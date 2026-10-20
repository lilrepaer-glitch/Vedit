# Vedit — plán a popis projektu

**Vedit** je profesionální desktopová aplikace pro střih a tvorbu videa na PC. Uživatel si ji **stáhne a nainstaluje** (žádný webový editor) — běží lokálně na výkonu jeho CPU/GPU, pracuje offline soubory na disku a je od základu navržená tak, aby ji uměla ovládat nejen myší, ale i AI přes **vestavěný MCP server a přímé API**.

> **Vize:** profesionální střih videa na PC, který ovládáte myší i AI — od hrubého sestřihu přes titulky a animace až po generované záběry a motion grafiku.

---

## 1. Proč desktopová aplikace (ne web)

| Požadavek | Řešení u Vedit |
|---|---|
| Velké 4K/8K soubory | Bez nahrávání do cloudu — čte se z disku, proxy workflow pro plynulý střih |
| Výkon | GPU akcelerace (NVENC / AMF / QSV), real-time preview na hardwaru uživatele |
| Soukromí | Materiály zůstávají lokálně; cloud AI jen výslovně na vyžádání |
| Offline | Plný střih a export bez internetu; online jen pro AI generování/updates |
| Distribuce | Stažitelný instalátor (`.exe` / MSI), automatické delta aktualizace |

**Platforma:** Windows 10/11 (64-bit) jako primární cíl; macOS a Linux v pozdější fázi.
**Distribuce:** instalátor ke stažení z webu projektu + portable verze; auto-update přes vlastní updater.

---

## 2. Cíloví uživatelé

- **Tvůrci obsahu** (YouTube, Twitch, TikTok/Reels) — rychlý střih, shorts z dlouhých videí
- **Freelance střihači a malá studia** — vícestopý NLE, barevné korekce, export
- **Marketéři a social media týmy** — motion grafika, reklamní spoty, šablony
- **AI-first uživatelé** — chtějí stříhat příkazy a agentem („sestříhej mi 20s highlight")

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

*Stav dokumentu: návrh plánu (v1, 2026-10-20). Další krok po odsouhlasení: F0 prototyp kostry aplikace.*
