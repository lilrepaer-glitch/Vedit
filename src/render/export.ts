// Real Render Pipeline F1 + F5 + F6 — Timeline → FFmpeg → Multi-Codec, GPU HwAccel, Pro VFX & Loudness
//
// Supported features:
//   • Video codecs: H.264, H.265/HEVC, Apple ProRes 422 (.mov), WebM VP9 (.webm)
//   • Hardware GPU acceleration: NVENC / AMF / QSV / VideoToolbox / VAAPI with safe CPU fallback
//   • Platform presets: YouTube 1080p/4K, TikTok/Reels, Instagram Square, LinkedIn, ProRes Master, WebM VP9
//   • Multi-track compositing, transforms, keyframe animation (x / y / opacity), burned-in SRT subtitles
//   • F6 Pro VFX: chroma-key + despill, speed control (0.25x–4x + chained atempo), color-grade, blur,
//     grayscale, sharpen, vignette, crop, fade-in/out transitions
//   • F6 Pro Audio: per-clip volume/denoise/EQ + master bus EBU R128 loudness normalization (-14 / -16 / -23 LUFS)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve as resolvePath } from "node:path";
import { ffmpegPath, probeMedia } from "../core/media.js";
import { captionsToSrt } from "../core/presets.js";
import {
  sequenceDuration,
  type Asset,
  type Clip,
  type Project,
  type Sequence,
} from "../core/types.js";
import { resolveVideoEncoder, type HwAccelBackend } from "./hwaccel.js";

export type VideoCodecId = "h264" | "h265" | "prores" | "vp9" | "gif";

export interface ExportPreset {
  id: string;
  label: string;
  description: string;
  width: number;
  height: number;
  fps: number;
  codec: VideoCodecId;
  format: "mp4" | "mov" | "webm" | "gif";
  ext: ".mp4" | ".mov" | ".webm" | ".gif";
  crf?: number;
  audioBitrate?: string;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: "youtube-1080p",
    label: "YouTube 1080p HD (16:9 H.264)",
    description: "Standard 1920×1080 H.264 + AAC faststart MP4",
    width: 1920,
    height: 1080,
    fps: 30,
    codec: "h264",
    format: "mp4",
    ext: ".mp4",
    crf: 19,
    audioBitrate: "192k",
  },
  {
    id: "youtube-4k",
    label: "YouTube 4K UHD (16:9 H.265/HEVC)",
    description: "Ultra HD 3840×2160 H.265/HEVC 10-bit ready MP4",
    width: 3840,
    height: 2160,
    fps: 30,
    codec: "h265",
    format: "mp4",
    ext: ".mp4",
    crf: 22,
    audioBitrate: "256k",
  },
  {
    id: "tiktok-reels",
    label: "TikTok / Reels / Shorts (9:16 Vertical)",
    description: "Vertical 1080×1920 30fps mobile-optimized MP4",
    width: 1080,
    height: 1920,
    fps: 30,
    codec: "h264",
    format: "mp4",
    ext: ".mp4",
    crf: 20,
    audioBitrate: "160k",
  },
  {
    id: "instagram-square",
    label: "Instagram / Feed Square (1:1)",
    description: "1080×1080 square social video MP4",
    width: 1080,
    height: 1080,
    fps: 30,
    codec: "h264",
    format: "mp4",
    ext: ".mp4",
    crf: 20,
    audioBitrate: "160k",
  },
  {
    id: "linkedin-hd",
    label: "LinkedIn Business HD (16:9)",
    description: "1920×1080 crisp presentation & promo MP4",
    width: 1920,
    height: 1080,
    fps: 30,
    codec: "h264",
    format: "mp4",
    ext: ".mp4",
    crf: 20,
    audioBitrate: "160k",
  },
  {
    id: "prores-master",
    label: "Apple ProRes 422 Studio Master (.mov)",
    description: "Mezzanine studio master 10-bit 4:2:2 + uncompressed PCM audio",
    width: 1920,
    height: 1080,
    fps: 30,
    codec: "prores",
    format: "mov",
    ext: ".mov",
  },
  {
    id: "webm-vp9",
    label: "WebM VP9 + Opus (.webm)",
    description: "Open royalty-free web streaming container",
    width: 1920,
    height: 1080,
    fps: 30,
    codec: "vp9",
    format: "webm",
    ext: ".webm",
    crf: 30,
    audioBitrate: "128k",
  },
  {
    id: "animated-gif",
    label: "Animated Loop GIF (640p Optimal Palette)",
    description: "High-quality 2-pass palettegen/paletteuse animated GIF loop",
    width: 640,
    height: 360,
    fps: 15,
    codec: "gif",
    format: "gif",
    ext: ".gif",
  },
];

