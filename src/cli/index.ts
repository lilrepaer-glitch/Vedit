#!/usr/bin/env node
// vedit CLI (PLAN.md §5) — lokální ovládání editoru z terminálu.

import { resolve } from "node:path";
import { Command } from "commander";
import { VeditEngine } from "../core/engine.js";
import { loadOrInitEngine, saveProject, captionsToSrt, listAnimationPresets } from "../core/index.js";

const program = new Command();
program
  .name("vedit")
  .description("Vedit — desktopový video editor s MCP a API pro AI (F0 kostra)")
  .version("0.1.0");

function projectPathOpt(cmd: Command): void {
  cmd.option("-p, --project <file>", "soubor projektu", ".vedit/project.vedit");
}

async function withEngine(opts: { project: string }, fn: (engine: VeditEngine) => Promise<void> | void): Promise<void> {
  const engine = await loadOrInitEngine(resolve(opts.project));
  await fn(engine);
  await saveProject(engine.project, resolve(opts.project));
}

const init = program.command("init").description("vytvoří nový projekt");
projectPathOpt(init);
init.argument("[name]", "název projektu", "Untitled");
init.action(async (name: string, opts: { project: string }) => {
  const engine = new VeditEngine(VeditEngine.createProject(name));
  engine.addTrack("video", "V1");
  engine.addTrack("audio", "A1");
  await saveProject(engine.project, resolve(opts.project));
  console.log(`Projekt "${name}" vytvořen → ${opts.project}`);
});

const imp = program.command("import").description("zaregistruje médium do projektu");
projectPathOpt(imp);
imp.argument("<files...>", "soubory k importu");
imp.option("--kind <kind>", "video|audio|image", "video");
imp.option("--duration <sec>", "délka v sekundách");
imp.action(async (files: string[], opts: { project: string; kind: string; duration?: string }) => {
  await withEngine(opts, (engine) => {
    for (const file of files) {
      const name = file.split(/[\\/]/).pop() ?? file;
      const asset = engine.addAsset({
        name,
        kind: opts.kind as "video" | "audio" | "image",
        path: resolve(file),
        duration: opts.duration ? Number(opts.duration) : undefined,
      });
      console.log(`+ asset ${asset.name} (${asset.id})`);
    }
  });
});

const timeline = program.command("timeline").description("vypíše timeline projektu");
projectPathOpt(timeline);
timeline.action(async (opts: { project: string }) => {
  await withEngine(opts, (engine) => {
    const t = engine.timeline();
    console.log(`Projekt: ${engine.project.name}  •  délka: ${t.duration.toFixed(2)}s`);
    for (const track of t.tracks) {
      console.log(`  [${track.kind[0]!.toUpperCase()}] ${track.name}`);
      for (const clip of track.clips) {
        console.log(`     • ${clip.name}  ${clip.start.toFixed(2)}s → ${clip.end.toFixed(2)}s`);
      }
    }
    if (t.sequence.captions.length) {
      console.log(`  titulky: ${t.sequence.captions.length}`);
    }
  });
});

const cut = program.command("cut").description("rozdělí klip (razor) v daném čase");
projectPathOpt(cut);
cut.argument("<clipId>", "ID klipu");
cut.requiredOption("--at <sec>", "čas v sekundách");
cut.action(async (clipId: string, opts: { project: string; at: string }) => {
  await withEngine(opts, (engine) => {
    const [left, right] = engine.splitClip(clipId, Number(opts.at));
    console.log(`rozděleno → ${left.id} + ${right.id}`);
  });
});

const del = program.command("delete").description("smaže klip");
projectPathOpt(del);
del.argument("<clipId>", "ID klipu");
del.option("--ripple", "zavřít mezeru", false);
del.action(async (clipId: string, opts: { project: string; ripple?: boolean }) => {
  await withEngine(opts, (engine) => {
    if (opts.ripple) engine.rippleDeleteClip(clipId);
    else engine.deleteClip(clipId);
    console.log(`smazáno ${clipId}${opts.ripple ? " (ripple)" : ""}`);
  });
});

const captions = program.command("captions").description("titulky");
projectPathOpt(captions);
captions
  .command("add <text> <start> <end>")
  .description("přidá titulek")
  .action(async (text: string, start: string, end: string, opts: { project: string }) => {
    await withEngine(opts, (engine) => {
      const c = engine.addCaption({ text, start: Number(start), end: Number(end) });
      console.log(`+ titulek ${c.id}`);
    });
  });
