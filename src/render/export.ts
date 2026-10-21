// Reálný render pipeline F1 + F5 — timeline → FFmpeg → multi-codec export & platform presets
// (PLAN.md §3.6, §13: H.264 / H.265 / ProRes / WebM, YouTube / TikTok / Reels / LinkedIn presets)

import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { Asset, Clip, Project, Sequence } from "../core/types.js";
import { clipEnd, sequenceDuration } from "../core/types.js";
import { captionsToSrt } from "../core/presets.js";
import { ffmpegPath, run } from "../core/media.js";

export type VideoCodecId = "h264" | "h265" | "prores" | "vp9";
export type ContainerFormat = "mp4" | "mov" | "webm";

export interface ExportPreset {
  id: string;
  label: string;
  platform: string;
  format: ContainerFormat;
  codec: VideoCodecId;
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
  audioBitrate?: string;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: "youtube-1080p",
    label: "YouTube 1080p HD (16:9 H.264)",
    platform: "YouTube",
    format: "mp4",
    codec: "h264",
    width: 1920,
    height: 1080,
    fps: 30,
    crf: 19,
    audioBitrate: "192k",
  },
  {
    id: "youtube-4k",
    label: "YouTube 4K UHD (16:9 H.265/HEVC)",
    platform: "YouTube",
    format: "mp4",
    codec: "h265",
    width: 3840,
    height: 2160,
    fps: 60,
    crf: 22,
    audioBitrate: "256k",
  },
  {
    id: "tiktok-reels",
    label: "TikTok / Reels / Shorts (9:16 Vertical)",
    platform: "TikTok / Reels",
    format: "mp4",
    codec: "h264",
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 20,
    audioBitrate: "192k",
  },
  {
    id: "instagram-square",
    label: "Instagram / Feed Square (1:1)",
    platform: "Instagram",
    format: "mp4",
    codec: "h264",
    width: 1080,
    height: 1080,
    fps: 30,
    crf: 20,
    audioBitrate: "160k",
  },
  {
    id: "linkedin-hd",
    label: "LinkedIn Business HD (16:9)",
    platform: "LinkedIn",
    format: "mp4",
    codec: "h264",
    width: 1920,
    height: 1080,
    fps: 30,
    crf: 20,
    audioBitrate: "192k",
  },
  {
    id: "prores-master",
    label: "Apple ProRes 422 Studio Master (.mov)",
    platform: "Broadcast / NLE Master",
    format: "mov",
    codec: "prores",
  },
  {
    id: "webm-vp9",
    label: "WebM VP9 + Opus (.webm)",
    platform: "Web / Open Codec",
    format: "webm",
    codec: "vp9",
    crf: 30,
    audioBitrate: "160k",
  },
];

export function resolveExportPreset(presetId?: string): ExportPreset | undefined {
  if (!presetId) return undefined;
  return EXPORT_PRESETS.find((p) => p.id === presetId);
}

export interface RenderOptions {
  outPath: string;
  preset?: string;
  codec?: VideoCodecId;
  format?: ContainerFormat;
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
  /** volitelně jen konkrétní sekvence */
  sequenceId?: string;
  onProgress?: (percent: number) => void;
}

export interface RenderResult {
  outPath: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: VideoCodecId;
  preset?: string;
  sizeBytes: number;
  warnings: string[];
  args: string[];
}

export interface RenderPlan {
  args: string[];
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: VideoCodecId;
  warnings: string[];
  /** titulky se před renderem zapíší do tohoto souboru */
  srt?: { path: string; content: string };
}

interface RenderClip {
  clip: Clip;
  asset: Asset;
  inputIndex: number;
}

/** lineární interpolace mezi keyframy → výraz pro overlay x/y (globální t) */
function keyframeExpr(clip: Clip, property: "x" | "y" | "opacity", fallback: number): string {
  const keys = clip.keyframes.filter((k) => k.property === property && typeof k.value === "number");
  if (keys.length === 0) return String(fallback);
  const s = clip.start;
  const v = (k: { value: number | string }) => Number(k.value);
  if (keys.length === 1) return String(v(keys[0]!));
  let expr = String(v(keys[keys.length - 1]!));
  for (let i = keys.length - 2; i >= 0; i--) {
    const k0 = keys[i]!;
    const k1 = keys[i + 1]!;
    const t0 = s + k0.time;
    const t1 = s + k1.time;
    const lin = `(${v(k0)})+(${v(k1)}-(${v(k0)}))*(t-${t0})/(${t1}-${t0})`;
    expr = `if(lt(t,${t1}),${lin},${expr})`;
  }
  return `if(lt(t,${s + keys[0]!.time}),${v(keys[0]!)},${expr})`;
}

function clipStaticValue(clip: Clip, property: "x" | "y", fallback: number): number {
  const keys = clip.keyframes.filter((k) => k.property === property && typeof k.value === "number");
  if (keys.length === 0) return fallback;
  return Number(keys[0]!.value);
}

