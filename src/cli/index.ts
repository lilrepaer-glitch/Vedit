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
