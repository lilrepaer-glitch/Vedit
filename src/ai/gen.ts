// Vedit Gen — unified AI media generation layer (PLAN.md §3.5, §4.1).
// Supports:
//  - Cloud aggregators: fal.ai (queue submit → poll → result download), Replicate (predictions submit → poll → download)
//  - Direct cloud models: Google Veo 3.1, Kling 3.0, Seedance 2.x, Runway Gen-4.5, Luma Ray 3, MiniMax Hailuo/H3, Wan Cloud
//  - Local open-source GPU runners: Wan 2.1 Local & Hunyuan Video (ComfyUI / local HTTP API or local CLI command)
//  - Offline playable FFmpeg generator ("stub") for zero-key editing, previews, tests, and render pipeline
//  - Shot direction: camera moves, timed prompt keyframes, shot-to-shot continuity (last-frame extraction + prompt carryover),
//    and atomic timeline insertion with rich AssetSource metadata.

import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import type { VeditEngine } from "../core/engine.js";
import { extractFrame, ffmpegPath, probeMedia } from "../core/media.js";
import { sequenceDuration, type Asset, type Clip, type JobType, type Keyframe, type TrackKind } from "../core/types.js";

export type GenKind = "video" | "image" | "music" | "sfx" | "voice";

export type ProviderId =
  | "stub"
  | "fal"
  | "replicate"
  | "google"
  | "kling"
  | "seedance"
  | "runway"
  | "luma"
  | "minimax"
  | "wan-cloud"
  | "wan-local"
  | "hunyuan-local";

export type CameraMoveId =
  | "static"
  | "push-in"
  | "pull-out"
  | "pan-left"
  | "pan-right"
  | "tilt-up"
  | "tilt-down"
  | "orbit"
  | "tracking"
  | "handheld"
  | "crane"
  | "fpv";

export interface CameraMovePreset {
  id: CameraMoveId;
  label: string;
  directive: string;
}

export const CAMERA_MOVES: CameraMovePreset[] = [
  { id: "static", label: "Static Tripod", directive: "locked-off static tripod shot, steady framing" },
  { id: "push-in", label: "Dolly Push In", directive: "smooth dolly push-in toward the subject" },
  { id: "pull-out", label: "Dolly Pull Out", directive: "cinematic dolly pull-out revealing the environment" },
  { id: "pan-left", label: "Pan Left", directive: "smooth horizontal camera pan to the left" },
  { id: "pan-right", label: "Pan Right", directive: "smooth horizontal camera pan to the right" },
  { id: "tilt-up", label: "Tilt Up", directive: "gradual vertical camera tilt upward" },
  { id: "tilt-down", label: "Tilt Down", directive: "gradual vertical camera tilt downward" },
  { id: "orbit", label: "360° Orbit", directive: "smooth orbital arc around the central subject" },
  { id: "tracking", label: "Lateral Tracking", directive: " gimbal lateral tracking shot following motion" },
  { id: "handheld", label: "Natural Handheld", directive: "organic handheld cinema camera micro-movement" },
  { id: "crane", label: "Crane / Drone Rise", directive: "sweeping crane jib rise with parallax depth" },
  { id: "fpv", label: "FPV Dynamic Dive", directive: "dynamic high-speed FPV drone flythrough" },
];

export interface PromptKeyframe {
  /** Time offset in seconds from shot start. */
  time: number;
  /** Visual/action beat at this timestamp. */
  prompt: string;
}

export interface GenProvider {
  id: ProviderId;
  label: string;
  kinds: GenKind[];
  /** Primary env var that enables this provider (e.g. FAL_KEY, VEDIT_WAN_URL). */
  envKey?: string;
  /** Optional secondary env var (e.g. VEDIT_WAN_CMD for CLI runner). */
  altEnvKey?: string;
  /** Default base URL for cloud/local HTTP calls. */
  baseUrl?: string;
  defaultModel: string;
  models: string[];
  cloud: boolean;
}