captions
  .command("srt")
  .description("vypíše titulky jako SRT")
  .action(async (opts: { project: string }) => {
    await withEngine(opts, (engine) => {
      process.stdout.write(captionsToSrt(engine.activeSequence().captions));
    });
  });

const presets = program.command("presets").description("seznam animačních presetů");
presets.action(() => {
  for (const p of listAnimationPresets()) {
    console.log(`${p.id.padEnd(16)} ${p.label} — ${p.description}`);
  }
});

const probe = program.command("probe").description("reálná metadata média (ffprobe)");
probe.argument("<file>", "mediální soubor");
probe.action(async (file: string) => {
  const { probeMedia } = await import("../core/media.js");
  const info = await probeMedia(file);
  console.log(JSON.stringify(info, null, 2));
});

const frame = program.command("frame").description("uloží snímek z videa (F1)");
frame.argument("<file>", "video soubor");
frame.requiredOption("--at <sec>", "čas v sekundách");
frame.requiredOption("--out <file>", "výstupní JPEG");
frame.option("--width <px>", "šířka", "640");
frame.action(async (file: string, opts: { at: string; out: string; width: string }) => {
  const { extractFrame } = await import("../core/media.js");
  const { writeFile } = await import("node:fs/promises");
  const jpeg = await extractFrame(file, Number(opts.at), { width: Number(opts.width) });
  await writeFile(opts.out, jpeg);
  console.log(`snímek uložen → ${opts.out} (${jpeg.length} B)`);
});

const proxy = program.command("proxy").description("vygeneruje 640p proxy (F1)");
proxy.argument("<file>", "zdrojový soubor");
proxy.requiredOption("--out <file>", "výstupní soubor");
proxy.action(async (file: string, opts: { out: string }) => {
  const { generateProxy } = await import("../core/media.js");
  await generateProxy(file, opts.out);
  console.log(`proxy uloženo → ${opts.out}`);
});

const exportCmd = program.command("export").description("reálný render timeline přes FFmpeg (F1)");
projectPathOpt(exportCmd);
exportCmd.requiredOption("--out <file>", "výstupní video (mp4)");
exportCmd.option("--width <px>", "šířka");
exportCmd.option("--height <px>", "výška");
exportCmd.option("--fps <fps>", "fps");
exportCmd.action(async (opts: { project: string; out: string; width?: string; height?: string; fps?: string }) => {
  const { renderSequence } = await import("../render/export.js");
  const engine = await loadOrInitEngine(resolve(opts.project));
  const result = await renderSequence(engine.project, {
    outPath: resolve(opts.out),
    width: opts.width ? Number(opts.width) : undefined,
    height: opts.height ? Number(opts.height) : undefined,
    fps: opts.fps ? Number(opts.fps) : undefined,
    onProgress: (pct) => process.stdout.write(`\rrender ${pct}%   `),
  });
  console.log(`\nhotovo → ${result.outPath} (${result.duration.toFixed(2)}s, ${result.sizeBytes} B)`);
  for (const w of result.warnings) console.warn(`varování: ${w}`);
});

const animate = program.command("animate").description("aplikuje animační preset na klip");
projectPathOpt(animate);
animate.argument("<clipId>", "ID klipu");
animate.requiredOption("--preset <id>", "ID presetu");
animate.action(async (clipId: string, opts: { project: string; preset: string }) => {
  await withEngine(opts, (engine) => {
    engine.applyAnimationPreset(clipId, opts.preset);
    console.log(`aplikováno ${opts.preset} na ${clipId}`);
  });
});

const tts = program.command("tts").description("F2: syntéza řeči (espeak-ng) → WAV");
tts.requiredOption("--text <text>", "text k přečtení");
tts.option("--voice <voice>", "hlas (cs, en, sk, …)", "cs");
tts.option("--rate <wpm>", "tempo", "175");
tts.requiredOption("--out <file>", "výstupní WAV");
tts.action(async (opts: { text: string; voice: string; rate: string; out: string }) => {
  const { ttsSynthesize } = await import("../ai/speech.js");
  const { writeFile } = await import("node:fs/promises");
  const result = await ttsSynthesize(opts.text, { voice: opts.voice, rate: Number(opts.rate) });
  await writeFile(opts.out, result.wav);
  console.log(`TTS hotovo → ${opts.out} (${result.duration.toFixed(2)}s, ${result.sampleRate} Hz)`);
});

