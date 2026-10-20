// MCP server (PLAN.md §4) — editor jako sada tools pro AI agenty.
// Stejné jádro operací jako REST API (PLAN.md §5).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VeditEngine } from "../core/engine.js";
import { captionsToSrt, listAnimationPresets } from "../core/presets.js";
import { sequenceDuration } from "../core/types.js";
import { extractFrame, extractPeaks, generateProxy, probeMedia } from "../core/media.js";
import { speechCapabilities } from "../ai/speech.js";
import { generateVoiceover, transcribeToCaptions } from "../ai/voiceover.js";
import { runStubGenJob, runRealRenderJob, runProxyJob } from "../server/app.js";
import { resolve as resolvePath } from "node:path";

export interface McpContext {
  engine: VeditEngine;
  /** Persist the bound project (stdio mode binds a .vedit file). */
  save?: () => Promise<void>;
  /** Open another project file into the context. */
  open?: (path: string) => Promise<void>;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  return {
    content: [{ type: "text" as const, text: (err as Error).message }],
    isError: true,
  };
}

const idSchema = z.string().min(1).describe("ID objektu (clip/asset/caption/job)");

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "vedit", version: "0.1.0" });
  const engine = () => ctx.engine;
  const save = async () => {
    await ctx.save?.();
  };

  const wrapTool = async (fn: () => Promise<unknown> | unknown) => {
    try {
      const result = await fn();
      await save();
      return ok(result ?? { ok: true });
    } catch (err) {
      return fail(err);
    }
  };

  // ---- systém ----
  server.registerTool(
    "health",
    { description: "Stav Vedit serveru a rozsah (F0 kostra)." },
    async () => ok({ ok: true, name: "vedit", version: "0.1.0", scope: "F0 skeleton" }),
  );

  server.registerTool(
    "project.get_state",
    { description: "Celý stav projektu: assety, timeline, titulky, fronta úloh." },
    async () => ok(engine().project),
  );

  server.registerTool(
    "project.create",
    {
      description: "Vytvoří nový projekt (nahradí aktuální v tomto procesu).",
      inputSchema: { name: z.string().default("Untitled") },
    },
    async ({ name }) =>
      wrapTool(() => {
        ctx.engine = new VeditEngine(VeditEngine.createProject(name));
        return { project: ctx.engine.project };
      }),
  );

  server.registerTool(
    "project.open",
    {
      description: "Otevře .vedit soubor projektu.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) =>
      wrapTool(async () => {
        if (!ctx.open) throw new Error("project.open není v tomto režimu podporováno");
        await ctx.open(path);
        return { project: ctx.engine.project };
      }),
  );

  server.registerTool(
    "project.save",
    { description: "Uloží projekt do navázaného .vedit souboru." },
    async () => wrapTool(() => ({ saved: true })),
  );

  server.registerTool(
    "undo",
    { description: "Vrátí poslední operaci zpět." },
    async () => wrapTool(() => ({ ok: engine().undo(), undo: engine().undoLabels, redo: engine().redoLabels })),
  );

  server.registerTool(
    "redo",
    { description: "Znovu provede poslední vrácenou operaci." },
    async () => wrapTool(() => ({ ok: engine().redo(), undo: engine().undoLabels, redo: engine().redoLabels })),
  );

  // ---- média ----
  server.registerTool(
    "media.import",
    {
      description: "Zaregistruje mediální soubor do media poolu (F0: metadata, bez ffprobe).",
      inputSchema: {
        name: z.string(),
        path: z.string(),
        kind: z.enum(["video", "audio", "image", "generated"]).default("video"),
        duration: z.number().nonnegative().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
      },
    },
    async (args) => wrapTool(() => ({ asset: engine().addAsset({ ...args }) })),
  );

  server.registerTool(
    "media.list",
    { description: "Seznam assetů v projektu." },
    async () => ok({ assets: engine().project.assets }),
  );

  server.registerTool(
    "media.get_info",
    {
      description: "Detail assetu (typ, cesta, rozměry, délka).",
      inputSchema: { assetId: idSchema },
    },
    async ({ assetId }) => wrapTool(() => ({ asset: engine().findAsset(assetId) })),
  );

  server.registerTool(
    "media.get_frames",
    {
      description: "Reálné náhledy snímků z média (F1: dekódování přes FFmpeg, vrací base64 JPEG).",
      inputSchema: {
        assetId: idSchema.optional(),
        path: z.string().optional(),
        times: z.array(z.number()).optional(),
        width: z.number().int().positive().max(640).default(320),
      },
    },
    async ({ assetId, path, times, width }) =>
      wrapTool(async () => {
        const mediaPath = assetId ? engine().findAsset(assetId).path : path;
        if (!mediaPath) throw new Error("zadej assetId nebo path");
        const asset = assetId ? engine().findAsset(assetId) : undefined;
        const ts = times?.length ? times : [0, asset?.duration ? asset.duration / 2 : 1, asset?.duration ?? 2];
        const frames = [];
        for (const t of ts) {
          const jpeg = await extractFrame(mediaPath, t, { width });
          frames.push({ t, jpegBase64: jpeg.toString("base64") });
        }
        return { frames, format: "jpeg", width };
      }),
  );

  server.registerTool(
    "media.probe",
    {
      description: "Reálná metadata média přes ffprobe (délka, kodeky, rozlišení, fps).",
      inputSchema: {
        assetId: idSchema.optional(),
        path: z.string().optional(),
      },
    },
    async ({ assetId, path }) =>
      wrapTool(async () => {
        const mediaPath = assetId ? engine().findAsset(assetId).path : path;
        if (!mediaPath) throw new Error("zadej assetId nebo path");
        return { probe: await probeMedia(mediaPath) };
      }),
  );

  server.registerTool(
    "media.waveform",
    {
      description: "Audio waveform peaks (0..1) pro zobrazení stopy.",
      inputSchema: { assetId: idSchema, samples: z.number().int().min(10).max(2000).default(400) },
    },
    async ({ assetId, samples }) =>
      wrapTool(async () => {
        const asset = engine().findAsset(assetId);
        return { peaks: await extractPeaks(asset.path, samples), samples };
      }),
  );

  server.registerTool(
    "media.proxy",
    {
      description: "Vygeneruje 64p proxy pro plynulý střih (F1, asynchronní job).",
      inputSchema: { assetId: idSchema },
    },
    async ({ assetId }) =>
      wrapTool(() => {
        engine().findAsset(assetId);
        return runProxyJob(engine(), assetId, { proxyDir: resolvePath(process.cwd(), ".vedit/proxies") });
      }),
  );

  // ---- timeline ----
  server.registerTool(
    "timeline.get_timeline",
    { description: "Aktuální timeline: stopy, klipy, délka sekvence." },
    async () => ok(engine().timeline()),
  );

  server.registerTool(
    "timeline.add_clip",
    {
      description: "Vloží klip z assetu na stopu (nový klip na timeline).",
      inputSchema: {
        assetId: idSchema,
        start: z.number().nonnegative(),
        trackId: idSchema.optional(),
        duration: z.number().positive().optional(),
        in: z.number().nonnegative().optional(),
        out: z.number().optional(),
        name: z.string().optional(),
      },
    },
    async (args) =>
      wrapTool(() => {
        let trackId = args.trackId;
        if (!trackId) {
          const asset = engine().findAsset(args.assetId);
          const kind = asset.kind === "audio" ? "audio" : "video";
          const seq = engine().activeSequence();
          const track = seq.tracks.find((t) => t.kind === kind);
          trackId = track ? track.id : engine().addTrack(kind).id;
        }
        return { clip: engine().addClip({ ...args, trackId }) };
      }),
  );

  server.registerTool(
    "timeline.cut",
    {
      description: "Razor: rozdělí klip v daném čase na timeline (vteřiny).",
      inputSchema: { clipId: idSchema, at: z.number(), trackId: idSchema.optional() },
    },
    async ({ clipId, at, trackId }) =>
      wrapTool(() => {
        const [left, right] = engine().splitClip(clipId, at, trackId);
        return { left, right };
      }),
  );

  server.registerTool(
    "timeline.split",
    {
      description: "Alias timeline.cut (rozdělení klipu).",
      inputSchema: { clipId: idSchema, at: z.number(), trackId: idSchema.optional() },
    },
    async ({ clipId, at, trackId }) =>
      wrapTool(() => {
        const [left, right] = engine().splitClip(clipId, at, trackId);
        return { left, right };
      }),
  );

  server.registerTool(
    "timeline.trim",
    {
      description: "Ořízne hranu klipu (posun in/out bodu).",
      inputSchema: {
        clipId: idSchema,
        edge: z.enum(["start", "end"]),
        time: z.number(),
        trackId: idSchema.optional(),
      },
    },
    async ({ clipId, edge, time, trackId }) =>
      wrapTool(() => ({ clip: engine().trimClip(clipId, edge, time, trackId) })),
  );

  server.registerTool(
    "timeline.move",
    {
      description: "Přesune klip na jiný čas/pozici (případně na jinou stopu).",
      inputSchema: {
        clipId: idSchema,
        start: z.number().nonnegative(),
        trackId: idSchema.optional(),
        fromTrackId: idSchema.optional(),
      },
    },
    async ({ clipId, start, trackId, fromTrackId }) =>
      wrapTool(() => ({ clip: engine().moveClip(clipId, start, trackId, fromTrackId) })),
  );

  server.registerTool(
    "timeline.delete",
    {
      description: "Smaže klip; ripple=true zavře mezeru za ním.",
      inputSchema: {
        clipId: idSchema,
        trackId: idSchema.optional(),
        ripple: z.boolean().default(false),
      },
    },
    async ({ clipId, trackId, ripple }) =>
      wrapTool(() => {
        if (ripple) engine().rippleDeleteClip(clipId, trackId);
        else engine().deleteClip(clipId, trackId);
        return { deleted: clipId, ripple };
      }),
  );

  server.registerTool(
    "timeline.update_clip",
    {
      description: "Upraví vlastnosti klipu (název, pozice, transformace).",
      inputSchema: {
        clipId: idSchema,
        name: z.string().optional(),
        start: z.number().nonnegative().optional(),
        duration: z.number().positive().optional(),
        in: z.number().nonnegative().optional(),
        out: z.number().optional(),
        trackId: idSchema.optional(),
        transform: z
          .object({
            x: z.number().optional(),
            y: z.number().optional(),
            scaleX: z.number().optional(),
            scaleY: z.number().optional(),
            rotation: z.number().optional(),
            opacity: z.number().optional(),
          })
          .optional(),
      },
    },
    async ({ clipId, trackId, ...patch }) =>
      wrapTool(() => ({ clip: engine().updateClip(clipId, patch, trackId) })),
  );

  server.registerTool(
    "timeline.roll",
    {
      description: "Roll edit: posune střih mezi klipem a sousedem vpravo (F1).",
      inputSchema: { clipId: idSchema, delta: z.number(), trackId: idSchema.optional() },
    },
    async ({ clipId, delta, trackId }) =>
      wrapTool(() => engine().rollClip(clipId, delta, trackId)),
  );

  server.registerTool(
    "timeline.slip",
    {
      description: "Slip edit: posune obsah klipu (in/out) bez pohybu na timeline (F1).",
      inputSchema: { clipId: idSchema, delta: z.number(), trackId: idSchema.optional() },
    },
    async ({ clipId, delta, trackId }) =>
      wrapTool(() => ({ clip: engine().slipClip(clipId, delta, trackId) })),
  );

  server.registerTool(
    "timeline.slide",
    {
      description: "Slide edit: posune klip po timeline a upraví sousedy (F1).",
      inputSchema: { clipId: idSchema, delta: z.number(), trackId: idSchema.optional() },
    },
    async ({ clipId, delta, trackId }) =>
      wrapTool(() => ({ clip: engine().slideClip(clipId, delta, trackId) })),
  );

  // ---- titulky ----
  server.registerTool(
    "captions.generate",
    {
      description:
        "Vygeneruje titulky. Buď přímo segments [{text,start,end}], nebo text + start/end (rozdělí se rovnoměrně na slova).",
      inputSchema: {
        segments: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).optional(),
        text: z.string().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
      },
    },
    async (args) =>
      wrapTool(() => {
        if (args.segments?.length) return { captions: engine().addCaptionsFromSegments(args.segments) };
        if (args.text && args.start != null && args.end != null) {
          const words = args.text.split(/\s+/).filter(Boolean);
          const span = (args.end - args.start) / Math.max(1, words.length);
          const segments = words.map((word, i) => ({
            text: word,
            start: args.start! + i * span,
            end: args.start! + (i + 1) * span,
          }));
          return { captions: engine().addCaptionsFromSegments(segments), note: "slova rozdělena rovnoměrně (F0)" };
        }
        throw new Error("zadej segments nebo text+start+end");
      }),
  );

  server.registerTool(
    "captions.edit",
    {
      description: "Upraví titulek (text, časy, styl).",
      inputSchema: {
        captionId: idSchema,
        text: z.string().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
        style: z.record(z.unknown()).optional(),
      },
    },
    async ({ captionId, ...patch }) =>
      wrapTool(() => ({ caption: engine().updateCaption(captionId, patch) })),
  );

  server.registerTool(
    "captions.translate",
    {
      description:
        "Přeložené titulky hromadně (překlad zajišťuje AI klient — vlož kompletní přeložené segments).",
      inputSchema: {
        replace: z.boolean().default(true),
        segments: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })),
      },
    },
    async ({ replace, segments }) =>
      wrapTool(() => {
        const seq = engine().activeSequence();
        if (replace && seq.captions.length) {
          // remove all captions as one transaction via individual ops is noisy;
          // snapshot commit handles it: delete each then add segments
          for (const c of [...seq.captions]) engine().removeCaption(c.id);
        }
        return { captions: engine().addCaptionsFromSegments(segments) };
      }),
  );

  server.registerTool(
    "captions.export",
    {
      description: "Export titulků (F0: SRT).",
      inputSchema: { format: z.enum(["srt"]).default("srt") },
    },
    async () => ok({ srt: captionsToSrt(engine().activeSequence().captions) }),
  );

  // ---- animace / efekty ----
  server.registerTool(
    "animation.list_presets",
    { description: "Seznam animačních presetů (fade-in, slide-in, pop-in, ...)." },
    async () => ok({ presets: listAnimationPresets() }),
  );

  server.registerTool(
    "animation.apply_preset",
    {
      description: "Aplikuje animační preset na klip (keyframy).",
      inputSchema: { clipId: idSchema, preset: z.string(), trackId: idSchema.optional() },
    },
    async ({ clipId, preset, trackId }) =>
      wrapTool(() => ({ clip: engine().applyAnimationPreset(clipId, preset, trackId) })),
  );

  server.registerTool(
    "animation.set_keyframes",
    {
      description: "Nastaví keyframy klipu (property: x,y,scaleX,scaleY,rotation,opacity; čas je lokální ke klipu).",
      inputSchema: {
        clipId: idSchema,
        trackId: idSchema.optional(),
        keyframes: z.array(
          z.object({
            time: z.number().nonnegative(),
            property: z.string(),
            value: z.union([z.number(), z.string()]),
            easing: z.string().optional(),
          }),
        ),
      },
    },
    async ({ clipId, trackId, keyframes }) =>
      wrapTool(() => ({ clip: engine().addKeyframes(clipId, keyframes, trackId) })),
  );

  server.registerTool(
    "effect.apply",
    {
      description: "Aplikuje efekt na klip (F1: blur/color/grayscale se renderují, ostatní evidence).",
      inputSchema: {
        clipId: idSchema,
        type: z.string(),
        params: z.record(z.unknown()).optional(),
        trackId: idSchema.optional(),
      },
    },
    async ({ clipId, type, params, trackId }) =>
      wrapTool(() => ({ effect: engine().addEffect(clipId, type, params ?? {}, trackId) })),
  );

  server.registerTool(
    "effect.update",
    {
      description: "Upraví parametry efektu (např. color: brightness/contrast/saturation/gamma).",
      inputSchema: {
        clipId: idSchema,
        effectId: idSchema,
        params: z.record(z.unknown()),
        trackId: idSchema.optional(),
      },
    },
    async ({ clipId, effectId, params, trackId }) =>
      wrapTool(() => ({ effect: engine().updateEffect(clipId, effectId, params, trackId) })),
  );

  server.registerTool(
    "effect.remove",
    {
      description: "Odebere efekt z klipu.",
      inputSchema: { clipId: idSchema, effectId: idSchema, trackId: idSchema.optional() },
    },
    async ({ clipId, effectId, trackId }) =>
      wrapTool(() => {
        engine().removeEffect(clipId, effectId, trackId);
        return { removed: effectId };
      }),
  );

  server.registerTool(
    "ai.capabilities",
    { description: "Dostupné AI enginy (TTS/ASR) a hlasy." },
    async () => wrapTool(() => speechCapabilities()),
  );

  // ---- generování (gen.video F0 stub) + export ----
  server.registerTool(
    "gen.video",
    {
      description: "Vygeneruje video z promptu (F0: simulovaný job vrací asset; reálné modely ve F4).",
      inputSchema: {
        prompt: z.string(),
        duration: z.number().positive().default(5),
        model: z.string().optional(),
        provider: z.string().optional(),
      },
    },
    async (args) => wrapTool(() => runStubGenJob(engine(), "gen.video", { ...args })),
  );

  server.registerTool(
    "gen.image",
    {
      description: "Vygeneruje obrázek z promptu (F0: simulovaný job).",
      inputSchema: { prompt: z.string(), model: z.string().optional() },
    },
    async (args) => wrapTool(() => runStubGenJob(engine(), "gen.image", { ...args })),
  );

  server.registerTool(
    "gen.audio",
    {
      description:
        "F2: kind=voice dělá REÁLNÝ voiceover ze skriptu (TTS + klip + titulky); music/sfx zůstávají simulované do F4.",
      inputSchema: {
        prompt: z.string().describe("Text skriptu (voice) nebo prompt (music/sfx)"),
        kind: z.enum(["music", "sfx", "voice"]).default("music"),
        voice: z.string().default("cs"),
        duration: z.number().positive().optional(),
        start: z.number().nonnegative().default(0),
        gap: z.number().min(0).max(3).optional(),
      },
    },
    async ({ prompt, kind, voice, start, gap }) =>
      wrapTool(async () => {
        if (kind === "voice") {
          const caps = await speechCapabilities();
          if (caps.tts.available) {
            return generateVoiceover(engine(), { script: prompt, voice, start, gap }, {
              mediaDir: resolvePath(process.cwd(), ".vedit/media"),
            });
          }
          return runStubGenJob(engine(), "gen.voice", { prompt, kind, simulated: true });
        }
        return runStubGenJob(engine(), kind === "sfx" ? "gen.sfx" : "gen.music", { prompt, kind });
      }),
  );

  server.registerTool(
    "captions.transcribe",
    {
      description: "F2: přepis řeči z média → titulky (pocketsphinx/externí Whisper přes VEDIT_ASR_CMD).",
      inputSchema: {
        assetId: idSchema,
        language: z.string().default("en"),
        maxWords: z.number().int().min(1).max(20).default(8),
      },
    },
    async ({ assetId, language, maxWords }) =>
      wrapTool(() => transcribeToCaptions(engine(), assetId, { language, maxWords })),
  );

  server.registerTool(
    "captions.from_script",
    {
      description: "F2: titulky ze skriptu — s voiceoverem (přesný čas) nebo odhad časování bez syntézy.",
      inputSchema: {
        script: z.string(),
        start: z.number().nonnegative().default(0),
        gap: z.number().min(0).max(3).default(0.35),
        voice: z.string().optional(),
        withVoiceover: z.boolean().default(false),
      },
    },
    async ({ script, start, gap, voice, withVoiceover }) =>
      wrapTool(async () => {
        if (withVoiceover) {
          return generateVoiceover(engine(), { script, voice: voice ?? "cs", start, gap }, {
            mediaDir: resolvePath(process.cwd(), ".vedit/media"),
          });
        }
        // odhad časování podle délky textu (~18 znaků/s) bez syntézy
        const { splitScript } = await import("../ai/speech.js");
        const phrases = splitScript(script);
        let t = start;
        const segments = phrases.map((text) => {
          const dur = Math.max(0.8, text.length * 0.055);
          const seg = { text, start: t, end: t + dur };
          t += dur + gap;
          return seg;
        });
        return { captions: engine().addCaptionsFromSegments(segments), estimated: true };
      }),
  );

  server.registerTool(
    "gen.job_status",
    {
      description: "Stav úlohy (render/generování).",
      inputSchema: { jobId: idSchema },
    },
    async ({ jobId }) => wrapTool(() => ({ job: engine().getJob(jobId) })),
  );

  server.registerTool(
    "export.render",
    {
      description: "Reálný export videa přes FFmpeg (F1) — asynchronní render job, stav přes gen.job_status.",
      inputSchema: {
        format: z.enum(["mp4", "mov"]).default("mp4"),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
        crf: z.number().int().min(0).max(51).optional(),
      },
    },
    async (args) =>
      wrapTool(() => {
        const seq = engine().activeSequence();
        return runRealRenderJob(
          engine(),
          {
            ...args,
            width: args.width ?? seq.width,
            height: args.height ?? seq.height,
            duration: sequenceDuration(seq),
          },
          { renderDir: resolvePath(process.cwd(), ".vedit/renders") },
        );
      }),
  );

  server.registerTool(
    "export.download",
    {
      description: "Výsledek exportu — cesta k hotovému souboru + metadata jobu.",
      inputSchema: { jobId: idSchema },
    },
    async ({ jobId }) =>
      wrapTool(() => {
        const job = engine().getJob(jobId);
        return {
          job,
          outPath: typeof job.output?.outPath === "string" ? job.output.outPath : undefined,
          note: "soubor je na disku tohoto stroje; MCP klient si ho může přečíst",
        };
      }),
  );

  return server;
}