export const GEN_PROVIDERS: GenProvider[] = [
  {
    id: "stub",
    label: "Vedit Offline Synth (FFmpeg)",
    kinds: ["video", "image", "music", "sfx", "voice"],
    defaultModel: "stub-v0",
    models: ["stub-v0"],
    cloud: false,
  },
  {
    id: "fal",
    label: "fal.ai (Veo 3.1 / Kling 3.0 / Seedance / Wan / Flux / Audio)",
    kinds: ["video", "image", "music", "sfx"],
    envKey: "FAL_KEY",
    baseUrl: "https://queue.fal.run",
    defaultModel: "fal-ai/veo3.1",
    models: [
      "fal-ai/veo3.1",
      "fal-ai/kling-video/v3/pro/text-to-video",
      "fal-ai/bytedance/seedance/v2/text-to-video",
      "fal-ai/wan-t2v",
      "fal-ai/luma-dream-machine/ray-2",
      "fal-ai/flux-pro/v1.1",
      "fal-ai/stable-audio",
      "fal-ai/mmaudio-v2",
    ],
    cloud: true,
  },
  {
    id: "replicate",
    label: "Replicate (Runway / Luma / MiniMax / Flux / MusicGen)",
    kinds: ["video", "image", "music", "sfx"],
    envKey: "REPLICATE_API_TOKEN",
    baseUrl: "https://api.replicate.com/v1",
    defaultModel: "minimax/video-01",
    models: [
      "minimax/video-01",
      "luma/ray-2-720p",
      "wan-video/wan-2.1-t2v-480p",
      "black-forest-labs/flux-1.1-pro",
      "meta/musicgen",
    ],
    cloud: true,
  },
  {
    id: "google",
    label: "Google Veo 3.1 (Gemini API)",
    kinds: ["video", "image"],
    envKey: "GOOGLE_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "veo-3.1-generate-preview",
    models: ["veo-3.1-generate-preview", "veo-3.1-fast-generate-preview", "imagen-3.0-generate-002"],
    cloud: true,
  },
  {
    id: "kling",
    label: "Kling 3.0 (Kuaishou)",
    kinds: ["video", "image"],
    envKey: "KLING_API_KEY",
    baseUrl: "https://api.klingai.com/v1",
    defaultModel: "kling-v3",
    models: ["kling-v3", "kling-v2-1"],
    cloud: true,
  },
  {
    id: "seedance",
    label: "Seedance 2.x (ByteDance)",
    kinds: ["video"],
    envKey: "SEEDANCE_API_KEY",
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
    defaultModel: "seedance-2.0-pro",
    models: ["seedance-2.0-pro", "seedance-2.0-lite"],
    cloud: true,
  },
  {
    id: "runway",
    label: "Runway Gen-4.5",
    kinds: ["video", "image"],
    envKey: "RUNWAY_API_KEY",
    baseUrl: "https://api.dev.runwayml.com/v1",
    defaultModel: "gen4.5_turbo",
    models: ["gen4.5_turbo", "gen4_aleph"],
    cloud: true,
  },
  {
    id: "luma",
    label: "Luma Ray 3 (Dream Machine)",
    kinds: ["video", "image"],
    envKey: "LUMA_API_KEY",
    baseUrl: "https://api.lumalabs.ai/dream-machine/v1",
    defaultModel: "ray-3",
    models: ["ray-3", "ray-2"],
    cloud: true,
  },
  {
    id: "minimax",
    label: "MiniMax Hailuo / Music",
    kinds: ["video", "music", "voice"],
    envKey: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimaxi.chat/v1",
    defaultModel: "MiniMax-Hailuo-02",
    models: ["MiniMax-Hailuo-02", "music-1.5", "speech-02-hd"],
    cloud: true,
  },
  {
    id: "wan-cloud",
    label: "Wan 2.1 (DashScope Cloud)",
    kinds: ["video", "image"],
    envKey: "WAN_API_KEY",
    baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1",
    defaultModel: "wan2.1-t2v-plus",
    models: ["wan2.1-t2v-plus", "wan2.1-i2v-plus"],
    cloud: true,
  },
  {
    id: "wan-local",
    label: "Wan 2.1 Local (ComfyUI / Local GPU)",
    kinds: ["video", "image"],
    envKey: "VEDIT_WAN_URL",
    altEnvKey: "VEDIT_WAN_CMD",
    defaultModel: "wan-2.1-local",
    models: ["wan-2.1-local", "wan-2.1-i2v-local"],
    cloud: false,
  },
  {
    id: "hunyuan-local",
    label: "Hunyuan Video (Local GPU)",
    kinds: ["video"],
    envKey: "VEDIT_HUNYUAN_URL",
    altEnvKey: "VEDIT_HUNYUAN_CMD",
    defaultModel: "hunyuan-video-720p",
    models: ["hunyuan-video-720p", "hunyuan-video-i2v"],
    cloud: false,
  },
];

export interface GenInput {
  prompt: string;
  kind: GenKind;
  provider?: ProviderId;
  model?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  aspectRatio?: "16:9" | "9:16" | "1:1" | "21:9";
  negativePrompt?: string;
  style?: string;
  seed?: number;
  /** Shot direction camera movement preset. */
  cameraMove?: CameraMoveId | string;
  /** Timed beats inside a generated shot. */
  promptKeyframes?: PromptKeyframe[];
  /** Reference image asset ID for image-to-video / style transfer. */
  imageAssetId?: string;
  /** Reference video asset ID for video-to-video. */
  videoAssetId?: string;
  /** Clip ID on timeline whose ending frame & style anchor this shot (continuity). */
  continuityFromClipId?: string;
  /** Asset ID whose ending frame & style anchor this shot (continuity). */
  continuityFromAssetId?: string;
  /** Insert generated clip directly onto active timeline (default true per PLAN §3.5). */
  insertToTimeline?: boolean;
  /** Optional explicit timeline start time in seconds. */
  start?: number;
  /** Optional explicit target track ID. */
  trackId?: string;
  /** Extra provider-specific parameters. */
  params?: Record<string, unknown>;
}

export interface ProviderAvailability {
  id: ProviderId;
  label: string;
  available: boolean;
  cloud: boolean;
  reason?: string;
  kinds: GenKind[];
  defaultModel: string;
  models: string[];
}

export function isProviderConfigured(p: GenProvider): boolean {
  if (!p.envKey && !p.altEnvKey) return true;
  if (p.envKey && process.env[p.envKey]) return true;
  if (p.altEnvKey && process.env[p.altEnvKey]) return true;
  return false;
}

export function providerAvailability(): ProviderAvailability[] {
  return GEN_PROVIDERS.map((p) => {
    const ok = isProviderConfigured(p);
    const hint = p.altEnvKey ? `set ${p.envKey} or ${p.altEnvKey}` : p.envKey ? `set ${p.envKey} to enable` : undefined;
    return {
      id: p.id,
      label: p.label,
      available: ok,
      cloud: p.cloud,
      reason: ok ? undefined : hint,
      kinds: p.kinds,
      defaultModel: p.defaultModel,
      models: p.models,
    };
  });
}