const voiceover = program.command("voiceover").description("F2: voiceover ze skriptu → audio + klip + titulky");
projectPathOpt(voiceover);
voiceover.requiredOption("--script <file>", "textový soubor se skriptem");
voiceover.option("--voice <voice>", "hlas", "cs");
voiceover.option("--start <sec>", "začátek na timeline", "0");
voiceover.action(async (opts: { project: string; script: string; voice: string; start: string }) => {
  const { generateVoiceover } = await import("../ai/voiceover.js");
  const { readFile, mkdir } = await import("node:fs/promises");
  const script = await readFile(resolve(opts.script), "utf8");
  await withEngine(opts, async (engine) => {
    await mkdir(resolve(".vedit/media"), { recursive: true });
    const result = await generateVoiceover(engine, { script, voice: opts.voice, start: Number(opts.start) }, {
      mediaDir: resolve(".vedit/media"),
    });
    console.log(`voiceover: ${result.asset.name} (${result.duration.toFixed(2)}s, ${result.engine})`);
    console.log(`titulky: ${result.captions.length}`);
  });
});

const transcribe = program.command("transcribe").description("F2: přepis řeči z média → titulky");
projectPathOpt(transcribe);
transcribe.argument("<assetId>", "ID assetu v projektu");
transcribe.option("--language <lang>", "jazyk", "en");
transcribe.action(async (assetId: string, opts: { project: string; language: string }) => {
  const { transcribeToCaptions } = await import("../ai/voiceover.js");
  await withEngine(opts, async (engine) => {
    const result = await transcribeToCaptions(engine, assetId, { language: opts.language });
    console.log(`přepsáno (${result.engine}): ${result.captions.length} titulků`);
    console.log(result.text.slice(0, 300));
  });
});

const analyze = program.command("analyze").description("F3: analýza média (silences | scenes | beats | motion)");
analyze.argument("<kind>", "silences | scenes | beats | motion");
analyze.argument("<media>", "cesta k médiu");
analyze.option("--noise-db <db>", "práh ticha v dBFS", (v) => parseFloat(v));
analyze.option("--min-silence <sec>", "minimální délka ticha", (v) => parseFloat(v));
analyze.option("--threshold <t>", "práh detekce scén 0..1", (v) => parseFloat(v));
analyze.option("--sensitivity <s>", "citlivost beatů", (v) => parseFloat(v));
analyze.action(async (kind: string, media: string, opts: { noiseDb?: number; minSilence?: number; threshold?: number; sensitivity?: number }) => {
  switch (kind) {
    case "silences": {
      const { detectSilences } = await import("../ai/analysis.js");
      console.log(JSON.stringify(await detectSilences(media, { noiseDb: opts.noiseDb, minDuration: opts.minSilence }), null, 2));
      break;
    }
    case "scenes": {
      const { detectScenes } = await import("../ai/analysis.js");
      console.log(JSON.stringify(await detectScenes(media, { threshold: opts.threshold }), null, 2));
      break;
    }
    case "beats": {
      const { detectBeats } = await import("../ai/analysis.js");
      console.log(JSON.stringify(await detectBeats(media, { sensitivity: opts.sensitivity }), null, 2));
      break;
    }
    case "motion": {
      const { trackMotion } = await import("../ai/analysis.js");
      console.log(JSON.stringify(await trackMotion(media, {}), null, 2));
      break;
    }
    default:
      throw new Error("kind = silences | scenes | beats | motion");
  }
});

const cutSilence = program.command("cut-silence").description("F3: vyhoď ticha ze stopy (ripple collapse)");
projectPathOpt(cutSilence);
cutSilence.option("--track <id>", "cílová stopa");
cutSilence.option("--clip <id>", "cílový klip (určí stopu)");
cutSilence.option("--noise-db <db>", "práh ticha v dBFS", (v) => parseFloat(v));
cutSilence.option("--min-silence <sec>", "minimální délka ticha", (v) => parseFloat(v));
cutSilence.action(async (opts: { project: string; track?: string; clip?: string; noiseDb?: number; minSilence?: number }) => {
  const { removeSilences } = await import("../ai/edit.js");
  await withEngine(opts, async (engine) => {
    const result = await removeSilences(engine, {
      trackId: opts.track,
      clipId: opts.clip,
      noiseDb: opts.noiseDb,
      minSilence: opts.minSilence,
    });
    console.log(`ticha vyhozena: −${result.savedDuration.toFixed(2)}s, ${result.clips.length} klipů na stopě ${result.trackId}`);
  });
});

