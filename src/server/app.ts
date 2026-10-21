// REST API (PLAN.md §5) — REST na /api/v1 + WebSocket události.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { access, mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { VeditEngine } from "../core/engine.js";
import { captionsToSrt, listAnimationPresets } from "../core/presets.js";
import { extractFrame, extractPeaks, generateProxy, probeMedia } from "../core/media.js";
import { renderSequence, resolveExportPreset, type VideoCodecId } from "../render/export.js";
import {
  addReviewComment,
  addTimelineMarker,
  deleteReviewComment,
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
  registerPack,
  runPlugin,
  uninstallPack,
} from "../ext/marketplace.js";
import { getQueueStatus, listExportPresets, runBatchExport, WatchFolderManager } from "../ext/delivery.js";
import { speechCapabilities } from "../ai/speech.js";
import { generateVoiceover, transcribeToCaptions } from "../ai/voiceover.js";
import { detectBeats, detectScenes, detectSilences, trackMotion, windowEnergy } from "../ai/analysis.js";
import { autoReframe, beatSync, buildHighlight, removeSilences, trackMotionTo } from "../ai/edit.js";
import {
  CAMERA_MOVES,
  buildDirectedPrompt,
  callProvider,
  genJobType,
  insertGeneratedAsset,
  isProviderConfigured,
  prepareContinuityContext,
  providerAvailability,
  resolveProvider,
  type GenInput,
  type GenKind,
} from "../ai/gen.js";
import type { AssetKind, JobType, TrackKind } from "../core/types.js";

export interface ServerOptions {
  /** Bearer token; when set, all /api routes require Authorization: Bearer <token>. */
  token?: string;
  /** Adresář pro render/proxy výstupy (výchozí: .vedit) */
  dataDir?: string;
  /** Called on every engine change (used by the WS layer). */
  onChange?: (projectId: string, label: string, engine: VeditEngine) => void;
  onJob?: (projectId: string, engine: VeditEngine) => void;
}

export class ProjectRegistry {
  private engines = new Map<string, VeditEngine>();

  constructor(private opts: ServerOptions) {}

  private wire(id: string, engine: VeditEngine): VeditEngine {
    engine.on((event) => {
      if (event.type === "change") this.opts.onChange?.(id, event.label, engine);
      else this.opts.onJob?.(id, engine);
    });
    return engine;
  }

  create(name: string, sample = false): VeditEngine {
    const engine = sample
      ? VeditEngine.createSampleProject().engine
      : new VeditEngine(VeditEngine.createProject(name));
    engine.project.name = name || engine.project.name;
    this.engines.set(engine.project.id, this.wire(engine.project.id, engine));
    return engine;
  }

  get(id: string): VeditEngine {
    const engine = this.engines.get(id);
    if (!engine) throw new Error(`project not found: ${id}`);
    return engine;
  }

  has(id: string): boolean {
    return this.engines.has(id);
  }

  findByJob(jobId: string): VeditEngine {
    for (const engine of this.engines.values()) {
      if (engine.project.jobs.some((j) => j.id === jobId)) return engine;
    }
    throw new Error(`job not found: ${jobId}`);
  }

  list(): Array<{ id: string; name: string; updatedAt: string }> {
    return [...this.engines.values()].map((e) => ({
      id: e.project.id,
      name: e.project.name,
      updatedAt: e.project.updatedAt,
    }));
  }

  add(engine: VeditEngine): VeditEngine {
    this.engines.set(engine.project.id, this.wire(engine.project.id, engine));
    return engine;
  }
}

type Handler = (req: Request, res: Response, engine: VeditEngine) => void | Promise<void>;

function wrap(fn: Handler, registry: ProjectRegistry) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const engine = registry.get(req.params.id!);
      await fn(req, res, engine);
    } catch (err) {
      next(err);
    }
  };
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

/**
/**
 * Generation job (F4 — Vedit Gen). Stub synchronously for tests, async for real providers.
 * Creates a job, resolves provider and runs callProvider (stub → FFmpeg placeholder, real → cloud API).
 */