export function resolveExportPreset(id?: string): ExportPreset | undefined {
  if (!id) return undefined;
  return EXPORT_PRESETS.find((p) => p.id === id);
}

export interface RenderOptions {
  outPath: string;
  preset?: string;
  codec?: VideoCodecId;
  /** F6: hardware encoder selection ("auto" | "cpu" | "nvenc" | "amf" | "qsv" | "videotoolbox" | "vaapi") */
  hwAccel?: HwAccelBackend;
  /** F6: target integrated loudness in LUFS (e.g. -14 streaming, -16 podcast, -23 EBU R128 broadcast) */
  loudnessLufs?: number;
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
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
  encoder?: string;
  hwBackend?: string;
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
  encoder?: string;
  hwBackend?: string;
  warnings: string[];
  srt?: { path: string; content: string };
}

interface RenderClip {
  clip: Clip;
  asset: Asset;
  inputIndex: number;
  speed: number;
  trackVolumeDb: number;
  trackPan: number;
}

/** Builds a valid FFmpeg `atempo` chain for any speed in [0.1 .. 8.0] (each stage within [0.5 .. 2.0]). */
export function buildAtempoChain(speed: number): string[] {
  const filters: string[] = [];
  let rem = Math.max(0.1, Math.min(8, speed));
  while (rem > 2.0 + 1e-6) {
    filters.push("atempo=2.0");
    rem /= 2.0;
  }
  while (rem < 0.5 - 1e-6) {
    filters.push("atempo=0.5");
    rem /= 0.5;
  }
  if (Math.abs(rem - 1.0) > 1e-3) {
    filters.push(`atempo=${rem.toFixed(4)}`);
  }
  return filters;
}

function getClipSpeed(clip: Clip): number {
  const eff = clip.effects.find((e) => e.type === "speed");
  const raw = Number(eff?.params?.rate ?? eff?.params?.speed ?? 1);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(0.1, Math.min(8, raw));
}

export type KeyframeEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold";

/** Evaluates a clip's keyframe curve at relative clip time `relTime` with full easing support. */
export function evaluateKeyframeCurve(
  clip: Pick<Clip, "keyframes">,
  property: string,
  relTime: number,
  fallback: number,
): number {
  const keys = clip.keyframes
    .filter((k) => k.property === property && typeof k.value === "number")
    .sort((a, b) => a.time - b.time);
  if (keys.length === 0) return fallback;
  if (relTime <= keys[0]!.time) return Number(keys[0]!.value);
  const last = keys[keys.length - 1]!;
  if (relTime >= last.time) return Number(last.value);

  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i]!;
    const k1 = keys[i + 1]!;
    if (relTime >= k0.time && relTime <= k1.time) {
      const v0 = Number(k0.value);
      const v1 = Number(k1.value);
      const dt = Math.max(1e-4, k1.time - k0.time);
      const u = Math.max(0, Math.min(1, (relTime - k0.time) / dt));
      switch (k0.easing) {
        case "hold":
          return v0;
        case "ease-in":
          return v0 + (v1 - v0) * (u * u);
        case "ease-out":
          return v0 + (v1 - v0) * (1 - (1 - u) * (1 - u));
        case "ease-in-out":
          return v0 + (v1 - v0) * (u * u * (3 - 2 * u));
        default:
          return v0 + (v1 - v0) * u;
      }
    }
  }
  return Number(last.value);
}