export function resolveProvider(input: GenInput): GenProvider {
  if (input.provider) {
    const exact = GEN_PROVIDERS.find((p) => p.id === input.provider);
    if (exact) return exact;
  }
  // Auto-select first configured real provider supporting this kind, else stub
  const real = GEN_PROVIDERS.find((p) => p.id !== "stub" && p.kinds.includes(input.kind) && isProviderConfigured(p));
  return real ?? GEN_PROVIDERS[0]!;
}

export function genJobType(kind: GenKind): JobType {
  switch (kind) {
    case "video":
      return "gen.video";
    case "image":
      return "gen.image";
    case "music":
      return "gen.music";
    case "sfx":
      return "gen.sfx";
    case "voice":
      return "gen.voice";
  }
}

// ---------- Shot Direction & Continuity ----------

export interface ContinuityContext {
  sourceClipId?: string;
  sourceAssetId?: string;
  previousPrompt?: string;
  suggestedStart?: number;
  referenceFramePath?: string;
  referenceImageDataUri?: string;
}

/**
 * Inspect timeline clip/asset to build continuity anchor:
 * carries forward previous shot description, calculates exact cut point on timeline,
 * and extracts the final frame with FFmpeg when source media exists on disk.
 */
export async function prepareContinuityContext(
  engine: VeditEngine,
  input: GenInput,
  workDir: string,
): Promise<ContinuityContext> {
  const ctx: ContinuityContext = {};
  let asset: Asset | undefined;
  let frameTime = 0;

  if (input.continuityFromClipId) {
    try {
      const found = engine.findClipAnywhere(input.continuityFromClipId);
      ctx.sourceClipId = found.clip.id;
      ctx.sourceAssetId = found.clip.assetId;
      ctx.suggestedStart = found.clip.start + found.clip.duration;
      asset = engine.findAsset(found.clip.assetId);
      frameTime = Math.max(0, found.clip.out - 0.05);
    } catch {
      /* ignore missing clip */
    }
  } else if (input.continuityFromAssetId) {
    try {
      asset = engine.findAsset(input.continuityFromAssetId);
      ctx.sourceAssetId = asset.id;
      frameTime = Math.max(0, (asset.duration ?? 1) - 0.05);
    } catch {
      /* ignore missing asset */
    }
  }

  // Explicit imageAssetId overrides reference image if provided
  if (input.imageAssetId) {
    try {
      const imgAsset = engine.findAsset(input.imageAssetId);
      const bytes = await readFile(imgAsset.path);
      const mime = imgAsset.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      ctx.referenceFramePath = imgAsset.path;
      ctx.referenceImageDataUri = `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      /* source asset path may be virtual in unit tests */
    }
  }

  if (asset) {
    ctx.previousPrompt = asset.source?.prompt ?? asset.name;
    if (!ctx.referenceImageDataUri) {
      try {
        await stat(asset.path);
        const jpeg = await extractFrame(asset.path, frameTime, { width: 1280 });
        await mkdir(workDir, { recursive: true });
        const framePath = join(workDir, "continuity-last-frame.jpg");
        await writeFile(framePath, jpeg);
        ctx.referenceFramePath = framePath;
        ctx.referenceImageDataUri = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      } catch {
        /* virtual path or audio-only asset — text continuity still applies */
      }
    }
  }

  return ctx;
}

/**
 * Compile user prompt + camera move + style + prompt keyframes + continuity context
 * into a single rich generation prompt understood across cloud & local video models.
 */
export function buildDirectedPrompt(input: GenInput, continuity?: ContinuityContext): string {
  const parts: string[] = [input.prompt.trim()];

  if (input.cameraMove) {
    const preset = CAMERA_MOVES.find((c) => c.id === input.cameraMove);
    parts.push(`Camera movement: ${preset ? preset.directive : input.cameraMove}`);
  }
  if (input.style) {
    parts.push(`Visual style: ${input.style}`);
  }
  if (input.promptKeyframes?.length) {
    const beats = [...input.promptKeyframes]
      .sort((a, b) => a.time - b.time)
      .map((kf) => `[${kf.time.toFixed(1)}s] ${kf.prompt}`)
      .join("; ");
    parts.push(`Shot progression: ${beats}`);
  }
  if (continuity?.previousPrompt) {
    parts.push(`Seamless visual continuity from previous shot ("${continuity.previousPrompt}")`);
  }
  if (input.negativePrompt) {
    parts.push(`Avoid: ${input.negativePrompt}`);
  }
  return parts.join(". ");
}

/**
 * Optional clip transform keyframes matching requested camera move so offline/image shots
 * also visibly move in preview & FFmpeg export.
 */
export function cameraKeyframesForClip(cameraMove: string | undefined, duration: number): Keyframe[] {
  const end = Math.max(0.2, duration);
  switch (cameraMove) {
    case "push-in":
      return [
        { time: 0, property: "scaleX", value: 1 },
        { time: end, property: "scaleX", value: 1.15 },
        { time: 0, property: "scaleY", value: 1 },
        { time: end, property: "scaleY", value: 1.15 },
      ];
    case "pull-out":
      return [
        { time: 0, property: "scaleX", value: 1.15 },
        { time: end, property: "scaleX", value: 1 },
        { time: 0, property: "scaleY", value: 1.15 },
        { time: end, property: "scaleY", value: 1 },
      ];
    case "pan-left":
      return [
        { time: 0, property: "x", value: 40 },
        { time: end, property: "x", value: -40 },
      ];
    case "pan-right":
      return [
        { time: 0, property: "x", value: -40 },
        { time: end, property: "x", value: 40 },
      ];
    case "tilt-up":
      return [
        { time: 0, property: "y", value: 30 },
        { time: end, property: "y", value: -30 },
      ];
    case "tilt-down":
      return [
        { time: 0, property: "y", value: -30 },
        { time: end, property: "y", value: 30 },
      ];
    default:
      return [];
  }
}

export interface InsertedGeneration {
  asset: Asset;
  clip?: Clip;
  trackId?: string;
}

/**
 * Register generated file in Media Pool with prompt/model/camera/continuity metadata
 * and insert clip onto the timeline as one atomic undo step (PLAN §3.5).
 */
export async function insertGeneratedAsset(
  engine: VeditEngine,
  input: GenInput,
  result: {
    path: string;
    provider: ProviderId;
    model: string;
    directedPrompt: string;
    simulated: boolean;
    continuity?: ContinuityContext;
  },
): Promise<InsertedGeneration> {
  const defaultDur = input.duration ?? (input.kind === "image" ? 4 : 5);
  let probed: Awaited<ReturnType<typeof probeMedia>> | undefined;
  try {
    const st = await stat(result.path);
    if (st.size > 0) probed = await probeMedia(result.path);
  } catch {
    /* keep requested dimensions */
  }

  const ext = extname(result.path) || (input.kind === "image" ? ".jpg" : input.kind === "video" ? ".mp4" : ".wav");
  const slug =
    input.prompt
      .trim()
      .slice(0, 24)
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "shot";
  const assetKind =
    input.kind === "video" || input.kind === "image"
      ? "generated"
      : "audio";
  const clipDuration =
    input.kind === "image"
      ? defaultDur
      : probed?.duration && probed.duration > 0.05
        ? probed.duration
        : defaultDur;

  return engine.transaction(`gen.${input.kind}: ${slug}`, () => {
    const asset = engine.addAsset({
      name: `gen-${slug}${ext}`,
      kind: assetKind,
      path: result.path,
      duration: input.kind === "image" ? undefined : clipDuration,
      width: probed?.width ?? input.width ?? (assetKind === "generated" ? 1920 : undefined),
      height: probed?.height ?? input.height ?? (assetKind === "generated" ? 1080 : undefined),
      fps: input.kind === "video" ? (probed?.fps ?? input.fps ?? 24) : undefined,
      sizeBytes: probed?.sizeBytes,
      videoCodec: probed?.videoCodec,
      audioCodec: probed?.audioCodec,
      hasAudio: probed?.hasAudio,
      source: {
        provider: result.provider,
        model: result.model,
        prompt: input.prompt,
        directedPrompt: result.directedPrompt,
        cameraMove: input.cameraMove,
        seed: input.seed,
        continuityFrom: result.continuity?.sourceClipId ?? result.continuity?.sourceAssetId,
        simulated: result.simulated,
      },
    });

    if (input.insertToTimeline === false) {
      return { asset };
    }

    const seq = engine.activeSequence();
    const targetKind: TrackKind = input.kind === "music" || input.kind === "sfx" || input.kind === "voice" ? "audio" : "video";
    let track = input.trackId
      ? seq.tracks.find((t) => t.id === input.trackId)
      : seq.tracks.find((t) => t.kind === targetKind);
    if (!track) {
      track = engine.addTrack(targetKind, targetKind === "video" ? "V1" : "A1");
    }

    const trackEnd = track.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    const start =
      input.start ??
      (result.continuity?.suggestedStart != null ? Math.max(trackEnd, result.continuity.suggestedStart) : trackEnd);

    const clip = engine.addClip({
      trackId: track.id,
      assetId: asset.id,
      name: asset.name,
      start,
      duration: clipDuration,
      in: 0,
      out: clipDuration,
    });

    if (result.simulated && input.cameraMove && targetKind === "video") {
      const kfs = cameraKeyframesForClip(input.cameraMove, clipDuration);
      if (kfs.length > 0) engine.addKeyframes(clip.id, kfs, track.id);
    }

    return { asset, clip: engine.findClip(track.id, clip.id).clip, trackId: track.id };
  });
}

// ---------- Cloud & Local Provider Transport ----------

export interface CallProviderOptions {
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  continuity?: ContinuityContext;
  onProgress?: (pct: number, detail?: string) => void;
}

export interface CallProviderResult {
  path: string;
  provider: ProviderId;
  model: string;
  directedPrompt: string;
  simulated: boolean;
}

function defaultExtension(kind: GenKind): string {
  switch (kind) {
    case "image":
      return ".jpg";
    case "video":
      return ".mp4";
    case "music":
    case "sfx":
    case "voice":
      return ".wav";
  }
}

function extractMediaUrl(payload: unknown): string | undefined {
  if (!payload) return undefined;
  if (typeof payload === "string" && /^https?:\/\//i.test(payload)) return payload;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractMediaUrl(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    // Priority keys used across fal.ai, Replicate, Veo, Runway, Luma, Kling, MiniMax, Wan
    for (const key of [
      "video",
      "audio_file",
      "audio",
      "image",
      "images",
      "output",
      "outputs",
      "result",
      "results",
      "data",
      "works",
      "generatedSamples",
      "generateVideoResponse",
      "response",
      "url",
      "uri",
      "video_url",
      "image_url",
      "audio_url",
      "download_url",
    ]) {
      if (key in obj) {
        const val = obj[key];
        if (typeof val === "string" && /^https?:\/\//i.test(val)) return val;
        const nested = extractMediaUrl(val);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

async function downloadToFile(
  url: string,
  destDir: string,
  kind: GenKind,
  fetchFn: typeof fetch,
  headers?: Record<string, string>,
): Promise<string> {
  const res = await fetchFn(url, headers ? { headers } : undefined);
  if (!res.ok) {
    throw new Error(`media download failed (${res.status}) from ${url}`);
  }
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  let ext = defaultExtension(kind);
  if (ct.includes("png") || url.toLowerCase().includes(".png")) ext = ".png";
  else if (ct.includes("jpeg") || ct.includes("jpg")) ext = ".jpg";
  else if (ct.includes("mpeg") || url.toLowerCase().endsWith(".mp3")) ext = ".mp3";
  else if (ct.includes("wav") || url.toLowerCase().endsWith(".wav")) ext = ".wav";
  else if (ct.includes("mp4") || url.toLowerCase().includes(".mp4")) ext = ".mp4";

  const outPath = join(destDir, `output${ext}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, bytes);
  return outPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callFalQueue(
  input: GenInput,
  directedPrompt: string,
  model: string,
  destDir: string,
  opts: CallProviderOptions,
): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const key = process.env.FAL_KEY!;
  const base = (process.env.VEDIT_FAL_BASE_URL ?? "https://queue.fal.run").replace(/\/+$/, "");
  const headers = {
    Authorization: `Key ${key}`,
    "Content-Type": "application/json",
  };
  const body: Record<string, unknown> = {
    prompt: directedPrompt,
    ...(input.duration != null ? { duration: input.duration } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    ...(input.seed != null ? { seed: input.seed } : {}),
    ...(opts.continuity?.referenceImageDataUri ? { image_url: opts.continuity.referenceImageDataUri } : {}),
    ...(input.params ?? {}),
  };

  opts.onProgress?.(15, `submitting to fal.ai (${model})`);
  const submitRes = await fetchFn(`${base}/${model}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!submitRes.ok) {
    throw new Error(`fal.ai submit failed (${submitRes.status}): ${await submitRes.text()}`);
  }
  const submitted = (await submitRes.json()) as Record<string, unknown>;

  // Immediate result shortcut
  const directUrl = extractMediaUrl(submitted);
  if (directUrl && !submitted.status_url) {
    opts.onProgress?.(85, "downloading generated media");
    return downloadToFile(directUrl, destDir, input.kind, fetchFn);
  }

  const requestId = String(submitted.request_id ?? "");
  const statusUrl =
    typeof submitted.status_url === "string"
      ? submitted.status_url
      : `${base}/${model}/requests/${requestId}/status`;
  const responseUrl =
    typeof submitted.response_url === "string"
      ? submitted.response_url
      : `${base}/${model}/requests/${requestId}`;

  const pollMs = opts.pollIntervalMs ?? 1500;
  const deadline = Date.now() + (opts.maxWaitMs ?? 300_000);
  let polls = 0;

  while (Date.now() < deadline) {
    const stRes = await fetchFn(statusUrl, { headers: { Authorization: `Key ${key}` } });
    if (!stRes.ok) {
      throw new Error(`fal.ai status poll failed (${stRes.status}): ${await stRes.text()}`);
    }
    const st = (await stRes.json()) as Record<string, unknown>;
    const status = String(st.status ?? "").toUpperCase();
    polls++;
    if (status === "COMPLETED" || status === "SUCCEEDED" || status === "DONE") {
      opts.onProgress?.(80, "fetching completed result");
      const finalUrlFromStatus = extractMediaUrl(st.response ?? st.output);
      if (finalUrlFromStatus) {
        return downloadToFile(finalUrlFromStatus, destDir, input.kind, fetchFn);
      }
      const resResp = await fetchFn(responseUrl, { headers: { Authorization: `Key ${key}` } });
      if (!resResp.ok) {
        throw new Error(`fal.ai result fetch failed (${resResp.status}): ${await resResp.text()}`);
      }
      const resultJson = await resResp.json();
      const mediaUrl = extractMediaUrl(resultJson);
      if (!mediaUrl) throw new Error("fal.ai response did not contain a media URL");
      opts.onProgress?.(90, "downloading generated media");
      return downloadToFile(mediaUrl, destDir, input.kind, fetchFn);
    }
    if (status === "FAILED" || status === "ERROR" || status === "CANCELED" || status === "CANCELLED") {
      throw new Error(`fal.ai generation failed: ${String(st.error ?? status)}`);
    }
    opts.onProgress?.(Math.min(75, 20 + polls * 8), `fal.ai ${status.toLowerCase() || "queued"}`);
    await sleep(pollMs);
  }
  throw new Error("fal.ai generation timed out waiting for queue completion");
}

async function callReplicate(
  input: GenInput,
  directedPrompt: string,
  model: string,
  destDir: string,
  opts: CallProviderOptions,
): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const token = process.env.REPLICATE_API_TOKEN!;
  const base = (process.env.VEDIT_REPLICATE_BASE_URL ?? "https://api.replicate.com/v1").replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const endpoint = model.includes("/") ? `${base}/models/${model}/predictions` : `${base}/predictions`;
  const submitRes = await fetchFn(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(model.includes("/") ? {} : { version: model }),
      input: {
        prompt: directedPrompt,
        ...(input.duration != null ? { duration: input.duration } : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        ...(opts.continuity?.referenceImageDataUri ? { first_frame_image: opts.continuity.referenceImageDataUri } : {}),
        ...(input.params ?? {}),
      },
    }),
  });
  if (!submitRes.ok) {
    throw new Error(`Replicate submit failed (${submitRes.status}): ${await submitRes.text()}`);
  }
  let pred = (await submitRes.json()) as Record<string, unknown>;
  const pollUrl =
    (pred.urls as Record<string, string> | undefined)?.get ?? `${base}/predictions/${String(pred.id)}`;
  const pollMs = opts.pollIntervalMs ?? 1500;
  const deadline = Date.now() + (opts.maxWaitMs ?? 300_000);

  while (pred.status === "starting" || pred.status === "processing" || pred.status === "queued") {
    if (Date.now() >= deadline) throw new Error("Replicate prediction timed out");
    opts.onProgress?.(50, `Replicate ${String(pred.status)}`);
    await sleep(pollMs);
    const r = await fetchFn(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Replicate poll failed (${r.status})`);
    pred = (await r.json()) as Record<string, unknown>;
  }

  if (pred.status !== "succeeded") {
    throw new Error(`Replicate prediction ${String(pred.status)}: ${String(pred.error ?? "unknown error")}`);
  }
  const mediaUrl = extractMediaUrl(pred.output);
  if (!mediaUrl) throw new Error("Replicate output did not include a media URL");
  opts.onProgress?.(90, "downloading generated media");
  return downloadToFile(mediaUrl, destDir, input.kind, fetchFn);
}

async function callGoogleVeo(
  input: GenInput,
  directedPrompt: string,
  model: string,
  destDir: string,
  opts: CallProviderOptions,
): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const apiKey = process.env.GOOGLE_API_KEY!;
  const base = (process.env.VEDIT_GOOGLE_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    "",
  );
  const instance: Record<string, unknown> = { prompt: directedPrompt };
  if (opts.continuity?.referenceImageDataUri) {
    const [, b64 = ""] = opts.continuity.referenceImageDataUri.split(",");
    instance.image = { bytesBase64Encoded: b64, mimeType: "image/jpeg" };
  }
  const submitRes = await fetchFn(`${base}/models/${model}:predictLongRunning?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.duration != null ? { durationSeconds: input.duration } : {}),
        ...(input.params ?? {}),
      },
    }),
  });
  if (!submitRes.ok) {
    throw new Error(`Google Veo submit failed (${submitRes.status}): ${await submitRes.text()}`);
  }
  let op = (await submitRes.json()) as Record<string, unknown>;
  const pollMs = opts.pollIntervalMs ?? 2000;
  const deadline = Date.now() + (opts.maxWaitMs ?? 300_000);

  while (!op.done) {
    if (Date.now() >= deadline) throw new Error("Google Veo operation timed out");
    opts.onProgress?.(55, "Google Veo rendering");
    await sleep(pollMs);
    const opName = String(op.name ?? "").replace(/^\/+/, "");
    const r = await fetchFn(`${base}/${opName}?key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) throw new Error(`Google Veo poll failed (${r.status})`);
    op = (await r.json()) as Record<string, unknown>;
  }
  if (op.error) {
    throw new Error(`Google Veo failed: ${JSON.stringify(op.error)}`);
  }
  const mediaUrl = extractMediaUrl(op.response ?? op);
  if (!mediaUrl) throw new Error("Google Veo response missing generated video URI");
  const sep = mediaUrl.includes("?") ? "&" : "?";
  const authedUrl = mediaUrl.includes("key=") ? mediaUrl : `${mediaUrl}${sep}key=${encodeURIComponent(apiKey)}`;
  return downloadToFile(authedUrl, destDir, input.kind, fetchFn);
}

