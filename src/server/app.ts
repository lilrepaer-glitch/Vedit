// REST API (PLAN.md §5) — REST na /api/v1 + WebSocket události.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { access, mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { VeditEngine } from "../core/engine.js";
import { captionsToSrt, listAnimationPresets } from "../core/presets.js";
import { extractFrame, extractPeaks, generateProxy, probeMedia } from "../core/media.js";
import { renderSequence } from "../render/export.js";
import { speechCapabilities } from "../ai/speech.js";
import { generateVoiceover, transcribeToCaptions } from "../ai/voiceover.js";
import { detectBeats, detectScenes, detectSilences, trackMotion, windowEnergy } from "../ai/analysis.js";
import { autoReframe, beatSync, buildHighlight, removeSilences, trackMotionTo } from "../ai/edit.js";
import { callProvider, providerAvailability, resolveProvider, type GenInput } from "../ai/gen.js";
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
): { jobId: string; assetId?: string } {
  const job = engine.createJob(type, { ...input, simulated: !input.provider || input.provider === "stub" });
  engine.updateJob(job.id, { status: "running", progress: 50 });
  let assetId: string | undefined;
  if (type === "gen.video" || type === "gen.image") {
    const prompt = String(input.prompt ?? "without prompt");
    const provider = String(input.provider ?? "stub");
    const model = String(input.model ?? "stub-v0");
    const asset = engine.addAsset({
      name: `generated-${prompt.slice(0, 24).replace(/\s+/g, "_")}.${type === "gen.video" ? "mp4" : "png"}`,
      kind: "generated",
      path: `/generated/${job.id}`,
      duration: type === "gen.video" ? Number(input.duration ?? 5) : undefined,
      width: Number(input.width ?? 1920),
      height: Number(input.height ?? 1080),
      fps: type === "gen.video" ? Number(input.fps ?? 30) : undefined,
      source: {
        provider,
        model,
        prompt,
        simulated: !input.provider || provider === "stub",
      },
    });
    assetId = asset.id;
    engine.updateJob(job.id, {
      status: "done",
      progress: 100,
      output: { assetId: asset.id, note: "F4 Vedit Gen — stub placeholder (set FAL_KEY / GOOGLE_API_KEY etc. for real models)" },
    });
  } else {
    engine.updateJob(job.id, {
      status: "done",
      progress: 100,
      output: { note: "F4 Vedit Gen — stub placeholder (set provider env keys for real models)" },
    });
  }
  return { jobId: job.id, assetId };
}

