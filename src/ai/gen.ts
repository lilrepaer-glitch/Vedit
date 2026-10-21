// F4 — Vedit Gen (PLAN.md §3.5): unified generation layer
// Cloud + local providers behind a single interface.
// F0-F3 had stub gen only; F4 introduces provider abstraction and async jobs.
//
// Supported in 2026 (per PLAN):
// - Cloud native: Google Veo 3.1, Kling 3.0, Seedance 2.x, Runway Gen-4.5, Luma Ray 3, MiniMax Hailuo/H3, Wan
// - Aggregators: fal.ai, Replicate (one key covers many models)
// - Local OSS: Wan (ComfyUI/Wan), Hunyuan Video (Tencent) — optional, needs powerful GPU
//
// All providers go through the same Job system (queued → running → done/failed)
// and the produced asset is inserted into the timeline automatically.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { JobType } from "../core/types.js";

export type GenKind = "video" | "image" | "music" | "sfx" | "voice";

export type ProviderId =
  | "stub" // always available — generates FFmpeg placeholder (color/testsrc)
  | "fal" // fal.ai aggregator
  | "replicate" // replicate.com aggregator
  | "google" // Veo 3.1 direct
  | "kling" // Kling 3.0
  | "seedance" // Seedance 2.x
  | "runway" // Runway Gen-4.5
  | "luma" // Luma Ray 3
  | "minimax" // MiniMax Hailuo/H3
  | "wan-cloud" // Wan cloud
  | "wan-local" // Wan local (ComfyUI)
  | "hunyuan-local"; // Hunyuan Video local

export interface GenProvider {
  id: ProviderId;
  label: string;
  kinds: GenKind[];
  // env var that must be set for this provider to be "available"
  envKey?: string;
  // default model id for this provider
  defaultModel: string;
  // models offered by this provider
  models: string[];
  // whether provider requires cloud reachability
  cloud: boolean;
}

export const GEN_PROVIDERS: GenProvider[] = [
  {
    id: "stub",
    label: "Vedit Stub (offline placeholder)",
    kinds: ["video", "image", "music", "sfx", "voice"],
    defaultModel: "stub-v0",
    models: ["stub-v0"],
    cloud: false,
  },
  {
    id: "fal",
    label: "fal.ai (aggregator — Veo/Kling/Seedance/Wan/…)",
    kinds: ["video", "image", "music"],
    envKey: "FAL_KEY",
    defaultModel: "fal/veo3.1",
    models: ["fal/veo3.1", "fal/kling-3.0", "fal/seedance-2", "fal/wan-2.1", "fal/luma-ray3"],
    cloud: true,
  },
  {
    id: "replicate",
    label: "Replicate (aggregator)",
    kinds: ["video", "image", "music"],
    envKey: "REPLICATE_API_TOKEN",
    defaultModel: "replicate/runway-gen4.5",
    models: ["replicate/runway-gen4.5", "replicate/luma-ray3", "replicate/minimax-hailuo"],
    cloud: true,
  },
  { id: "google", label: "Google Veo 3.1", kinds: ["video"], envKey: "GOOGLE_API_KEY", defaultModel: "veo-3.1", models: ["veo-3.1", "veo-3.1-fast"], cloud: true },
  { id: "kling", label: "Kling 3.0 (Kuaishou)", kinds: ["video","image"], envKey: "KLING_API_KEY", defaultModel: "kling-3.0", models: ["kling-3.0", "kling-2.1"], cloud: true },
  { id: "seedance", label: "Seedance 2.x (ByteDance)", kinds: ["video"], envKey: "SEEDANCE_API_KEY", defaultModel: "seedance-2.0", models: ["seedance-2.0"], cloud: true },
  { id: "runway", label: "Runway Gen-4.5", kinds: ["video","image"], envKey: "RUNWAY_API_KEY", defaultModel: "gen-4.5", models: ["gen-4.5", "gen-4-turbo"], cloud: true },
  { id: "luma", label: "Luma Ray 3 (Dream Machine)", kinds: ["video"], envKey: "LUMA_API_KEY", defaultModel: "ray-3", models: ["ray-3", "ray-2"], cloud: true },
  { id: "minimax", label: "MiniMax Hailuo/H3", kinds: ["video"], envKey: "MINIMAX_API_KEY", defaultModel: "hailuo-02", models: ["hailuo-02", "hailuo-h3"], cloud: true },
  { id: "wan-cloud", label: "Wan 2.1 (Alibaba Cloud)", kinds: ["video","image"], envKey: "WAN_API_KEY", defaultModel: "wan-2.1-t2v", models: ["wan-2.1-t2v", "wan-2.1-i2v"], cloud: true },
  { id: "wan-local", label: "Wan Local (ComfyUI / OSS)", kinds: ["video","image"], envKey: "VEDIT_WAN_URL", defaultModel: "wan-2.1-local", models: ["wan-2.1-local"], cloud: false },
  { id: "hunyuan-local", label: "Hunyuan Video (Tencent, local)", kinds: ["video"], envKey: "VEDIT_HUNYUAN_URL", defaultModel: "hunyuan-720p", models: ["hunyuan-720p"], cloud: false },
];