const highlight = program.command("highlight").description("F3: sestav highlight reel do nové stopy");
projectPathOpt(highlight);
highlight.option("--track <id>", "zdrojová stopa");
highlight.option("--asset <id>", "zdrojové médium");
highlight.option("--clip <id>", "zdrojový klip");
highlight.option("--duration <sec>", "cílová délka vteřin", (v) => parseFloat(v), 15);
highlight.action(async (opts: { project: string; track?: string; asset?: string; clip?: string; duration: number }) => {
  const { buildHighlight } = await import("../ai/edit.js");
  await withEngine(opts, async (engine) => {
    const result = await buildHighlight(engine, {
      trackId: opts.track,
      assetId: opts.asset,
      clipId: opts.clip,
      targetDuration: opts.duration,
    });
    console.log(`highlight: ${result.totalDuration.toFixed(2)}s v ${result.clips.length} klipech na stopě ${result.trackId}`);
  });
});

const beats = program.command("beats").description("F3: rozděl klip na střihy na beaty hudby");
projectPathOpt(beats);
beats.argument("<clipId>", "ID klipu");
beats.argument("<musicAssetId>", "ID hudebního assetu");
beats.action(async (clipId: string, musicAssetId: string, opts: { project: string }) => {
  const { beatSync } = await import("../ai/edit.js");
  await withEngine(opts, async (engine) => {
    const result = await beatSync(engine, { clipId, musicAssetId });
    console.log(`beat-sync: ${result.beats.length} beatů → ${result.splits.length} střihů`);
  });
});

const track = program.command("track").description("F3: motion tracking — grafika sleduje pohyb");
projectPathOpt(track);
track.argument("<targetClipId>", "ID cílového klipu (grafika/text)");
track.argument("<source>", "ID zdrojového assetu nebo klipu");
track.option("--strength <s>", "síla 0..2", (v) => parseFloat(v), 1);
track.action(async (targetClipId: string, source: string, opts: { project: string; strength: number }) => {
  const { trackMotionTo } = await import("../ai/edit.js");
  await withEngine(opts, async (engine) => {
    const byClip = engine.project.sequences.some((s) => s.tracks.some((t) => t.clips.some((c) => c.id === source)));
    const result = await trackMotionTo(engine, {
      targetClipId,
      sourceAssetId: byClip ? undefined : source,
      sourceClipId: byClip ? source : undefined,
      strength: opts.strength,
    });
    console.log(`tracking: ${result.keyframes} keyframů na klipu ${result.clip.id}`);
  });
});

const serve = program.command("serve").description("spustí REST+WS API server");
serve.option("--port <port>", "port", "47000");
serve.option("--host <host>", "host", "127.0.0.1");
serve.option("--token <token>", "API token (výchozí: náhodný)");
serve.option("--no-sample", "bez demo projektu");
serve.action(async (opts: { port: string; host: string; token?: string; sample: boolean }) => {
  const { startServer } = await import("../server/index.js");
  startServer({
    port: Number(opts.port),
    host: opts.host,
    token: opts.token ?? undefined,
    sample: opts.sample,
  });
});

const mcp = program.command("mcp").description("spustí MCP server (stdio)");
mcp.option("-p, --project <file>", "soubor projektu", process.env.VEDIT_PROJECT ?? ".vedit/project.vedit");
mcp.action(async (opts: { project: string }) => {
  const { startStdio } = await import("../mcp/stdio.js");
  await startStdio(opts.project);
});

const mcpHttp = program.command("mcp-http").description("spustí MCP server (Streamable HTTP)");
mcpHttp.option("--port <port>", "port", "47001");
mcpHttp.action(async (opts: { port: string }) => {
  const { startMcpHttp } = await import("../mcp/http.js");
  startMcpHttp({ port: Number(opts.port) });
});

