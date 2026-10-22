// REST API (PLAN.md §5) — REST na /api/v1 + WebSocket události.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { access, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { VeditEngine } from "../core/engine.js";
import { captionsToSrt, listAnimationPresets } from "../core/presets.js";
import { extractFrame, extractPeaks, generateProxy, probeMedia } from "../core/media.js";
import { renderSequence, resolveExportPreset, type VideoCodecId } from "../render/export.js";
import { probeHardwareEncoders, type HwAccelBackend } from "../render/hwaccel.js";
import {
  COLOR_GRADE_PRESETS,
  applyChromaKey,
  applyColorGrade,
  applyFadeTransition,
  setClipSpeed,
} from "../pro/fx.js";
import { duckMusicUnderVoice, enhanceAudio } from "../pro/audio.js";
import { listSavedProjects, loadProjectFromDisk, saveProjectToDisk } from "../pro/persistence.js";
import { addGraphicOverlay, type VectorGraphicPreset } from "../pro/graphics.js";
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
  AUDIO_EQ_PRESETS,
  TONE_CURVE_PRESETS,
  applyParametricEq,
  applyToneCurve,
  importSubtitlesToSequence,
  serializeSubtitles,
  type AudioEqPresetId,
  type SubtitleFormat,
  type ToneCurvePresetId,
} from "../pro/studio-grade.js";
import { VEDIT_VERSION, checkForUpdates, downloadAndInstallUpdate } from "../pro/updater.js";
import {
  fetchRemoteModels,
  initApiSettings,
  saveApiSettings,
  testApiConnection,
  toPublicApiConfig,
} from "../pro/api-settings.js";
import { connect as connectSocket } from "node:net";
import { runStudioCopilot } from "../ai/orchestrator.js";
import { sequenceDuration } from "../core/types.js";
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
        hwAccel: input.hwAccel != null ? (String(input.hwAccel) as HwAccelBackend) : "auto",
        loudnessLufs: input.loudnessLufs != null ? Number(input.loudnessLufs) : undefined,
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
          encoder: result.encoder,
          hwBackend: result.hwBackend,
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
  void initApiSettings(dataDir).catch(() => undefined);
  const app = express();
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "25mb" }));

  // CORS + Chromium Private Network Access — desktop Tauri WebView2 (`http(s)://tauri.localhost` or same-origin `http://127.0.0.1:47000`)
  app.use((req, res, next) => {
    const origin = req.header("origin") || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
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
    res.json({ ok: true, name: "vedit", version: VEDIT_VERSION, scope: "F0–F9 Broadcast Studio" });
  });

  // Custom API Key, Base URL & Model Configuration (persisted in <dataDir>/settings/api-config.json)
  app.get("/api/v1/settings/api", (_req, res) => {
    res.json(toPublicApiConfig());
  });

  app.put("/api/v1/settings/api", async (req, res) => {
    try {
      const saved = await saveApiSettings(req.body ?? {}, dataDir);
      res.json(saved);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  });

  app.post("/api/v1/settings/api/models", async (req, res) => {
    try {
      const result = await fetchRemoteModels({
        baseUrl: req.body?.baseUrl ? String(req.body.baseUrl) : undefined,
        apiKey: req.body?.apiKey ? String(req.body.apiKey) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  });

  app.post("/api/v1/settings/api/test", async (req, res) => {
    try {
      const result = await testApiConnection({
        baseUrl: req.body?.baseUrl ? String(req.body.baseUrl) : undefined,
        apiKey: req.body?.apiKey ? String(req.body.apiKey) : undefined,
        model: req.body?.model ? String(req.body.model) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  });

  // Native Desktop Window Borderless Fullscreen Bridge (Win32 Tauri shell + WebView fallback)
  app.post("/api/v1/window/fullscreen", async (req, res) => {
    const shellPort = Number(process.env.VEDIT_SHELL_PORT || 0);
    if (!shellPort) {
      res.json({ supported: false, fullscreen: false });
      return;
    }
    const mode = req.body?.mode === "on" || req.body?.mode === "off" || req.body?.mode === "state" ? req.body.mode : "toggle";
    try {
      const reply = await new Promise<{ fullscreen: boolean }>((resolve, reject) => {
        const sock = connectSocket({ host: "127.0.0.1", port: shellPort });
        let raw = "";
        sock.setTimeout(1500);
        sock.on("connect", () => sock.write(`${mode}\n`));
        sock.on("data", (chunk) => {
          raw += chunk.toString("utf8");
        });
        sock.on("end", () => {
          try {
            resolve(JSON.parse(raw.trim()) as { fullscreen: boolean });
          } catch {
            resolve({ fullscreen: mode === "on" });
          }
        });
        sock.on("timeout", () => {
          sock.destroy();
          reject(new Error("shell fullscreen timeout"));
        });
        sock.on("error", reject);
      });
      res.json({ supported: true, fullscreen: Boolean(reply.fullscreen) });
    } catch {
      res.json({ supported: false, fullscreen: false });
    }
  });

  // Self-Updater API (GitHub Releases check + one-click NSIS `/P /UPDATE /R` download & launch)
  app.get("/api/v1/updater/check", async (_req, res) => {
    try {
      res.json(await checkForUpdates(VEDIT_VERSION));
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  });

  app.post("/api/v1/updater/install", async (req, res) => {
    try {
      const result = await downloadAndInstallUpdate({
        downloadUrl: req.body?.downloadUrl ? String(req.body.downloadUrl) : undefined,
        autoLaunch: req.body?.autoLaunch !== false,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
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
    res.json({
      project: engine.project,
      history: {
        canUndo: engine.undoLabels.length > 0,
        canRedo: engine.redoLabels.length > 0,
        undoCount: engine.undoLabels.length,
        redoCount: engine.redoLabels.length,
      },
    });
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

  // F1 + v0.8.0: Direct HTTP 206 Partial Content Range streaming for instant 60 FPS GPU video/audio playback
  app.get("/api/v1/projects/:id/assets/:assetId/file", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.params.assetId));
    const st = await stat(asset.path);
    const total = st.size;
    const ext = extname(asset.path).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".mp4": "video/mp4",
      ".m4v": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".ogg": "audio/ogg",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    const contentType = mimeMap[ext] ?? "application/octet-stream";
    res.setHeader("Accept-Ranges", "bytes");
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m?.[1] ? parseInt(m[1], 10) : 0;
      const end = m?.[2] ? Math.min(total - 1, parseInt(m[2], 10)) : total - 1;
      if (start >= total || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", String(end - start + 1));
      res.type(contentType);
      createReadStream(asset.path, { start, end }).pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(total));
    res.type(contentType);
    createReadStream(asset.path).pipe(res);
  }, registry));

  app.get("/api/v1/projects/:id/assets/:assetId/thumbnail", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.params.assetId));
    if (asset.kind === "image" && (await fileExists(asset.path))) {
      createReadStream(asset.path).pipe(res.type(extname(asset.path) || "image/jpeg"));
      return;
    }
    try {
      const jpeg = await extractFrame(asset.path, Math.min(0.5, (asset.duration ?? 0) * 0.25), { width: 320 });
      res.type("image/jpeg").send(jpeg);
    } catch {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#18181b"/><text x="160" y="95" fill="#a1a1aa" font-family="sans-serif" font-size="14" text-anchor="middle">${asset.name.replace(/[<>&"]/g, "")}</text></svg>`;
      res.type("image/svg+xml").send(svg);
    }
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

  app.patch("/api/v1/projects/:id/assets/:assetId", wrap(async (req, res, engine) => {
    const assetId = String(req.params.assetId);
    const patch: Record<string, unknown> = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name);
    if (req.body?.path !== undefined) patch.path = String(req.body.path);
    if (Array.isArray(req.body?.tags)) patch.tags = req.body.tags.map(String);
    const updated = engine.updateAsset(assetId, patch);
    if (req.body?.path !== undefined) {
      await probeIntoAsset(engine, assetId, updated.path);
    }
    res.json({ asset: engine.findAsset(assetId) });
  }, registry));

  // tracks
  app.post("/api/v1/projects/:id/tracks", wrap((req, res, engine) => {
    const kind = req.body?.kind as TrackKind | undefined;
    if (!kind || !["video", "audio", "text", "graphics"].includes(kind)) {
      return badRequest(res, "kind must be video|audio|text|graphics");
    }
    const track = engine.addTrack(kind, req.body?.name ? String(req.body.name) : undefined);
    res.status(201).json({ track });
  }, registry));

  app.patch("/api/v1/projects/:id/tracks/:trackId", wrap((req, res, engine) => {
    try {
      const track = engine.updateTrack(String(req.params.trackId), {
        ...(req.body?.name !== undefined ? { name: String(req.body.name) } : {}),
        ...(req.body?.muted !== undefined ? { muted: Boolean(req.body.muted) } : {}),
        ...(req.body?.solo !== undefined ? { solo: Boolean(req.body.solo) } : {}),
        ...(req.body?.locked !== undefined ? { locked: Boolean(req.body.locked) } : {}),
        ...(req.body?.volumeDb !== undefined ? { volumeDb: Number(req.body.volumeDb) } : {}),
        ...(req.body?.pan !== undefined ? { pan: Number(req.body.pan) } : {}),
      });
      res.json({ track });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.delete("/api/v1/projects/:id/tracks/:trackId", wrap((req, res, engine) => {
    try {
      engine.removeTrack(String(req.params.trackId));
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
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
      const clipId = String(req.params.clipId);
      const effectType = String(req.body?.type ?? "effect");
      const trackId = req.body?.trackId ? String(req.body.trackId) : undefined;
      if (req.body?.replace) {
        for (const tr of engine.activeSequence().tracks) {
          const foundClip = tr.clips.find((c) => c.id === clipId);
          if (foundClip) {
            foundClip.effects = foundClip.effects.filter((prev) => prev.type !== effectType);
          }
        }
      }
      const effect = engine.addEffect(
        clipId,
        effectType,
        req.body?.params ?? {},
        trackId,
      );
      res.status(201).json({ effect });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.patch("/api/v1/projects/:id/sequence", wrap((req, res, engine) => {
    const seq = engine.activeSequence();
    const { width, height, fps, name, background } = req.body ?? {};
    if (width != null) seq.width = Math.max(16, Math.round(Number(width) / 2) * 2);
    if (height != null) seq.height = Math.max(16, Math.round(Number(height) / 2) * 2);
    if (fps != null) seq.fps = Math.max(1, Math.min(120, Number(fps)));
    if (typeof name === "string" && name.trim()) seq.name = name.trim();
    if (typeof background === "string") (seq as unknown as Record<string, unknown>).background = background;
    res.json({ sequence: seq });
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
  const sendJobOutput = (req: Request, res: Response, next: NextFunction) => {
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
  };
  app.get("/api/v1/jobs/:jobId/output", sendJobOutput);
  app.get("/api/v1/projects/:id/jobs/:jobId/output", sendJobOutput);

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

  // ---- F6: Hardware GPU Encoders, Media Streaming, Drag & Drop File Upload, Persistence, Pro VFX & Pro Audio ----

  app.get("/api/v1/export/encoders", async (_req, res, next) => {
    try {
      res.json(await probeHardwareEncoders());
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/fx/color-presets", (_req, res) => {
    res.json({ presets: COLOR_GRADE_PRESETS });
  });

  // HTTP 206 Range media streamer for smooth 60fps HTML5 <video>/<audio> playback in Desktop Preview
  app.get("/api/v1/projects/:id/assets/:assetId/stream", wrap(async (req, res, engine) => {
    const asset = engine.findAsset(String(req.params.assetId));
    const filePath = asset.proxyPath ?? asset.path;
    const st = await stat(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    };
    const contentType = mimeMap[ext] ?? "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = m?.[1] ? parseInt(m[1], 10) : 0;
      const end = m?.[2] ? Math.min(st.size - 1, parseInt(m[2], 10)) : st.size - 1;
      if (start >= st.size || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${st.size}`).end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": contentType,
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Length": st.size,
        "Content-Type": contentType,
      });
      createReadStream(filePath).pipe(res);
    }
  }, registry));

  // Native Drag & Drop / File Picker zero-buffer streaming upload straight into local dataDir/imports (unlimited GB size!)
  app.post(
    "/api/v1/projects/:id/assets/upload",
    wrap(async (req, res, engine) => {
      const rawName = String(req.query.name ?? "imported.mp4");
      const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]+/g, "_") || "imported.mp4";
      const importsDir = resolvePath(dataDir, "imports");
      await mkdir(importsDir, { recursive: true });
      const targetPath = join(importsDir, `${Date.now()}-${safeName}`);

      // Stream raw body directly to disk so multi-GB 4K/8K MP4/MKV/MOV files never buffer in RAM or hit 512MB caps!
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        await writeFile(targetPath, req.body);
      } else {
        await pipeline(req, createWriteStream(targetPath));
      }
      const writtenStat = await stat(targetPath);
      if (writtenStat.size === 0) {
        await unlink(targetPath).catch(() => {});
        return badRequest(res, "Uploaded media body is empty");
      }

      const ext = extname(safeName).toLowerCase();
      const inferredKind: AssetKind =
        /\.(wav|mp3|ogg|flac|m4a|aac|opus)$/i.test(ext)
          ? "audio"
          : /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(ext)
            ? "image"
            : "video";
      const kind = (req.query.kind as AssetKind | undefined) ?? inferredKind;

      const asset = engine.addAsset({
        name: rawName,
        kind,
        path: targetPath,
      });
      await probeIntoAsset(engine, asset.id, targetPath);
      const probed = engine.findAsset(asset.id);

      let insertedClip = null;
      if (req.query.insert !== "false") {
        const seq = engine.activeSequence();
        const wantAudio = probed.kind === "audio";
        const requestedTrackId = typeof req.query.trackId === "string" ? req.query.trackId : "";
        const explicitTrack = requestedTrackId ? seq.tracks.find((t) => t.id === requestedTrackId && !t.locked) : undefined;
        const track =
          explicitTrack ??
          seq.tracks.find((t) => t.kind === (wantAudio ? "audio" : "video") && !t.locked) ??
          engine.addTrack(wantAudio ? "audio" : "video", wantAudio ? "A1" : "V1");
        const startAt = Number.isFinite(Number(req.query.at))
          ? Math.max(0, Number(req.query.at))
          : Math.max(0, sequenceDuration(seq));
        const dur = Math.max(0.5, probed.duration ?? 5);
        insertedClip = engine.addClip({
          trackId: track.id,
          assetId: probed.id,
          name: probed.name,
          start: startAt,
          duration: dur,
          in: 0,
          out: dur,
        });
      }

      res.status(201).json({ asset: probed, clip: insertedClip });
    }, registry),
  );

  // Project Disk Persistence (.vedit JSON Save / Open / Saved List)
  app.get("/api/v1/projects-saved", async (_req, res, next) => {
    try {
      res.json({ saved: await listSavedProjects(dataDir) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/projects/:id/save", wrap(async (req, res, engine) => {
    const customPath = req.body?.filePath != null ? String(req.body.filePath) : undefined;
    const saved = await saveProjectToDisk(engine, dataDir, customPath);
    res.json(saved);
  }, registry));

  app.post("/api/v1/projects/open", async (req, res) => {
    try {
      const filePath = String(req.body?.filePath ?? "");
      if (!filePath) return badRequest(res, "filePath is required");
      const loaded = await loadProjectFromDisk(filePath);
      registry.add(loaded);
      res.json({ project: loaded.project });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  });

  // Pro VFX & Speed Control
  app.post("/api/v1/projects/:id/clips/:clipId/color-grade", wrap((req, res, engine) => {
    try {
      const effect = applyColorGrade(engine, String(req.params.clipId), req.body ?? {});
      res.json({ effect });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/chroma-key", wrap((req, res, engine) => {
    try {
      const effect = applyChromaKey(engine, String(req.params.clipId), req.body ?? {});
      res.json({ effect });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/speed", wrap((req, res, engine) => {
    try {
      const speed = Number(req.body?.speed ?? req.body?.rate ?? 1);
      const clip = setClipSpeed(engine, String(req.params.clipId), speed);
      res.json({ clip });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/fade", wrap((req, res, engine) => {
    try {
      const effect = applyFadeTransition(engine, String(req.params.clipId), req.body ?? {});
      res.json({ effect });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  // Pro Audio DSP: Voice Enhance & Music Auto-Ducking
  app.post("/api/v1/projects/:id/audio/enhance", wrap(async (req, res, engine) => {
    try {
      const result = await enhanceAudio(engine, {
        clipId: req.body?.clipId != null ? String(req.body.clipId) : undefined,
        assetId: req.body?.assetId != null ? String(req.body.assetId) : undefined,
        noiseFloor: req.body?.noiseFloor != null ? Number(req.body.noiseFloor) : undefined,
        voicePresence: req.body?.voicePresence !== false,
        loudnessLufs: req.body?.loudnessLufs != null ? Number(req.body.loudnessLufs) : undefined,
        outDir: resolvePath(dataDir, "audio"),
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/audio/duck", wrap(async (req, res, engine) => {
    try {
      if (!req.body?.musicClipId) return badRequest(res, "musicClipId is required");
      const result = await duckMusicUnderVoice(engine, {
        musicClipId: String(req.body.musicClipId),
        voiceClipId: req.body?.voiceClipId != null ? String(req.body.voiceClipId) : undefined,
        voiceAssetId: req.body?.voiceAssetId != null ? String(req.body.voiceAssetId) : undefined,
        reductionDb: req.body?.reductionDb != null ? Number(req.body.reductionDb) : undefined,
        noiseDb: req.body?.noiseDb != null ? Number(req.body.noiseDb) : undefined,
        outDir: resolvePath(dataDir, "audio"),
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  // ---- F7: Vector Shapes / SVG Overlays, Desktop Screen Capture & Smart Thumbnail Export ----

  app.post("/api/v1/projects/:id/graphics", wrap(async (req, res, engine) => {
    try {
      const kind = (req.body?.kind ?? "lower-third-card") as VectorGraphicPreset;
      const result = await addGraphicOverlay(engine, {
        kind,
        width: req.body?.width != null ? Number(req.body.width) : undefined,
        height: req.body?.height != null ? Number(req.body.height) : undefined,
        primaryColor: req.body?.primaryColor != null ? String(req.body.primaryColor) : undefined,
        accentColor: req.body?.accentColor != null ? String(req.body.accentColor) : undefined,
        svgMarkup: req.body?.svgMarkup != null ? String(req.body.svgMarkup) : undefined,
        start: req.body?.start != null ? Number(req.body.start) : undefined,
        duration: req.body?.duration != null ? Number(req.body.duration) : undefined,
        x: req.body?.x != null ? Number(req.body.x) : undefined,
        y: req.body?.y != null ? String(req.body.y) === "" ? undefined : Number(req.body.y) : undefined,
        animationPreset: req.body?.animationPreset != null ? String(req.body.animationPreset) : undefined,
        label: req.body?.label != null ? String(req.body.label) : undefined,
        outDir: resolvePath(dataDir, "graphics"),
      });
      res.status(201).json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/capture/screen", wrap(async (req, res, engine) => {
    try {
      const result = await captureDesktopClip(engine, {
        seconds: req.body?.seconds != null ? Number(req.body.seconds) : 3,
        fps: req.body?.fps != null ? Number(req.body.fps) : 24,
        start: req.body?.start != null ? Number(req.body.start) : undefined,
        label: req.body?.label != null ? String(req.body.label) : undefined,
        outDir: resolvePath(dataDir, "captures"),
      });
      res.status(201).json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/thumbnail", wrap(async (req, res, engine) => {
    try {
      const result = await generateProjectThumbnail(engine, {
        at: req.body?.at != null ? Number(req.body.at) : undefined,
        width: req.body?.width != null ? Number(req.body.width) : 1280,
        title: req.body?.title != null ? String(req.body.title) : undefined,
        outDir: resolvePath(dataDir, "thumbnails"),
      });
      res.status(201).json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.get("/api/v1/projects/:id/thumbnail/image", wrap(async (req, res, engine) => {
    const result = await generateProjectThumbnail(engine, {
      at: req.query.at != null ? Number(req.query.at) : undefined,
      width: req.query.width != null ? Number(req.query.width) : 1280,
      title: req.query.title != null ? String(req.query.title) : undefined,
      outDir: resolvePath(dataDir, "thumbnails"),
    });
    res.type("image/jpeg").sendFile(result.outPath);
  }, registry));

  // ---- F8: Cinema 3D .cube LUTs, VidStab Stabilization, PiP/Split Layouts, EDL/FCPXML Interchange & AI Copilot ----

  app.get("/api/v1/cinema/luts", (_req, res) => {
    res.json({ luts: BUILTIN_LUTS });
  });

  app.post("/api/v1/projects/:id/clips/:clipId/lut", wrap(async (req, res, engine) => {
    try {
      const result = await applyCubeLut(engine, String(req.params.clipId), {
        lutId: req.body?.lutId != null ? (String(req.body.lutId) as BuiltInLutId) : undefined,
        filePath: req.body?.filePath != null ? String(req.body.filePath) : undefined,
        intensity: req.body?.intensity != null ? Number(req.body.intensity) : undefined,
        outDir: resolvePath(dataDir, "luts"),
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/stabilize", wrap(async (req, res, engine) => {
    try {
      const result = await stabilizeClip(engine, String(req.params.clipId), {
        shakiness: req.body?.shakiness != null ? Number(req.body.shakiness) : undefined,
        smoothing: req.body?.smoothing != null ? Number(req.body.smoothing) : undefined,
        outDir: resolvePath(dataDir, "stabilized"),
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/layout", wrap((req, res, engine) => {
    try {
      const layout = (req.body?.layout ?? "pip-bottom-right") as LayoutPresetId;
      const clip = applyLayoutPreset(engine, String(req.params.clipId), layout);
      res.json({ clip });
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/copilot", wrap(async (req, res, engine) => {
    try {
      const prompt = String(req.body?.prompt ?? "");
      const result = await runStudioCopilot(engine, prompt, { dataDir });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.get("/api/v1/projects/:id/export/edl", wrap((_req, res, engine) => {
    res.setHeader("Content-Disposition", `attachment; filename="${engine.project.id.slice(0, 8)}.edl"`);
    res.type("text/plain").send(exportEdl(engine.project));
  }, registry));

  app.get("/api/v1/projects/:id/export/fcpxml", wrap((_req, res, engine) => {
    res.setHeader("Content-Disposition", `attachment; filename="${engine.project.id.slice(0, 8)}.fcpxml"`);
    res.type("application/xml").send(exportFcpXml(engine.project));
  }, registry));

  // ---- F9: Broadcast Scopes, Multicam Sync & Live Angle Switcher, Reverse & Freeze Frame ----

  app.get("/api/v1/projects/:id/scopes", wrap(async (req, res, engine) => {
    try {
      const time = req.query.time != null ? Number(req.query.time) : 0;
      const result = await analyzeFrameScopes(engine, { time });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/reverse", wrap(async (req, res, engine) => {
    try {
      const result = await reverseClip(engine, String(req.params.clipId), {
        outDir: resolvePath(dataDir, "reversed"),
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/freeze", wrap(async (req, res, engine) => {
    try {
      const result = await freezeFrameClip(engine, String(req.params.clipId), {
        at: req.body?.at != null ? Number(req.body.at) : undefined,
        holdDuration: req.body?.holdDuration != null ? Number(req.body.holdDuration) : undefined,
        outDir: resolvePath(dataDir, "freezes"),
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/multicam/sync", wrap(async (req, res, engine) => {
    try {
      const result = await syncMulticamClips(engine, {
        assetIds: Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : undefined,
        maxOffsetSec: req.body?.maxOffsetSec != null ? Number(req.body.maxOffsetSec) : undefined,
        sampleRate: req.body?.sampleRate != null ? Number(req.body.sampleRate) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/multicam/cuts", wrap((req, res, engine) => {
    try {
      const result = applyMulticamCuts(engine, {
        cuts: Array.isArray(req.body?.cuts) ? req.body.cuts : undefined,
        autoIntervalSec: req.body?.autoIntervalSec != null ? Number(req.body.autoIntervalSec) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  // ---- F11: Studio Grade (Tone Curves, 3-Band Audio EQ + Voice Clarity, SRT/VTT Subtitles, Client MP4 Fallback) ----
  app.get("/api/v1/studio-grade/presets", (_req, res) => {
    res.json({
      curves: Object.values(TONE_CURVE_PRESETS),
      eq: Object.values(AUDIO_EQ_PRESETS),
    });
  });

  app.post("/api/v1/projects/:id/clips/:clipId/curves", wrap((req, res, engine) => {
    try {
      const result = applyToneCurve(engine, String(req.params.clipId), {
        preset: typeof req.body?.preset === "string" ? (req.body.preset as ToneCurvePresetId) : undefined,
        points: Array.isArray(req.body?.points) ? req.body.points : undefined,
        shadows: req.body?.shadows != null ? Number(req.body.shadows) : undefined,
        midtones: req.body?.midtones != null ? Number(req.body.midtones) : undefined,
        highlights: req.body?.highlights != null ? Number(req.body.highlights) : undefined,
        clarity: req.body?.clarity != null ? Number(req.body.clarity) : undefined,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/clips/:clipId/eq", wrap(async (req, res, engine) => {
    try {
      const renderDir = resolvePath(dataDir, "renders");
      const result = await applyParametricEq(engine, String(req.params.clipId), {
        preset: typeof req.body?.preset === "string" ? (req.body.preset as AudioEqPresetId) : undefined,
        lowDb: req.body?.lowDb != null ? Number(req.body.lowDb) : undefined,
        midDb: req.body?.midDb != null ? Number(req.body.midDb) : undefined,
        highDb: req.body?.highDb != null ? Number(req.body.highDb) : undefined,
        voiceClarity: req.body?.voiceClarity != null ? Boolean(req.body.voiceClarity) : undefined,
        renderFile: Boolean(req.body?.renderToFile || req.body?.renderFile),
        outDir: renderDir,
      });
      res.json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.post("/api/v1/projects/:id/captions/import", wrap((req, res, engine) => {
    const text = String(req.body?.text ?? req.body?.content ?? "");
    if (!text.trim()) return badRequest(res, "Subtitle content (`text`) is required");
    try {
      const result = importSubtitlesToSequence(engine, text, {
        replaceExisting: Boolean(req.body?.replaceExisting),
        offsetSec: req.body?.offsetSec != null ? Number(req.body.offsetSec) : 0,
      });
      res.status(201).json(result);
    } catch (err) {
      badRequest(res, (err as Error).message);
    }
  }, registry));

  app.get("/api/v1/projects/:id/captions/export", wrap((req, res, engine) => {
    const format: SubtitleFormat = req.query.format === "vtt" ? "vtt" : "srt";
    const text = serializeSubtitles(engine.activeSequence().captions, format);
    if (req.query.raw === "1") {
      res.type(format === "vtt" ? "text/vtt" : "text/plain").send(text);
      return;
    }
    res.json({ format, text, count: engine.activeSequence().captions.length });
  }, registry));

  app.post(
    "/api/v1/projects/:id/export/client-mp4",
    express.raw({ type: () => true, limit: "2gb" }),
    wrap(async (req, res, engine) => {
      try {
        const renderDir = resolvePath(dataDir, "renders");
        await mkdir(renderDir, { recursive: true });
        const rawName = String(req.query.filename ?? `${engine.project.name || "export"}.mp4`)
          .replace(/[^a-zA-Z0-9._-]+/g, "_")
          .replace(/^\.+/, "");
        const safeName = rawName.toLowerCase().endsWith(".mp4") ? rawName : `${rawName || "export"}.mp4`;
        const outPath = join(renderDir, `${Date.now()}-${safeName}`);
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
        if (buf.byteLength < 16) {
          return badRequest(res, "Empty client MP4 payload");
        }
        await writeFile(outPath, buf);
        const job = engine.createJob("render", { clientMux: true, filename: safeName });
        engine.updateJob(job.id, {
          status: "done",
          progress: 1,
          output: { outPath, sizeBytes: buf.byteLength, encoder: "webcodecs-mp4-muxer" },
        });
        res.status(201).json({ job: engine.getJob(job.id), outPath, sizeBytes: buf.byteLength });
      } catch (err) {
        badRequest(res, (err as Error).message);
      }
    }, registry),
  );

  // Serve built Desktop UI bundle directly on same-origin `http://127.0.0.1:47000/`
  // so Windows WebView2 avoids every cross-origin / Mixed Content / Private Network Access restriction!
  const appModuleDir = dirname(fileURLToPath(import.meta.url));
  const uiCandidates = [
    resolvePath(appModuleDir, "..", "..", "ui"),
    resolvePath(appModuleDir, "..", "..", "apps", "desktop", "dist"),
  ];
  const uiDir = uiCandidates.find((p) => existsSync(join(p, "index.html")));
  if (uiDir) {
    app.use(express.static(uiDir));
    app.get(/^\/(?!api\/|ws$).*/, (_req, res) => {
      res.sendFile(join(uiDir, "index.html"));
    });
  }

  // error handler → JSON
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return { app, registry };
}