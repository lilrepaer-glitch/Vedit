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

program.parseAsync(process.argv).catch((err) => {
  console.error(`chyba: ${(err as Error).message}`);
  process.exit(1);
});