export function runStubGenJob(
  engine: VeditEngine,
  type: JobType,
  input: Record<string, unknown>,
): { jobId: string; assetId?: string; clipId?: string; trackId?: string } {
  const job = engine.createJob(type, { ...input, simulated: true });
  engine.updateJob(job.id, { status: "running", progress: 50 });
  const prompt = String(input.prompt ?? "without prompt");
  const provider = String(input.provider ?? "stub");
  const model = String(input.model ?? "stub-v0");
  const cameraMove = typeof input.cameraMove === "string" ? input.cameraMove : undefined;
  const kind: GenKind =
    type === "gen.image"
      ? "image"
      : type === "gen.music"
        ? "music"
        : type === "gen.sfx"
          ? "sfx"
          : type === "gen.voice"
            ? "voice"
            : "video";
  const directedPrompt = buildDirectedPrompt({ prompt, kind, cameraMove });

  let assetId: string | undefined;
  let clipId: string | undefined;
  let trackId: string | undefined;

  if (type === "gen.video" || type === "gen.image" || input.insertToTimeline) {
    const ext = type === "gen.video" ? "mp4" : type === "gen.image" ? "png" : "wav";
    const dur = Number(input.duration ?? (type === "gen.image" ? 4 : 5));
    const asset = engine.addAsset({
      name: `generated-${prompt.slice(0, 24).replace(/\s+/g, "_")}.${ext}`,
      kind: type === "gen.video" || type === "gen.image" ? "generated" : "audio",
      path: `/generated/${job.id}`,
      duration: type === "gen.image" ? undefined : dur,
      width: type === "gen.video" || type === "gen.image" ? Number(input.width ?? 1920) : undefined,
      height: type === "gen.video" || type === "gen.image" ? Number(input.height ?? 1080) : undefined,
      fps: type === "gen.video" ? Number(input.fps ?? 30) : undefined,
      source: {
        provider,
        model,
        prompt,
        directedPrompt,
        cameraMove,
        simulated: true,
      },
    });
    assetId = asset.id;

    if (input.insertToTimeline) {
      const targetKind: TrackKind = type === "gen.video" || type === "gen.image" ? "video" : "audio";
      const seq = engine.activeSequence();
      const track = seq.tracks.find((t) => t.kind === targetKind) ?? engine.addTrack(targetKind, targetKind === "video" ? "V1" : "A1");
      const trackEnd = track.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      const start = input.start != null ? Number(input.start) : trackEnd;
      const clip = engine.addClip({
        trackId: track.id,
        assetId: asset.id,
        name: asset.name,
        start,
        duration: dur,
        in: 0,
        out: dur,
      });
      clipId = clip.id;
      trackId = track.id;
    }

    engine.updateJob(job.id, {
      status: "done",
      progress: 100,
      output: {
        assetId: asset.id,
        clipId,
        trackId,
        note: "F0/F4 Vedit Gen — stub placeholder (set FAL_KEY / GOOGLE_API_KEY / VEDIT_WAN_URL for real models)",
      },
    });
  } else {
    engine.updateJob(job.id, {
      status: "done",
      progress: 100,
      output: { note: "F0/F4 Vedit Gen — stub placeholder (set provider env keys for real models)" },
    });
  }
  return { jobId: job.id, assetId, clipId, trackId };
}

/** Async Vedit Gen job (F4) — queued → running → done with cloud/local provider or real FFmpeg synth + timeline insertion. */
export function runGenJob(
  engine: VeditEngine,
  kind: GenKind,
  rawInput: Record<string, unknown>,
  opts: {
    dataDir: string;
    onUpdate?: () => void;
    fetchImpl?: typeof fetch;
    pollIntervalMs?: number;
  },
): { jobId: string } {
  const input: GenInput = {
    prompt: String(rawInput.prompt ?? ""),
    kind,
    provider: rawInput.provider as GenInput["provider"],
    model: rawInput.model != null ? String(rawInput.model) : undefined,
    duration: rawInput.duration != null ? Number(rawInput.duration) : undefined,
    width: rawInput.width != null ? Number(rawInput.width) : undefined,
    height: rawInput.height != null ? Number(rawInput.height) : undefined,
    fps: rawInput.fps != null ? Number(rawInput.fps) : undefined,
    aspectRatio: rawInput.aspectRatio as GenInput["aspectRatio"],
    negativePrompt: rawInput.negativePrompt != null ? String(rawInput.negativePrompt) : undefined,
    style: rawInput.style != null ? String(rawInput.style) : undefined,
    seed: rawInput.seed != null ? Number(rawInput.seed) : undefined,
    cameraMove: rawInput.cameraMove != null ? String(rawInput.cameraMove) : undefined,
    promptKeyframes: Array.isArray(rawInput.promptKeyframes) ? (rawInput.promptKeyframes as GenInput["promptKeyframes"]) : undefined,
    imageAssetId: rawInput.imageAssetId != null ? String(rawInput.imageAssetId) : undefined,
    videoAssetId: rawInput.videoAssetId != null ? String(rawInput.videoAssetId) : undefined,
    continuityFromClipId: rawInput.continuityFromClipId != null ? String(rawInput.continuityFromClipId) : undefined,
    continuityFromAssetId: rawInput.continuityFromAssetId != null ? String(rawInput.continuityFromAssetId) : undefined,
    insertToTimeline: rawInput.insertToTimeline !== false,
    start: rawInput.start != null ? Number(rawInput.start) : undefined,
    trackId: rawInput.trackId != null ? String(rawInput.trackId) : undefined,
    params: rawInput.params as Record<string, unknown> | undefined,
  };
  if (!input.prompt.trim()) throw new Error("prompt is required");

  const prov = resolveProvider(input);
  const model = input.model ?? prov.defaultModel;
  const simulated = prov.id === "stub" || !isProviderConfigured(prov);
  const job = engine.createJob(genJobType(kind), {
    ...rawInput,
    provider: prov.id,
    model,
    simulated,
  });

  void (async () => {
    try {
      engine.updateJob(job.id, { status: "running", progress: 8 });
      opts.onUpdate?.();
      const continuity = await prepareContinuityContext(engine, input, resolvePath(opts.dataDir, "gen", job.id));
      const directedPrompt = buildDirectedPrompt(input, continuity);
      const outPath = await callProvider(
        prov,
        { ...input, model },
        job.id,
        opts.dataDir,
        {
          continuity,
          fetchImpl: opts.fetchImpl,
          pollIntervalMs: opts.pollIntervalMs,
          onProgress: (pct) => {
            engine.updateJob(job.id, { progress: pct });
            opts.onUpdate?.();
          },
        },
      );
      engine.updateJob(job.id, { status: "running", progress: 92 });
      opts.onUpdate?.();
      const inserted = await insertGeneratedAsset(engine, input, {
        path: outPath,
        provider: prov.id,
        model,
        directedPrompt,
        simulated,
        continuity,
      });
      engine.updateJob(job.id, {
        status: "done",
        progress: 100,
        output: {
          assetId: inserted.asset.id,
          clipId: inserted.clip?.id,
          trackId: inserted.trackId,
          path: outPath,
          outPath,
          provider: prov.id,
          model,
          directedPrompt,
          simulated,
        },
      });
      opts.onUpdate?.();
    } catch (err) {
      engine.updateJob(job.id, { status: "failed", error: (err as Error).message });
      opts.onUpdate?.();
    }
  })();
  return { jobId: job.id };
}