export interface GenInput {
  prompt: string;
  kind: GenKind;
  provider?: ProviderId;
  model?: string;
  duration?: number; // seconds, video/music only
  width?: number;
  height?: number;
  fps?: number;
  // optional image-to-video or video-to-video sources
  imageAssetId?: string;
  videoAssetId?: string;
  // extra model params (camera move, style, etc.)
  params?: Record<string, unknown>;
}

export interface ProviderAvailability {
  id: ProviderId;
  label: string;
  available: boolean;
  reason?: string;
  kinds: GenKind[];
  defaultModel: string;
  models: string[];
}

export function providerAvailability(): ProviderAvailability[] {
  return GEN_PROVIDERS.map((p) => {
    if (!p.envKey) return { id: p.id, label: p.label, available: true, kinds: p.kinds, defaultModel: p.defaultModel, models: p.models };
    const ok = !!process.env[p.envKey];
    return {
      id: p.id,
      label: p.label,
      available: ok,
      reason: ok ? undefined : `set ${p.envKey} to enable`,
      kinds: p.kinds,
      defaultModel: p.defaultModel,
      models: p.models,
    };
  });
}

export function resolveProvider(input: GenInput): GenProvider {
  const want = (input.provider ?? "stub") as ProviderId;
  const found = GEN_PROVIDERS.find((p) => p.id === want);
  if (found) return found;
  // fallback: pick first provider that supports this kind and is available
  const avail = providerAvailability().find((a) => a.available && a.kinds.includes(input.kind));
  if (avail) return GEN_PROVIDERS.find((p) => p.id === avail.id)!;
  return GEN_PROVIDERS[0]!;
}

// --- Job helpers ---

export interface GenJobMeta {
  kind: GenKind;
  provider: ProviderId;
  model: string;
  prompt: string;
  simulated: boolean;
  dataDir: string; // where to write placeholder media
}

export function genJobType(kind: GenKind): JobType {
  switch (kind) {
    case "video": return "gen.video";
    case "image": return "gen.image";
    case "music": return "gen.music";
    case "sfx": return "gen.sfx";
    case "voice": return "gen.voice";
  }
}

/**
 * Create a placeholder media file for the given job (FFmpeg if available).
 * Returns absolute path to the generated file.
 */