function clipVideoFilters(clip: Clip, warnings: string[]): string[] {
  const f: string[] = ["setpts=PTS-STARTPTS"];
  const sx = clip.transform.scaleX;
  const sy = clip.transform.scaleY;
  if (sx !== 1 || sy !== 1) {
    f.push(`scale=iw*${sx.toFixed(4)}:ih*${sy.toFixed(4)}`);
  }
  if (clip.transform.rotation !== 0) {
    const rad = (clip.transform.rotation * Math.PI) / 180;
    f.push(`rotate=${rad.toFixed(5)}:ow=rotw(iw):oh=roth(ih):c=black@0`);
  }
  for (const effect of clip.effects) {
    const p = effect.params as Record<string, number | boolean | string>;
    switch (effect.type) {
      case "blur":
        f.push(`gblur=sigma=${Number(p.sigma ?? p.radius ?? 5)}`);
        break;
      case "color":
      case "color-grade": {
        const args: string[] = [];
        if (p.brightness != null) args.push(`b=${Number(p.brightness)}`);
        if (p.contrast != null) args.push(`contrast=${Number(p.contrast)}`);
        if (p.saturation != null) args.push(`saturation=${Number(p.saturation)}`);
        if (p.gamma != null) args.push(`gamma=${Number(p.gamma)}`);
        if (args.length) f.push(`eq=${args.join(":")}`);
        break;
      }
      case "grayscale":
      case "black-and-white":
        f.push("hue=s=0");
        break;
      default:
        warnings.push(`efekt "${effect.type}" zatím není renderovaný (F1: blur/color/grayscale)`);
    }
  }
  if (clip.transform.opacity < 1) {
    f.push("format=yuva420p", `colorchannelmixer=aa=${clip.transform.opacity.toFixed(3)}`);
  }
  return f;
}

function codecArgsFor(codec: VideoCodecId, fps: number, crf?: number, audioBitrate = "160k"): string[] {
  switch (codec) {
    case "h265":
      return [
        "-c:v", "libx265",
        "-preset", "veryfast",
        "-crf", String(crf ?? 22),
        "-tag:v", "hvc1",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-c:a", "aac",
        "-b:a", audioBitrate,
        "-movflags", "+faststart",
      ];
    case "prores":
      return [
        "-c:v", "prores_ks",
        "-profile:v", "2",
        "-pix_fmt", "yuv422p10le",
        "-r", String(fps),
        "-c:a", "pcm_s16le",
        "-ar", "48000",
      ];
    case "vp9":
      return [
        "-c:v", "libvpx-vp9",
        "-b:v", "0",
        "-crf", String(crf ?? 30),
        "-deadline", "realtime",
        "-cpu-used", "5",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-ar", "48000",
        "-c:a", "libopus",
        "-b:a", audioBitrate,
      ];
    case "h264":
    default:
      return [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", String(crf ?? 20),
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-c:a", "aac",
        "-b:a", audioBitrate,
        "-movflags", "+faststart",
      ];
  }
}