// ---- F5: Export Presets, Watch Folders, Marketplace & Checkpoints CLI ----
program
  .command("export-presets")
  .description("F5: vypíše dostupné exportní presety a kodeky")
  .action(async () => {
    const { listExportPresets } = await import("../ext/delivery.js");
    for (const p of listExportPresets()) {
      console.log(`${p.id.padEnd(18)} ${p.codec.toUpperCase().padEnd(7)} .${p.format.padEnd(5)} ${p.label}`);
    }
  });

const batchCmd = program.command("batch-export").description("F5: vyrenderuje sekvenci do více presetů najednou");
projectPathOpt(batchCmd);
batchCmd.requiredOption("--presets <list>", "seznam presetů oddělený čárkou (např. youtube-1080p,tiktok-reels)");
batchCmd.option("--out-dir <dir>", "výstupní složka", ".vedit/renders");
batchCmd.action(async (opts: { project: string; presets: string; outDir: string }) => {
  const { renderSequence, resolveExportPreset } = await import("../render/export.js");
  const { join } = await import("node:path");
  const engine = await loadOrInitEngine(resolve(opts.project));
  const ids = opts.presets.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    const preset = resolveExportPreset(id);
    if (!preset) throw new Error(`neznámý preset: ${id}`);
    const outPath = join(resolve(opts.outDir), `${id}.${preset.format}`);
    const r = await renderSequence(engine.project, { outPath, preset: id });
    console.log(`✓ ${id} → ${r.outPath} (${r.codec}, ${r.width}×${r.height}, ${r.sizeBytes} B)`);
  }
});

const watchCmd = program.command("watch").description("F5: watch-folder — automatický render nově přidaných videí");
watchCmd.requiredOption("--in <dir>", "vstupní složka");
watchCmd.requiredOption("--out <dir>", "výstupní složka");
watchCmd.option("--preset <id>", "exportní preset", "youtube-1080p");
watchCmd.option("--template <id>", "volitelná šablona z Marketplace");
watchCmd.action(async (opts: { in: string; out: string; preset: string; template?: string }) => {
  const { WatchFolderManager } = await import("../ext/delivery.js");
  const mgr = new WatchFolderManager();
  await mgr.start(
    { inboxDir: opts.in, outputDir: opts.out, preset: opts.preset, templateId: opts.template },
    (item) => console.log(`[watch] hotovo → ${item.outPath} (${item.sizeBytes} B)`),
  );
  console.log(`Sleduji ${resolve(opts.in)} → ${resolve(opts.out)} (preset: ${opts.preset})…`);
});

program
  .command("marketplace")
  .description("F5: vypíše šablony a pluginy ve Vedit Marketplace")
  .action(async () => {
    const { listMarketplacePacks } = await import("../ext/marketplace.js");
    for (const p of listMarketplacePacks()) {
      console.log(`[${p.kind.padEnd(8)}] ${p.id.padEnd(22)} ${p.name} (${p.category})`);
    }
  });

const applyTplCmd = program.command("apply-template").description("F5: aplikuje šablonu z Marketplace na projekt");
projectPathOpt(applyTplCmd);
applyTplCmd.argument("<templateId>", "ID šablony (např. tpl-youtube-intro)");
applyTplCmd.option("--title <text>", "hlavní titulek");
applyTplCmd.option("--subtitle <text>", "podtitulek");
applyTplCmd.option("--cta <text>", "CTA text");
applyTplCmd.action(async (templateId: string, opts: { project: string; title?: string; subtitle?: string; cta?: string }) => {
  const { applyTemplate } = await import("../ext/marketplace.js");
  await withEngine(opts, (engine) => {
    const res = applyTemplate(engine, templateId, {
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.subtitle ? { subtitle: opts.subtitle } : {}),
      ...(opts.cta ? { cta: opts.cta } : {}),
    });
    console.log(`aplikováno "${res.appliedName}" (+${res.captionsAdded} titulků, ${res.sequence.width}×${res.sequence.height})`);
  });
});

const diffCmd = program.command("diff").description("F5: porovná dva .vedit soubory projektu");
diffCmd.argument("<baseFile>", "původní .vedit soubor");
diffCmd.argument("<targetFile>", "nový .vedit soubor");
diffCmd.action(async (baseFile: string, targetFile: string) => {
  const { readFile } = await import("node:fs/promises");
  const { diffProjects } = await import("../ext/collab.js");
  const a = JSON.parse(await readFile(resolve(baseFile), "utf8"));
  const b = JSON.parse(await readFile(resolve(targetFile), "utf8"));
  console.log(JSON.stringify(diffProjects(a, b), null, 2));
});

