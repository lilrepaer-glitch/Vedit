// REST API (PLAN.md §5) — REST na /api/v1 + WebSocket události.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { VeditEngine } from "../core/engine.js";
import { captionsToSrt, listAnimationPresets } from "../core/presets.js";
import type { AssetKind, JobType, TrackKind } from "../core/types.js";

export interface ServerOptions {
  /** Bearer token; when set, all /api routes require Authorization: Bearer <token>. */
  token?: string;
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
 * Simulated generation job (F0 stub — real models in F4 per PLAN.md §3.5).
 * Creates a job, completes it immediately and registers the generated asset.
 */
export function runStubGenJob(
  engine: VeditEngine,
  type: JobType,
  input: Record<string, unknown>,
): { jobId: string; assetId?: string } {
  const job = engine.createJob(type, { ...input, simulated: true });
  engine.updateJob(job.id, { status: "running", progress: 50 });
  let assetId: string | undefined;
  if (type === "gen.video" || type === "gen.image") {
    const prompt = String(input.prompt ?? "bez promptu");
    const asset = engine.addAsset({
      name: `generated-${prompt.slice(0, 24).replace(/\s+/g, "_")}.${type === "gen.video" ? "mp4" : "png"}`,
      kind: "generated",
      path: `/generated/${job.id}`,
      duration: type === "gen.video" ? Number(input.duration ?? 5) : undefined,
      width: Number(input.width ?? 1920),
      height: Number(input.height ?? 1080),
      fps: type === "gen.video" ? Number(input.fps ?? 30) : undefined,
      source: {
        provider: String(input.provider ?? "vedit-stub"),
        model: String(input.model ?? "stub-v0"),
        prompt,
        simulated: true,
      },
    });
    assetId = asset.id;
    engine.updateJob(job.id, {
      status: "done",
      progress: 100,
      output: { assetId: asset.id, note: "F0 simulovaný výstup — napojení modelů ve F4" },
    });
  } else {
    engine.updateJob(job.id, {
      status: "done",
      progress: 100,
      output: { note: "F0 simulovaný výstup — napojení modelů ve F4" },
    });
  }
  return { jobId: job.id, assetId };
}

export function createApp(opts: ServerOptions & { registry?: ProjectRegistry }): {
  app: Express;
  registry: ProjectRegistry;
} {
  const registry = opts.registry ?? new ProjectRegistry(opts);
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // auth (PLAN.md §5: lokální API token)
  if (opts.token) {
    app.use("/api", (req, res, next) => {
      if (req.path === "/v1/health") return next(); // health je veřejný
      const header = req.header("authorization") ?? "";
      if (header === `Bearer ${opts.token}`) return next();
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
  app.post("/api/v1/projects/:id/assets", wrap((req, res, engine) => {
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
    res.status(201).json({ asset });
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

  // generation + export (F0 stubs; real providers in F4)
  app.post("/api/v1/projects/:id/gen/video", wrap((req, res, engine) => {
    const result = runStubGenJob(engine, "gen.video", req.body ?? {});
    res.status(201).json(result);
  }, registry));

  app.post("/api/v1/projects/:id/gen/image", wrap((req, res, engine) => {
    const result = runStubGenJob(engine, "gen.image", req.body ?? {});
    res.status(201).json(result);
  }, registry));

  app.post("/api/v1/projects/:id/gen/audio", wrap((req, res, engine) => {
    const kind = String(req.body?.kind ?? "music");
    const type: JobType = kind === "voice" ? "gen.voice" : kind === "sfx" ? "gen.sfx" : "gen.music";
    const result = runStubGenJob(engine, type, req.body ?? {});
    res.status(201).json(result);
  }, registry));

  app.post("/api/v1/projects/:id/export", wrap((req, res, engine) => {
    const result = runStubGenJob(engine, "render", {
      format: String(req.body?.format ?? "mp4"),
      ...req.body,
    });
    res.status(201).json(result);
  }, registry));

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