/** Sestaví kompletní ffmpeg argumenty pro render timeline (bez spuštění). */
export function buildRenderArgs(project: Project, opts: RenderOptions): RenderPlan {
  const preset = resolveExportPreset(opts.preset);
  const seq: Sequence =
    (opts.sequenceId && project.sequences.find((s) => s.id === opts.sequenceId)) ||
    project.sequences.find((s) => s.id === project.activeSequenceId)!;
  const width = opts.width ?? preset?.width ?? seq.width;
  const height = opts.height ?? preset?.height ?? seq.height;
  const fps = opts.fps ?? preset?.fps ?? seq.fps;
  const ext = extname(opts.outPath).toLowerCase();
  const inferredCodec: VideoCodecId =
    ext === ".webm" ? "vp9" : "h264";
  const codec: VideoCodecId = opts.codec ?? preset?.codec ?? inferredCodec;
  const warnings: string[] = [];

  const duration = Math.max(sequenceDuration(seq), ...seq.captions.map((c) => c.end), 1);
  const assetOf = (clip: Clip): Asset | undefined => project.assets.find((a) => a.id === clip.assetId);

  // ---- vstupy (base canvas = input 0, pak klipy v pořadí stop) ----
  const args: string[] = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=black:size=${width}x${height}:rate=${fps}`,
  ];
  const visual: RenderClip[] = [];
  const audioClips: RenderClip[] = [];
  let inputIndex = 1;

  for (const track of seq.tracks) {
    if (track.muted) continue;
    const isAudioTrack = track.kind === "audio";
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      const asset = assetOf(clip);
      if (!asset) {
        warnings.push(`klip "${clip.name}" nemá asset — přeskočeno`);
        continue;
      }
      if (!existsSync(asset.path)) {
        warnings.push(`offline médium "${asset.name}" (${asset.path}) — přeskočeno`);
        continue;
      }
      const rc: RenderClip = { clip, asset, inputIndex };
      if (isAudioTrack) {
        if (asset.kind !== "audio" && !asset.hasAudio) {
          warnings.push(`klip "${clip.name}" nemá audio stopu — přeskočeno`);
          continue;
        }
        args.push("-ss", clip.in.toFixed(3), "-t", clip.duration.toFixed(3), "-i", asset.path);
        audioClips.push(rc);
        inputIndex++;
      } else {
        if (asset.kind === "image") {
          args.push("-loop", "1", "-t", clip.duration.toFixed(3), "-i", asset.path);
        } else {
          args.push("-ss", clip.in.toFixed(3), "-t", clip.duration.toFixed(3), "-i", asset.path);
        }
        visual.push(rc);
        inputIndex++;
        if (asset.hasAudio) audioClips.push(rc);
      }
    }
  }

  // ---- video řetězec: base → overlay klipy → titulky ----
  const filters: string[] = [`[0:v]setpts=PTS-STARTPTS[base]`];
  let current = "base";
  visual.forEach((rc, n) => {
    const { clip } = rc;
    const vf = clipVideoFilters(clip, warnings);
    filters.push(`[${rc.inputIndex}:v:0]${vf.join(",")}[v${n}]`);
    const xExpr = keyframeExpr(clip, "x", clipStaticValue(clip, "x", 0));
    const yExpr = keyframeExpr(clip, "y", clipStaticValue(clip, "y", 0));
    const x = `'(W-w)/2+${xExpr}'`;
    const y = `'(H-h)/2+${yExpr}'`;
    const out = `ov${n}`;
    filters.push(
      `[${current}][v${n}]overlay=x=${x}:y=${y}:enable='between(t,${clip.start.toFixed(3)},${clipEnd(clip).toFixed(3)})'[${out}]`,
    );
    current = out;
  });

  let srt: RenderPlan["srt"];
  let videoOut = current;
  if (seq.captions.length > 0) {
    const srtPath = join(dirname(opts.outPath), `sub_${Date.now().toString(36)}.srt`);
    srt = { path: srtPath, content: captionsToSrt(seq.captions) };
    filters.push(
      `[${current}]subtitles=${srtPath.replace(/\\/g, "/").replace(/:/g, "\\:")}:force_style='FontSize=20,PrimaryColour=&HFFFFFF&,OutlineColour=&H80000000&,Outline=2'[vout]`,
    );
    videoOut = "vout";
  } else {
    filters.push(`[${current}]null[vout]`);
    videoOut = "vout";
  }

  // ---- audio řetězec ----
  const audioLabels: string[] = [];
  audioClips.forEach((rc, n) => {
    const label = `a${n}`;
    const delayMs = Math.round(rc.clip.start * 1000);
    filters.push(
      `[${rc.inputIndex}:a:0]asetpts=PTS-STARTPTS,atrim=0:${rc.clip.duration.toFixed(3)},volume=1,adelay=${delayMs}|${delayMs},apad,atrim=0:${duration.toFixed(3)}[${label}]`,
    );
    audioLabels.push(label);
  });
  if (audioLabels.length === 0) {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${duration.toFixed(3)}[aout]`);
  } else if (audioLabels.length === 1) {
    filters.push(`[${audioLabels[0]}]anull[aout]`);
  } else {
    const mixInputs = audioLabels.map((l) => `[${l}]`).join("");
    filters.push(
      `${mixInputs}amix=inputs=${audioLabels.length}:dropout_transition=0,volume=${audioLabels.length}[aout]`,
    );
  }

  // ---- výstup ----
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${videoOut}]`,
    "-map", "[aout]",
    ...codecArgsFor(codec, fps, opts.crf ?? preset?.crf, preset?.audioBitrate ?? "160k"),
    "-t", duration.toFixed(3),
    "-progress", "pipe:1", "-nostats",
    opts.outPath,
  );

  return { args, duration, width, height, fps, codec, warnings, srt };
}

/** Spustí reálný render timeline přes FFmpeg. */
export async function renderSequence(project: Project, opts: RenderOptions): Promise<RenderResult> {
  await mkdir(dirname(opts.outPath), { recursive: true });
  const plan = buildRenderArgs(project, opts);
  if (plan.srt) {
    await mkdir(dirname(plan.srt.path), { recursive: true });
    await writeFile(plan.srt.path, plan.srt.content, "utf8");
  }

  let lastPct = -1;
  const res = await run(ffmpegPath(), plan.args, {
    onStdout: (chunk) => {
      if (!opts.onProgress) return;
      const text = chunk.toString();
      const m = /out_time_ms=(\d+)/.exec(text);
      if (m) {
        const pct = Math.min(99, Math.round((Number(m[1]) / 1e6 / plan.duration) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          opts.onProgress(pct);
        }
      }
    },
  });
  if (res.code !== 0) {
    throw new Error(`render selhal: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  }
  const sizeBytes = (await stat(opts.outPath)).size;
  opts.onProgress?.(100);
  return {
    outPath: opts.outPath,
    duration: plan.duration,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    codec: plan.codec,
    preset: opts.preset,
    sizeBytes,
    warnings: plan.warnings,
    args: plan.args,
  };
}
