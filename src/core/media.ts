// Mediální engine F1 — skutečné dekódování přes FFmpeg/ffprobe
// (PLAN.md §13: F1 — dekódování médií, reálný export)

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export function ffmpegPath(): string {
  return process.env.VEDIT_FFMPEG ?? (require_("@ffmpeg-installer/ffmpeg") as { path: string }).path;
}

export function ffprobePath(): string {
  return process.env.VEDIT_FFPROBE ?? (require_("@ffprobe-installer/ffprobe") as { path: string }).path;
}

export interface ProbeResult {
  path: string;
  sizeBytes: number;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/** Spustí binárku; sbírá stdout/stderr. */
export function run(
  bin: string,
  args: string[],
  opts: { onStdout?: (chunk: Buffer) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out.push(c);
      opts.onStdout?.(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout: Buffer.concat(out), stderr: err, code: code ?? -1 });
    });
  });
}

function parseFps(rate?: string): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return undefined;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : undefined;
}

/** Skutečné metadata média přes ffprobe. */
export async function probeMedia(path: string): Promise<ProbeResult> {
  const res = await run(ffprobePath(), [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  if (res.code !== 0) {
    throw new Error(`ffprobe selhal pro ${path}: ${res.stderr.trim().split("\n").pop()}`);
  }
  const data = JSON.parse(res.stdout.toString() || "{}") as {
    format?: { duration?: string; size?: string; bit_rate?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      duration?: string;
    }>;
  };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration =
    Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0) || 0;
  const sizeBytes = Number(data.format?.size ?? 0) || (await stat(path)).size;
  return {
    path,
    sizeBytes,
    duration,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width,
    height: video?.height,
    fps: parseFps(video?.r_frame_rate) ?? parseFps(video?.avg_frame_rate),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    bitrate: Number(data.format?.bit_rate ?? 0) || undefined,
  };
}

/** Skutečný JPEG snímek z videa v čase t (sekundy). */
export async function extractFrame(
  path: string,
  t: number,
  opts: { width?: number; quality?: number } = {},
): Promise<Buffer> {
  const width = opts.width ?? 640;
  const quality = opts.quality ?? 3; // 2..31 (mjpeg qscale)
  const res = await run(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error",
    "-ss", Math.max(0, t).toFixed(3),
    "-i", path,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-c:v", "mjpeg",
    "-q:v", String(quality),
    "-f", "image2pipe", "-",
  ]);
  if (res.code !== 0 || res.stdout.length === 0) {
    throw new Error(`extrakce snímku selhala (${path} @ ${t}s): ${res.stderr.trim().split("\n").pop()}`);
  }
  return res.stdout;
}

/** Waveform peaks (0..1) z audio stopy — dekóduje se do PCM a downsample. */
export async function extractPeaks(path: string, samples = 400): Promise<number[]> {
  const res = await run(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error",
    "-i", path,
    "-map", "a:0",
    "-ac", "1",
    "-ar", "8000",
    "-f", "s16le",
    "-",
  ]);
  if (res.code !== 0 || res.stdout.length < 2) {
    throw new Error(`audio dekódování selhalo (${path}): ${res.stderr.trim().split("\n").pop()}`);
  }
  const total = Math.floor(res.stdout.length / 2);
  const peaks = new Array<number>(samples).fill(0);
  const bucket = Math.max(1, Math.floor(total / samples));
  for (let i = 0; i < samples; i++) {
    let max = 0;
    const start = i * bucket;
    const end = Math.min(total, start + bucket);
    for (let s = start; s < end; s += 2) {
      const v = Math.abs(res.stdout.readInt16LE(s * 2)) / 32768;
      if (v > max) max = v;
    }
    peaks[i] = Number(max.toFixed(3));
  }
  return peaks;
}

/** Proxy (640p) pro plynulý střih velkých médií (PLAN.md §3.1). */
export async function generateProxy(src: string, out: string): Promise<void> {
  const res = await run(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error",
    "-i", src,
    "-vf", "scale=640:-2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    out, "-y",
  ]);
  if (res.code !== 0) {
    throw new Error(`proxy selhal: ${res.stderr.trim().split("\n").pop()}`);
  }
}

export type TestClipKind = "testsrc" | "smptebars" | "gradient" | "color";

/** Vygeneruje testovací klip přes lavfi (demo projekt + testy). */
export async function generateTestClip(
  out: string,
  opts: {
    seconds?: number;
    size?: string;
    rate?: number;
    kind?: TestClipKind;
    color?: string;
    freq?: number;
    audio?: boolean;
  } = {},
): Promise<void> {
  const seconds = opts.seconds ?? 3;
  const size = opts.size ?? "640x360";
  const rate = opts.rate ?? 30;
  const videoSrc =
    opts.kind === "smptebars"
      ? `smptebars=size=${size}:rate=${rate}`
      : opts.kind === "gradient"
        ? `gradients=size=${size}:rate=${rate}`
        : opts.kind === "color"
          ? `color=c=${opts.color ?? "0x1f6f4f"}:size=${size}:rate=${rate}`
          : `testsrc2=size=${size}:rate=${rate}`;
  const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", videoSrc];
  if (opts.audio !== false) {
    args.push("-f", "lavfi", "-i", `sine=frequency=${opts.freq ?? 440}:sample_rate=48000`);
  }
  args.push("-t", String(seconds), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
  if (opts.audio !== false) args.push("-c:a", "aac", "-b:a", "128k", "-shortest");
  args.push(out, "-y");
  const res = await run(ffmpegPath(), args);
  if (res.code !== 0) {
    throw new Error(`generování test klipu selhalo: ${res.stderr.trim().split("\n").pop()}`);
  }
}
