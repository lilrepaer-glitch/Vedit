// F7: Desktop Screen Capture & Smart High-Entropy Thumbnail Generator (PLAN.md §3.1, §3.4)

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { VeditEngine } from "../core/engine.js";
import { extractFrame, ffmpegPath, probeMedia, run } from "../core/media.js";
import { sequenceDuration, type Asset, type Clip } from "../core/types.js";

export interface ScreenCaptureOptions {
  seconds?: number;
  fps?: number;
  outDir?: string;
  start?: number;
  label?: string;
}

/**
 * Records desktop screen using bundled FFmpeg OS grabber (`gdigrab` on Windows, `avfoundation` on macOS,
 * `x11grab` on Linux), cleanly falling back to a synthetic desktop capture pattern when no GUI display is attached.
 */
export async function captureDesktopClip(
  engine: VeditEngine,
  opts: ScreenCaptureOptions = {},
): Promise<{ asset: Asset; clip: Clip; outPath: string; simulatedDisplay: boolean }> {
  const seconds = Math.max(0.5, Math.min(120, opts.seconds ?? 3));
  const fps = Math.max(5, Math.min(60, opts.fps ?? 24));
  const outDir = resolvePath(opts.outDir ?? ".vedit/captures");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `screen-capture-${Date.now()}.mp4`);

  let simulatedDisplay = false;
  let grabArgs: string[];
  if (process.platform === "win32") {
    grabArgs = ["-f", "gdigrab", "-framerate", String(fps), "-t", String(seconds), "-i", "desktop"];
  } else if (process.platform === "darwin") {
    grabArgs = ["-f", "avfoundation", "-framerate", String(fps), "-t", String(seconds), "-i", "1:none"];
  } else if (process.env.DISPLAY) {
    grabArgs = ["-f", "x11grab", "-framerate", String(fps), "-t", String(seconds), "-i", `${process.env.DISPLAY}.0`];
  } else {
    simulatedDisplay = true;
    grabArgs = ["-f", "lavfi", "-t", String(seconds), "-i", `testsrc2=size=1280x720:rate=${fps}`];
  }

  let res = await run(ffmpegPath(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...grabArgs,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    outPath,
  ]);

  if (res.code !== 0 && !simulatedDisplay) {
    simulatedDisplay = true;
    res = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-t",
      String(seconds),
      "-i",
      `testsrc2=size=1280x720:rate=${fps}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ]);
  }
  if (res.code !== 0) {
    throw new Error(`Screen capture failed: ${res.stderr.trim()}`);
  }

  const info = await probeMedia(outPath);
  return engine.transaction("capture.screen", () => {
    const asset = engine.addAsset({
      name: opts.label ?? "Screen Recording.mp4",
      kind: "video",
      path: outPath,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      sizeBytes: info.sizeBytes,
      videoCodec: info.videoCodec,
      hasAudio: false,
      source: { provider: "vedit-capture", model: process.platform, simulated: simulatedDisplay },
    });
    const seq = engine.activeSequence();
    const vTrack =
      seq.tracks.find((t) => t.kind === "video" && !t.locked) ??
      engine.addTrack("video", "Screen Capture");
    const at = opts.start ?? Math.max(0, sequenceDuration(seq));
    const clip = engine.addClip({
      trackId: vTrack.id,
      assetId: asset.id,
      name: opts.label ?? "Screen Capture",
      start: at,
      duration: info.duration,
      in: 0,
      out: info.duration,
    });
    return { asset, clip, outPath, simulatedDisplay };
  });
}

export interface ThumbnailOptions {
  /** Optional explicit timestamp in seconds; when omitted, picks highest visual detail/sharpness frame */
  at?: number;
  width?: number;
  title?: string;
  outDir?: string;
}

export interface ThumbnailResult {
  outPath: string;
  selectedTime: number;
  width: number;
  sizeBytes: number;
}

/**
 * Picks the sharpest/richest action frame in the project (via JPEG DCT entropy scoring)
 * and exports a ready-to-publish YouTube / social thumbnail JPEG.
 */
export async function generateProjectThumbnail(
  engine: VeditEngine,
  opts: ThumbnailOptions = {},
): Promise<ThumbnailResult> {
  const seq = engine.activeSequence();
  const videoClips = seq.tracks
    .filter((t) => t.kind === "video" && !t.muted)
    .flatMap((t) => t.clips)
    .sort((a, b) => a.start - b.start);

  if (videoClips.length === 0) {
    throw new Error("Project has no video clips to extract a thumbnail from");
  }

  const width = Math.max(320, Math.min(3840, opts.width ?? 1280));
  const outDir = resolvePath(opts.outDir ?? ".vedit/thumbnails");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `thumbnail-${Date.now()}.jpg`);

  let bestBuffer: Buffer | null = null;
  let bestTime = 0;

  if (opts.at != null && Number.isFinite(opts.at)) {
    const targetClip =
      videoClips.find((c) => opts.at! >= c.start && opts.at! <= c.start + c.duration) ?? videoClips[0]!;
    const asset = engine.findAsset(targetClip.assetId);
    const localT = Math.max(0, targetClip.in + (opts.at - targetClip.start));
    bestBuffer = await extractFrame(asset.path, localT, { width });
    bestTime = opts.at;
  } else {
    const totalDur = Math.max(0.5, sequenceDuration(seq));
    const ratios = [0.15, 0.35, 0.5, 0.7, 0.85];
    for (const r of ratios) {
      const t = totalDur * r;
      const clip = videoClips.find((c) => t >= c.start && t <= c.start + c.duration) ?? videoClips[0]!;
      const asset = engine.findAsset(clip.assetId);
      const localT = Math.max(0, clip.in + Math.min(clip.duration, Math.max(0, t - clip.start)));
      try {
        const buf = await extractFrame(asset.path, localT, { width });
        if (!bestBuffer || buf.length > bestBuffer.length) {
          bestBuffer = buf;
          bestTime = Number(t.toFixed(2));
        }
      } catch {
        // skip unreadable candidate frame
      }
    }
  }

  if (!bestBuffer) {
    throw new Error("Failed to extract thumbnail frame from project media");
  }

  await writeFile(outPath, bestBuffer);

  if (opts.title?.trim()) {
    const srtTmp = `${outPath}.srt`;
    await writeFile(srtTmp, `1\n00:00:00,000 --> 00:00:05,000\n${opts.title.trim()}\n`, "utf-8");
    const escaped = srtTmp.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const titledPath = join(outDir, `thumbnail-titled-${Date.now()}.jpg`);
    const res = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-loop",
      "1",
      "-t",
      "0.1",
      "-i",
      outPath,
      "-vf",
      `subtitles='${escaped}':force_style='FontSize=28,Bold=1,Alignment=2,MarginV=32,Outline=3'`,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      titledPath,
    ]);
    if (res.code === 0) {
      const st = await stat(titledPath);
      return { outPath: titledPath, selectedTime: bestTime, width, sizeBytes: st.size };
    }
  }

  const st = await stat(outPath);
  return { outPath, selectedTime: bestTime, width, sizeBytes: st.size };
}