// ---- F6: Hardware GPU Encoders, Pro VFX, Speed & Pro Audio CLI ----
program
  .command("encoders")
  .description("F6: probes hardware GPU encoders (NVENC, AMF, QSV, VideoToolbox, VAAPI)")
  .action(async () => {
    const { probeHardwareEncoders } = await import("../render/hwaccel.js");
    const report = await probeHardwareEncoders();
    console.log(`Recommended backend: ${report.recommendedBackend.toUpperCase()}`);
    for (const enc of report.encoders) {
      const status = enc.usable ? "✓ USABLE" : enc.compiled ? "○ no GPU driver" : "– not compiled";
      console.log(`  ${enc.encoder.padEnd(20)} ${status.padEnd(18)} ${enc.label}`);
    }
  });

const gradeCmd = program.command("color-grade").description("F6: applies color grading preset to a clip");
projectPathOpt(gradeCmd);
gradeCmd.argument("<clipId>", "target clip ID");
gradeCmd.option("--preset <id>", "color preset ID", "cinematic-contrast");
gradeCmd.action(async (clipId: string, opts: { project: string; preset: string }) => {
  const { applyColorGrade } = await import("../pro/fx.js");
  await withEngine(opts, (engine) => {
    const eff = applyColorGrade(engine, clipId, { preset: opts.preset });
    console.log(`Color grade applied (${opts.preset}) → ${eff.id}`);
  });
});

const chromaCmd = program.command("chroma-key").description("F6: applies green/blue screen chroma key + despill");
projectPathOpt(chromaCmd);
chromaCmd.argument("<clipId>", "target clip ID");
chromaCmd.option("--color <hex>", "key color (#00ff00 or blue)", "#00ff00");
chromaCmd.option("--similarity <n>", "similarity (0.01..1.0)", "0.28");
chromaCmd.action(async (clipId: string, opts: { project: string; color: string; similarity: string }) => {
  const { applyChromaKey } = await import("../pro/fx.js");
  await withEngine(opts, (engine) => {
    const eff = applyChromaKey(engine, clipId, { color: opts.color, similarity: Number(opts.similarity) });
    console.log(`Chroma key applied (${opts.color}) → ${eff.id}`);
  });
});

const speedCmd = program.command("speed").description("F6: sets clip playback speed (0.1x..8.0x)");
projectPathOpt(speedCmd);
speedCmd.argument("<clipId>", "target clip ID");
speedCmd.requiredOption("--rate <x>", "speed multiplier, e.g. 2.0 or 0.5");
speedCmd.action(async (clipId: string, opts: { project: string; rate: string }) => {
  const { setClipSpeed } = await import("../pro/fx.js");
  await withEngine(opts, (engine) => {
    const clip = setClipSpeed(engine, clipId, Number(opts.rate));
    console.log(`Clip speed set to ${opts.rate}x → duration ${clip.duration.toFixed(2)}s`);
  });
});

const enhCmd = program.command("audio-enhance").description("F6: cleans, equalizes & normalizes speech audio");
projectPathOpt(enhCmd);
enhCmd.option("--clip <clipId>", "target clip ID");
enhCmd.action(async (opts: { project: string; clip?: string }) => {
  const { enhanceAudio } = await import("../pro/audio.js");
  await withEngine(opts, async (engine) => {
    const r = await enhanceAudio(engine, { clipId: opts.clip });
    console.log(`Enhanced audio saved → ${r.outPath} (${r.duration.toFixed(2)}s)`);
  });
});

const duckCmd = program.command("audio-duck").description("F6: auto-ducks music clip under speech");
projectPathOpt(duckCmd);
duckCmd.requiredOption("--music <clipId>", "background music clip ID");
duckCmd.option("--voice <clipId>", "voice clip ID");
duckCmd.action(async (opts: { project: string; music: string; voice?: string }) => {
  const { duckMusicUnderVoice } = await import("../pro/audio.js");
  await withEngine(opts, async (engine) => {
    const r = await duckMusicUnderVoice(engine, { musicClipId: opts.music, voiceClipId: opts.voice });
    console.log(`Ducked music (${r.speechIntervals.length} speech segments) → ${r.outPath}`);
  });
});

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