/** Reálný render job (F1) — běží asynchronně přes FFmpeg, hlásí průběh. */
export function runRealRenderJob(
  engine: VeditEngine,
  input: Record<string, unknown>,
  opts: { renderDir: string; onUpdate?: () => void },
): { jobId: string } {
  const presetObj = typeof input.preset === "string" ? resolveExportPreset(input.preset) : undefined;
  const format = String(presetObj?.format ?? input.format ?? "mp4");
  const job = engine.createJob("render", { ...input, format, simulated: false });
  const outPath = resolvePath(opts.renderDir, `${job.id}.${format}`);
  void (async () => {
    try {
      engine.updateJob(job.id, { status: "running", progress: 1 });
      opts.onUpdate?.();
      const result = await renderSequence(engine.project, {
        outPath,
        preset: presetObj?.id,
        codec: input.codec != null ? (String(input.codec) as VideoCodecId) : presetObj?.codec,
        width: input.width != null ? Number(input.width) : undefined,
        height: input.height != null ? Number(input.height) : undefined,
        fps: input.fps != null ? Number(input.fps) : undefined,
        crf: input.crf != null ? Number(input.crf) : undefined,
        onProgress: (pct) => {
          engine.updateJob(job.id, { progress: pct });
          opts.onUpdate?.();
        },
      });
      engine.updateJob(job.id, {
        status: "done",
        progress: 100,
        output: {
          outPath: result.outPath,
          duration: result.duration,
          width: result.width,
          height: result.height,
          fps: result.fps,
          codec: result.codec,
          preset: result.preset,
          sizeBytes: result.sizeBytes,
          warnings: result.warnings,
        },
      });
      opts.onUpdate?.();
    } catch (err) {
      engine.updateJob(job.id, { status: "failed", error: (err as Error).message });
      opts.onUpdate?.();
    }
  })();
  return { jobId: job.id };
}

/** Proxy job (F1) — 640p verze pro plynulý střih. */
export function runProxyJob(
  engine: VeditEngine,
  assetId: string,
  opts: { proxyDir: string },
): { jobId: string } {
  const job = engine.createJob("other", { op: "proxy", assetId });
  const asset = engine.findAsset(assetId);
  const outPath = resolvePath(opts.proxyDir, `${assetId}.mp4`);
  void (async () => {
    try {
      engine.updateJob(job.id, { status: "running", progress: 10 });
      await mkdir(opts.proxyDir, { recursive: true });
      await generateProxy(asset.path, outPath);
      engine.updateAsset(assetId, { proxyPath: outPath });
      engine.updateJob(job.id, {
        status: "done",
        progress: 100,
        output: { proxyPath: outPath, assetId },
      });
    } catch (err) {
      engine.updateJob(job.id, { status: "failed", error: (err as Error).message });
    }
  })();
  return { jobId: job.id };
}

/** Voiceover job (F2) — TTS ze skriptu → audio + klip + titulky s přesným časováním. */
export function runVoiceoverJob(
  engine: VeditEngine,
  input: {
    script: string;
    voice?: string;
    rate?: number;
    gap?: number;
    start?: number;
    trackId?: string;
    captions?: boolean;
  },
  opts: { dataDir: string },
): { jobId: string } {
  const job = engine.createJob("gen.voice", { ...input, script: String(input.script ?? "").slice(0, 200) });
  void (async () => {
    try {
      if (!input.script?.trim()) throw new Error("script je prázdný");
      engine.updateJob(job.id, { status: "running", progress: 15 });
      const result = await generateVoiceover(engine, input, {
        mediaDir: resolvePath(opts.dataDir, "media"),
      });
      engine.updateJob(job.id, {
        status: "done",
        progress: 100,
        output: {
          assetId: result.asset.id,
          clipId: result.clip.id,
          captions: result.captions.length,
          duration: result.duration,
          engine: result.engine,
        },
      });
    } catch (err) {
      engine.updateJob(job.id, { status: "failed", error: (err as Error).message });
    }
  })();
  return { jobId: job.id };
}

