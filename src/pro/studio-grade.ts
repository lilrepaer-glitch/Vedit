// F11 — Pro Studio Grading, Live Chroma Key, Parametric 3-Band Audio EQ & Subtitle (.srt / .vtt) Engine

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { VeditEngine } from "../core/engine.js";
import type { Caption, EffectInstance } from "../core/types.js";
import { ffmpegPath, probeMedia, run } from "../core/media.js";

export type SubtitleFormat = "srt" | "vtt";

export type ToneCurvePresetId =
  | "linear"
  | "cinema-s-curve"
  | "matte-fade"
  | "high-contrast"
  | "soft-rolloff";

export interface ToneCurvePoint {
  x: number; // 0..1 input luminance
  y: number; // 0..1 output luminance
}

export interface ToneCurvePreset {
  id: ToneCurvePresetId;
  label: string;
  points: ToneCurvePoint[];
}

export const TONE_CURVE_PRESETS: ToneCurvePreset[] = [
  {
    id: "linear",
    label: "Linear",
    points: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.25 },
      { x: 0.5, y: 0.5 },
      { x: 0.75, y: 0.75 },
      { x: 1, y: 1 },
    ],
  },
  {
    id: "cinema-s-curve",
    label: "Cinema S-Curve",
    points: [
      { x: 0, y: 0.02 },
      { x: 0.25, y: 0.19 },
      { x: 0.5, y: 0.5 },
      { x: 0.75, y: 0.82 },
      { x: 1, y: 0.98 },
    ],
  },
  {
    id: "matte-fade",
    label: "Matte Lifted",
    points: [
      { x: 0, y: 0.08 },
      { x: 0.25, y: 0.27 },
      { x: 0.5, y: 0.51 },
      { x: 0.75, y: 0.77 },
      { x: 1, y: 0.95 },
    ],
  },
  {
    id: "high-contrast",
    label: "Punchy Contrast",
    points: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.14 },
      { x: 0.5, y: 0.5 },
      { x: 0.75, y: 0.86 },
      { x: 1, y: 1 },
    ],
  },
  {
    id: "soft-rolloff",
    label: "Highlight Roll-off",
    points: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.26 },
      { x: 0.5, y: 0.52 },
      { x: 0.75, y: 0.76 },
      { x: 1, y: 0.91 },
    ],
  },
];

export type AudioEqPresetId =
  | "flat"
  | "voice-podcast"
  | "bass-boost"
  | "crisp-vocal"
  | "warm-cinema"
  | "lo-fi-radio";

export interface AudioEqPreset {
  id: AudioEqPresetId;
  label: string;
  lowDb: number;
  midDb: number;
  highDb: number;
  voiceClarity: boolean;
}

export const AUDIO_EQ_PRESETS: AudioEqPreset[] = [
  { id: "flat", label: "Flat", lowDb: 0, midDb: 0, highDb: 0, voiceClarity: false },
  { id: "voice-podcast", label: "Podcast Voice", lowDb: -4, midDb: 3, highDb: 4, voiceClarity: true },
  { id: "bass-boost", label: "Bass Boost", lowDb: 7, midDb: 0, highDb: 1, voiceClarity: false },
  { id: "crisp-vocal", label: "Crisp Presence", lowDb: -2, midDb: 2, highDb: 6, voiceClarity: true },
  { id: "warm-cinema", label: "Warm Cinema", lowDb: 4, midDb: 1, highDb: -2, voiceClarity: false },
  { id: "lo-fi-radio", label: "Lo-Fi Radio", lowDb: -12, midDb: 6, highDb: -10, voiceClarity: false },
];

export function pointsFromShadowsMidHighlights(
  shadows = 0,
  midtones = 0,
  highlights = 0,
  presetId: ToneCurvePresetId = "linear",
): ToneCurvePoint[] {
  const base = TONE_CURVE_PRESETS.find((p) => p.id === presetId)?.points ?? TONE_CURVE_PRESETS[0]!.points;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, Number(v.toFixed(4))));
  return [
    { x: 0, y: clamp01(base[0]!.y + Math.max(-0.15, shadows * 0.0012)) },
    { x: 0.25, y: clamp01(base[1]!.y + shadows * 0.0022) },
    { x: 0.5, y: clamp01(base[2]!.y + midtones * 0.0022) },
    { x: 0.75, y: clamp01(base[3]!.y + highlights * 0.0022) },
    { x: 1, y: clamp01(base[4]!.y + Math.min(0.15, highlights * 0.0012)) },
  ];
}