/** Async Vedit Gen job (F4) — queued → running → done with real provider or FFmpeg placeholder. */
export function runGenJob(
  engine: VeditEngine,
  kind: "video" | "image" | "music" | "sfx" | "voice",
  rawInput: Record<string, unknown>,
  opts: { dataDir: string; onUpdate?: () => void },
): { jobId: string } {
  const input: import("../ai/gen.js").GenInput = {
    prompt: String(rawInput.prompt ?? ""),
    kind,
    provider: rawInput.provider as any,
    model: rawInput.model as string | undefined,
    duration: rawInput.duration as number | undefined,
    width: rawInput.width as number | undefined,
    height: rawInput.height as number | undefined,
    fps: rawInput.fps as number | undefined,
    imageAssetId: rawInput.imageAssetId as string | undefined,
    videoAssetId: rawInput.videoAssetId as string | undefined,
    params: rawInput.params as Record<string, unknown> | undefined,
  };
  if (!input.prompt) throw new Error("prompt is required");
  const provider = (globalThis as any).__veditResolveProvider ? (globalThis as any).__veditResolveProvider(input) : null;
  // Lazy import to avoid circular deps — will be overridden in createApp below
  const jobType: JobType = kind === "video" ? "gen.video" : kind === "image" ? "gen.image" : kind === "music" ? "gen.music" : kind === "sfx" ? "gen.sfx" : "gen.voice";
  const job = engine.createJob(jobType, { ...rawInput, provider: input.provider ?? "stub", model: input.model ?? "stub-v0" });
  void (async () => {
    try {
      const { resolveProvider, callProvider } = await import("../ai/gen.js");
      const prov = resolveProvider(input);
      engine.updateJob(job.id, { status: "running", progress: 10 });
      opts.onUpdate?.();
      const outPath = await callProvider(prov, { ...input, model: input.model ?? prov.defaultModel }, job.id, opts.dataDir);
      engine.updateJob(job.id, { status: "running", progress: 80 });
      opts.onUpdate?.();
      let assetId: string | undefined;
      if (kind === "video" || kind === "image") {
        const asset = engine.addAsset({
          name: `gen-${input.prompt.slice(0, 24).replace(/\s+/g, "_")}.${kind === "video" ? "mp4" : kind === "image" ? "png" : "mp4"}`,
          kind: "generated",
          path: outPath,
          duration: kind === "video" ? Number(input.duration ?? 5) : undefined,
          width: Number(input.width ?? 1920),
          height: Number(input.height ?? 1080),
          fps: Number(input.fps ?? 24),
          source: { provider: prov.id, model: input.model ?? prov.defaultModel, prompt: input.prompt },
        });
        assetId = asset.id;
      }
      engine.updateJob(job.id, { status: "done", progress: 100, output: { assetId, path: outPath, provider: prov.id, model: input.model ?? prov.defaultModel } });
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
  opts: { renderDir: string },
): { jobId: string } {
  const job = engine.createJob("render", { ...input, simulated: false });
  const outPath = resolvePath(opts.renderDir, `${job.id}.${String(input.format ?? "mp4")}`);
  void (async () => {
    try {
      engine.updateJob(job.id, { status: "running", progress: 1 });
      const result = await renderSequence(engine.project, {
        outPath,
        width: input.width != null ? Number(input.width) : undefined,
        height: input.height != null ? Number(input.height) : undefined,
        fps: input.fps != null ? Number(input.fps) : undefined,
        crf: input.crf != null ? Number(input.crf) : undefined,
        onProgress: (pct) => engine.updateJob(job.id, { progress: pct }),
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
          sizeBytes: result.sizeBytes,
          warnings: result.warnings,
        },
      });
    } catch (err) {
      engine.updateJob(job.id, { status: "failed", error: (err as Error).message });
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
    res.json({ providers: providerAvailability() });
  });

  app.post("/api/v1/projects/:id/gen/video", wrap((req, res, engine) => {
    const body = req.body ?? {};
    // Use async provider-aware job when a cloud provider is requested; otherwise keep sync stub for tests
    if (body.provider && body.provider !== "stub") {
      const result = runGenJob(engine, "video", body, { dataDir, onUpdate: () => opts.onJob?.(req.params.id!, engine) });
      res.status(201).json(result);
    } else {
      const result = runStubGenJob(engine, "gen.video", body);
      res.status(201).json(result);
    }
  }, registry));

  app.post("/api/v1/projects/:id/gen/image", wrap((req, res, engine) => {
    const body = req.body ?? {};
    if (body.provider && body.provider !== "stub") {
      const result = runGenJob(engine, "image", body, { dataDir, onUpdate: () => opts.onJob?.(req.params.id!, engine) });
      res.status(201).json(result);
    } else {
      const result = runStubGenJob(engine, "gen.image", body);
      res.status(201).json(result);
    }
  }, registry));

  app.post("/api/v1/projects/:id/gen/audio", wrap((req, res, engine) => {
    const body = req.body ?? {};
    const kind = String(body?.kind ?? "music");
    if (body.provider && body.provider !== "stub") {
      const k = (kind === "voice" ? "voice" : kind === "sfx" ? "sfx" : "music") as "voice" | "sfx" | "music";
      const result = runGenJob(engine, k, body, { dataDir, onUpdate: () => opts.onJob?.(req.params.id!, engine) });
      res.status(201).json(result);
    } else {
      const type: JobType = kind === "voice" ? "gen.voice" : kind === "sfx" ? "gen.sfx" : "gen.music";
      const result = runStubGenJob(engine, type, body);
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

  // error handler → JSON
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return { app, registry };
}