function keyframeExpr(clip: Clip, property: "x" | "y" | "opacity", fallback: number): string {
  const keys = clip.keyframes
    .filter((k) => k.property === property && typeof k.value === "number")
    .sort((a, b) => a.time - b.time);
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
    const dt = Math.max(1e-4, t1 - t0).toFixed(4);
    const u = `((t-${t0.toFixed(4)})/${dt})`;
    let seg: string;
    switch (k0.easing) {
      case "hold":
        seg = `${v(k0)}`;
        break;
      case "ease-in":
        seg = `(${v(k0)})+(${v(k1)}-(${v(k0)}))*pow(${u},2)`;
        break;
      case "ease-out":
        seg = `(${v(k0)})+(${v(k1)}-(${v(k0)}))*(1-pow(1-${u},2))`;
        break;
      case "ease-in-out":
        seg = `(${v(k0)})+(${v(k1)}-(${v(k0)}))*(pow(${u},2)*(3-2*${u}))`;
        break;
      default:
        seg = `(${v(k0)})+(${v(k1)}-(${v(k0)}))*${u}`;
        break;
    }
    expr = `if(lt(t,${t1.toFixed(4)}),${seg},${expr})`;
  }
  return `if(lt(t,${(s + keys[0]!.time).toFixed(4)}),${v(keys[0]!)},${expr})`;
}

function clipStaticValue(clip: Clip, property: "x" | "y", fallback: number): number {
  const keys = clip.keyframes.filter((k) => k.property === property && typeof k.value === "number");
  if (keys.length === 0) return fallback;
  return Number(keys[0]!.value);
}

function normalizeHexColor(color: unknown): string {
  const str = String(color ?? "0x00ff00").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(str)) {
    return `0x${str.replace(/^#/, "")}`;
  }
  if (/^0x[0-9a-fA-F]{6}$/.test(str)) return str;
  if (str.toLowerCase() === "blue") return "0x0000ff";
  return "0x00ff00";
}