/** Evaluates sorted control points across 0..255 into a monotonic-safe 256-entry 8-bit LUT. */
export function evaluateToneCurveLut(points: ToneCurvePoint[]): Uint8Array {
  const sorted = points
    .map((p) => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }))
    .sort((a, b) => a.x - b.x);
  if (sorted.length === 0) {
    return Uint8Array.from({ length: 256 }, (_, i) => i);
  }
  const pts: ToneCurvePoint[] = [];
  for (const p of sorted) {
    if (pts.length > 0 && Math.abs(pts[pts.length - 1]!.x - p.x) < 1e-4) {
      pts[pts.length - 1] = p;
    } else {
      pts.push(p);
    }
  }
  if (pts[0]!.x > 0) pts.unshift({ x: 0, y: pts[0]!.y });
  if (pts[pts.length - 1]!.x < 1) pts.push({ x: 1, y: pts[pts.length - 1]!.y });

  const lut = new Uint8Array(256);
  const n = pts.length;
  // Secant slopes for Fritsch-Carlson monotone piecewise cubic interpolation
  const m = new Array<number>(n).fill(0);
  const d = new Array<number>(n - 1).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const h = Math.max(1e-5, pts[i + 1]!.x - pts[i]!.x);
    d[i] = (pts[i + 1]!.y - pts[i]!.y) / h;
  }
  m[0] = d[0] ?? 0;
  m[n - 1] = d[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) * 0.5;
  }

  for (let idx = 0; idx < 256; idx++) {
    const x = idx / 255;
    let seg = 0;
    while (seg < n - 2 && x > pts[seg + 1]!.x) seg++;
    const p0 = pts[seg]!;
    const p1 = pts[seg + 1]!;
    const h = Math.max(1e-5, p1.x - p0.x);
    const t = Math.max(0, Math.min(1, (x - p0.x) / h));
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const y = h00 * p0.y + h10 * h * m[seg]! + h01 * p1.y + h11 * h * m[seg + 1]!;
    lut[idx] = Math.max(0, Math.min(255, Math.round(y * 255)));
  }
  return lut;
}

export function buildFfmpegCurvesFilter(points: ToneCurvePoint[]): string {
  const clean = points
    .map((p) => `${Math.max(0, Math.min(1, p.x)).toFixed(3)}/${Math.max(0, Math.min(1, p.y)).toFixed(3)}`)
    .join(" ");
  return `curves=master='${clean}'`;
}

export function applyToneCurve(
  engine: VeditEngine,
  clipId: string,
  opts: {
    preset?: ToneCurvePresetId;
    shadows?: number;
    midtones?: number;
    highlights?: number;
    clarity?: number;
    points?: ToneCurvePoint[];
  } = {},
): EffectInstance {
  const { clip } = engine.findClipAnywhere(clipId);
  const points =
    opts.points && opts.points.length >= 2
      ? opts.points
      : pointsFromShadowsMidHighlights(
          opts.shadows ?? 0,
          opts.midtones ?? 0,
          opts.highlights ?? 0,
          opts.preset ?? "cinema-s-curve",
        );

  clip.effects = (clip.effects ?? []).filter((e) => e.type !== "curves");
  return engine.addEffect(clipId, "curves", {
    preset: opts.preset ?? "custom",
    shadows: opts.shadows ?? 0,
    midtones: opts.midtones ?? 0,
    highlights: opts.highlights ?? 0,
    clarity: opts.clarity ?? 0,
    points,
    ffmpegFilter: buildFfmpegCurvesFilter(points),
  });
}

export function buildFfmpegEqFilter(opts: {
  lowDb?: number;
  midDb?: number;
  highDb?: number;
  voiceClarity?: boolean;
}): string {
  const chain: string[] = [];
  if (opts.voiceClarity) {
    chain.push("highpass=f=85");
    chain.push("lowpass=f=13500");
  }
  const low = Math.max(-18, Math.min(18, Number(opts.lowDb ?? 0)));
  const mid = Math.max(-18, Math.min(18, Number(opts.midDb ?? 0)));
  const high = Math.max(-18, Math.min(18, Number(opts.highDb ?? 0)));
  if (Math.abs(low) > 0.05) chain.push(`equalizer=f=120:t=o:w=1.2:g=${low.toFixed(1)}`);
  if (Math.abs(mid) > 0.05) chain.push(`equalizer=f=1200:t=o:w=1.4:g=${mid.toFixed(1)}`);
  if (Math.abs(high) > 0.05) chain.push(`equalizer=f=4800:t=o:w=1.5:g=${high.toFixed(1)}`);
  if (opts.voiceClarity) {
    chain.push("acompressor=threshold=-18dB:ratio=3:attack=8:release=120:makeup=2");
  }
  return chain.length > 0 ? chain.join(",") : "anull";
}