/** Transcribe job (F2) — přepis řeči z média → titulky. */
export function runTranscribeJob(
  engine: VeditEngine,
  assetId: string,
  opts: { language?: string; maxWords?: number },
): { jobId: string } {
  const job = engine.createJob("captions", { op: "transcribe", assetId, language: opts.language ?? "en" });
  void (async () => {
    try {
      engine.updateJob(job.id, { status: "running", progress: 15 });
      const result = await transcribeToCaptions(engine, assetId, opts);
      engine.updateJob(job.id, {
        status: "done",
        progress: 100,
        output: {
          captions: result.captions.length,
          text: result.text.slice(0, 500),
          engine: result.engine,
        },
      });
    } catch (err) {
      engine.updateJob(job.id, { status: "failed", error: (err as Error).message });
    }
  })();
  return { jobId: job.id };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Auto-probe: doplní reálná metadata z ffprobe, pokud soubor existuje. */
async function probeIntoAsset(engine: VeditEngine, assetId: string, path: string): Promise<void> {
  if (!(await fileExists(path))) return;
  try {
    const probe = await probeMedia(path);
    engine.updateAsset(assetId, {
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      sizeBytes: probe.sizeBytes,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      hasAudio: probe.hasAudio,
      bitrate: probe.bitrate,
    });
  } catch {
    /* nečitelné médium — metadata zůstanou zadaná */
  }
}

export function createApp(opts: ServerOptions & { registry?: ProjectRegistry }): {
  app: Express;
  registry: ProjectRegistry;
} {
  const registry = opts.registry ?? new ProjectRegistry(opts);
  const dataDir = opts.dataDir ?? resolvePath(process.cwd(), ".vedit");
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // CORS — desktopový Tauri webview (http://tauri.localhost) volá API na 127.0.0.1:47000
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // auth (PLAN.md §5: lokální API token; ?token= pro <img> a download odkazy)
  if (opts.token) {
    app.use("/api", (req, res, next) => {
      if (req.path === "/v1/health") return next(); // health je veřejný
      const header = req.header("authorization") ?? "";
      const queryToken = typeof req.query.token === "string" ? req.query.token : "";
      if (header === `Bearer ${opts.token}` || queryToken === opts.token) return next();
      res.status(401).json({ error: "unauthorized" });
    });
  }

  app.get("/api/v1/health", (_req, res) => {
    res.json({ ok: true, name: "vedit", version: "0.1.0", scope: "F0 skeleton" });
  });

  app.get("/api/v1/projects", (_req, res) => {
    res.json({ projects: registry.list() });
  });

  app.post("/api/v1/projects", (req, res) => {
    const name = String(req.body?.name ?? "Untitled");
    const sample = Boolean(req.body?.sample);
    const engine = registry.create(name, sample);
    res.status(201).json({ project: engine.project });
  });

  app.get("/api/v1/projects/:id", wrap((_req, res, engine) => {
    res.json({ project: engine.project });
  }, registry));

  app.get("/api/v1/projects/:id/timeline", wrap((_req, res, engine) => {
    res.json(engine.timeline());
  }, registry));

  // assets
  app.post("/api/v1/projects/:id/assets", wrap(async (req, res, engine) => {
    const { name, kind, path, duration, width, height, fps, sizeBytes, source } = req.body ?? {};
    if (!name || !kind || !path) return badRequest(res, "name, kind a path jsou povinné");
    const asset = engine.addAsset({
      name: String(name),
      kind: kind as AssetKind,
      path: String(path),
      duration: duration != null ? Number(duration) : undefined,
      width: width != null ? Number(width) : undefined,
      height: height != null ? Number(height) : undefined,
      fps: fps != null ? Number(fps) : undefined,
      sizeBytes: sizeBytes != null ? Number(sizeBytes) : undefined,
      source,
    });
    // F1: skutečný probe, pokud soubor existuje
    if (kind !== "generated") await probeIntoAsset(engine, asset.id, asset.path);
    res.status(201).json({ asset: engine.findAsset(asset.id) });
  }, registry));

  // F1: média — reálné snímky, waveform, proxy
  app.get("/api/v1/projects/:id/assets/:assetId/frame", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.params.assetId));
    const t = Number(req.query.t ?? 0);
    const width = Number(req.query.width ?? 640);
    const jpeg = await extractFrame(asset.path, Number.isFinite(t) ? t : 0, { width });
    res.type("image/jpeg").send(jpeg);
  }, registry));

  app.get("/api/v1/projects/:id/assets/:assetId/thumbs", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.params.assetId));
    const count = Math.min(12, Math.max(1, Number(req.query.count ?? 6)));
    const width = Math.min(640, Math.max(64, Number(req.query.width ?? 160)));
    const duration = asset.duration ?? 0;
    const base = `/api/v1/projects/${req.params.id}/assets/${asset.id}/frame`;
    const token = typeof req.query.token === "string" ? `&token=${req.query.token}` : "";
    const thumbs = [];
    for (let i = 0; i < count; i++) {
      const t = duration > 0 ? (duration * (i + 0.5)) / count : 0;
      thumbs.push({ t, url: `${base}?t=${t.toFixed(2)}&width=${width}${token}` });
    }
    res.json({ thumbs });
  }, registry));

  app.get("/api/v1/projects/:id/assets/:assetId/waveform", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.params.assetId));
    const samples = Math.min(2000, Math.max(10, Number(req.query.samples ?? 400)));
    const peaks = await extractPeaks(asset.path, samples);
    res.json({ peaks, samples });
  }, registry));

  app.post("/api/v1/projects/:id/assets/:assetId/proxy", wrap((req, res, engine) => {
    const assetId = String(req.params.assetId);
    engine.findAsset(assetId);
    const result = runProxyJob(engine, assetId, { proxyDir: resolvePath(dataDir, "proxies") });
    res.status(201).json(result);
  }, registry));

  app.get("/api/v1/projects/:id/assets", wrap((_req, res, engine) => {
    res.json({ assets: engine.project.assets });
  }, registry));

  // tracks
  app.post("/api/v1/projects/:id/tracks", wrap((req, res, engine) => {
    const kind = req.body?.kind as TrackKind | undefined;
    if (!kind || !["video", "audio", "text", "graphics"].includes(kind)) {
      return badRequest(res, "kind musí být video|audio|text|graphics");
    }
    const track = engine.addTrack(kind, req.body?.name ? String(req.body.name) : undefined);
    res.status(201).json({ track });
  }, registry));

  // clips
  app.post("/api/v1/projects/:id/clips", wrap((req, res, engine) => {
    const { trackId, assetId, start, duration, in: inPt, out, name } = req.body ?? {};
    if (!trackId || !assetId || start == null) return badRequest(res, "trackId, assetId a start jsou povinné");
    try {
      const clip = engine.addClip({
        trackId: String(trackId),
        assetId: String(assetId),
        start: Number(start),
        duration: duration != null ? Number(duration) : undefined,
        in: inPt != null ? Number(inPt) : undefined,
        out: out != null ? Number(out) : undefined,
        name: name != null ? String(name) : undefined,
      });
      res.status(201).json({ clip });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/split", wrap((req, res, engine) => {
    const at = Number(req.body?.at);
    if (!Number.isFinite(at)) return badRequest(res, "at (sekundy) je povinné");
    try {
      const [left, right] = engine.splitClip(String(req.params.clipId), at, req.body?.trackId ? String(req.body.trackId) : undefined);
      res.json({ left, right });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/trim", wrap((req, res, engine) => {
    const edge = req.body?.edge as "start" | "end" | undefined;
    const time = Number(req.body?.time);
    if ((edge !== "start" && edge !== "end") || !Number.isFinite(time)) {
      return badRequest(res, "edge (start|end) a time jsou povinné");
    }
    try {
      const clip = engine.trimClip(String(req.params.clipId), edge, time, req.body?.trackId ? String(req.body.trackId) : undefined);
      res.json({ clip });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/move", wrap((req, res, engine) => {
    const start = Number(req.body?.start);
    if (!Number.isFinite(start)) return badRequest(res, "start je povinné");
    try {
      const clip = engine.moveClip(
        String(req.params.clipId),
        start,
        req.body?.trackId ? String(req.body.trackId) : undefined,
        req.body?.fromTrackId ? String(req.body.fromTrackId) : undefined,
      );
      res.json({ clip });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.patch("/api/v1/projects/:id/clips/:clipId", wrap((req, res, engine) => {
    try {
      const clip = engine.updateClip(String(req.params.clipId), req.body ?? {}, req.body?.trackId ? String(req.body.trackId) : undefined);
      res.json({ clip });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.delete("/api/v1/projects/:id/clips/:clipId", wrap((req, res, engine) => {
    const clipId = String(req.params.clipId);
    const trackId = req.query.trackId ? String(req.query.trackId) : undefined;
    try {
      if (req.query.ripple === "1" || req.query.ripple === "true") engine.rippleDeleteClip(clipId, trackId);
      else engine.deleteClip(clipId, trackId);
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  // animation / effects
  app.get("/api/v1/animation/presets", (_req, res) => {
    res.json({ presets: listAnimationPresets() });
  });

  app.post("/api/v1/projects/:id/clips/:clipId/animation", wrap((req, res, engine) => {
    const preset = String(req.body?.preset ?? "");
    try {
      const clip = engine.applyAnimationPreset(String(req.params.clipId), preset, req.body?.trackId ? String(req.body.trackId) : undefined);
      res.json({ clip });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/keyframes", wrap((req, res, engine) => {
    const keyframes = req.body?.keyframes;
    if (!Array.isArray(keyframes)) return badRequest(res, "keyframes musí být pole");
    try {
      const clip = engine.addKeyframes(String(req.params.clipId), keyframes, req.body?.trackId ? String(req.body.trackId) : undefined);
      res.json({ clip });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/effects", wrap((req, res, engine) => {
    try {
      const effect = engine.addEffect(
        String(req.params.clipId),
        String(req.body?.type ?? "effect"),
        req.body?.params ?? {},
        req.body?.trackId ? String(req.body.trackId) : undefined,
      );
      res.status(201).json({ effect });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  // captions
  app.get("/api/v1/projects/:id/captions", wrap((_req, res, engine) => {
    res.json({ captions: engine.activeSequence().captions });
  }, registry));

  app.post("/api/v1/projects/:id/captions", wrap((req, res, engine) => {
    const { text, start, end, style } = req.body ?? {};
    if (!text || start == null || end == null) return badRequest(res, "text, start a end jsou povinné");
    try {
      const caption = engine.addCaption({ text: String(text), start: Number(start), end: Number(end), style });
      res.status(201).json({ caption });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/captions/from-text", wrap((req, res, engine) => {
    const segments = req.body?.segments;
    if (!Array.isArray(segments)) return badRequest(res, "segments musí být pole {text,start,end}");
    try {
      const captions = engine.addCaptionsFromSegments(segments);
      res.status(201).json({ captions });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.patch("/api/v1/projects/:id/captions/:captionId", wrap((req, res, engine) => {
    try {
      const caption = engine.updateCaption(String(req.params.captionId), req.body ?? {});
      res.json({ caption });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.delete("/api/v1/projects/:id/captions/:captionId", wrap((req, res, engine) => {
    try {
      engine.removeCaption(String(req.params.captionId));
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.get("/api/v1/projects/:id/captions/export.srt", wrap((_req, res, engine) => {
    res.type("text/plain").send(captionsToSrt(engine.activeSequence().captions));
  }, registry));

  // undo / redo
  app.post("/api/v1/projects/:id/undo", wrap((_req, res, engine) => {
    res.json({ ok: engine.undo(), undo: engine.undoLabels, redo: engine.redoLabels });
  }, registry));

  app.post("/api/v1/projects/:id/redo", wrap((_req, res, engine) => {
    res.json({ ok: engine.redo(), undo: engine.undoLabels, redo: engine.redoLabels });
  }, registry));

  // generation (F4 — Vedit Gen, see src/ai/gen.ts)
  app.get("/api/v1/gen/providers", (_req, res) => {
    res.json({ providers: providerAvailability(), cameraMoves: CAMERA_MOVES });
  });

  const handleGen = (kind: GenKind) =>
    wrap((req, res, engine) => {
      const body = req.body ?? {};
      const wantsReal = Boolean(body.real) || (body.provider && body.provider !== "stub");
      if (wantsReal) {
        try {
          const result = runGenJob(engine, kind, body, {
            dataDir,
            onUpdate: () => opts.onJob?.(req.params.id!, engine),
          });
          res.status(201).json(result);
        } catch (err) {
          badRequest(res, (err as Error).message);
        }
      } else {
        const result = runStubGenJob(engine, genJobType(kind), body);
        res.status(201).json(result);
      }
    }, registry);

  app.post("/api/v1/projects/:id/gen/video", handleGen("video"));
  app.post("/api/v1/projects/:id/gen/image", handleGen("image"));
  app.post("/api/v1/projects/:id/gen/music", handleGen("music"));
  app.post("/api/v1/projects/:id/gen/sfx", handleGen("sfx"));
  app.post("/api/v1/projects/:id/gen/voice", handleGen("voice"));

  app.post("/api/v1/projects/:id/gen/audio", wrap((req, res, engine) => {
    const body = req.body ?? {};
    const kindStr = String(body?.kind ?? "music");
    const k: GenKind = kindStr === "voice" ? "voice" : kindStr === "sfx" ? "sfx" : "music";
    const wantsReal = Boolean(body.real) || (body.provider && body.provider !== "stub");
    if (wantsReal) {
      try {
        const result = runGenJob(engine, k, body, {
          dataDir,
          onUpdate: () => opts.onJob?.(req.params.id!, engine),
        });
        res.status(201).json(result);
      } catch (err) {
        badRequest(res, (err as Error).message);
      }
    } else {
      const result = runStubGenJob(engine, genJobType(k), body);
      res.status(201).json(result);
    }
  }, registry));

  app.post("/api/v1/projects/:id/export", wrap((req, res, engine) => {
    const result = runRealRenderJob(engine, {
      format: String(req.body?.format ?? "mp4"),
      ...req.body,
    }, { renderDir: resolvePath(dataDir, "renders") });
    res.status(201).json(result);
  }, registry));

  // ---- F2: AI titulky a voiceover ----
  app.get("/api/v1/ai/capabilities", async (_req, res, next) => {
    try {
      res.json(await speechCapabilities());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/projects/:id/voiceover", wrap((req, res, engine) => {
    const { script, voice, rate, gap, start, trackId, captions } = req.body ?? {};
    if (!script || !String(script).trim()) return badRequest(res, "script je povinný");
    const result = runVoiceoverJob(engine, {
      script: String(script),
      voice: voice != null ? String(voice) : undefined,
      rate: rate != null ? Number(rate) : undefined,
      gap: gap != null ? Number(gap) : undefined,
      start: start != null ? Number(start) : undefined,
      trackId: trackId != null ? String(trackId) : undefined,
      captions: captions !== false,
    }, { dataDir });
    res.status(201).json(result);
  }, registry));

  app.post("/api/v1/projects/:id/assets/:assetId/transcribe", wrap((req, res, engine) => {
    const assetId = String(req.params.assetId);
    engine.findAsset(assetId);
    const result = runTranscribeJob(engine, assetId, {
      language: req.body?.language != null ? String(req.body.language) : undefined,
      maxWords: req.body?.maxWords != null ? Number(req.body.maxWords) : undefined,
    });
    res.status(201).json(result);
  }, registry));

  // ---- F3: AI střih — analýza ----
  app.post("/api/v1/projects/:id/analyze/silences", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.body?.assetId ?? ""));
    const regions = await detectSilences(asset.path, {
      noiseDb: req.body?.noiseDb != null ? Number(req.body.noiseDb) : undefined,
      minDuration: req.body?.minSilence != null ? Number(req.body.minSilence) : undefined,
    });
    res.json({ regions });
  }, registry));

  app.post("/api/v1/projects/:id/analyze/scenes", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.body?.assetId ?? ""));
    const scenes = await detectScenes(asset.path, {
      threshold: req.body?.threshold != null ? Number(req.body.threshold) : undefined,
    });
    res.json({ scenes });
  }, registry));

  app.post("/api/v1/projects/:id/analyze/beats", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.body?.assetId ?? ""));
    const beats = await detectBeats(asset.path, {
      sensitivity: req.body?.sensitivity != null ? Number(req.body.sensitivity) : undefined,
      minBeatSec: req.body?.minBeatSec != null ? Number(req.body.minBeatSec) : undefined,
    });
    res.json({ beats });
  }, registry));

  app.post("/api/v1/projects/:id/analyze/motion", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.body?.assetId ?? ""));
    const track = await trackMotion(asset.path, {
      fps: req.body?.fps != null ? Number(req.body.fps) : undefined,
    });
    res.json({ track });
  }, registry));

  app.post("/api/v1/projects/:id/analyze/energy", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.body?.assetId ?? ""));
    const windows = await windowEnergy(asset.path, {
      windowSec: req.body?.windowSec != null ? Number(req.body.windowSec) : undefined,
      hopSec: req.body?.hopSec != null ? Number(req.body.hopSec) : undefined,
    });
    res.json({ windows });
  }, registry));

  // ---- F3: AI střih — operace ----
  app.post("/api/v1/projects/:id/edit/remove-silences", wrap(async (req, res, engine) => {
    try {
      const result = await removeSilences(engine, {
        trackId: req.body?.trackId != null ? String(req.body.trackId) : undefined,
        clipId: req.body?.clipId != null ? String(req.body.clipId) : undefined,
        noiseDb: req.body?.noiseDb != null ? Number(req.body.noiseDb) : undefined,
        minSilence: req.body?.minSilence != null ? Number(req.body.minSilence) : undefined,
        padding: req.body?.padding != null ? Number(req.body.padding) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/edit/highlight", wrap(async (req, res, engine) => {
    try {
      const result = await buildHighlight(engine, {
        trackId: req.body?.trackId != null ? String(req.body.trackId) : undefined,
        assetId: req.body?.assetId != null ? String(req.body.assetId) : undefined,
        clipId: req.body?.clipId != null ? String(req.body.clipId) : undefined,
        targetDuration: req.body?.targetDuration != null ? Number(req.body.targetDuration) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/beat-sync", wrap(async (req, res, engine) => {
    try {
      const result = await beatSync(engine, {
        clipId: String(req.params.clipId),
        musicAssetId: String(req.body?.musicAssetId ?? ""),
        sensitivity: req.body?.sensitivity != null ? Number(req.body.sensitivity) : undefined,
        minBeatSec: req.body?.minBeatSec != null ? Number(req.body.minBeatSec) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/auto-reframe", wrap(async (req, res, engine) => {
    try {
      const result = await autoReframe(engine, {
        clipId: String(req.params.clipId),
        strength: req.body?.strength != null ? Number(req.body.strength) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/track-motion", wrap(async (req, res, engine) => {
    try {
      const result = await trackMotionTo(engine, {
        targetClipId: String(req.params.clipId),
        sourceAssetId: req.body?.sourceAssetId != null ? String(req.body.sourceAssetId) : undefined,
        sourceClipId: req.body?.sourceClipId != null ? String(req.body.sourceClipId) : undefined,
        strength: req.body?.strength != null ? Number(req.body.strength) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  // F1: stažení render výstupu
  app.get("/api/v1/jobs/:jobId/output", (req, res, next) => {
    try {
      const jobId = String(req.params.jobId);
      const engine = registry.findByJob(jobId);
      const job = engine.getJob(jobId);
      const outPath = job.output?.outPath;
      if (job.status !== "done" || typeof outPath !== "string") {
        return badRequest(res, `job ${jobId} ještě nemá hotový výstup (stav: ${job.status})`);
      }
      res.download(outPath);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/projects/:id/jobs", wrap((_req, res, engine) => {
    res.json({ jobs: engine.project.jobs });
  }, registry));

  app.get("/api/v1/jobs/:jobId", (req, res, next) => {
    try {
      const jobId = String(req.params.jobId);
      const engine = registry.findByJob(jobId);
      res.json({ job: engine.getJob(jobId) });
    } catch (err) {
      next(err);
    }
  });

  // ---- F5: Export Presets, Batch Queue, Watch Folders, Marketplace & Collaboration ----
  const watchManager = new WatchFolderManager();

  app.get("/api/v1/export/presets", (_req, res) => {
    res.json({ presets: listExportPresets() });
  });

  app.post("/api/v1/projects/:id/export/batch", wrap((req, res, engine) => {
    try {
      const presets = Array.isArray(req.body?.presets) ? req.body.presets.map(String) : [];
      const result = runBatchExport(engine, presets, {
        renderDir: resolvePath(dataDir, "renders"),
        onUpdate: () => opts.onJob?.(req.params.id!, engine),
      });
      res.status(201).json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.get("/api/v1/projects/:id/export/queue", wrap((_req, res, engine) => {
    res.json(getQueueStatus(engine));
  }, registry));

  // Snapshots / Checkpoints / Diff / Merge
  app.get("/api/v1/projects/:id/snapshots", wrap((_req, res, engine) => {
    res.json({ snapshots: listSnapshots(engine) });
  }, registry));

  app.post("/api/v1/projects/:id/snapshots", wrap((req, res, engine) => {
    const label = String(req.body?.label ?? "");
    const author = req.body?.author != null ? String(req.body.author) : "editor";
    res.status(201).json({ snapshot: saveSnapshot(engine, label, author) });
  }, registry));

  app.post("/api/v1/projects/:id/snapshots/:snapId/restore", wrap((req, res, engine) => {
    try {
      res.json({ restored: restoreSnapshot(engine, String(req.params.snapId)) });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/diff", wrap((req, res, engine) => {
    const snapId = req.body?.snapshotId != null ? String(req.body.snapshotId) : undefined;
    if (snapId) {
      const found = (engine.project.snapshots ?? []).find((s) => s.id === snapId);
      if (!found) return badRequest(res, `snapshot not found: ${snapId}`);
      res.json({ diff: diffProjects(found.snapshot, engine.project) });
      return;
    }
    if (req.body?.otherProject) {
      res.json({ diff: diffProjects(engine.project, req.body.otherProject) });
      return;
    }
    badRequest(res, "provide snapshotId or otherProject");
  }, registry));

  app.post("/api/v1/projects/:id/merge", wrap((req, res, engine) => {
    if (!req.body?.project) return badRequest(res, "project payload is required");
    const merged = mergeProjectChanges(engine, req.body.project, String(req.body.author ?? "collaborator"));
    res.json({ merged });
  }, registry));

  // Timecoded Review Comments, Markers & Chapters
  app.get("/api/v1/projects/:id/comments", wrap((_req, res, engine) => {
    res.json({ comments: engine.project.comments ?? [] });
  }, registry));

  app.post("/api/v1/projects/:id/comments", wrap((req, res, engine) => {
    try {
      const comment = addReviewComment(engine, {
        author: req.body?.author != null ? String(req.body.author) : undefined,
        text: String(req.body?.text ?? ""),
        timecode: Number(req.body?.timecode ?? 0),
      });
      res.status(201).json({ comment });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.patch("/api/v1/projects/:id/comments/:commentId", wrap((req, res, engine) => {
    try {
      const resolved = req.body?.resolved !== false;
      res.json({ comment: resolveReviewComment(engine, String(req.params.commentId), Boolean(resolved)) });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.delete("/api/v1/projects/:id/comments/:commentId", wrap((req, res, engine) => {
    deleteReviewComment(engine, String(req.params.commentId));
    res.json({ ok: true });
  }, registry));

  app.post("/api/v1/projects/:id/markers", wrap((req, res, engine) => {
    const marker = addTimelineMarker(engine, {
      time: Number(req.body?.time ?? 0),
      label: String(req.body?.label ?? "Marker"),
      color: req.body?.color != null ? String(req.body.color) : undefined,
    });
    res.status(201).json({ marker });
  }, registry));

  app.get("/api/v1/projects/:id/chapters", wrap((_req, res, engine) => {
    res.json(exportYouTubeChapters(engine.project));
  }, registry));

  app.get("/api/v1/projects/:id/audit", wrap((req, res, engine) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.json({ entries: listAuditLog(engine.project, limit) });
  }, registry));

  // Marketplace (Templates & Plugins)
  app.get("/api/v1/marketplace", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const engine = projectId && registry.has(projectId) ? registry.get(projectId) : undefined;
    res.json({ packs: listMarketplacePacks(engine) });
  });

  app.post("/api/v1/projects/:id/marketplace/install", wrap(async (req, res, engine) => {
    try {
      if (req.body?.filePath) {
        const pack = await installPackFromFile(engine, String(req.body.filePath));
        res.status(201).json({ pack });
        return;
      }
      if (req.body?.manifest) {
        const registered = registerPack(req.body.manifest);
        const pack = installPack(engine, registered.id);
        res.status(201).json({ pack });
        return;
      }
      const pack = installPack(engine, String(req.body?.packId ?? ""));
      res.status(201).json({ pack });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.delete("/api/v1/projects/:id/marketplace/:packId", wrap((req, res, engine) => {
    uninstallPack(engine, String(req.params.packId));
    res.json({ ok: true });
  }, registry));

  app.post("/api/v1/projects/:id/marketplace/apply-template", wrap((req, res, engine) => {
    try {
      const result = applyTemplate(
        engine,
        String(req.body?.templateId ?? ""),
        (req.body?.params as Record<string, string> | undefined) ?? {},
      );
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/marketplace/run-plugin", wrap((req, res, engine) => {
    try {
      const result = runPlugin(
        engine,
        String(req.body?.pluginId ?? ""),
        (req.body?.params as Record<string, string> | undefined) ?? {},
      );
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  // Watch Folders
  app.get("/api/v1/watch-folders", (_req, res) => {
    res.json({ watchers: watchManager.list() });
  });

  app.post("/api/v1/watch-folders", async (req, res) => {
    try {
      if (!req.body?.inboxDir || !req.body?.outputDir) {
        return badRequest(res, "inboxDir and outputDir are required");
      }
      const watcher = await watchManager.start({
        id: req.body.id != null ? String(req.body.id) : undefined,
        inboxDir: String(req.body.inboxDir),
        outputDir: String(req.body.outputDir),
        preset: req.body.preset != null ? String(req.body.preset) : undefined,
        templateId: req.body.templateId != null ? String(req.body.templateId) : undefined,
        pollMs: req.body.pollMs != null ? Number(req.body.pollMs) : undefined,
      });
      res.status(201).json({ watcher });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  });

  app.delete("/api/v1/watch-folders/:watchId", (req, res) => {
    res.json({ ok: watchManager.stop(String(req.params.watchId)) });
  });

  // error handler → JSON
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return { app, registry };
}