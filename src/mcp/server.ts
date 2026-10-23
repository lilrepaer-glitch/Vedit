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
import { detectBeats, detectScenes, detectSilences, trackMotion, windowEnergy } from "../ai/analysis.js";
import { autoReframe, beatSync, buildHighlight, removeSilences, trackMotionTo } from "../ai/edit.js";
import { runGenJob, runStubGenJob, runRealRenderJob, runProxyJob } from "../server/app.js";
import { CAMERA_MOVES, providerAvailability } from "../ai/gen.js";
import {
  addReviewComment,
  addTimelineMarker,
  diffProjects,
  exportYouTubeChapters,
  listAuditLog,
  listSnapshots,
  mergeProjectChanges,
  resolveReviewComment,
  restoreSnapshot,
  saveSnapshot,
} from "../ext/collab.js";
import {
  applyTemplate,
  installPack,
  installPackFromFile,
  listMarketplacePacks,
  runPlugin,
} from "../ext/marketplace.js";
import { getQueueStatus, listExportPresets, runBatchExport, WatchFolderManager } from "../ext/delivery.js";
import { probeHardwareEncoders } from "../render/hwaccel.js";
import {
  COLOR_GRADE_PRESETS,
  applyChromaKey,
  applyColorGrade,
  applyFadeTransition,
  setClipSpeed,
} from "../pro/fx.js";
import { duckMusicUnderVoice, enhanceAudio } from "../pro/audio.js";
import { addGraphicOverlay } from "../pro/graphics.js";
import { captureDesktopClip, generateProjectThumbnail } from "../pro/capture.js";
import {
  BUILTIN_LUTS,
  applyCubeLut,
  applyLayoutPreset,
  freezeFrameClip,
  reverseClip,
  stabilizeClip,
  type BuiltInLutId,
  type LayoutPresetId,
} from "../pro/cinema.js";
import { exportEdl, exportFcpXml } from "../pro/interchange.js";
import { applyMulticamCuts, syncMulticamClips } from "../pro/multicam.js";
import { analyzeFrameScopes } from "../pro/scopes.js";
import {
  applyParametricEq,
  applyToneCurve,
  importSubtitlesToSequence,
  serializeSubtitles,
} from "../pro/studio-grade.js";
import { VEDIT_VERSION, checkForUpdates } from "../pro/updater.js";
import { runStudioCopilot } from "../ai/orchestrator.js";
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

  // ---- F3: analýza (ticha, scény, beaty, pohyb) ----
  server.registerTool(
    "analysis.silences",
    {
      description: "F3: detekce tich v médiu (pro auto-cut).",
      inputSchema: {
        assetId: idSchema,
        noiseDb: z.number().min(-80).max(0).optional(),
        minSilence: z.number().min(0.05).max(10).optional(),
      },
    },
    async ({ assetId, noiseDb, minSilence }) =>
      wrapTool(async () => ({
        regions: await detectSilences(engine().findAsset(assetId).path, { noiseDb, minDuration: minSilence }),
      })),
  );

  server.registerTool(
    "analysis.scenes",
    {
      description: "F3: detekce střihů scén v médiu.",
      inputSchema: { assetId: idSchema, threshold: z.number().min(0.05).max(0.95).optional() },
    },
    async ({ assetId, threshold }) =>
      wrapTool(async () => ({ scenes: await detectScenes(engine().findAsset(assetId).path, { threshold }) })),
  );

  server.registerTool(
    "analysis.beats",
    {
      description: "F3: detekce beatů v hudbě (pro beat-sync střih).",
      inputSchema: {
        assetId: idSchema,
        sensitivity: z.number().min(0.5).max(5).optional(),
        minBeatSec: z.number().min(0.1).max(2).optional(),
      },
    },
    async ({ assetId, sensitivity, minBeatSec }) =>
      wrapTool(async () => ({
        beats: await detectBeats(engine().findAsset(assetId).path, { sensitivity, minBeatSec }),
      })),
  );

  server.registerTool(
    "analysis.motion",
    {
      description: "F3: motion tracking — těžiště pohybu po snímcích (0..1).",
      inputSchema: { assetId: idSchema, fps: z.number().min(1).max(30).optional() },
    },
    async ({ assetId, fps }) =>
      wrapTool(async () => ({ track: await trackMotion(engine().findAsset(assetId).path, { fps }) })),
  );

  // ---- F3: AI střihové operace ----
  server.registerTool(
    "edit.remove_silences",
    {
      description: "F3: vyhoď ticha — detekuje ticha na stopě a zavře mezery (ripple collapse).",
      inputSchema: {
        trackId: idSchema.optional(),
        clipId: idSchema.optional(),
        noiseDb: z.number().min(-80).max(0).optional(),
        minSilence: z.number().min(0.05).max(10).optional(),
        padding: z.number().min(0).max(1).optional(),
      },
    },
    async (args) => wrapTool(() => removeSilences(engine(), args)),
  );

  server.registerTool(
    "edit.highlight",
    {
      description: "F3: sestaví highlight reel (pohyb + audio energie + scény) do nové stopy.",
      inputSchema: {
        trackId: idSchema.optional(),
        assetId: idSchema.optional(),
        clipId: idSchema.optional(),
        targetDuration: z.number().min(2).max(120).default(15),
      },
    },
    async (args) => wrapTool(() => buildHighlight(engine(), args)),
  );

  server.registerTool(
    "edit.beat_sync",
    {
      description: "F3: rozdělí klip na střihy přesně na beaty hudby.",
      inputSchema: {
        clipId: idSchema,
        musicAssetId: idSchema,
        sensitivity: z.number().min(0.5).max(5).optional(),
        minBeatSec: z.number().min(0.1).max(2).optional(),
      },
    },
    async ({ clipId, musicAssetId, sensitivity, minBeatSec }) =>
      wrapTool(() => beatSync(engine(), { clipId, musicAssetId, sensitivity, minBeatSec })),
  );

  server.registerTool(
    "edit.auto_reframe",
    {
      description: "F3: vycentruje pohyb v klipu (pan keyframy) pro výřez na jiný poměr stran (9:16…).",
      inputSchema: { clipId: idSchema, strength: z.number().min(0).max(2).optional() },
    },
    async ({ clipId, strength }) => wrapTool(() => autoReframe(engine(), { clipId, strength })),
  );

  server.registerTool(
    "edit.track_motion",
    {
      description: "F3: motion tracking — grafika/text sleduje pohyb ve zdroji (keyframy x/y).",
      inputSchema: {
        targetClipId: idSchema,
        sourceAssetId: idSchema.optional(),
        sourceClipId: idSchema.optional(),
        strength: z.number().min(0).max(2).optional(),
      },
    },
    async (args) => wrapTool(() => trackMotionTo(engine(), args)),
  );

  // ---- generování (F4 Vedit Gen — cloud + local + offline synth) + export ----
  const genDataDir = () => resolvePath(process.cwd(), ".vedit");
  const awaitJobIfNeeded = async (jobId: string, wait?: boolean) => {
    if (!wait) return { jobId };
    for (let i = 0; i < 600; i++) {
      const job = engine().getJob(jobId);
      if (job.status === "done") {
        return { jobId, job, assetId: job.output?.assetId, clipId: job.output?.clipId, trackId: job.output?.trackId };
      }
      if (job.status === "failed") {
        throw new Error(job.error ?? "generation job failed");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { jobId, job: engine().getJob(jobId) };
  };

  server.registerTool(
    "gen.providers",
    {
      description: "F4: seznam poskytovatelů Vedit Gen (fal.ai, Replicate, Veo 3.1, Kling 3.0, Wan Local, Hunyuan…), stav klíčů a pohyby kamery.",
    },
    async () => ok({ providers: providerAvailability(), cameraMoves: CAMERA_MOVES }),
  );

  server.registerTool(
    "gen.video",
    {
      description: "F4 Vedit Gen: vygeneruje video z promptu (cloud / lokální GPU / offline FFmpeg) a volitelně ho vloží na timeline s návazností záběrů.",
      inputSchema: {
        prompt: z.string(),
        duration: z.number().positive().default(5),
        model: z.string().optional(),
        provider: z.string().optional(),
        cameraMove: z.string().optional(),
        continuityFromClipId: z.string().optional(),
        continuityFromAssetId: z.string().optional(),
        imageAssetId: z.string().optional(),
        insertToTimeline: z.boolean().optional(),
        start: z.number().nonnegative().optional(),
        real: z.boolean().optional(),
        wait: z.boolean().optional(),
      },
    },
    async (args) =>
      wrapTool(async () => {
        if (args.real || (args.provider && args.provider !== "stub")) {
          const { jobId } = runGenJob(engine(), "video", { ...args }, { dataDir: genDataDir() });
          return awaitJobIfNeeded(jobId, args.wait);
        }
        return runStubGenJob(engine(), "gen.video", { ...args });
      }),
  );

  server.registerTool(
    "gen.image",
    {
      description: "F4 Vedit Gen: vygeneruje obrázek/keyframe z promptu a volitelně ho vloží na timeline.",
      inputSchema: {
        prompt: z.string(),
        model: z.string().optional(),
        provider: z.string().optional(),
        duration: z.number().positive().optional(),
        insertToTimeline: z.boolean().optional(),
        start: z.number().nonnegative().optional(),
        real: z.boolean().optional(),
        wait: z.boolean().optional(),
      },
    },
    async (args) =>
      wrapTool(async () => {
        if (args.real || (args.provider && args.provider !== "stub")) {
          const { jobId } = runGenJob(engine(), "image", { ...args }, { dataDir: genDataDir() });
          return awaitJobIfNeeded(jobId, args.wait);
        }
        return runStubGenJob(engine(), "gen.image", { ...args });
      }),
  );

  server.registerTool(
    "gen.music",
    {
      description: "F4 Vedit Gen: vygeneruje hudební podkres z promptu.",
      inputSchema: {
        prompt: z.string(),
        duration: z.number().positive().default(10),
        provider: z.string().optional(),
        model: z.string().optional(),
        insertToTimeline: z.boolean().optional(),
        start: z.number().nonnegative().optional(),
        real: z.boolean().optional(),
        wait: z.boolean().optional(),
      },
    },
    async (args) =>
      wrapTool(async () => {
        if (args.real || (args.provider && args.provider !== "stub")) {
          const { jobId } = runGenJob(engine(), "music", { ...args }, { dataDir: genDataDir() });
          return awaitJobIfNeeded(jobId, args.wait);
        }
        return runStubGenJob(engine(), "gen.music", { ...args });
      }),
  );

  server.registerTool(
    "gen.sfx",
    {
      description: "F4 Vedit Gen: vygeneruje zvukový efekt (SFX) z promptu.",
      inputSchema: {
        prompt: z.string(),
        duration: z.number().positive().default(3),
        provider: z.string().optional(),
        model: z.string().optional(),
        insertToTimeline: z.boolean().optional(),
        start: z.number().nonnegative().optional(),
        real: z.boolean().optional(),
        wait: z.boolean().optional(),
      },
    },
    async (args) =>
      wrapTool(async () => {
        if (args.real || (args.provider && args.provider !== "stub")) {
          const { jobId } = runGenJob(engine(), "sfx", { ...args }, { dataDir: genDataDir() });
          return awaitJobIfNeeded(jobId, args.wait);
        }
        return runStubGenJob(engine(), "gen.sfx", { ...args });
      }),
  );

  server.registerTool(
    "gen.voice",
    {
      description: "F4 Vedit Gen: vygeneruje voiceover ze skriptu (TTS nebo cloud model) a vloží klip + titulky.",
      inputSchema: {
        prompt: z.string(),
        voice: z.string().default("en"),
        provider: z.string().optional(),
        model: z.string().optional(),
        start: z.number().nonnegative().default(0),
        gap: z.number().min(0).max(3).optional(),
        real: z.boolean().optional(),
        wait: z.boolean().optional(),
      },
    },
    async ({ prompt, voice, provider, model, start, gap, real, wait }) =>
      wrapTool(async () => {
        if (provider && provider !== "stub") {
          const { jobId } = runGenJob(engine(), "voice", { prompt, provider, model, start }, { dataDir: genDataDir() });
          return awaitJobIfNeeded(jobId, wait);
        }
        const caps = await speechCapabilities();
        if (caps.tts.available) {
          return generateVoiceover(engine(), { script: prompt, voice, start, gap }, {
            mediaDir: resolvePath(process.cwd(), ".vedit/media"),
          });
        }
        if (real) {
          const { jobId } = runGenJob(engine(), "voice", { prompt, start, real: true }, { dataDir: genDataDir() });
          return awaitJobIfNeeded(jobId, wait);
        }
        return runStubGenJob(engine(), "gen.voice", { prompt, kind: "voice", simulated: true });
      }),
  );

  server.registerTool(
    "gen.audio",
    {
      description:
        "F2/F4: kind=voice dělá REÁLNÝ voiceover ze skriptu (TTS + klip + titulky); music/sfx podporují Vedit Gen providery.",
      inputSchema: {
        prompt: z.string().describe("Text skriptu (voice) nebo prompt (music/sfx)"),
        kind: z.enum(["music", "sfx", "voice"]).default("music"),
        voice: z.string().default("cs"),
        provider: z.string().optional(),
        model: z.string().optional(),
        duration: z.number().positive().optional(),
        start: z.number().nonnegative().default(0),
        gap: z.number().min(0).max(3).optional(),
        real: z.boolean().optional(),
        wait: z.boolean().optional(),
      },
    },
    async ({ prompt, kind, voice, provider, model, duration, start, gap, real, wait }) =>
      wrapTool(async () => {
        if (real || (provider && provider !== "stub")) {
          const { jobId } = runGenJob(
            engine(),
            kind,
            { prompt, kind, provider, model, duration, start },
            { dataDir: genDataDir() },
          );
          return awaitJobIfNeeded(jobId, wait);
        }
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
      description: "Real FFmpeg video export (F1/F5/F6) — H.264 / H.265 / ProRes / WebM, GPU hardware acceleration, and loudness normalization.",
      inputSchema: {
        preset: z.string().optional(),
        codec: z.enum(["h264", "h265", "prores", "vp9", "gif"]).optional(),
        hwAccel: z.enum(["auto", "cpu", "nvenc", "amf", "qsv", "videotoolbox", "vaapi"]).optional(),
        loudnessLufs: z.number().min(-36).max(-5).optional(),
        format: z.enum(["mp4", "mov", "webm", "gif"]).default("mp4"),
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
            width: args.preset ? args.width : (args.width ?? seq.width),
            height: args.preset ? args.height : (args.height ?? seq.height),
            duration: sequenceDuration(seq),
          },
          { renderDir: resolvePath(process.cwd(), ".vedit/renders") },
        );
      }),
  );

  server.registerTool(
    "export.presets",
    {
      description: "F5: dostupné exportní presety (YouTube 1080p/4K, TikTok/Reels, Instagram, LinkedIn, ProRes, WebM).",
    },
    async () => ok({ presets: listExportPresets() }),
  );

  server.registerTool(
    "export.batch",
    {
      description: "F5: hromadný multi-formátový export sekvence pro více platforem najednou.",
      inputSchema: {
        presets: z.array(z.string()).min(1),
      },
    },
    async ({ presets }) =>
      wrapTool(() =>
        runBatchExport(engine(), presets, {
          renderDir: resolvePath(process.cwd(), ".vedit/renders"),
        }),
      ),
  );

  server.registerTool(
    "export.queue_status",
    {
      description: "F5: přehled fronty renderů a generování (PLAN §4.1).",
    },
    async () => ok(getQueueStatus(engine())),
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

  // ---- F5: Collaboration, Checkpoints, Diff, Marketplace & Watch Folders ----
  const mcpWatchManager = new WatchFolderManager();

  server.registerTool(
    "project.snapshot",
    {
      description: "F5: uloží pojmenovaný checkpoint verze projektu.",
      inputSchema: {
        label: z.string().default(""),
        author: z.string().default("mcp-agent"),
      },
    },
    async ({ label, author }) => wrapTool(() => ({ snapshot: saveSnapshot(engine(), label, author) })),
  );

  server.registerTool(
    "project.snapshots",
    { description: "F5: vypíše uložené checkpointy verze projektu." },
    async () => ok({ snapshots: listSnapshots(engine()) }),
  );

  server.registerTool(
    "project.restore_snapshot",
    {
      description: "F5: vrátí projekt do zvoleného checkpointu (jako undo krok).",
      inputSchema: { snapshotId: idSchema },
    },
    async ({ snapshotId }) => wrapTool(() => ({ restored: restoreSnapshot(engine(), snapshotId) })),
  );

  server.registerTool(
    "project.diff",
    {
      description: "F5: strukturální porovnání aktuálního projektu s uloženým checkpointem nebo jiným .vedit souborem (PLAN §4.1).",
      inputSchema: {
        snapshotId: z.string().optional(),
        otherProjectPath: z.string().optional(),
      },
    },
    async ({ snapshotId, otherProjectPath }) =>
      wrapTool(async () => {
        if (snapshotId) {
          const snap = (engine().project.snapshots ?? []).find((s) => s.id === snapshotId);
          if (!snap) throw new Error(`snapshot not found: ${snapshotId}`);
          return { diff: diffProjects(snap.snapshot, engine().project) };
        }
        if (otherProjectPath) {
          const { readFile } = await import("node:fs/promises");
          const other = JSON.parse(await readFile(resolvePath(otherProjectPath), "utf8"));
          return { diff: diffProjects(other, engine().project) };
        }
        const snaps = engine().project.snapshots ?? [];
        if (snaps.length > 0) {
          return { diff: diffProjects(snaps[snaps.length - 1]!.snapshot, engine().project) };
        }
        return { diff: diffProjects(engine().project, engine().project) };
      }),
  );

  server.registerTool(
    "collab.merge",
    {
      description: "F5: sloučí změny (stopy, klipy, titulky, komentáře) z .vedit souboru spolupracovníka.",
      inputSchema: {
        projectPath: z.string(),
        author: z.string().default("collaborator"),
      },
    },
    async ({ projectPath, author }) =>
      wrapTool(async () => {
        const { readFile } = await import("node:fs/promises");
        const other = JSON.parse(await readFile(resolvePath(projectPath), "utf8"));
        return { merged: mergeProjectChanges(engine(), other, author) };
      }),
  );

  server.registerTool(
    "collab.add_comment",
    {
      description: "F5: přidá časově ukotvený revizní komentář na timeline.",
      inputSchema: {
        text: z.string().min(1),
        timecode: z.number().nonnegative().default(0),
        author: z.string().default("Reviewer"),
      },
    },
    async (args) => wrapTool(() => ({ comment: addReviewComment(engine(), args) })),
  );

  server.registerTool(
    "collab.list_comments",
    { description: "F5: vypíše revizní komentáře a markery projektu." },
    async () => ok({ comments: engine().project.comments ?? [], markers: engine().project.markers ?? [] }),
  );

  server.registerTool(
    "collab.resolve_comment",
    {
      description: "F5: označí revizní komentář jako vyřešený.",
      inputSchema: { commentId: idSchema, resolved: z.boolean().default(true) },
    },
    async ({ commentId, resolved }) =>
      wrapTool(() => ({ comment: resolveReviewComment(engine(), commentId, resolved) })),
  );

  server.registerTool(
    "collab.chapters",
    {
      description: "F5: vyexportuje kapitolové značky projektu pro YouTube popis.",
      inputSchema: {
        addMarkerTime: z.number().nonnegative().optional(),
        addMarkerLabel: z.string().optional(),
      },
    },
    async ({ addMarkerTime, addMarkerLabel }) =>
      wrapTool(() => {
        if (addMarkerTime != null && addMarkerLabel) {
          addTimelineMarker(engine(), { time: addMarkerTime, label: addMarkerLabel });
        }
        return exportYouTubeChapters(engine().project);
      }),
  );

  server.registerTool(
    "marketplace.list",
    { description: "F5: katalog šablon motion grafiky a pluginů ve Vedit Marketplace." },
    async () => ok({ packs: listMarketplacePacks(engine()) }),
  );

  server.registerTool(
    "marketplace.install",
    {
      description: "F5: nainstaluje šablonu/plugin z Marketplace ID nebo lokálního .veditpack.json souboru.",
      inputSchema: {
        packId: z.string().optional(),
        filePath: z.string().optional(),
      },
    },
    async ({ packId, filePath }) =>
      wrapTool(async () => {
        if (filePath) return { pack: await installPackFromFile(engine(), resolvePath(filePath)) };
        if (!packId) throw new Error("provide packId or filePath");
        return { pack: installPack(engine(), packId) };
      }),
  );

  server.registerTool(
    "marketplace.apply_template",
    {
      description: "F5: aplikuje parametrickou šablonu z Marketplace na aktivní sekvenci.",
      inputSchema: {
        templateId: z.string(),
        params: z.record(z.string()).optional(),
      },
    },
    async ({ templateId, params }) => wrapTool(() => applyTemplate(engine(), templateId, params ?? {})),
  );

  server.registerTool(
    "marketplace.run_plugin",
    {
      description: "F5: spustí plugin z Marketplace nad aktivním projektem.",
      inputSchema: {
        pluginId: z.string(),
        params: z.record(z.string()).optional(),
      },
    },
    async ({ pluginId, params }) => wrapTool(() => runPlugin(engine(), pluginId, params ?? {})),
  );

  server.registerTool(
    "watch.start",
    {
      description: "F5: spustí automatický watch-folder render při přidání videa do složky.",
      inputSchema: {
        inboxDir: z.string(),
        outputDir: z.string(),
        preset: z.string().default("youtube-1080p"),
        templateId: z.string().optional(),
      },
    },
    async (args) => wrapTool(() => mcpWatchManager.start(args)),
  );

  server.registerTool(
    "watch.list",
    { description: "F5: seznam běžících watch-folderů a zpracovaných souborů." },
    async () => ok({ watchers: mcpWatchManager.list() }),
  );

  server.registerTool(
    "watch.stop",
    {
      description: "F5: zastaví watch-folder.",
      inputSchema: { watchId: idSchema },
    },
    async ({ watchId }) => wrapTool(() => ({ stopped: mcpWatchManager.stop(watchId) })),
  );

  server.registerTool(
    "audit.list",
    {
      description: "F5: vypíše auditní záznam AI a pluginových operací (guardrails).",
      inputSchema: { limit: z.number().int().positive().max(200).default(50) },
    },
    async ({ limit }) => ok({ entries: listAuditLog(engine().project, limit) }),
  );

  // ---- F6: Hardware GPU Encoders, Pro VFX, Color Grading, Chroma Key, Speed Control & Pro Audio DSP ----
  server.registerTool(
    "export.encoders",
    {
      description: "F6: Probes hardware GPU encoders (NVENC, AMF, QSV, VideoToolbox, VAAPI) and recommends best backend.",
    },
    async () => wrapTool(async () => probeHardwareEncoders()),
  );

  server.registerTool(
    "color.grade",
    {
      description: "F6: Applies color grading preset or custom brightness/contrast/saturation/gamma to a clip.",
      inputSchema: {
        clipId: idSchema,
        preset: z.string().optional(),
        brightness: z.number().min(-1).max(1).optional(),
        contrast: z.number().min(0).max(4).optional(),
        saturation: z.number().min(0).max(4).optional(),
        gamma: z.number().min(0.1).max(4).optional(),
      },
    },
    async ({ clipId, ...opts }) =>
      wrapTool(() => ({
        effect: applyColorGrade(engine(), clipId, opts),
        presets: COLOR_GRADE_PRESETS.map((p) => p.id),
      })),
  );

  server.registerTool(
    "effect.chroma_key",
    {
      description: "F6: Applies green/blue screen chroma keying with edge spill suppression on a clip.",
      inputSchema: {
        clipId: idSchema,
        color: z.string().optional().describe("Hex key color like '#00ff00' or 'blue'"),
        similarity: z.number().min(0.01).max(1).optional(),
        blend: z.number().min(0.0).max(1).optional(),
        despill: z.boolean().optional(),
      },
    },
    async ({ clipId, ...opts }) => wrapTool(() => ({ effect: applyChromaKey(engine(), clipId, opts) })),
  );

  server.registerTool(
    "clip.set_speed",
    {
      description: "F6: Sets clip playback speed (0.1x .. 8.0x) and retimes timeline duration & pitch-preserved audio.",
      inputSchema: {
        clipId: idSchema,
        speed: z.number().min(0.1).max(8),
      },
    },
    async ({ clipId, speed }) => wrapTool(() => ({ clip: setClipSpeed(engine(), clipId, speed) })),
  );

  server.registerTool(
    "effect.fade",
    {
      description: "F6: Adds smooth fade-in / fade-out transitions on a clip.",
      inputSchema: {
        clipId: idSchema,
        fadeIn: z.number().min(0).max(30).optional(),
        fadeOut: z.number().min(0).max(30).optional(),
      },
    },
    async ({ clipId, fadeIn, fadeOut }) =>
      wrapTool(() => ({ effect: applyFadeTransition(engine(), clipId, { fadeIn, fadeOut }) })),
  );

  server.registerTool(
    "audio.enhance",
    {
      description: "F6: Pro voice enhancement — highpass rumble filter, FFT denoise, vocal EQ, compressor & EBU R128 loudness.",
      inputSchema: {
        clipId: idSchema.optional(),
        assetId: idSchema.optional(),
        noiseFloor: z.number().min(-80).max(-20).optional(),
        voicePresence: z.boolean().optional(),
        loudnessLufs: z.number().min(-36).max(-8).optional(),
      },
    },
    async (args) => wrapTool(() => enhanceAudio(engine(), args)),
  );

  server.registerTool(
    "audio.duck",
    {
      description: "F6: Automatically ducks background music volume whenever speech is active on the voice clip.",
      inputSchema: {
        musicClipId: idSchema,
        voiceClipId: idSchema.optional(),
        voiceAssetId: idSchema.optional(),
        reductionDb: z.number().min(-40).max(0).optional(),
      },
    },
    async (args) => wrapTool(() => duckMusicUnderVoice(engine(), args)),
  );

  // ---- F7: Studio Capture, Track Mixer Console, Vector/SVG Graphics & Smart Thumbnail Export ----
  server.registerTool(
    "track.update",
    {
      description: "F7: Updates track mixer & state controls (muted, solo, locked, volumeDb, pan, name).",
      inputSchema: {
        trackId: idSchema,
        name: z.string().optional(),
        muted: z.boolean().optional(),
        solo: z.boolean().optional(),
        locked: z.boolean().optional(),
        volumeDb: z.number().min(-60).max(18).optional(),
        pan: z.number().min(-1).max(1).optional(),
      },
    },
    async ({ trackId, ...patch }) => wrapTool(() => ({ track: engine().updateTrack(trackId, patch) })),
  );

  server.registerTool(
    "graphics.add_overlay",
    {
      description: "F7: Generates a transparent 32-bit RGBA vector shape, callout arrow, lower-third card, or custom SVG overlay onto a Graphics track.",
      inputSchema: {
        kind: z.enum([
          "lower-third-card",
          "callout-arrow",
          "spotlight-ring",
          "pill-badge",
          "progress-ribbon",
          "custom-svg",
        ]),
        width: z.number().int().min(32).max(3840).optional(),
        height: z.number().int().min(32).max(2160).optional(),
        primaryColor: z.string().optional(),
        accentColor: z.string().optional(),
        svgMarkup: z.string().optional(),
        start: z.number().nonnegative().optional(),
        duration: z.number().positive().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        animationPreset: z.string().optional(),
        label: z.string().optional(),
      },
    },
    async (args) => wrapTool(() => addGraphicOverlay(engine(), args)),
  );

  server.registerTool(
    "capture.screen",
    {
      description: "F7: Captures desktop screen video via FFmpeg OS grabber and inserts clip onto timeline.",
      inputSchema: {
        seconds: z.number().min(0.5).max(120).optional(),
        fps: z.number().min(5).max(60).optional(),
        start: z.number().nonnegative().optional(),
        label: z.string().optional(),
      },
    },
    async (args) => wrapTool(() => captureDesktopClip(engine(), args)),
  );

  server.registerTool(
    "export.thumbnail",
    {
      description: "F7: Scores timeline frames by visual detail/sharpness and exports a high-resolution YouTube/social thumbnail JPEG.",
      inputSchema: {
        at: z.number().nonnegative().optional(),
        width: z.number().int().min(320).max(3840).optional(),
        title: z.string().optional(),
      },
    },
    async (args) => wrapTool(() => generateProjectThumbnail(engine(), args)),
  );

  // ---- F8: AI Orchestrator Copilot, Cinema 3D .cube LUTs, Stabilization, PiP/Split Layouts & EDL/FCPXML ----
  server.registerTool(
    "ai.orchestrate",
    {
      description: "F8: Runs multi-step AI Studio Copilot workflow from a natural-language instruction with automatic checkpoint protection.",
      inputSchema: {
        prompt: z.string().min(2),
      },
    },
    async ({ prompt }) => wrapTool(() => runStudioCopilot(engine(), prompt)),
  );

  server.registerTool(
    "cinema.list_luts",
    { description: "F8: Lists built-in cinema 3D .cube film stock LUTs." },
    async () => ok({ luts: BUILTIN_LUTS }),
  );

  server.registerTool(
    "system.check_update",
    { description: "Checks GitHub Releases for a newer Vedit Windows installer update." },
    async () => wrapTool(() => checkForUpdates(VEDIT_VERSION)),
  );

  server.registerTool(
    "cinema.apply_lut",
    {
      description: "F8: Applies a built-in cinema film stock 3D .cube LUT or custom .cube file to a clip.",
      inputSchema: {
        clipId: idSchema,
        lutId: z
          .enum(["kodak-2383", "teal-orange-blockbuster", "fuji-eterna-soft", "bleach-bypass", "cyberpunk-neon"])
          .optional(),
        filePath: z.string().optional(),
        intensity: z.number().min(0).max(1).optional(),
      },
    },
    async ({ clipId, lutId, filePath, intensity }) =>
      wrapTool(() => applyCubeLut(engine(), clipId, { lutId: lutId as BuiltInLutId | undefined, filePath, intensity })),
  );

  server.registerTool(
    "cinema.stabilize",
    {
      description: "F8: Stabilizes shaky camera motion on a video clip using 2-pass FFmpeg VidStab optical analysis.",
      inputSchema: {
        clipId: idSchema,
        shakiness: z.number().min(1).max(10).optional(),
        smoothing: z.number().min(1).max(60).optional(),
      },
    },
    async ({ clipId, shakiness, smoothing }) =>
      wrapTool(() => stabilizeClip(engine(), clipId, { shakiness, smoothing })),
  );

  server.registerTool(
    "cinema.layout",
    {
      description: "F8: Positions a clip using Picture-in-Picture (PiP) or 50/50 Split-Screen layout geometry.",
      inputSchema: {
        clipId: idSchema,
        layout: z.enum([
          "pip-bottom-right",
          "pip-bottom-left",
          "pip-top-right",
          "pip-top-left",
          "split-left",
          "split-right",
          "full-reset",
        ]),
      },
    },
    async ({ clipId, layout }) => wrapTool(() => ({ clip: applyLayoutPreset(engine(), clipId, layout as LayoutPresetId) })),
  );

  server.registerTool(
    "export.edl",
    { description: "F8: Exports active sequence as CMX 3600 .edl for DaVinci Resolve / Premiere Pro / Avid." },
    async () => ok({ edl: exportEdl(engine().project) }),
  );

  server.registerTool(
    "export.fcpxml",
    { description: "F8: Exports active sequence as Final Cut Pro / DaVinci Resolve FCPXML v1.10 (.fcpxml)." },
    async () => ok({ fcpxml: exportFcpXml(engine().project) }),
  );

  server.registerTool(
    "media.update",
    {
      description: "F8: Updates media asset tags, name, or relinks offline media path.",
      inputSchema: {
        assetId: idSchema,
        name: z.string().optional(),
        path: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ assetId, ...patch }) => wrapTool(() => ({ asset: engine().updateAsset(assetId, patch) })),
  );

  // ---- F9: Broadcast Video Scopes, Multicam Audio Sync & Switcher, Freeze Frame, Reverse & Keyframe Curves ----
  server.registerTool(
    "cinema.scopes",
    {
      description: "F9: Computes Broadcast RGB Parade Histograms, 48-column IRE Waveform, and clipping QC metrics at time `t`.",
      inputSchema: {
        time: z.number().nonnegative().optional(),
        assetPath: z.string().optional(),
      },
    },
    async (args) => wrapTool(() => analyzeFrameScopes(engine(), args)),
  );

  server.registerTool(
    "cinema.reverse",
    {
      description: "F9: Reverses video and audio playback on a clip cleanly via FFmpeg reverse + areverse.",
      inputSchema: {
        clipId: idSchema,
      },
    },
    async ({ clipId }) => wrapTool(() => reverseClip(engine(), clipId)),
  );

  server.registerTool(
    "cinema.freeze_frame",
    {
      description: "F9: Extracts a sharp still frame from a clip at time `at` and inserts a ripple freeze-frame hold clip.",
      inputSchema: {
        clipId: idSchema,
        at: z.number().nonnegative().optional(),
        holdDuration: z.number().min(0.2).max(30).optional(),
      },
    },
    async ({ clipId, at, holdDuration }) =>
      wrapTool(() => freezeFrameClip(engine(), clipId, { at, holdDuration })),
  );

  server.registerTool(
    "multicam.sync",
    {
      description: "F9: Acoustically cross-correlates 2+ multi-camera/mic assets to align them automatically on timeline.",
      inputSchema: {
        assetIds: z.array(idSchema).min(2).optional(),
        maxOffsetSec: z.number().min(1).max(60).optional(),
        sampleRate: z.number().min(1000).max(16000).optional(),
      },
    },
    async (args) => wrapTool(() => syncMulticamClips(engine(), args)),
  );

  server.registerTool(
    "multicam.cuts",
    {
      description: "F9: Generates a switched Multicam Program track across camera angles via explicit cut points or interval.",
      inputSchema: {
        cuts: z
          .array(
            z.object({
              time: z.number().nonnegative(),
              angleIndex: z.number().int().nonnegative().optional(),
              trackId: idSchema.optional(),
            }),
          )
          .optional(),
        autoIntervalSec: z.number().min(0.4).max(120).optional(),
      },
    },
    async (args) => wrapTool(() => applyMulticamCuts(engine(), args)),
  );

  server.registerTool(
    "keyframes.set_curve",
    {
      description: "F9: Sets eased keyframes (`linear`, `ease-in`, `ease-out`, `ease-in-out`, `hold`) on a clip property.",
      inputSchema: {
        clipId: idSchema,
        keyframes: z.array(
          z.object({
            time: z.number().nonnegative(),
            property: z.enum(["x", "y", "opacity"]),
            value: z.number(),
            easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out", "hold"]).optional(),
          }),
        ),
      },
    },
    async ({ clipId, keyframes }) => wrapTool(() => ({ clip: engine().updateClip(clipId, { keyframes }) })),
  );

  // ---- F11: Studio Grade MCP Tools (Tone Curves, Chroma Key, 3-Band EQ, SRT/VTT Subtitles) ----
  server.registerTool(
    "color.curves",
    {
      description: "F11: Applies a monotone cubic tone curve LUT, preset, or shadows/midtones/highlights lift plus clarity to a clip.",
      inputSchema: {
        clipId: idSchema,
        preset: z.enum(["linear", "cinema-s-curve", "matte-fade", "high-contrast", "soft-rolloff"]).optional(),
        points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).optional(),
        shadows: z.number().min(-100).max(100).optional(),
        midtones: z.number().min(-100).max(100).optional(),
        highlights: z.number().min(-100).max(100).optional(),
        clarity: z.number().min(-100).max(100).optional(),
      },
    },
    async ({ clipId, ...opts }) => wrapTool(() => applyToneCurve(engine(), clipId, opts)),
  );

  server.registerTool(
    "color.chroma_key",
    {
      description: "F11: Applies green/blue/custom screen chroma key with spill suppression to a clip.",
      inputSchema: {
        clipId: idSchema,
        color: z.string().default("#00ff00"),
        similarity: z.number().min(0.01).max(1).default(0.32),
        blend: z.number().min(0).max(1).default(0.1),
        despill: z.boolean().default(true),
      },
    },
    async ({ clipId, color, similarity, blend, despill }) =>
      wrapTool(() => ({ clip: applyChromaKey(engine(), clipId, { color, similarity, blend, despill }) })),
  );

  server.registerTool(
    "audio.eq",
    {
      description: "F11: Applies 3-band parametric audio EQ (120Hz low, 1.2kHz mid, 4.8kHz high) and Voice Clarity dynamics to a clip.",
      inputSchema: {
        clipId: idSchema,
        preset: z.enum(["flat", "voice-podcast", "bass-boost", "crisp-vocal", "warm-cinema", "lo-fi-radio"]).optional(),
        lowDb: z.number().min(-18).max(18).optional(),
        midDb: z.number().min(-18).max(18).optional(),
        highDb: z.number().min(-18).max(18).optional(),
        voiceClarity: z.boolean().optional(),
      },
    },
    async ({ clipId, ...opts }) => wrapTool(() => applyParametricEq(engine(), clipId, opts)),
  );

  server.registerTool(
    "captions.import_subtitles",
    {
      description: "F11: Parses and imports SubRip (.srt) or WebVTT (.vtt) subtitles directly onto the active sequence.",
      inputSchema: {
        text: z.string().min(1),
        replaceExisting: z.boolean().default(false),
        offsetSec: z.number().default(0),
      },
    },
    async ({ text, replaceExisting, offsetSec }) =>
      wrapTool(() => importSubtitlesToSequence(engine(), text, { replaceExisting, offsetSec })),
  );

  server.registerTool(
    "captions.export_subtitles",
    {
      description: "F11: Serializes active sequence captions to standard SubRip (.srt) or WebVTT (.vtt).",
      inputSchema: {
        format: z.enum(["srt", "vtt"]).default("srt"),
      },
    },
    async ({ format }) =>
      wrapTool(() => ({
        format,
        count: engine().activeSequence().captions.length,
        text: serializeSubtitles(engine().activeSequence().captions, format),
      })),
  );

  // ---- F5: MCP Resources (PLAN.md §4.2) ----
  server.registerResource(
    "project-state",
    "vedit://project/state",
    {
      title: "Active Vedit Project State",
      description: "Full JSON project document including assets, sequences, comments, markers, and jobs.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(engine().project, null, 2) }],
    }),
  );

  server.registerResource(
    "project-timeline",
    "vedit://project/timeline",
    {
      title: "Active Sequence Timeline",
      description: "Tracks, clips, keyframes, and total sequence duration.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(engine().timeline(), null, 2) }],
    }),
  );

  server.registerResource(
    "project-captions",
    "vedit://project/captions",
    {
      title: "Sequence Captions (SRT)",
      description: "Current captions exported in SubRip (.srt) format.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/plain",
          text: captionsToSrt(engine().activeSequence().captions),
        },
      ],
    }),
  );

  server.registerResource(
    "project-jobs",
    "vedit://project/jobs",
    {
      title: "Render & AI Generation Queue",
      description: "Live queue summary of render and generation jobs.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(getQueueStatus(engine()), null, 2) }],
    }),
  );

  server.registerResource(
    "marketplace-catalog",
    "vedit://marketplace/catalog",
    {
      title: "Vedit Template & Plugin Marketplace",
      description: "Installed and built-in motion templates and workflow plugins.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(listMarketplacePacks(engine()), null, 2),
        },
      ],
    }),
  );

  // ---- F5: MCP Workflow Prompts (PLAN.md §4.2) ----
  server.registerPrompt(
    "highlight-reel",
    {
      title: "Build Highlight Reel",
      description: "Analyze footage energy/motion/scenes and assemble a punchy highlight cut.",
      argsSchema: {
        targetDuration: z.string().optional().describe("Target duration in seconds (default 20)"),
      },
    },
    ({ targetDuration }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Create a ${targetDuration ?? "20"}s highlight reel from the active Vedit project: save a checkpoint first with project.snapshot, run edit.highlight, apply plg-cinematic-lut via marketplace.run_plugin, and queue export.render with preset "youtube-1080p".`,
          },
        },
      ],
    }),
  );

  // ---- F14 (v1.0.0): Pro Shape Masks, Blend Modes & Non-Linear Speed Ramps ----
  server.registerTool(
    "vfx.apply_mask",
    {
      description: "F14: Apply parametric alpha shape mask (circle, rectangle, split-h, split-v, linear) with feather & inversion to a clip.",
      inputSchema: {
        clipId: idSchema,
        shape: z.enum(["none", "circle", "rectangle", "split-h", "split-v", "linear"]),
        scale: z.number().min(0.15).max(1).optional(),
        feather: z.number().min(0).max(100).optional(),
        radius: z.number().min(0).max(50).optional(),
        centerX: z.number().min(0).max(1).optional(),
        centerY: z.number().min(0).max(1).optional(),
        invert: z.boolean().optional(),
      },
    },
    async ({ clipId, shape, scale, feather, radius, centerX, centerY, invert }) =>
      wrapTool(async () => {
        const { applyClipMask } = await import("../pro/compositing.js");
        const fx = applyClipMask(engine(), clipId, { shape, scale, feather, radius, centerX, centerY, invert });
        return { effect: fx, active: Boolean(fx) };
      }),
  );

  server.registerTool(
    "vfx.apply_blend",
    {
      description: "F14: Apply compositing layer blend mode (normal, screen, multiply, overlay, lighten, darken, soft-light, color-dodge, add) to a clip.",
      inputSchema: {
        clipId: idSchema,
        mode: z.enum(["normal", "screen", "multiply", "overlay", "lighten", "darken", "soft-light", "color-dodge", "add"]),
        opacity: z.number().min(0).max(1).optional(),
      },
    },
    async ({ clipId, mode, opacity }) =>
      wrapTool(async () => {
        const { applyClipBlend } = await import("../pro/compositing.js");
        const fx = applyClipBlend(engine(), clipId, mode, opacity);
        return { effect: fx, mode: fx?.params?.mode ?? "normal" };
      }),
  );

  server.registerTool(
    "vfx.apply_speed_ramp",
    {
      description: "F14: Apply smooth duration-preserving non-linear speed ramp curve (constant, montage-in, hero-slowmo, bullet, jump-cut, smooth-out).",
      inputSchema: {
        clipId: idSchema,
        preset: z.enum(["constant", "montage-in", "hero-slowmo", "bullet", "jump-cut", "smooth-out"]),
        intensity: z.number().min(0.1).max(1).optional(),
      },
    },
    async ({ clipId, preset, intensity }) =>
      wrapTool(async () => {
        const { applySpeedRamp } = await import("../pro/compositing.js");
        const fx = applySpeedRamp(engine(), clipId, preset, intensity ?? 1);
        return { effect: fx, preset: fx?.params?.preset ?? "constant" };
      }),
  );

  server.registerPrompt(
    "shorts-from-longform",
    {
      title: "Vertical Shorts / Reels from Long Video",
      description: "Cut silences, reframe to 9:16 vertical, generate captions, and export for TikTok/Reels.",
      argsSchema: {
        hookTitle: z.string().optional().describe("Opening hook headline"),
      },
    },
    ({ hookTitle }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Turn the active long-form video into a vertical 9:16 Short: save a project.snapshot, run edit.remove_silences, apply marketplace.apply_template "tpl-tiktok-shorts" with title "${hookTitle ?? "Best Moment"}", run edit.auto_reframe on the lead clip, and export with preset "tiktok-reels".`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "promo-spot",
    {
      title: "Product Promo Spot with Motion Graphics",
      description: "Generate hero AI B-roll, apply promo motion graphics template, voiceover, and multi-format export.",
      argsSchema: {
        productName: z.string().optional(),
      },
    },
    ({ productName }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Produce a commercial promo spot for "${productName ?? "Vedit Desktop"}": generate two consecutive AI shots using gen.video with cameraMove "push-in" and shot continuity, apply marketplace.apply_template "tpl-promo-spot", add voiceover via gen.voice, and batch export for "youtube-1080p" and "linkedin-hd".`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "captions-translate-export",
    {
      title: "Transcribe, Translate Captions & Export",
      description: "Transcribe spoken audio into captions, translate them to target language, and render MP4 + SRT.",
      argsSchema: {
        targetLanguage: z.string().optional().describe("Target language code (e.g. cs, de, es, en)"),
      },
    },
    ({ targetLanguage }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Transcribe the main speech track using captions.transcribe, translate all caption segments cleanly into "${targetLanguage ?? "en"}" via captions.translate (replace=true), export standalone SRT via captions.export, and render burned-in video with export.render.`,
          },
        },
      ],
    }),
  );

  return server;
}