export async function createPlaceholderMedia(
  input: GenInput,
  jobId: string,
  dataDir: string,
): Promise<string> {
  const dir = join(dataDir, "gen", jobId);
  await mkdir(dir, { recursive: true });
  const kind = input.kind;
  const w = input.width ?? 1920;
  const h = input.height ?? 1080;
  const fps = input.fps ?? 24;
  const dur = input.duration ?? (kind === "video" ? 5 : 3);

  if (kind === "image") {
    // Generate a JPEG placeholder via FFmpeg (color + text if possible), fallback to tiny JPEG stub
    const out = join(dir, "output.jpg");
    const ok = await tryFfmpegImage(out, w, h, input.prompt);
    if (ok) return out;
    // fallback: 1x1 jpeg bytes written manually (smallest valid)
    const tiny = Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEA",
      "base64"
    );
    await writeFile(out, tiny);
    return out;
  }

  // video / music / sfx / voice → MP4 with color + sine audio (for video, audio track; for audio-only, still MP4 for preview)
  const out = join(dir, kind === "video" ? "output.mp4" : `${kind}.mp4`);
  const ok = await tryFfmpegVideo(out, w, h, fps, dur, input.prompt);
  if (ok) return out;
  // fallback: empty file (engine will treat as asset with path)
  await writeFile(out, Buffer.alloc(0));
  return out;
}

async function tryFfmpegImage(out: string, w: number, h: number, prompt: string): Promise<boolean> {
  const ffmpeg = process.env.VEDIT_FFMPEG || "ffmpeg";
  // Use color source; add text via drawtext if font available — keep simple
  const color = colorFromPrompt(prompt);
  const args = [
    "-f", "lavfi",
    "-i", `color=c=${color}:s=${w}x${h}:d=1`,
    "-frames:v", "1",
    "-y", out,
  ];
  return await spawnOk(ffmpeg, args);
}

async function tryFfmpegVideo(out: string, w: number, h: number, fps: number, dur: number, prompt: string): Promise<boolean> {
  const ffmpeg = process.env.VEDIT_FFMPEG || "ffmpeg";
  const color = colorFromPrompt(prompt);
  // testsrc + sine audio = visible placeholder + audible
  const args = [
    "-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h}:r=${fps}:d=${dur}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}`,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    "-y", out,
  ];
  return await spawnOk(ffmpeg, args);
}

function spawnOk(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: "ignore" });
      let done = false;
      p.on("error", () => { if (!done) { done = true; resolve(false); } });
      p.on("close", (code) => { if (!done) { done = true; resolve(code === 0); } });
      setTimeout(() => { if (!done) { try { p.kill(); } catch {} done = true; resolve(false); } }, 15000);
    } catch { resolve(false); }
  });
}

function colorFromPrompt(prompt: string): string {
  // deterministic color from prompt hash (so same prompt = same placeholder color)
  let h = 0;
  for (let i = 0; i < prompt.length; i++) h = (h * 31 + prompt.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsv(${hue},80%,85%)`;
}

// Call real provider APIs when env keys are set.
// For now these do a simulated delay then return a placeholder path.
// In a full F4 implementation they'd POST to fal.ai / Replicate / Google etc,
// poll for completion and download the result.
export async function callProvider(
  provider: GenProvider,
  input: GenInput,
  jobId: string,
  dataDir: string,
): Promise<string> {
  const isStub = provider.id === "stub";
  const hasKey = !provider.envKey || !!process.env[provider.envKey];
  if (isStub || !hasKey) {
    // Simulate network latency for realism (800ms)
    await new Promise((r) => setTimeout(r, 800));
    return createPlaceholderMedia(input, jobId, dataDir);
  }

  // Real provider path — scaffold (does not require keys in CI)
  // Example for fal.ai:
  //   POST https://queue.fal.run/fal-ai/veo3.1 with { prompt, duration, aspect_ratio }
  //   Poll GET https://queue.fal.run/fal-ai/veo3.1/requests/{id}/status
  //   Download result video → dataDir
  // For now we log intent and still produce placeholder, but with provider tag.
  console.log(`[Vedit Gen] provider=${provider.id} model=${input.model ?? provider.defaultModel} prompt="${input.prompt.slice(0,80)}" job=${jobId}`);
  await new Promise((r) => setTimeout(r, 1200));
  const out = await createPlaceholderMedia(input, jobId, dataDir);
  // Append provider info to sidecar meta file for debugging
  try {
    await writeFile(join(dataDir, "gen", jobId, "provider.json"), JSON.stringify({ provider: provider.id, model: input.model ?? provider.defaultModel, prompt: input.prompt }, null, 2));
  } catch {}
  return out;
}