export async function applyParametricEq(
  engine: VeditEngine,
  clipId: string,
  opts: {
    preset?: AudioEqPresetId;
    lowDb?: number;
    midDb?: number;
    highDb?: number;
    voiceClarity?: boolean;
    renderFile?: boolean;
    outDir?: string;
  } = {},
): Promise<{ effect: EffectInstance; outPath?: string }> {
  const { clip } = engine.findClipAnywhere(clipId);
  const presetObj = opts.preset ? AUDIO_EQ_PRESETS.find((p) => p.id === opts.preset) : undefined;
  const lowDb = opts.lowDb ?? presetObj?.lowDb ?? 0;
  const midDb = opts.midDb ?? presetObj?.midDb ?? 0;
  const highDb = opts.highDb ?? presetObj?.highDb ?? 0;
  const voiceClarity = opts.voiceClarity ?? presetObj?.voiceClarity ?? false;
  const filter = buildFfmpegEqFilter({ lowDb, midDb, highDb, voiceClarity });

  clip.effects = (clip.effects ?? []).filter((e) => e.type !== "eq");
  const effect = engine.addEffect(clipId, "eq", {
    preset: opts.preset ?? "custom",
    lowDb,
    midDb,
    highDb,
    voiceClarity,
    ffmpegFilter: filter,
  });

  if (opts.renderFile && opts.outDir) {
    const asset = engine.findAsset(clip.assetId);
    await mkdir(opts.outDir, { recursive: true });
    const outPath = join(opts.outDir, `eq_${clip.id}.wav`);
    const res = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      asset.path,
      "-af",
      filter,
      outPath,
    ]);
    if (res.code === 0) {
      await probeMedia(outPath).catch(() => undefined);
      return { effect, outPath };
    }
  }
  return { effect };
}

// ---------- Standards-Compliant SubRip (.srt) & WebVTT (.vtt) Parser & Serializer ----------

function parseTimestampToSeconds(raw: string): number {
  const cleaned = raw.trim().replace(",", ".");
  const parts = cleaned.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) {
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }
  if (parts.length === 2) {
    return parts[0]! * 60 + parts[1]!;
  }
  return parts[0] ?? 0;
}

function formatSubtitleTimestamp(seconds: number, separator: "," | "."): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const hrs = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(ms).padStart(3, "0")}`;
}

export function parseSubtitlesText(content: string): Array<{ start: number; end: number; text: string }> {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\s*\n/);
  const result: Array<{ start: number; end: number; text: string }> = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0]!) || /^NOTE\b/i.test(lines[0]!)) continue;

    let cueIdx = lines.findIndex((l) => l.includes("-->"));
    if (cueIdx < 0) continue;
    const timingLine = lines[cueIdx]!;
    const arrowParts = timingLine.split("-->");
    if (arrowParts.length < 2) continue;
    const startStr = arrowParts[0]!.trim();
    const endStr = arrowParts[1]!.trim().split(/\s+/)[0]!;
    const start = Number(parseTimestampToSeconds(startStr).toFixed(3));
    const end = Number(Math.max(start + 0.2, parseTimestampToSeconds(endStr)).toFixed(3));
    const text = lines
      .slice(cueIdx + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (text) {
      result.push({ start, end, text });
    }
  }
  return result;
}

export function serializeSubtitles(captions: Caption[], format: "srt" | "vtt" = "srt"): string {
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  if (format === "vtt") {
    const lines = ["WEBVTT", ""];
    sorted.forEach((cap, idx) => {
      lines.push(String(idx + 1));
      lines.push(`${formatSubtitleTimestamp(cap.start, ".")} --> ${formatSubtitleTimestamp(cap.end, ".")}`);
      lines.push(cap.text.trim() || " ");
      lines.push("");
    });
    return lines.join("\n");
  }
  return sorted
    .map(
      (cap, idx) =>
        `${idx + 1}\n${formatSubtitleTimestamp(cap.start, ",")} --> ${formatSubtitleTimestamp(cap.end, ",")}\n${cap.text.trim() || " "}\n`,
    )
    .join("\n");
}

export function importSubtitlesToSequence(
  engine: VeditEngine,
  content: string,
  opts: boolean | { replaceExisting?: boolean; offsetSec?: number } = false,
): { captions: Caption[]; count: number } {
  const replace = typeof opts === "boolean" ? opts : Boolean(opts.replaceExisting);
  const offsetSec = typeof opts === "boolean" ? 0 : Number(opts.offsetSec ?? 0);
  const parsed = parseSubtitlesText(content);
  const seq = engine.activeSequence();
  if (replace) {
    seq.captions = [];
  }
  const added: Caption[] = [];
  for (const item of parsed) {
    const start = Math.max(0, Number((item.start + offsetSec).toFixed(3)));
    const end = Math.max(start + 0.2, Number((item.end + offsetSec).toFixed(3)));
    added.push(engine.addCaption({ text: item.text, start, end }));
  }
  return { captions: added, count: added.length };
}