function clipVideoFilters(clip: Clip, speed: number, warnings: string[]): string[] {
  const f: string[] = [
    Math.abs(speed - 1) > 1e-3 ? `setpts=(PTS-STARTPTS)/${speed.toFixed(4)}` : "setpts=PTS-STARTPTS",
  ];
  const sx = clip.transform.scaleX;
  const sy = clip.transform.scaleY;
  if (sx !== 1 || sy !== 1) {
    f.push(`scale=iw*${sx.toFixed(4)}:ih*${sy.toFixed(4)}`);
  }
  if (clip.transform.rotation !== 0) {
    const rad = (clip.transform.rotation * Math.PI) / 180;
    f.push(`rotate=${rad.toFixed(5)}:ow=rotw(iw):oh=roth(ih):c=black@0`);
  }
  let hasAlpha = false;
  for (const effect of clip.effects) {
    const p = effect.params as Record<string, number | boolean | string>;
    switch (effect.type) {
      case "speed":
      case "audio-volume":
      case "audio-denoise":
      case "audio-eq":
        break;
      case "blur":
        f.push(`gblur=sigma=${Number(p.sigma ?? p.radius ?? 5)}`);
        break;
      case "color":
      case "color-grade": {
        const args: string[] = [];
        if (p.brightness != null) args.push(`brightness=${Number(p.brightness)}`);
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
      case "chroma-key":
      case "chromakey": {
        const hex = normalizeHexColor(p.color);
        const similarity = Math.max(0.01, Math.min(1, Number(p.similarity ?? 0.28)));
        const blend = Math.max(0, Math.min(1, Number(p.blend ?? 0.08)));
        f.push(`colorkey=${hex}:${similarity.toFixed(3)}:${blend.toFixed(3)}`);
        hasAlpha = true;
        if (p.despill !== false) {
          const spillType = hex.toLowerCase().endsWith("ff") && !hex.toLowerCase().includes("ff00") ? "blue" : "green";
          f.push(`despill=type=${spillType}`);
        }
        break;
      }
      case "sharpen": {
        const amount = Math.max(-1.5, Math.min(3.5, Number(p.amount ?? 1.0)));
        f.push(`unsharp=5:5:${amount.toFixed(2)}:5:5:0.0`);
        break;
      }
      case "vignette": {
        const angle = Math.max(0.05, Math.min(1.5, Number(p.angle ?? 0.5)));
        f.push(`vignette=angle=${angle.toFixed(3)}`);
        break;
      }
      case "crop": {
        const cw = p.w ?? "iw";
        const ch = p.h ?? "ih";
        const cx = p.x ?? 0;
        const cy = p.y ?? 0;
        f.push(`crop=${cw}:${ch}:${cx}:${cy}`);
        break;
      }
      case "fade": {
        const fadeIn = Number(p.inDuration ?? p.fadeIn ?? 0);
        const fadeOut = Number(p.outDuration ?? p.fadeOut ?? 0);
        if (fadeIn > 0) {
          f.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
        }
        if (fadeOut > 0 && clip.duration > fadeOut) {
          f.push(`fade=t=out:st=${Math.max(0, clip.duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
        }
        break;
      }
      case "lut3d": {
        const lutFile = String(p.filePath ?? "");
        if (lutFile && existsSync(lutFile)) {
          const escapedLut = lutFile.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
          f.push(`lut3d=file='${escapedLut}'`);
        }
        break;
      }
      default:
        warnings.push(`Effect "${effect.type}" is stored as metadata only (not rendered by FFmpeg filter graph)`);
    }
  }
  if (clip.transform.opacity < 1) {
    if (!hasAlpha) f.push("format=yuva420p");
    f.push(`colorchannelmixer=aa=${clip.transform.opacity.toFixed(3)}`);
  }
  return f;
}

function clipAudioFilters(clip: Clip, speed: number, trackVolumeDb = 0, trackPan = 0): string[] {
  const af: string[] = [...buildAtempoChain(speed)];
  if (Math.abs(trackVolumeDb) > 0.01) {
    af.push(`volume=${trackVolumeDb.toFixed(2)}dB`);
  }
  if (Math.abs(trackPan) > 0.01) {
    const leftGain = Math.min(1, 1 - Math.max(0, trackPan)).toFixed(3);
    const rightGain = Math.min(1, 1 + Math.min(0, trackPan)).toFixed(3);
    af.push(`pan=stereo|c0=${leftGain}*c0|c1=${rightGain}*c1`);
  }
  for (const effect of clip.effects) {
    const p = effect.params as Record<string, number | boolean | string>;
    if (effect.type === "audio-volume" && p.gainDb != null) {
      af.push(`volume=${Number(p.gainDb).toFixed(2)}dB`);
    } else if (effect.type === "audio-denoise") {
      const nf = Math.max(-80, Math.min(-20, Number(p.noiseFloor ?? -25)));
      af.push("highpass=f=80", `afftdn=nf=${nf}`);
    } else if (effect.type === "audio-eq") {
      const freq = Number(p.frequency ?? 3000);
      const gain = Number(p.gainDb ?? 3);
      af.push(`equalizer=f=${freq}:t=q:w=1.2:g=${gain}`);
    }
  }
  return af;
}

function defaultCodecArgs(codec: VideoCodecId, fps: number, crf?: number, audioBitrate = "160k"): string[] {
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
    case "gif":
      return [
        "-r", String(fps),
        "-loop", "0",
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

/** Builds complete FFmpeg render arguments synchronously (pure plan builder; uses custom codecArgs when provided). */
export function buildRenderArgs(
  project: Project,
  opts: RenderOptions,
  customCodecArgs?: string[],
): RenderPlan {
  const preset = resolveExportPreset(opts.preset);
  const seq: Sequence =
    (opts.sequenceId && project.sequences.find((s) => s.id === opts.sequenceId)) ||
    project.sequences.find((s) => s.id === project.activeSequenceId)!;
  const width = opts.width ?? preset?.width ?? seq.width;
  const height = opts.height ?? preset?.height ?? seq.height;
  const fps = opts.fps ?? preset?.fps ?? seq.fps;
  const ext = extname(opts.outPath).toLowerCase();
  const inferredCodec: VideoCodecId = ext === ".webm" ? "vp9" : ext === ".gif" ? "gif" : "h264";
  const codec: VideoCodecId = opts.codec ?? preset?.codec ?? inferredCodec;
  const warnings: string[] = [];

  const duration = Math.max(sequenceDuration(seq), ...seq.captions.map((c) => c.end), 1);
  const assetOf = (clip: Clip): Asset | undefined => project.assets.find((a) => a.id === clip.assetId);

  const args: string[] = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=black:size=${width}x${height}:rate=${fps}:duration=${duration.toFixed(3)}`,
  ];
  const visual: RenderClip[] = [];
  const audioClips: RenderClip[] = [];
  let inputIndex = 1;

  const hasVideoSolo = seq.tracks.some((t) => t.kind !== "audio" && t.solo);
  const hasAudioSolo = seq.tracks.some((t) => t.kind === "audio" && t.solo);

  for (const track of seq.tracks) {
    if (track.muted) continue;
    const isAudioTrack = track.kind === "audio";
    if (isAudioTrack && hasAudioSolo && !track.solo) continue;
    if (!isAudioTrack && hasVideoSolo && !track.solo) continue;

    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      const asset = assetOf(clip);
      if (!asset) {
        warnings.push(`Clip "${clip.name}" has no backing asset — skipped`);
        continue;
      }
      if (!existsSync(asset.path)) {
        warnings.push(`offline médium "${asset.name}" (${asset.path}) — skipped`);
        continue;
      }
      const speed = getClipSpeed(clip);
      const sourceSpan = Math.max(0.05, clip.duration * speed);
      const rc: RenderClip = {
        clip,
        asset,
        inputIndex,
        speed,
        trackVolumeDb: track.volumeDb ?? 0,
        trackPan: track.pan ?? 0,
      };
      if (isAudioTrack) {
        if (asset.kind !== "audio" && !asset.hasAudio) {
          warnings.push(`Clip "${clip.name}" has no audio stream — skipped`);
          continue;
        }
        args.push("-ss", clip.in.toFixed(3), "-t", sourceSpan.toFixed(3), "-i", asset.path);
        audioClips.push(rc);
        inputIndex++;
      } else {
        if (asset.kind === "image") {
          args.push("-loop", "1", "-t", clip.duration.toFixed(3), "-i", asset.path);
        } else {
          args.push("-ss", clip.in.toFixed(3), "-t", sourceSpan.toFixed(3), "-i", asset.path);
        }
        visual.push(rc);
        inputIndex++;
        if (asset.hasAudio && (!hasAudioSolo || track.solo)) {
          audioClips.push(rc);
        }
      }
    }
  }

  const filters: string[] = [`[0:v]setpts=PTS-STARTPTS[base]`];
  let current = "base";
  visual.forEach((rc, n) => {
    const vLabel = `v${n}`;
    const outLabel = `o${n}`;
    const vf = clipVideoFilters(rc.clip, rc.speed, warnings);
    vf.push(`setpts=PTS+${rc.clip.start.toFixed(3)}/TB`);
    filters.push(`[${rc.inputIndex}:v]${vf.join(",")}[${vLabel}]`);

    const hasKeysX = rc.clip.keyframes.some((k) => k.property === "x");
    const hasKeysY = rc.clip.keyframes.some((k) => k.property === "y");
    const baseX = `(W-w)/2+${rc.clip.transform.x.toFixed(2)}`;
    const baseY = `(H-h)/2+${rc.clip.transform.y.toFixed(2)}`;
    const xExpr = hasKeysX
      ? `(W-w)/2+(${keyframeExpr(rc.clip, "x", clipStaticValue(rc.clip, "x", rc.clip.transform.x))})`
      : baseX;
    const yExpr = hasKeysY
      ? `(H-h)/2+(${keyframeExpr(rc.clip, "y", clipStaticValue(rc.clip, "y", rc.clip.transform.y))})`
      : baseY;
    const end = (rc.clip.start + rc.clip.duration).toFixed(3);
    filters.push(
      `[${current}][${vLabel}]overlay=x='${xExpr}':y='${yExpr}':eof_action=pass:enable='between(t,${rc.clip.start.toFixed(3)},${end})'[${outLabel}]`,
    );
    current = outLabel;
  });

  let srt: { path: string; content: string } | undefined;
  if (seq.captions.length > 0) {
    const srtPath = `${resolvePath(opts.outPath)}.vedit-subs.srt`;
    srt = { path: srtPath, content: captionsToSrt(seq.captions) };
    const escaped = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    filters.push(`[${current}]subtitles='${escaped}'[vsub]`);
    current = "vsub";
  }

  if (codec === "gif") {
    filters.push(`[${current}]split[g0][g1];[g0]palettegen=stats_mode=diff[gp];[g1][gp]paletteuse=dither=bayer[vgif]`);
    current = "vgif";
    const encArgs = customCodecArgs ?? defaultCodecArgs(codec, fps);
    args.push(
      "-filter_complex", filters.join(";"),
      "-map", `[${current}]`,
      "-an",
      "-t", duration.toFixed(3),
      ...encArgs,
      "-progress", "pipe:1", "-nostats",
      opts.outPath,
    );
    return { args, duration, width, height, fps, codec, warnings, srt };
  }

  const loudnessChain =
    opts.loudnessLufs != null
      ? `,loudnorm=I=${Math.max(-36, Math.min(-5, opts.loudnessLufs)).toFixed(1)}:TP=-1.5:LRA=11`
      : "";

  let audioMap: string;
  if (audioClips.length > 0) {
    const labels: string[] = [];
    audioClips.forEach((rc, n) => {
      const aLabel = `a${n}`;
      const delayMs = Math.round(rc.clip.start * 1000);
      const af = clipAudioFilters(rc.clip, rc.speed, rc.trackVolumeDb, rc.trackPan);
      af.push(`adelay=${delayMs}|${delayMs}`, "apad");
      filters.push(`[${rc.inputIndex}:a]${af.join(",")}[${aLabel}]`);
      labels.push(`[${aLabel}]`);
    });
    filters.push(
      `${labels.join("")}amix=inputs=${labels.length}:dropout_transition=0,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS${loudnessChain}[aout]`,
    );
    audioMap = "[aout]";
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${duration.toFixed(3)}[aout]`);
    audioMap = "[aout]";
  }

  const encArgs =
    customCodecArgs ??
    defaultCodecArgs(codec, fps, opts.crf ?? preset?.crf, preset?.audioBitrate ?? "160k");

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${current}]`,
    "-map", audioMap,
    "-t", duration.toFixed(3),
    ...encArgs,
    "-progress", "pipe:1", "-nostats",
    opts.outPath,
  );

  return { args, duration, width, height, fps, codec, warnings, srt };
}

/** Runs real FFmpeg sequence render with multi-codec + GPU hardware acceleration + loudness support. */
export async function renderSequence(project: Project, opts: RenderOptions): Promise<RenderResult> {
  await mkdir(dirname(resolvePath(opts.outPath)), { recursive: true });
  const preset = resolveExportPreset(opts.preset);
  const seq: Sequence =
    (opts.sequenceId && project.sequences.find((s) => s.id === opts.sequenceId)) ||
    project.sequences.find((s) => s.id === project.activeSequenceId)!;
  const fps = opts.fps ?? preset?.fps ?? seq.fps;
  const ext = extname(opts.outPath).toLowerCase();
  const inferredCodec: VideoCodecId = ext === ".webm" ? "vp9" : ext === ".gif" ? "gif" : "h264";
  const codec: VideoCodecId = opts.codec ?? preset?.codec ?? inferredCodec;

  const resolvedEncoder = await resolveVideoEncoder(
    codec,
    opts.hwAccel ?? "cpu",
    fps,
    opts.crf ?? preset?.crf,
    preset?.audioBitrate ?? "160k",
  );

  const plan = buildRenderArgs(project, opts, resolvedEncoder.args);
  if (resolvedEncoder.fallbackReason) {
    plan.warnings.push(resolvedEncoder.fallbackReason);
  }
  if (plan.srt) await writeFile(plan.srt.path, plan.srt.content, "utf-8");

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegPath(), plan.args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let buf = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (c) => (stderr += c));
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const m = /^out_time_us=(\d+)/.exec(line.trim());
          if (m && opts.onProgress) {
            const sec = Number(m[1]) / 1e6;
            opts.onProgress(Math.min(99, Math.round((sec / plan.duration) * 100)));
          }
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg render failed (code ${code}): ${stderr.trim().split("\n").slice(-4).join(" | ")}`));
      });
    });
  } finally {
    if (plan.srt) await rm(plan.srt.path, { force: true });
  }

  opts.onProgress?.(100);
  const info = await probeMedia(opts.outPath);
  const st = await stat(opts.outPath);
  return {
    outPath: opts.outPath,
    duration: info.duration,
    width: info.width ?? plan.width,
    height: info.height ?? plan.height,
    fps: info.fps ?? plan.fps,
    codec: plan.codec,
    encoder: resolvedEncoder.encoder,
    hwBackend: resolvedEncoder.backend,
    preset: opts.preset,
    sizeBytes: st.size,
    warnings: plan.warnings,
    args: plan.args,
  };
}