async function callDirectCloudProvider(
  provider: GenProvider,
  input: GenInput,
  directedPrompt: string,
  model: string,
  destDir: string,
  opts: CallProviderOptions,
): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const apiKey = provider.envKey ? process.env[provider.envKey] ?? "" : "";
  const base = (process.env.VEDIT_PROVIDER_URL ?? provider.baseUrl ?? "").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  const submitRes = await fetchFn(`${base}/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      kind: input.kind,
      prompt: directedPrompt,
      duration: input.duration,
      aspect_ratio: input.aspectRatio,
      image: opts.continuity?.referenceImageDataUri,
      ...(input.params ?? {}),
    }),
  });
  if (!submitRes.ok) {
    throw new Error(`${provider.label} submit failed (${submitRes.status}): ${await submitRes.text()}`);
  }
  let body = (await submitRes.json()) as Record<string, unknown>;
  const direct = extractMediaUrl(body);
  if (direct) return downloadToFile(direct, destDir, input.kind, fetchFn);

  const taskId = String(body.id ?? body.task_id ?? "");
  const statusUrl =
    typeof body.status_url === "string" ? body.status_url : `${base}/generations/${encodeURIComponent(taskId)}`;
  const pollMs = opts.pollIntervalMs ?? 1500;
  const deadline = Date.now() + (opts.maxWaitMs ?? 300_000);

  while (Date.now() < deadline) {
    const st = String(body.status ?? body.state ?? "").toLowerCase();
    if (st === "succeeded" || st === "completed" || st === "done") {
      const url = extractMediaUrl(body);
      if (!url) throw new Error(`${provider.label} finished without output URL`);
      return downloadToFile(url, destDir, input.kind, fetchFn);
    }
    if (st === "failed" || st === "error" || st === "canceled" || st === "cancelled") {
      throw new Error(`${provider.label} failed: ${String(body.error ?? st)}`);
    }
    await sleep(pollMs);
    const r = await fetchFn(statusUrl, { headers });
    if (!r.ok) throw new Error(`${provider.label} poll failed (${r.status})`);
    body = (await r.json()) as Record<string, unknown>;
  }
  throw new Error(`${provider.label} timed out`);
}

async function callLocalRunner(
  provider: GenProvider,
  input: GenInput,
  directedPrompt: string,
  model: string,
  destDir: string,
  opts: CallProviderOptions,
): Promise<string> {
  const cmdVar = provider.id === "wan-local" ? process.env.VEDIT_WAN_CMD : process.env.VEDIT_HUNYUAN_CMD;
  if (cmdVar) {
    const outPath = join(destDir, `output${defaultExtension(input.kind)}`);
    const ok = await runLocalCommand(cmdVar, outPath, input, directedPrompt, model, opts.continuity?.referenceFramePath);
    if (!ok) throw new Error(`Local generator command failed: ${cmdVar}`);
    return outPath;
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const rawUrl = (
    (provider.id === "wan-local" ? process.env.VEDIT_WAN_URL : process.env.VEDIT_HUNYUAN_URL) ?? ""
  ).replace(/\/+$/, "");

  // Support ComfyUI API (/prompt → /history/{id} → /view) when endpoint accepts /prompt or has Comfy workflow in params
  if (input.params?.comfyWorkflow) {
    const pRes = await fetchFn(`${rawUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: input.params.comfyWorkflow }),
    });
    if (!pRes.ok) throw new Error(`ComfyUI /prompt failed (${pRes.status})`);
    const { prompt_id } = (await pRes.json()) as { prompt_id: string };
    const pollMs = opts.pollIntervalMs ?? 1500;
    const deadline = Date.now() + (opts.maxWaitMs ?? 600_000);
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const hRes = await fetchFn(`${rawUrl}/history/${encodeURIComponent(prompt_id)}`);
      if (!hRes.ok) continue;
      const hist = (await hRes.json()) as Record<string, { outputs?: Record<string, Record<string, Array<{ filename: string; subfolder?: string; type?: string }>>> }>;
      const entry = hist[prompt_id];
      if (!entry?.outputs) continue;
      for (const nodeOut of Object.values(entry.outputs)) {
        for (const list of Object.values(nodeOut)) {
          if (Array.isArray(list) && list[0]?.filename) {
            const f = list[0];
            const q = new URLSearchParams({
              filename: f.filename,
              subfolder: f.subfolder ?? "",
              type: f.type ?? "output",
            });
            return downloadToFile(`${rawUrl}/view?${q.toString()}`, destDir, input.kind, fetchFn);
          }
        }
      }
    }
    throw new Error("ComfyUI local generation timed out");
  }

  // Standard local inference HTTP endpoint (POST {url}/generate or {url})
  const endpoint = rawUrl.endsWith("/generate") ? rawUrl : `${rawUrl}/generate`;
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      kind: input.kind,
      prompt: directedPrompt,
      duration: input.duration ?? 5,
      width: input.width ?? 1280,
      height: input.height ?? 720,
      fps: input.fps ?? 24,
      seed: input.seed,
      reference_image: opts.continuity?.referenceImageDataUri,
      ...(input.params ?? {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Local model server failed (${res.status}): ${await res.text()}`);
  }
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    const outPath = join(destDir, `output${defaultExtension(input.kind)}`);
    await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    return outPath;
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.path === "string") {
    const outPath = join(destDir, `output${extname(data.path) || defaultExtension(input.kind)}`);
    await copyFile(data.path, outPath);
    return outPath;
  }
  if (typeof data.base64 === "string") {
    const outPath = join(destDir, `output${defaultExtension(input.kind)}`);
    await writeFile(outPath, Buffer.from(data.base64, "base64"));
    return outPath;
  }
  const mediaUrl = extractMediaUrl(data);
  if (!mediaUrl) throw new Error("Local model server response contained no output path, base64, or URL");
  const resolved = mediaUrl.startsWith("/") ? `${rawUrl}${mediaUrl}` : mediaUrl;
  return downloadToFile(resolved, destDir, input.kind, fetchFn);
}

function runLocalCommand(
  cmdLine: string,
  outPath: string,
  input: GenInput,
  directedPrompt: string,
  model: string,
  refFramePath?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmdLine, {
      shell: true,
      stdio: "ignore",
      env: {
        ...process.env,
        VEDIT_GEN_OUT: outPath,
        VEDIT_GEN_PROMPT: directedPrompt,
        VEDIT_GEN_MODEL: model,
        VEDIT_GEN_KIND: input.kind,
        VEDIT_GEN_DURATION: String(input.duration ?? 5),
        VEDIT_GEN_WIDTH: String(input.width ?? 1280),
        VEDIT_GEN_HEIGHT: String(input.height ?? 720),
        VEDIT_GEN_REF_IMAGE: refFramePath ?? "",
      },
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// ---------- Offline Playable FFmpeg Media Synth ----------

export async function createPlaceholderMedia(
  input: GenInput,
  jobId: string,
  dataDir: string,
): Promise<string> {
  const dir = join(dataDir, "gen", jobId);
  await mkdir(dir, { recursive: true });
  const kind = input.kind;
  const w = input.width ?? 640;
  const h = input.height ?? 360;
  const fps = input.fps ?? 24;
  const dur = Math.max(0.5, input.duration ?? (kind === "image" ? 1 : 4));
  const color = colorFromPrompt(input.prompt);

  if (kind === "image") {
    const out = join(dir, "output.jpg");
    const ok = await spawnOk(resolveFfmpeg(), [
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=${w}x${h}:d=1`,
      "-frames:v",
      "1",
      "-y",
      out,
    ]);
    if (ok) return out;
    const tiny = Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEA",
      "base64",
    );
    await writeFile(out, tiny);
    return out;
  }

  if (kind === "music" || kind === "sfx" || kind === "voice") {
    const out = join(dir, `${kind}.wav`);
    const baseFreq = kind === "music" ? 330 : kind === "sfx" ? 165 : 220;
    const ok = await spawnOk(resolveFfmpeg(), [
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${baseFreq}:duration=${dur}`,
      "-ar",
      "22050",
      "-ac",
      "1",
      "-y",
      out,
    ]);
    if (ok) return out;
    await writeFile(out, Buffer.alloc(0));
    return out;
  }

  const out = join(dir, "output.mp4");
  const ok = await spawnOk(resolveFfmpeg(), [
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${w}x${h}:r=${fps}:d=${dur}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${dur}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    out,
  ]);
  if (ok) return out;
  await writeFile(out, Buffer.alloc(0));
  return out;
}

function resolveFfmpeg(): string {
  try {
    return ffmpegPath();
  } catch {
    return process.env.VEDIT_FFMPEG || "ffmpeg";
  }
}

function spawnOk(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: "ignore" });
      let done = false;
      p.on("error", () => {
        if (!done) {
          done = true;
          resolve(false);
        }
      });
      p.on("close", (code) => {
        if (!done) {
          done = true;
          resolve(code === 0);
        }
      });
      setTimeout(() => {
        if (!done) {
          try {
            p.kill();
          } catch {
            /* ignore */
          }
          done = true;
          resolve(false);
        }
      }, 15_000);
    } catch {
      resolve(false);
    }
  });
}

function colorFromPrompt(prompt: string): string {
  let h = 0;
  for (let i = 0; i < prompt.length; i++) h = (h * 31 + prompt.charCodeAt(i)) | 0;
  const palette = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#059669", "#0891b2", "#4f46e5", "#d97706"];
  return palette[Math.abs(h) % palette.length]!;
}

/**
 * Execute generation through selected provider (cloud queue/poll/download, local runner, or offline FFmpeg synth)
 * and persist sidecar metadata file `provider.json`.
 */
export async function callProvider(
  provider: GenProvider,
  input: GenInput,
  jobId: string,
  dataDir: string,
  opts: CallProviderOptions = {},
): Promise<string> {
  const destDir = join(dataDir, "gen", jobId);
  await mkdir(destDir, { recursive: true });
  const model = input.model ?? provider.defaultModel;
  const directedPrompt = buildDirectedPrompt(input, opts.continuity);

  const isStub = provider.id === "stub";
  const hasKey = isProviderConfigured(provider);

  if (isStub || !hasKey) {
    const out = await createPlaceholderMedia(input, jobId, dataDir);
    await writeFile(
      join(destDir, "provider.json"),
      JSON.stringify(
        {
          provider: provider.id,
          model,
          prompt: input.prompt,
          directedPrompt,
          cameraMove: input.cameraMove ?? null,
          continuityFrom: opts.continuity?.sourceClipId ?? opts.continuity?.sourceAssetId ?? null,
          simulated: true,
        },
        null,
        2,
      ),
    );
    return out;
  }

  let outPath: string;
  switch (provider.id) {
    case "fal":
      outPath = await callFalQueue(input, directedPrompt, model, destDir, opts);
      break;
    case "replicate":
      outPath = await callReplicate(input, directedPrompt, model, destDir, opts);
      break;
    case "google":
      outPath = await callGoogleVeo(input, directedPrompt, model, destDir, opts);
      break;
    case "wan-local":
    case "hunyuan-local":
      outPath = await callLocalRunner(provider, input, directedPrompt, model, destDir, opts);
      break;
    default:
      outPath = await callDirectCloudProvider(provider, input, directedPrompt, model, destDir, opts);
      break;
  }

  await writeFile(
    join(destDir, "provider.json"),
    JSON.stringify(
      {
        provider: provider.id,
        model,
        prompt: input.prompt,
        directedPrompt,
        cameraMove: input.cameraMove ?? null,
        continuityFrom: opts.continuity?.sourceClipId ?? opts.continuity?.sourceAssetId ?? null,
        simulated: false,
      },
      null,
      2,
    ),
  );
  return outPath;
}

/** Default timeline insertion end helper for UI/CLI previews. */
export function nextTimelineSlot(engine: VeditEngine): number {
  return sequenceDuration(engine.activeSequence());
}
