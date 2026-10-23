// Real-Time Multi-Track HTML5/WebGL-2D Compositor, Per-Pixel Chroma Keyer + Monotone Tone Curve LUT,
// Filmstrip & Real Audio Waveform Extractor, Live RGB/Luma Scopes Analyzer, 3-Band Parametric WebAudio EQ,
// and Hardware WebCodecs H.264 + AAC `.mp4` Exporter for Vedit Studio (v0.9.0 — Milestone F11).

import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { Asset, Caption, Clip, Project, Sequence, Track } from "./api";
import {
  drawMotionGraphicOverlay,
  drawProceduralFxClip,
  easeInOutQuart,
  easeOutBackSpring,
  easeOutExpo,
  type MotionGraphicTemplateId,
  type ProceduralVisualPresetId,
} from "./studioAssets";

export interface ColorAdjustments {
  exposure: number;    // -100 .. 100
  brightness: number;  // -100 .. 100
  contrast: number;    // -100 .. 100
  saturation: number;  // -100 .. 100
  temperature: number; // -100 .. 100 (cool <-> warm)
  tint: number;        // -100 .. 100 (green <-> magenta)
  fade: number;        // 0 .. 100 (lifted matte blacks)
  vignette: number;    // 0 .. 100
  blur: number;        // 0 .. 25
}

export const DEFAULT_ADJUSTMENTS: ColorAdjustments = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  fade: 0,
  vignette: 0,
  blur: 0,
};

export interface ToneCurvePoint {
  x: number;
  y: number;
}

export interface ToneCurvePresetUi {
  id: "linear" | "cinema-s-curve" | "matte-fade" | "high-contrast" | "soft-rolloff";
  label: string;
  points: ToneCurvePoint[];
}

export const TONE_CURVE_PRESETS_UI: ToneCurvePresetUi[] = [
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
    label: "S-Curve",
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
    label: "Matte",
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
    label: "Punchy",
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
    label: "Roll-Off",
    points: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.26 },
      { x: 0.5, y: 0.52 },
      { x: 0.75, y: 0.76 },
      { x: 1, y: 0.91 },
    ],
  },
];

export interface AudioEqPresetUi {
  id: "flat" | "voice-podcast" | "bass-boost" | "crisp-vocal" | "warm-cinema" | "lo-fi-radio";
  label: string;
  lowDb: number;
  midDb: number;
  highDb: number;
  voiceClarity: boolean;
}

export const AUDIO_EQ_PRESETS_UI: AudioEqPresetUi[] = [
  { id: "flat", label: "Flat", lowDb: 0, midDb: 0, highDb: 0, voiceClarity: false },
  { id: "voice-podcast", label: "Podcast Voice", lowDb: -4, midDb: 3, highDb: 4, voiceClarity: true },
  { id: "bass-boost", label: "Bass Boost", lowDb: 7, midDb: 0, highDb: 1, voiceClarity: false },
  { id: "crisp-vocal", label: "Crisp Vocal", lowDb: -2, midDb: 2, highDb: 6, voiceClarity: true },
  { id: "warm-cinema", label: "Warm Cinema", lowDb: 4, midDb: 1, highDb: -2, voiceClarity: false },
  { id: "lo-fi-radio", label: "Lo-Fi Radio", lowDb: -12, midDb: 6, highDb: -10, voiceClarity: false },
];

export interface LookPresetDef {
  id: string;
  label: string;
  category: "Cinema" | "Film" | "Modern" | "Mono";
  cssFilter: string;
  warmOverlay?: string;
  fadeLift?: number;
  vignette?: number;
}

export const LOOK_PRESETS: LookPresetDef[] = [
  { id: "none", label: "Original", category: "Modern", cssFilter: "none" },
  {
    id: "kodak-2383",
    label: "Kodak 2383",
    category: "Film",
    cssFilter: "contrast(1.16) saturate(1.22) sepia(0.14) brightness(1.02)",
    warmOverlay: "rgba(255, 166, 77, 0.08)",
    vignette: 18,
  },
  {
    id: "teal-orange-blockbuster",
    label: "Teal & Orange",
    category: "Cinema",
    cssFilter: "contrast(1.24) saturate(1.36) hue-rotate(-8deg)",
    warmOverlay: "rgba(0, 145, 175, 0.07)",
    vignette: 22,
  },
  {
    id: "fuji-eterna",
    label: "Fuji Eterna",
    category: "Film",
    cssFilter: "contrast(1.06) saturate(1.08) brightness(1.03)",
    warmOverlay: "rgba(110, 210, 175, 0.05)",
    fadeLift: 12,
  },
  {
    id: "warm-golden",
    label: "Golden Hour",
    category: "Cinema",
    cssFilter: "brightness(1.05) contrast(1.1) saturate(1.28) sepia(0.2)",
    warmOverlay: "rgba(255, 180, 65, 0.11)",
  },
  {
    id: "cool-noir",
    label: "Arctic Steel",
    category: "Cinema",
    cssFilter: "contrast(1.25) saturate(0.78) brightness(0.97) hue-rotate(8deg)",
    warmOverlay: "rgba(56, 152, 255, 0.08)",
    vignette: 26,
  },
  {
    id: "bleach-bypass",
    label: "Bleach Grit",
    category: "Film",
    cssFilter: "grayscale(0.58) contrast(1.38) brightness(0.96)",
    vignette: 28,
  },
  {
    id: "silver-mono",
    label: "Ilford Silver",
    category: "Mono",
    cssFilter: "grayscale(1) contrast(1.26) brightness(1.03)",
    vignette: 20,
  },
  {
    id: "cyberpunk-neon",
    label: "Night Neon",
    category: "Modern",
    cssFilter: "contrast(1.22) saturate(1.52) hue-rotate(14deg)",
    warmOverlay: "rgba(168, 85, 247, 0.08)",
  },
  {
    id: "vivid-social",
    label: "Clean Crisp",
    category: "Modern",
    cssFilter: "contrast(1.13) saturate(1.26) brightness(1.03)",
  },
];

export interface CaptionStyle {
  x?: number; // 0..1 normalized center X (default 0.5)
  y?: number; // 0..1 normalized center Y (default 0.85)
  fontSize?: number; // relative to 1080p height, default 52
  fontFamily?: string;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  bgColor?: string;
  bgOpacity?: number;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  animation?: "none" | "fade" | "pop" | "slide-up" | "typewriter";
  [key: string]: unknown;
}

export interface ExtendedCaption extends Caption {
  style?: CaptionStyle;
}

export interface RenderedClipBox {
  clipId: string;
  trackId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export function getSequenceDuration(seq: Sequence | undefined | null): number {
  if (!seq) return 5;
  let max = 0.5;
  for (const track of seq.tracks) {
    for (const c of track.clips) {
      if (c.start + c.duration > max) max = c.start + c.duration;
    }
  }
  for (const cap of seq.captions) {
    if (cap.end > max) max = cap.end;
  }
  return Number(max.toFixed(3));
}

export type MaskShapeUiId = "none" | "circle" | "rectangle" | "split-h" | "split-v" | "linear";
export type BlendModeUiId =
  | "normal"
  | "screen"
  | "multiply"
  | "overlay"
  | "lighten"
  | "darken"
  | "soft-light"
  | "color-dodge"
  | "add";
export type SpeedRampUiId =
  | "constant"
  | "montage-in"
  | "hero-slowmo"
  | "bullet"
  | "jump-cut"
  | "smooth-out";

export const MASK_SHAPES_UI: ReadonlyArray<{ id: MaskShapeUiId; label: string }> = [
  { id: "none", label: "None" },
  { id: "circle", label: "Circle" },
  { id: "rectangle", label: "Rectangle" },
  { id: "split-h", label: "Split H" },
  { id: "split-v", label: "Split V" },
  { id: "linear", label: "Linear" },
];

export const BLEND_MODES_UI: ReadonlyArray<{
  id: BlendModeUiId;
  label: string;
  canvasOp: GlobalCompositeOperation;
}> = [
  { id: "normal", label: "Normal", canvasOp: "source-over" },
  { id: "screen", label: "Screen", canvasOp: "screen" },
  { id: "multiply", label: "Multiply", canvasOp: "multiply" },
  { id: "overlay", label: "Overlay", canvasOp: "overlay" },
  { id: "lighten", label: "Lighten", canvasOp: "lighten" },
  { id: "darken", label: "Darken", canvasOp: "darken" },
  { id: "soft-light", label: "Soft Light", canvasOp: "soft-light" },
  { id: "color-dodge", label: "Color Dodge", canvasOp: "color-dodge" },
  { id: "add", label: "Linear Add", canvasOp: "lighter" },
];

export const SPEED_RAMPS_UI: ReadonlyArray<{
  id: SpeedRampUiId;
  label: string;
  curve: readonly [number, number, number, number, number];
}> = [
  { id: "constant", label: "Constant", curve: [1, 1, 1, 1, 1] },
  { id: "montage-in", label: "Montage In", curve: [2.4, 1.35, 0.72, 0.72, 0.85] },
  { id: "hero-slowmo", label: "Hero Slow-Mo", curve: [1.55, 1.2, 0.42, 1.2, 1.63] },
  { id: "bullet", label: "Bullet Time", curve: [2.1, 1.15, 0.3, 1.15, 2.1] },
  { id: "jump-cut", label: "Jump Pop", curve: [0.65, 1.95, 0.65, 1.95, 0.8] },
  { id: "smooth-out", label: "Smooth Out", curve: [0.85, 0.85, 0.95, 1.45, 2.2] },
];

export interface ClipMaskUiState {
  shape: MaskShapeUiId;
  scale: number;
  feather: number;
  invert: boolean;
}

export function readClipMask(clip: Clip): ClipMaskUiState {
  const fx = clip.effects.find((e) => e.type === "mask" && e.enabled !== false);
  if (!fx) return { shape: "none", scale: 0.78, feather: 12, invert: false };
  return {
    shape: (fx.params?.shape as MaskShapeUiId) || "none",
    scale: Math.max(0.15, Math.min(1, Number(fx.params?.scale ?? 0.78))),
    feather: Math.max(0, Math.min(100, Number(fx.params?.feather ?? 12))),
    invert: Boolean(fx.params?.invert),
  };
}

export function readClipBlend(clip: Clip): { mode: BlendModeUiId; canvasOp: GlobalCompositeOperation } {
  const fx = clip.effects.find((e) => e.type === "blend" && e.enabled !== false);
  if (!fx) return { mode: "normal", canvasOp: "source-over" };
  const hit = BLEND_MODES_UI.find((b) => b.id === String(fx.params?.mode || "normal")) ?? BLEND_MODES_UI[0]!;
  return { mode: hit.id, canvasOp: hit.canvasOp };
}

export function readClipSpeedRamp(clip: Clip): { preset: SpeedRampUiId; intensity: number } {
  const fx = clip.effects.find((e) => e.type === "speed-ramp" && e.enabled !== false);
  if (!fx) return { preset: "constant", intensity: 1 };
  const hit = SPEED_RAMPS_UI.find((r) => r.id === String(fx.params?.preset || "constant")) ?? SPEED_RAMPS_UI[0]!;
  return {
    preset: hit.id,
    intensity: Math.max(0.1, Math.min(1, Number(fx.params?.intensity ?? 1))),
  };
}

export function evaluateSpeedRampUiProgress(
  preset: SpeedRampUiId,
  uRaw: number,
  intensity = 1,
): number {
  const u = Math.max(0, Math.min(1, uRaw));
  if (preset === "constant" || u <= 0 || u >= 1) return u;
  const spec = SPEED_RAMPS_UI.find((s) => s.id === preset) ?? SPEED_RAMPS_UI[0]!;
  const k = Math.max(0, Math.min(1, intensity));
  const weights = spec.curve.map((w) => Math.max(0.15, 1 + (w - 1) * k));
  const STEPS = 64;
  let totalArea = 0;
  let partialArea = 0;
  for (let i = 0; i < STEPS; i++) {
    const mid = (i + 0.5) / STEPS;
    const seg = mid * 4;
    const idx = Math.min(3, Math.floor(seg));
    const frac = seg - idx;
    const w = weights[idx]! + (weights[idx + 1]! - weights[idx]!) * frac;
    const area = w / STEPS;
    totalArea += area;
    const segEnd = (i + 1) / STEPS;
    const segStart = i / STEPS;
    if (u >= segEnd) partialArea += area;
    else if (u > segStart) partialArea += area * ((u - segStart) * STEPS);
  }
  return totalArea > 0 ? Math.max(0, Math.min(1, partialArea / totalArea)) : u;
}

export function getClipSpeed(clip: Clip): number {
  const fx = clip.effects.find((e) => e.type === "speed");
  const rate = Number(fx?.params?.rate ?? fx?.params?.speed ?? 1);
  return Number.isFinite(rate) && rate > 0.05 ? rate : 1;
}

export function isClipReversed(clip: Clip): boolean {
  return clip.effects.some((e) => e.type === "reverse" && e.params?.reversed !== false);
}

export function getClipVolumeGain(clip: Clip, track: Track): number {
  if (track.muted) return 0;
  const volFx = clip.effects.find((e) => e.type === "volume");
  const clipGain = volFx ? Number(volFx.params?.gain ?? 1) : 1;
  const db = track.volumeDb ?? 0;
  const trackGain = Math.pow(10, db / 20);
  return Math.max(0, Math.min(3, clipGain * trackGain));
}

export function getClipFadeEnvelope(clip: Clip, localTime: number): number {
  const fadeFx = clip.effects.find((e) => e.type === "fade");
  if (!fadeFx) return 1;
  const fi = Math.max(0, Number(fadeFx.params?.fadeIn ?? 0));
  const fo = Math.max(0, Number(fadeFx.params?.fadeOut ?? 0));
  let env = 1;
  if (fi > 0 && localTime < fi) env = Math.min(env, Math.max(0, localTime / fi));
  if (fo > 0 && localTime > clip.duration - fo) {
    env = Math.min(env, Math.max(0, (clip.duration - localTime) / fo));
  }
  return env;
}

export function getClipTransition(clip: Clip): { kind: string; duration: number } | null {
  const tx = clip.effects.find((e) => e.type === "transition");
  if (!tx) return null;
  const kind = String(tx.params?.kind || "dissolve");
  const duration = Math.max(0.15, Math.min(clip.duration * 0.85, Number(tx.params?.duration ?? 0.5)));
  return kind === "none" ? null : { kind, duration };
}

export function readClipAdjustments(clip: Clip): ColorAdjustments {
  const adjFx = clip.effects.find((e) => e.type === "adjust");
  if (!adjFx) return { ...DEFAULT_ADJUSTMENTS };
  return {
    exposure: Number(adjFx.params?.exposure ?? 0),
    brightness: Number(adjFx.params?.brightness ?? 0),
    contrast: Number(adjFx.params?.contrast ?? 0),
    saturation: Number(adjFx.params?.saturation ?? 0),
    temperature: Number(adjFx.params?.temperature ?? 0),
    tint: Number(adjFx.params?.tint ?? 0),
    fade: Number(adjFx.params?.fade ?? 0),
    vignette: Number(adjFx.params?.vignette ?? 0),
    blur: Number(adjFx.params?.blur ?? 0),
  };
}

export function readClipChromaKey(clip: Clip): {
  enabled: boolean;
  color: string;
  similarity: number;
  blend: number;
  despill: boolean;
} {
  const fx = clip.effects.find((e) => e.type === "chroma-key" || e.type === "chromakey");
  if (!fx || fx.enabled === false) {
    return { enabled: false, color: "#00ff00", similarity: 0.3, blend: 0.1, despill: true };
  }
  return {
    enabled: true,
    color: String(fx.params?.color || "#00ff00"),
    similarity: Math.max(0.02, Math.min(1, Number(fx.params?.similarity ?? 0.3))),
    blend: Math.max(0, Math.min(1, Number(fx.params?.blend ?? 0.1))),
    despill: fx.params?.despill !== false,
  };
}

export function readClipCurves(clip: Clip): {
  active: boolean;
  preset: ToneCurvePresetUi["id"] | "custom";
  shadows: number;
  midtones: number;
  highlights: number;
  clarity: number;
  points: ToneCurvePoint[];
} {
  const fx = clip.effects.find((e) => e.type === "curves");
  if (!fx || fx.enabled === false) {
    return {
      active: false,
      preset: "linear",
      shadows: 0,
      midtones: 0,
      highlights: 0,
      clarity: 0,
      points: TONE_CURVE_PRESETS_UI[0]!.points,
    };
  }
  const shadows = Number(fx.params?.shadows ?? 0);
  const midtones = Number(fx.params?.midtones ?? 0);
  const highlights = Number(fx.params?.highlights ?? 0);
  const clarity = Number(fx.params?.clarity ?? 0);
  const preset = (fx.params?.preset as ToneCurvePresetUi["id"] | "custom") || "custom";
  const pts = Array.isArray(fx.params?.points)
    ? (fx.params.points as ToneCurvePoint[])
    : computeCurvePoints(shadows, midtones, highlights, preset === "custom" ? "linear" : preset);
  const isIdentity =
    preset === "linear" && Math.abs(shadows) < 0.5 && Math.abs(midtones) < 0.5 && Math.abs(highlights) < 0.5;
  return {
    active: !isIdentity || Math.abs(clarity) >= 1,
    preset,
    shadows,
    midtones,
    highlights,
    clarity,
    points: pts,
  };
}

export function readClipAudioEq(clip: Clip): {
  preset: string;
  lowDb: number;
  midDb: number;
  highDb: number;
  voiceClarity: boolean;
} {
  const fx = clip.effects.find((e) => e.type === "eq");
  if (!fx || fx.enabled === false) {
    return { preset: "flat", lowDb: 0, midDb: 0, highDb: 0, voiceClarity: false };
  }
  return {
    preset: String(fx.params?.preset || "custom"),
    lowDb: Number(fx.params?.lowDb ?? 0),
    midDb: Number(fx.params?.midDb ?? 0),
    highDb: Number(fx.params?.highDb ?? 0),
    voiceClarity: Boolean(fx.params?.voiceClarity),
  };
}

export function computeCurvePoints(
  shadows = 0,
  midtones = 0,
  highlights = 0,
  presetId: ToneCurvePresetUi["id"] = "linear",
): ToneCurvePoint[] {
  const base = TONE_CURVE_PRESETS_UI.find((p) => p.id === presetId)?.points ?? TONE_CURVE_PRESETS_UI[0]!.points;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, Number(v.toFixed(4))));
  return [
    { x: 0, y: clamp01(base[0]!.y + Math.max(-0.15, shadows * 0.0012)) },
    { x: 0.25, y: clamp01(base[1]!.y + shadows * 0.0022) },
    { x: 0.5, y: clamp01(base[2]!.y + midtones * 0.0022) },
    { x: 0.75, y: clamp01(base[3]!.y + highlights * 0.0022) },
    { x: 1, y: clamp01(base[4]!.y + Math.min(0.15, highlights * 0.0012)) },
  ];
}

const lutCache = new Map<string, Uint8Array>();

export function getCachedCurveLut(points: ToneCurvePoint[]): Uint8Array {
  const key = points.map((p) => `${p.x.toFixed(3)}:${p.y.toFixed(3)}`).join("|");
  const hit = lutCache.get(key);
  if (hit) return hit;

  const sorted = points
    .map((p) => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }))
    .sort((a, b) => a.x - b.x);
  const pts: ToneCurvePoint[] = [];
  for (const p of sorted) {
    if (pts.length > 0 && Math.abs(pts[pts.length - 1]!.x - p.x) < 1e-4) pts[pts.length - 1] = p;
    else pts.push(p);
  }
  if (pts.length === 0) return Uint8Array.from({ length: 256 }, (_, i) => i);
  if (pts[0]!.x > 0) pts.unshift({ x: 0, y: pts[0]!.y });
  if (pts[pts.length - 1]!.x < 1) pts.push({ x: 1, y: pts[pts.length - 1]!.y });

  const n = pts.length;
  const d = new Array<number>(n - 1).fill(0);
  const m = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const h = Math.max(1e-5, pts[i + 1]!.x - pts[i]!.x);
    d[i] = (pts[i + 1]!.y - pts[i]!.y) / h;
  }
  m[0] = d[0] ?? 0;
  m[n - 1] = d[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) * 0.5;
  }

  const lut = new Uint8Array(256);
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
    const y =
      (2 * t3 - 3 * t2 + 1) * p0.y +
      (t3 - 2 * t2 + t) * h * m[seg]! +
      (-2 * t3 + 3 * t2) * p1.y +
      (t3 - t2) * h * m[seg + 1]!;
    lut[idx] = Math.max(0, Math.min(255, Math.round(y * 255)));
  }
  if (lutCache.size > 64) lutCache.clear();
  lutCache.set(key, lut);
  return lut;
}

export function readClipLook(clip: Clip): { id: string; intensity: number } {
  const lut = clip.effects.find((e) => e.type === "lut3d");
  if (lut) {
    return {
      id: String(lut.params?.lutId || "none"),
      intensity: Number(lut.params?.intensity ?? 100),
    };
  }
  const grade = clip.effects.find((e) => e.type === "color-grade");
  if (grade && grade.params?.preset) {
    return {
      id: String(grade.params.preset),
      intensity: Number(grade.params?.intensity ?? 100),
    };
  }
  return { id: "none", intensity: 100 };
}

export function buildClipCssFilter(clip: Clip): string {
  const adj = readClipAdjustments(clip);
  const curves = readClipCurves(clip);
  const look = readClipLook(clip);
  const preset = LOOK_PRESETS.find((p) => p.id === look.id);

  const parts: string[] = [];
  const expMul = Math.pow(2, adj.exposure / 100);
  const brightMul = Math.max(0.1, expMul * (1 + adj.brightness / 120));
  const clarityMul = 1 + curves.clarity / 260;
  const contrastMul = Math.max(0.2, (1 + adj.contrast / 100) * clarityMul);
  const satMul = Math.max(0, 1 + adj.saturation / 100);

  if (Math.abs(brightMul - 1) > 0.005) parts.push(`brightness(${brightMul.toFixed(3)})`);
  if (Math.abs(contrastMul - 1) > 0.005) parts.push(`contrast(${contrastMul.toFixed(3)})`);
  if (Math.abs(satMul - 1) > 0.005) parts.push(`saturate(${satMul.toFixed(3)})`);
  if (adj.temperature > 1) parts.push(`sepia(${(adj.temperature / 220).toFixed(3)})`);
  if (adj.temperature < -1) parts.push(`hue-rotate(${(adj.temperature * 0.22).toFixed(1)}deg)`);
  if (Math.abs(adj.tint) > 1) parts.push(`hue-rotate(${(adj.tint * 0.35).toFixed(1)}deg)`);
  if (adj.blur > 0.2) parts.push(`blur(${adj.blur.toFixed(1)}px)`);

  if (preset && preset.id !== "none" && look.intensity > 0) {
    parts.push(preset.cssFilter);
  }
  return parts.length ? parts.join(" ") : "none";
}

export function interpolateKeyframes(clip: Clip, prop: string, localTime: number, fallback: number): number {
  const kfs = clip.keyframes
    .filter((k) => k.property === prop)
    .slice()
    .sort((a, b) => a.time - b.time);
  if (kfs.length === 0) return fallback;
  if (localTime <= kfs[0]!.time) return Number(kfs[0]!.value) || fallback;
  const last = kfs[kfs.length - 1]!;
  if (localTime >= last.time) return Number(last.value) || fallback;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (localTime >= a.time && localTime <= b.time) {
      const span = Math.max(0.0001, b.time - a.time);
      const rawT = (localTime - a.time) / span;
      const easing = a.easing || "ease-in-out";
      let t = rawT;
      if (easing === "hold") t = 0;
      else if (easing === "ease-in") t = rawT * rawT;
      else if (easing === "ease-out") t = 1 - (1 - rawT) * (1 - rawT);
      else if (easing === "expo-out") t = easeOutExpo(rawT);
      else if (easing === "cinema") t = easeInOutQuart(rawT);
      else if (easing === "spring") t = easeOutBackSpring(rawT, 1.08);
      else if (easing === "ease-in-out") t = rawT * rawT * (3 - 2 * rawT);
      const av = Number(a.value) || 0;
      const bv = Number(b.value) || 0;
      return av + (bv - av) * t;
    }
  }
  return fallback;
}

export function computeClipMediaTime(clip: Clip, timelineTime: number): number {
  const rawLocal = Math.max(0, Math.min(clip.duration, timelineTime - clip.start));
  const ramp = readClipSpeedRamp(clip);
  const local =
    ramp.preset !== "constant" && clip.duration > 0.05
      ? evaluateSpeedRampUiProgress(ramp.preset, rawLocal / clip.duration, ramp.intensity) * clip.duration
      : rawLocal;
  const speed = getClipSpeed(clip);
  if (isClipReversed(clip)) {
    return Math.max(0, clip.out - local * speed);
  }
  return Math.max(0, clip.in + local * speed);
}

// ---------- Filmstrip & Real Audio Waveform Caches ----------

const filmstripCache = new Map<string, string[]>();
const filmstripPending = new Map<string, Promise<string[]>>();
const waveformCache = new Map<string, number[]>();
const waveformPending = new Map<string, Promise<number[]>>();

export function getCachedFilmstrip(assetId: string): string[] | undefined {
  return filmstripCache.get(assetId);
}

export function getCachedWaveform(assetId: string): number[] | undefined {
  return waveformCache.get(assetId);
}

export function setCachedWaveform(assetId: string, peaks: number[]): void {
  if (peaks.length > 0) waveformCache.set(assetId, peaks);
}

export async function extractBrowserWaveformPeaks(
  assetId: string,
  mediaUrl: string,
  buckets = 72,
): Promise<number[]> {
  const key = `${assetId}:${buckets}`;
  if (waveformCache.has(assetId)) return waveformCache.get(assetId)!;
  if (waveformPending.has(key)) return waveformPending.get(key)!;

  const task = (async (): Promise<number[]> => {
    try {
      if (typeof AudioContext === "undefined") return [];
      const resp = await fetch(mediaUrl);
      const arr = await resp.arrayBuffer();
      const actx = new AudioContext();
      try {
        const decoded = await actx.decodeAudioData(arr.slice(0));
        const ch0 = decoded.getChannelData(0);
        const ch1 = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : ch0;
        const step = Math.max(1, Math.floor(ch0.length / buckets));
        const stride = Math.max(1, Math.floor(step / 48));
        const raw: number[] = [];
        let globalPeak = 0.01;
        for (let i = 0; i < buckets; i++) {
          let max = 0;
          const end = Math.min(ch0.length, (i + 1) * step);
          for (let j = i * step; j < end; j += stride) {
            const amp = (Math.abs(ch0[j] || 0) + Math.abs(ch1[j] || 0)) * 0.5;
            if (amp > max) max = amp;
          }
          if (max > globalPeak) globalPeak = max;
          raw.push(max);
        }
        const normalized = raw.map((v) => Number(Math.max(0.06, Math.min(1, v / globalPeak)).toFixed(3)));
        waveformCache.set(assetId, normalized);
        return normalized;
      } finally {
        void actx.close().catch(() => undefined);
      }
    } catch {
      return [];
    } finally {
      waveformPending.delete(key);
    }
  })();

  waveformPending.set(key, task);
  return task;
}

export async function extractMediaFilmstrip(
  assetId: string,
  mediaUrl: string,
  kind: Asset["kind"],
  duration = 5,
  count = 6,
): Promise<string[]> {
  if (filmstripCache.has(assetId)) return filmstripCache.get(assetId)!;
  if (filmstripPending.has(assetId)) return filmstripPending.get(assetId)!;

  const task = (async (): Promise<string[]> => {
    if (typeof document === "undefined" || kind === "audio") return [];
    if (kind === "image" || kind === "generated") {
      const arr = [mediaUrl];
      filmstripCache.set(assetId, arr);
      return arr;
    }
    try {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = mediaUrl;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 6000);
        video.onloadeddata = () => {
          clearTimeout(timer);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(timer);
          reject(new Error("video error"));
        };
      });

      const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const ctx = canvas.getContext("2d");
      if (!ctx) return [];

      const frames: string[] = [];
      const steps = Math.max(2, Math.min(8, count));
      for (let i = 0; i < steps; i++) {
        const t = Math.min(Math.max(0.05, dur - 0.05), ((i + 0.35) / steps) * dur);
        await seekVideoElement(video, t, 1500);
        const vw = video.videoWidth || 160;
        const vh = video.videoHeight || 90;
        const scale = Math.max(160 / vw, 90 / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        ctx.clearRect(0, 0, 160, 90);
        ctx.drawImage(video, (160 - dw) / 2, (90 - dh) / 2, dw, dh);
        frames.push(canvas.toDataURL("image/jpeg", 0.68));
      }
      video.src = "";
      filmstripCache.set(assetId, frames);
      return frames;
    } catch {
      return [];
    } finally {
      filmstripPending.delete(assetId);
    }
  })();

  filmstripPending.set(assetId, task);
  return task;
}

export function seekVideoElement(video: HTMLVideoElement, timeSec: number, timeoutMs = 1500): Promise<void> {
  const target = Math.max(0, timeSec);
  if (Math.abs(video.currentTime - target) < 0.012 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener(
      "seeked",
      () => {
        clearTimeout(timer);
        finish();
      },
      { once: true },
    );
    try {
      video.currentTime = target;
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

// ---------- Reusable 60 FPS Offscreen Pixel Shader Buffer (Chroma Key + Tone Curve LUT) ----------

let fxCanvas: HTMLCanvasElement | null = null;
let fxCtx: CanvasRenderingContext2D | null = null;

function parseHexRgb(hex: string): [number, number, number] {
  const c = hex.replace(/^#|^0x/i, "").trim();
  if (c.toLowerCase() === "blue") return [0, 85, 255];
  if (c.length === 6) {
    return [
      parseInt(c.slice(0, 2), 16) || 0,
      parseInt(c.slice(2, 4), 16) || 0,
      parseInt(c.slice(4, 6), 16) || 0,
    ];
  }
  return [0, 255, 0];
}

function renderProcessedClipSource(
  source: HTMLVideoElement | HTMLImageElement,
  sxPx: number,
  syPx: number,
  swPx: number,
  shPx: number,
  targetW: number,
  targetH: number,
  chroma: ReturnType<typeof readClipChromaKey>,
  curves: ReturnType<typeof readClipCurves>,
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  // Cap pixel buffer resolution to keep 60 FPS effortless on mobile GPUs/CPUs while staying razor sharp
  const maxDim = 960;
  const scale = Math.min(1, maxDim / Math.max(targetW, targetH, 1));
  const bw = Math.max(2, Math.round(targetW * scale));
  const bh = Math.max(2, Math.round(targetH * scale));

  if (!fxCanvas) {
    fxCanvas = document.createElement("canvas");
    fxCtx = fxCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (!fxCtx) return null;
  if (fxCanvas.width !== bw || fxCanvas.height !== bh) {
    fxCanvas.width = bw;
    fxCanvas.height = bh;
  }

  fxCtx.clearRect(0, 0, bw, bh);
  fxCtx.drawImage(source, sxPx, syPx, swPx, shPx, 0, 0, bw, bh);

  let imgData: ImageData;
  try {
    imgData = fxCtx.getImageData(0, 0, bw, bh);
  } catch {
    return null;
  }
  const data = imgData.data;
  const lut = curves.active ? getCachedCurveLut(curves.points) : null;

  const [kr, kg, kb] = parseHexRgb(chroma.color);
  const keyCb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
  const keyCr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
  const innerTol = chroma.similarity * 145;
  const outerTol = innerTol + Math.max(4, chroma.blend * 110);
  const invSpan = 1 / Math.max(1, outerTol - innerTol);
  const greenDominant = kg >= kb;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]!;
    let g = data[i + 1]!;
    let b = data[i + 2]!;

    if (chroma.enabled) {
      const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
      const dCb = cb - keyCb;
      const dCr = cr - keyCr;
      const dist = Math.sqrt(dCb * dCb + dCr * dCr);
      if (dist <= innerTol) {
        data[i + 3] = 0;
        continue;
      } else if (dist < outerTol) {
        data[i + 3] = Math.round(data[i + 3]! * ((dist - innerTol) * invSpan));
      }
      if (chroma.despill) {
        if (greenDominant) {
          const ceiling = (r + b) * 0.52;
          if (g > ceiling) g = Math.round(ceiling);
        } else {
          const ceiling = (r + g) * 0.52;
          if (b > ceiling) b = Math.round(ceiling);
        }
      }
    }

    if (lut) {
      r = lut[r]!;
      g = lut[g]!;
      b = lut[b]!;
    }

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }

  fxCtx.putImageData(imgData, 0, 0);
  return fxCanvas;
}

let maskCompCanvas: HTMLCanvasElement | null = null;
let maskCompCtx: CanvasRenderingContext2D | null = null;
let maskAlphaCanvas: HTMLCanvasElement | null = null;
let maskAlphaCtx: CanvasRenderingContext2D | null = null;

function applyShapeMaskToSource(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  drawW: number,
  drawH: number,
  mask: ClipMaskUiState,
): HTMLCanvasElement | null {
  if (typeof document === "undefined" || mask.shape === "none") return null;
  const maxDim = 960;
  const ratio = Math.min(1, maxDim / Math.max(drawW, drawH, 1));
  const mw = Math.max(4, Math.round(drawW * ratio));
  const mh = Math.max(4, Math.round(drawH * ratio));
  if (!maskCompCanvas) {
    maskCompCanvas = document.createElement("canvas");
    maskCompCtx = maskCompCanvas.getContext("2d");
  }
  if (!maskAlphaCanvas) {
    maskAlphaCanvas = document.createElement("canvas");
    maskAlphaCtx = maskAlphaCanvas.getContext("2d");
  }
  if (!maskCompCtx || !maskAlphaCtx) return null;
  if (maskCompCanvas.width !== mw || maskCompCanvas.height !== mh) {
    maskCompCanvas.width = mw;
    maskCompCanvas.height = mh;
    maskAlphaCanvas.width = mw;
    maskAlphaCanvas.height = mh;
  }

  maskAlphaCtx.save();
  maskAlphaCtx.clearRect(0, 0, mw, mh);
  const blurPx = Math.round((mask.feather / 100) * Math.min(mw, mh) * 0.16);
  if (blurPx > 0) maskAlphaCtx.filter = `blur(${blurPx}px)`;
  maskAlphaCtx.fillStyle = "#ffffff";

  if (mask.shape === "circle") {
    const r = (Math.min(mw, mh) / 2) * mask.scale;
    maskAlphaCtx.beginPath();
    maskAlphaCtx.arc(mw / 2, mh / 2, r, 0, Math.PI * 2);
    maskAlphaCtx.fill();
  } else if (mask.shape === "rectangle") {
    const rw = mw * mask.scale;
    const rh = mh * mask.scale;
    const rx = (mw - rw) / 2;
    const ry = (mh - rh) / 2;
    const rad = Math.min(rw, rh) * 0.08;
    maskAlphaCtx.beginPath();
    maskAlphaCtx.moveTo(rx + rad, ry);
    maskAlphaCtx.lineTo(rx + rw - rad, ry);
    maskAlphaCtx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rad);
    maskAlphaCtx.lineTo(rx + rw, ry + rh - rad);
    maskAlphaCtx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rad, ry + rh);
    maskAlphaCtx.lineTo(rx + rad, ry + rh);
    maskAlphaCtx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rad);
    maskAlphaCtx.lineTo(rx, ry + rad);
    maskAlphaCtx.quadraticCurveTo(rx, ry, rx + rad, ry);
    maskAlphaCtx.closePath();
    maskAlphaCtx.fill();
  } else if (mask.shape === "split-h") {
    maskAlphaCtx.fillRect(0, 0, mw, mh * mask.scale);
  } else if (mask.shape === "split-v") {
    maskAlphaCtx.fillRect(0, 0, mw * mask.scale, mh);
  } else if (mask.shape === "linear") {
    maskAlphaCtx.filter = "none";
    const span = Math.max(0.06, (mask.feather / 100) * 0.55);
    const y0 = mh * Math.max(0, mask.scale - span);
    const y1 = mh * Math.min(1, mask.scale + span);
    const grad = maskAlphaCtx.createLinearGradient(0, y0, 0, Math.max(y0 + 2, y1));
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    maskAlphaCtx.fillStyle = grad;
    maskAlphaCtx.fillRect(0, 0, mw, mh);
  }
  maskAlphaCtx.restore();

  maskCompCtx.save();
  maskCompCtx.clearRect(0, 0, mw, mh);
  maskCompCtx.globalCompositeOperation = "source-over";
  maskCompCtx.drawImage(source, sx, sy, sw, sh, 0, 0, mw, mh);
  maskCompCtx.globalCompositeOperation = mask.invert ? "destination-out" : "destination-in";
  maskCompCtx.drawImage(maskAlphaCanvas, 0, 0);
  maskCompCtx.restore();
  return maskCompCanvas;
}

export function exportCanvasSnapshotPng(canvas: HTMLCanvasElement | null, baseName = "vedit-frame"): boolean {
  if (!canvas || typeof document === "undefined") return false;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${baseName.replace(/[^a-zA-Z0-9_-]+/g, "_")}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch {
    return false;
  }
}

export interface RenderFrameOptions {
  project: Project;
  sequence: Sequence;
  time: number;
  mediaElements: Map<string, HTMLVideoElement | HTMLImageElement>;
  splitComparePct?: number | null;
  backdropMode?: "blur" | "black" | "dark" | "white";
}

let lastRenderedClipBoxes: RenderedClipBox[] = [];

export function getLastRenderedClipBoxes(): RenderedClipBox[] {
  return lastRenderedClipBoxes;
}

function drawSingleClipLayer(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  trackId: string,
  clip: Clip,
  source: HTMLVideoElement | HTMLImageElement,
  localTime: number,
  extraAlpha = 1,
  offsetXRatio = 0,
  offsetYRatio = 0,
  extraScale = 1,
  backdropBlurFill = false,
  disableGrading = false,
  recordBounds = false,
): void {
  const srcW =
    source instanceof HTMLVideoElement ? source.videoWidth || width : source.naturalWidth || width;
  const srcH =
    source instanceof HTMLVideoElement ? source.videoHeight || height : source.naturalHeight || height;
  if (!srcW || !srcH) return;

  const fadeEnv = getClipFadeEnvelope(clip, localTime);
  const baseOpacity = interpolateKeyframes(clip, "opacity", localTime, clip.transform.opacity ?? 1);
  const alpha = Math.max(0, Math.min(1, baseOpacity * fadeEnv * extraAlpha));
  if (alpha <= 0.002) return;

  const chroma = disableGrading
    ? { enabled: false, color: "#00ff00", similarity: 0.3, blend: 0.1, despill: true }
    : readClipChromaKey(clip);
  const curves = disableGrading
    ? { active: false, preset: "linear" as const, shadows: 0, midtones: 0, highlights: 0, clarity: 0, points: [] }
    : readClipCurves(clip);
  const mask = readClipMask(clip);
  const blend = readClipBlend(clip);

  // Optional blurred full-canvas background fill when aspect ratios differ (suppress if chroma-keyed or masked!)
  const canvasAspect = width / height;
  const srcAspect = srcW / srcH;
  if (
    backdropBlurFill &&
    !chroma.enabled &&
    mask.shape === "none" &&
    blend.mode === "normal" &&
    Math.abs(canvasAspect - srcAspect) > 0.08
  ) {
    ctx.save();
    ctx.globalAlpha = alpha * 0.85;
    ctx.filter = "blur(26px) brightness(0.62) saturate(1.2)";
    const coverScale = Math.max(width / srcW, height / srcH) * 1.12;
    const bw = srcW * coverScale;
    const bh = srcH * coverScale;
    ctx.drawImage(source, (width - bw) / 2, (height - bh) / 2, bw, bh);
    ctx.restore();
  }

  const tx = interpolateKeyframes(clip, "x", localTime, clip.transform.x ?? 0);
  const ty = interpolateKeyframes(clip, "y", localTime, clip.transform.y ?? 0);
  const sx = interpolateKeyframes(clip, "scaleX", localTime, clip.transform.scaleX ?? 1) * extraScale;
  const sy = interpolateKeyframes(clip, "scaleY", localTime, clip.transform.scaleY ?? 1) * extraScale;
  const rot = interpolateKeyframes(clip, "rotation", localTime, clip.transform.rotation ?? 0);

  const cropFx = clip.effects.find((e) => e.type === "crop");
  const normCrop = (v: unknown) => {
    const n = Number(v ?? 0);
    return Math.max(0, Math.min(0.45, Math.abs(n) > 0.5 ? n / 100 : n));
  };
  const cLeft = normCrop(cropFx?.params?.left);
  const cRight = normCrop(cropFx?.params?.right);
  const cTop = normCrop(cropFx?.params?.top);
  const cBottom = normCrop(cropFx?.params?.bottom);

  const sxPx = srcW * cLeft;
  const syPx = srcH * cTop;
  const swPx = Math.max(2, srcW * (1 - cLeft - cRight));
  const shPx = Math.max(2, srcH * (1 - cTop - cBottom));

  const fitMode = String((clip.transform as Record<string, unknown>).fitMode || "contain");
  const baseScale =
    fitMode === "cover" ? Math.max(width / swPx, height / shPx) : Math.min(width / swPx, height / shPx);
  const drawW = swPx * baseScale * Math.abs(sx);
  const drawH = shPx * baseScale * Math.abs(sy);

  const centerX = width / 2 + tx + offsetXRatio * width;
  const centerY = height / 2 + ty + offsetYRatio * height;
  if (recordBounds) {
    lastRenderedClipBoxes.push({
      clipId: clip.id,
      trackId,
      x: centerX - drawW / 2,
      y: centerY - drawH / 2,
      w: drawW,
      h: drawH,
      cx: centerX,
      cy: centerY,
    });
  }

  const adj = readClipAdjustments(clip);
  const look = readClipLook(clip);
  const lookPreset = LOOK_PRESETS.find((p) => p.id === look.id);

  const processed =
    chroma.enabled || curves.active
      ? renderProcessedClipSource(source, sxPx, syPx, swPx, shPx, drawW, drawH, chroma, curves)
      : null;

  const maskedSource =
    mask.shape !== "none"
      ? applyShapeMaskToSource(
          processed ?? source,
          processed ? 0 : sxPx,
          processed ? 0 : syPx,
          processed ? processed.width : swPx,
          processed ? processed.height : shPx,
          drawW,
          drawH,
          mask,
        )
      : null;

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalAlpha = alpha;
  if (blend.mode !== "normal") {
    ctx.globalCompositeOperation = blend.canvasOp;
  }
  if (!disableGrading) {
    const cssFilter = buildClipCssFilter(clip);
    if (cssFilter !== "none") ctx.filter = cssFilter;
  }

  ctx.translate(centerX, centerY);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(sx < 0 ? -1 : 1, sy < 0 ? -1 : 1);
  if (maskedSource) {
    ctx.drawImage(maskedSource, 0, 0, maskedSource.width, maskedSource.height, -drawW / 2, -drawH / 2, drawW, drawH);
  } else if (processed) {
    ctx.drawImage(processed, 0, 0, processed.width, processed.height, -drawW / 2, -drawH / 2, drawW, drawH);
  } else {
    ctx.drawImage(source, sxPx, syPx, swPx, shPx, -drawW / 2, -drawH / 2, drawW, drawH);
  }

  // Subtle color temperature / LUT tint wash
  if (!disableGrading && !chroma.enabled && lookPreset?.warmOverlay && look.intensity > 0) {
    ctx.filter = "none";
    ctx.globalAlpha = alpha * (look.intensity / 100);
    ctx.fillStyle = lookPreset.warmOverlay;
    ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
  }

  // Matte film fade lift
  const fadeLift = disableGrading ? 0 : Math.max(adj.fade, lookPreset?.fadeLift ?? 0);
  if (fadeLift > 0 && !chroma.enabled) {
    ctx.filter = "none";
    ctx.globalAlpha = alpha * (fadeLift / 260);
    ctx.fillStyle = "#232329";
    ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
  }
  ctx.restore();

  // Optical vignette
  const vig = disableGrading ? 0 : Math.max(adj.vignette, lookPreset?.vignette ?? 0);
  if (vig > 1 && !chroma.enabled) {
    ctx.save();
    const grad = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.28,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.72,
    );
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.82, vig / 115).toFixed(3)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
}

export function drawCaptionOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cap: ExtendedCaption,
  time: number,
): { boxX: number; boxY: number; boxW: number; boxH: number } | null {
  if (time < cap.start || time > cap.end) return null;
  const dur = Math.max(0.1, cap.end - cap.start);
  const rel = (time - cap.start) / dur;
  const elapsed = time - cap.start;

  const st: CaptionStyle = cap.style ?? {};
  if (typeof st.motionTemplate === "string" && st.motionTemplate) {
    return drawMotionGraphicOverlay(ctx, width, height, {
      template: st.motionTemplate as MotionGraphicTemplateId,
      title: cap.text,
      subtitle: typeof st.subtitle === "string" ? st.subtitle : "",
      color: st.color,
      accentColor: typeof st.accentColor === "string" ? st.accentColor : "#3b82f6",
      bgColor: st.bgColor,
      bgOpacity: st.bgOpacity,
      x: st.x,
      y: st.y,
      fontSize: st.fontSize,
      elapsed,
      duration: dur,
    });
  }

  const cx = (st.x ?? 0.5) * width;
  let cy = (st.y ?? 0.84) * height;
  const scaleFactor = height / 1080;
  const fontPx = Math.max(16, Math.round((st.fontSize ?? 54) * scaleFactor));
  const family = st.fontFamily || "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const anim = st.animation || "fade";

  let alpha = 1;
  let popScale = 1;
  let visibleText = cap.text;

  if (anim === "fade") {
    if (elapsed < 0.22) alpha = elapsed / 0.22;
    else if (cap.end - time < 0.22) alpha = (cap.end - time) / 0.22;
  } else if (anim === "pop") {
    if (elapsed < 0.2) {
      const p = elapsed / 0.2;
      popScale = 0.72 + 0.34 * p;
      alpha = p;
    } else if (elapsed < 0.3) {
      popScale = 1.06 - 0.06 * ((elapsed - 0.2) / 0.1);
    }
  } else if (anim === "slide-up") {
    if (elapsed < 0.28) {
      const p = 1 - Math.pow(1 - elapsed / 0.28, 3);
      cy += (1 - p) * 42 * scaleFactor;
      alpha = p;
    }
  } else if (anim === "typewriter") {
    const chars = Math.max(1, Math.floor(cap.text.length * Math.min(1, rel * 2.2)));
    visibleText = cap.text.slice(0, chars);
  }

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.translate(cx, cy);
  ctx.scale(popScale, popScale);

  const weight = st.bold !== false ? "700" : "500";
  const italic = st.italic ? "italic " : "";
  ctx.font = `${italic}${weight} ${fontPx}px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = visibleText.split("\n");
  const lineH = Math.round(fontPx * 1.24);
  let maxLineW = 40;
  for (const l of lines) {
    maxLineW = Math.max(maxLineW, ctx.measureText(l).width);
  }
  const padX = Math.round(fontPx * 0.55);
  const padY = Math.round(fontPx * 0.32);
  const boxW = maxLineW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  const bgOpacity = st.bgOpacity ?? 0.62;
  if (bgOpacity > 0.01) {
    const r = Math.min(18 * scaleFactor, boxH / 2);
    ctx.fillStyle = hexWithAlpha(st.bgColor || "#09090b", bgOpacity);
    roundRectPath(ctx, -boxW / 2, -boxH / 2, boxW, boxH, r);
    ctx.fill();
  }

  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = Math.round(8 * scaleFactor);
  ctx.shadowOffsetY = Math.round(2 * scaleFactor);

  const strokeW = (st.strokeWidth ?? 3) * scaleFactor;
  lines.forEach((line, idx) => {
    const ly = -((lines.length - 1) * lineH) / 2 + idx * lineH;
    if (strokeW > 0.3) {
      ctx.lineWidth = strokeW;
      ctx.lineJoin = "round";
      ctx.strokeStyle = st.strokeColor || "rgba(0,0,0,0.85)";
      ctx.strokeText(line, 0, ly);
    }
    ctx.fillStyle = st.color || "#ffffff";
    ctx.fillText(line, 0, ly);
  });

  ctx.restore();
  return { boxX: cx - boxW / 2, boxY: cy - boxH / 2, boxW, boxH };
}

function hexWithAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "").trim();
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  }
  return `rgba(9,9,11,${alpha.toFixed(3)})`;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function renderSequenceFrame(
  ctx: CanvasRenderingContext2D,
  opts: RenderFrameOptions,
): Array<{ id: string; boxX: number; boxY: number; boxW: number; boxH: number }> {
  const { sequence, time, mediaElements, splitComparePct, backdropMode = "blur" } = opts;
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  lastRenderedClipBoxes = [];

  // Base canvas fill
  ctx.save();
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  ctx.fillStyle =
    backdropMode === "white" ? "#ffffff" : backdropMode === "dark" ? "#111114" : "#000000";
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  const renderPass = (disableGrading: boolean, recordBounds: boolean) => {
    const soloVisual = sequence.tracks.some((t) => t.kind !== "audio" && t.solo);
    const visualTracks = sequence.tracks.filter(
      (t) => t.kind !== "audio" && !t.muted && (!soloVisual || t.solo),
    );
    // Track index 0 is bottom/primary video track; subsequent video/graphics tracks overlay on top
    visualTracks.forEach((track, trackIdx) => {
      const sorted = track.clips.slice().sort((a, b) => a.start - b.start);
      for (let i = 0; i < sorted.length; i++) {
        const clip = sorted[i]!;
        if (time < clip.start || time > clip.start + clip.duration) continue;

        const procFx = clip.effects.find((e) => e.type === "procedural-fx" && e.enabled !== false);
        if (procFx && procFx.params?.preset) {
          const localProcT = time - clip.start;
          const fadeEnv = getClipFadeEnvelope(clip, localProcT);
          const clipAlpha = Math.max(0, Math.min(1, (clip.transform.opacity ?? 1) * fadeEnv));
          drawProceduralFxClip(
            ctx,
            width,
            height,
            localProcT,
            clip.duration,
            {
              preset: procFx.params.preset as ProceduralVisualPresetId,
              primaryColor: String(procFx.params.primaryColor || "#f59e0b"),
              accentColor: String(procFx.params.accentColor || "#ef4444"),
              intensity: Number(procFx.params.intensity ?? 92),
              seed: Number(procFx.params.seed ?? 7),
            },
            clipAlpha,
          );
          if (recordBounds) {
            lastRenderedClipBoxes.push({
              clipId: clip.id,
              trackId: track.id,
              x: 0,
              y: 0,
              w: width,
              h: height,
              cx: width / 2,
              cy: height / 2,
            });
          }
          continue;
        }

        const source = mediaElements.get(clip.id) ?? mediaElements.get(clip.assetId);
        if (!source) continue;

        const localTime = time - clip.start;
        const tx = getClipTransition(clip);
        let alpha = 1;
        let offsetX = 0;
        let offsetY = 0;
        let extraScale = 1;
        let wipeRect: { x: number; y: number; w: number; h: number } | null = null;
        let irisRadius: number | null = null;

        if (tx && localTime < tx.duration) {
          const p = Math.max(0, Math.min(1, localTime / tx.duration));
          const ease = easeInOutQuart(p);
          // Blend outgoing clip underneath during transition window
          const prev = i > 0 ? sorted[i - 1] : undefined;
          if (prev) {
            const prevSrc = mediaElements.get(prev.id) ?? mediaElements.get(prev.assetId);
            if (prevSrc) {
              drawSingleClipLayer(
                ctx,
                width,
                height,
                track.id,
                prev,
                prevSrc,
                Math.max(0, prev.duration - 0.02),
                1,
                tx.kind === "whip-pan" ? -ease * 0.45 : 0,
                0,
                tx.kind === "zoom-punch" ? 1 + 0.35 * ease : 1,
                trackIdx === 0 && backdropMode === "blur",
                disableGrading,
                false,
              );
            }
          }
          if (tx.kind === "dissolve" || tx.kind === "light-leak" || tx.kind === "film-burn") alpha = ease;
          else if (tx.kind === "slide-left") offsetX = 1 - ease;
          else if (tx.kind === "whip-pan") offsetX = (1 - easeOutExpo(p)) * 1.15;
          else if (tx.kind === "slide-right") offsetX = -(1 - ease);
          else if (tx.kind === "slide-up") offsetY = 1 - ease;
          else if (tx.kind === "wipe-left") {
            const revealW = Math.round(width * ease);
            wipeRect = { x: width - revealW, y: 0, w: revealW, h: height };
          } else if (tx.kind === "wipe-right") {
            const revealW = Math.round(width * ease);
            wipeRect = { x: 0, y: 0, w: revealW, h: height };
          } else if (tx.kind === "iris-circle") {
            irisRadius = Math.hypot(width, height) * 0.6 * ease;
          } else if (tx.kind === "zoom-in") {
            extraScale = 0.78 + 0.22 * ease;
            alpha = ease;
          } else if (tx.kind === "zoom-punch") {
            extraScale = 1.42 - 0.42 * easeOutExpo(p);
            alpha = Math.min(1, p * 2.2);
          } else if (tx.kind === "fade-black" || tx.kind === "fade-white") {
            alpha = ease;
          }
        }

        if (wipeRect) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(wipeRect.x, wipeRect.y, wipeRect.w, wipeRect.h);
          ctx.clip?.();
        } else if (irisRadius != null) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(width / 2, height / 2, Math.max(2, irisRadius), 0, Math.PI * 2);
          ctx.clip?.();
        }

        drawSingleClipLayer(
          ctx,
          width,
          height,
          track.id,
          clip,
          source,
          localTime,
          alpha,
          offsetX,
          offsetY,
          extraScale,
          trackIdx === 0 && backdropMode === "blur",
          disableGrading,
          recordBounds,
        );

        if (wipeRect || irisRadius != null) {
          ctx.restore();
        }

        if (tx && localTime < tx.duration && (tx.kind === "fade-black" || tx.kind === "fade-white")) {
          const p = localTime / tx.duration;
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - p);
          ctx.fillStyle = tx.kind === "fade-white" ? "#ffffff" : "#000000";
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
        } else if (tx && localTime < tx.duration && (tx.kind === "light-leak" || tx.kind === "film-burn")) {
          drawProceduralFxClip(ctx, width, height, localTime, tx.duration, {
            preset: tx.kind === "light-leak" ? "golden-light-leak" : "film-flash-burn",
            primaryColor: tx.kind === "light-leak" ? "#f59e0b" : "#fb923c",
            accentColor: tx.kind === "light-leak" ? "#ef4444" : "#fef08a",
            intensity: 90,
            seed: 11,
          });
        }
      }
    });
  };

  if (splitComparePct != null && splitComparePct > 0 && splitComparePct < 100) {
    const splitX = Math.round((splitComparePct / 100) * width);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, height);
    ctx.clip();
    renderPass(true, false);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, width - splitX, height);
    ctx.clip();
    renderPass(false, true);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, height);
    ctx.stroke();
    ctx.restore();
  } else {
    renderPass(false, true);
  }

  // Draw active captions / titles
  const captionBoxes: Array<{ id: string; boxX: number; boxY: number; boxW: number; boxH: number }> = [];
  for (const cap of sequence.captions as ExtendedCaption[]) {
    const box = drawCaptionOverlay(ctx, width, height, cap, time);
    if (box) captionBoxes.push({ id: cap.id, ...box });
  }
  return captionBoxes;
}

// ---------- Real Live RGB + Luma Scope Analyzer ----------

let scopeCanvas: HTMLCanvasElement | null = null;
let scopeCtx: CanvasRenderingContext2D | null = null;

export function analyzeCanvasScopes(canvas: HTMLCanvasElement, time: number) {
  const sampleW = 128;
  const sampleH = 72;
  if (!scopeCanvas) {
    scopeCanvas = document.createElement("canvas");
    scopeCanvas.width = sampleW;
    scopeCanvas.height = sampleH;
    scopeCtx = scopeCanvas.getContext("2d", { willReadFrequently: true });
  }
  const bins = 32;
  const rHist = new Array<number>(bins).fill(0);
  const gHist = new Array<number>(bins).fill(0);
  const bHist = new Array<number>(bins).fill(0);
  const lumaHist = new Array<number>(bins).fill(0);

  if (!scopeCtx) {
    return {
      time,
      status: "ok",
      warnings: [] as string[],
      lumaHistogram: lumaHist,
      redHistogram: rHist,
      greenHistogram: gHist,
      blueHistogram: bHist,
      waveform: Array.from({ length: 32 }, () => ({ min: 0, p25: 25, median: 50, p75: 75, max: 100 })),
      metrics: {
        avgLumaIre: 50,
        minLumaIre: 0,
        maxLumaIre: 100,
        blackClippingPct: 0,
        whiteClippingPct: 0,
        rAvg: 128,
        gAvg: 128,
        bAvg: 128,
        saturationAvg: 0.3,
      },
    };
  }

  scopeCtx.drawImage(canvas, 0, 0, sampleW, sampleH);
  const img = scopeCtx.getImageData(0, 0, sampleW, sampleH).data;
  const totalPx = sampleW * sampleH;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let lumaSum = 0;
  let minIre = 100;
  let maxIre = 0;
  let blackClip = 0;
  let whiteClip = 0;
  let satSum = 0;

  for (let i = 0; i < img.length; i += 4) {
    const r = img[i]!;
    const g = img[i + 1]!;
    const b = img[i + 2]!;
    rSum += r;
    gSum += g;
    bSum += b;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const ire = (y / 255) * 100;
    lumaSum += ire;
    if (ire < minIre) minIre = ire;
    if (ire > maxIre) maxIre = ire;
    if (ire < 2) blackClip++;
    if (ire > 98) whiteClip++;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    satSum += maxC === 0 ? 0 : (maxC - minC) / maxC;

    rHist[Math.min(bins - 1, Math.floor((r / 256) * bins))]!++;
    gHist[Math.min(bins - 1, Math.floor((g / 256) * bins))]!++;
    bHist[Math.min(bins - 1, Math.floor((b / 256) * bins))]!++;
    lumaHist[Math.min(bins - 1, Math.floor((y / 256) * bins))]!++;
  }

  const waveform: Array<{ min: number; p25: number; median: number; p75: number; max: number }> = [];
  const colStride = Math.max(1, Math.floor(sampleW / 32));
  for (let c = 0; c < 32; c++) {
    const colVals: number[] = [];
    const x = Math.min(sampleW - 1, c * colStride);
    for (let yRow = 0; yRow < sampleH; yRow++) {
      const idx = (yRow * sampleW + x) * 4;
      const luma = ((0.2126 * img[idx]! + 0.7152 * img[idx + 1]! + 0.0722 * img[idx + 2]!) / 255) * 100;
      colVals.push(luma);
    }
    colVals.sort((a, b) => a - b);
    waveform.push({
      min: Math.round(colVals[0] ?? 0),
      p25: Math.round(colVals[Math.floor(colVals.length * 0.25)] ?? 0),
      median: Math.round(colVals[Math.floor(colVals.length * 0.5)] ?? 0),
      p75: Math.round(colVals[Math.floor(colVals.length * 0.75)] ?? 0),
      max: Math.round(colVals[colVals.length - 1] ?? 0),
    });
  }

  const blackPct = Number(((blackClip / totalPx) * 100).toFixed(1));
  const whitePct = Number(((whiteClip / totalPx) * 100).toFixed(1));
  const warnings: string[] = [];
  if (whitePct > 8) warnings.push(`Highlight clipping (${whitePct}%)`);
  if (blackPct > 25) warnings.push(`Crushed blacks (${blackPct}%)`);

  return {
    time,
    status: "ok",
    warnings,
    lumaHistogram: lumaHist,
    redHistogram: rHist,
    greenHistogram: gHist,
    blueHistogram: bHist,
    waveform,
    metrics: {
      avgLumaIre: Number((lumaSum / totalPx).toFixed(1)),
      minLumaIre: Number(minIre.toFixed(1)),
      maxLumaIre: Number(maxIre.toFixed(1)),
      blackClippingPct: blackPct,
      whiteClippingPct: whitePct,
      rAvg: Math.round(rSum / totalPx),
      gAvg: Math.round(gSum / totalPx),
      bAvg: Math.round(bSum / totalPx),
      saturationAvg: Number((satSum / totalPx).toFixed(2)),
    },
  };
}

// ---------- Real 3-Band Parametric WebAudio EQ + Voice Clarity Chain ----------

export function buildClipAudioChain(
  ctx: BaseAudioContext,
  input: AudioNode,
  clip: Clip,
): AudioNode {
  const eq = readClipAudioEq(clip);
  let tail: AudioNode = input;

  if (eq.voiceClarity) {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 85;
    tail.connect(hp);
    tail = hp;
  }

  if (Math.abs(eq.lowDb) > 0.05) {
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 120;
    low.gain.value = eq.lowDb;
    tail.connect(low);
    tail = low;
  }

  if (Math.abs(eq.midDb) > 0.05) {
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1200;
    mid.Q.value = 1.1;
    mid.gain.value = eq.midDb;
    tail.connect(mid);
    tail = mid;
  }

  if (Math.abs(eq.highDb) > 0.05) {
    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 4800;
    high.gain.value = eq.highDb;
    tail.connect(high);
    tail = high;
  }

  if (eq.voiceClarity) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.008;
    comp.release.value = 0.14;
    tail.connect(comp);
    tail = comp;
  }

  return tail;
}

// ---------- Offline Multi-Track Audio Mixdown + Hardware `.mp4` Exporter ----------

async function mixSequenceAudio(
  project: Project,
  seq: Sequence,
  resolveUrl: (assetId: string) => string,
  totalDuration: number,
  sampleRate = 48000,
): Promise<AudioBuffer | null> {
  if (typeof OfflineAudioContext === "undefined") return null;
  const totalFrames = Math.max(sampleRate / 2, Math.ceil(totalDuration * sampleRate));
  const offline = new OfflineAudioContext(2, totalFrames, sampleRate);
  const decodeCtx = new AudioContext();
  const decodedCache = new Map<string, AudioBuffer | null>();

  const soloActive = seq.tracks.some((t) => t.solo);
  let hasAnySource = false;

  try {
    for (const track of seq.tracks) {
      if (track.muted) continue;
      if (soloActive && !track.solo) continue;
      for (const clip of track.clips) {
        const asset = project.assets.find((a) => a.id === clip.assetId);
        if (!asset || asset.kind === "image" || asset.kind === "generated") continue;
        if (!decodedCache.has(asset.id)) {
          try {
            const url = resolveUrl(asset.id);
            const resp = await fetch(url);
            const arr = await resp.arrayBuffer();
            const buf = await decodeCtx.decodeAudioData(arr.slice(0));
            decodedCache.set(asset.id, buf);
          } catch {
            decodedCache.set(asset.id, null);
          }
        }
        const audioBuf = decodedCache.get(asset.id);
        if (!audioBuf) continue;

        const gainVal = getClipVolumeGain(clip, track);
        if (gainVal <= 0.001) continue;

        const src = offline.createBufferSource();
        src.buffer = audioBuf;
        const speed = getClipSpeed(clip);
        src.playbackRate.value = speed;

        const eqTail = buildClipAudioChain(offline, src, clip);

        const gainNode = offline.createGain();
        const fadeFx = clip.effects.find((e) => e.type === "fade");
        const fi = Math.max(0, Number(fadeFx?.params?.fadeIn ?? 0));
        const fo = Math.max(0, Number(fadeFx?.params?.fadeOut ?? 0));

        if (fi > 0) {
          gainNode.gain.setValueAtTime(0.0001, clip.start);
          gainNode.gain.linearRampToValueAtTime(gainVal, clip.start + fi);
        } else {
          gainNode.gain.setValueAtTime(gainVal, clip.start);
        }
        if (fo > 0 && clip.duration > fo) {
          gainNode.gain.setValueAtTime(gainVal, Math.max(clip.start, clip.start + clip.duration - fo));
          gainNode.gain.linearRampToValueAtTime(0.0001, clip.start + clip.duration);
        }

        eqTail.connect(gainNode);
        gainNode.connect(offline.destination);
        const maxAvail = Math.max(0.05, (audioBuf.duration - clip.in) / speed);
        src.start(clip.start, Math.min(clip.in, Math.max(0, audioBuf.duration - 0.05)), Math.min(clip.duration, maxAvail));
        hasAnySource = true;
      }
    }
    if (!hasAnySource) return null;
    return await offline.startRendering();
  } catch {
    return null;
  } finally {
    void decodeCtx.close().catch(() => undefined);
  }
}

export async function exportSequenceToMp4Blob(opts: {
  project: Project;
  sequence: Sequence;
  resolveUrl: (assetId: string) => string;
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
  onProgress?: (pct: number) => void;
}): Promise<{ blob: Blob; mimeType: string; ext: "mp4" | "webm" }> {
  const { project, sequence, resolveUrl, fps, onProgress } = opts;
  const width = Math.max(16, Math.round(opts.width / 2) * 2);
  const height = Math.max(16, Math.round(opts.height / 2) * 2);
  const totalDuration = Math.max(0.5, getSequenceDuration(sequence));
  const totalFrames = Math.max(1, Math.round(totalDuration * fps));

  const mediaElements = new Map<string, HTMLVideoElement | HTMLImageElement>();
  const soloVisual = sequence.tracks.some((t) => t.kind !== "audio" && t.solo);
  const visualClips = sequence.tracks
    .filter((t) => t.kind !== "audio" && !t.muted && (!soloVisual || t.solo))
    .flatMap((t) => t.clips);

  await Promise.all(
    visualClips.map(async (clip) => {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset) return;
      const url = resolveUrl(asset.id);
      if (asset.kind === "video") {
        const v = document.createElement("video");
        v.crossOrigin = "anonymous";
        v.muted = true;
        v.playsInline = true;
        v.preload = "auto";
        v.src = url;
        await new Promise<void>((res) => {
          const t = setTimeout(res, 5000);
          v.onloadeddata = () => {
            clearTimeout(t);
            res();
          };
          v.onerror = () => {
            clearTimeout(t);
            res();
          };
        });
        mediaElements.set(clip.id, v);
      } else {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = url;
        await new Promise<void>((res) => {
          const t = setTimeout(res, 4000);
          img.onload = () => {
            clearTimeout(t);
            res();
          };
          img.onerror = () => {
            clearTimeout(t);
            res();
          };
        });
        mediaElements.set(clip.id, img);
      }
    }),
  );

  onProgress?.(8);
  const mixedAudio = await mixSequenceAudio(project, sequence, resolveUrl, totalDuration, 48000);
  onProgress?.(16);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false })!;

  const WinAny = window as unknown as {
    VideoEncoder?: typeof VideoEncoder;
    AudioEncoder?: typeof AudioEncoder;
    VideoFrame?: typeof VideoFrame;
    AudioData?: typeof AudioData;
  };

  // Path A: Hardware WebCodecs H.264 + AAC -> ISO Fast-Start `.mp4` via `mp4-muxer`
  if (WinAny.VideoEncoder && WinAny.VideoFrame) {
    let chosenCodec: string | null = null;
    for (const candidate of ["avc1.640028", "avc1.4d0028", "avc1.42001f", "avc1.42E01E"]) {
      try {
        const sup = await WinAny.VideoEncoder.isConfigSupported({
          codec: candidate,
          width,
          height,
          bitrate: opts.bitrate ?? 8_000_000,
          framerate: fps,
        });
        if (sup.supported) {
          chosenCodec = candidate;
          break;
        }
      } catch {
        /* try next H.264 profile */
      }
    }

    if (chosenCodec) {
      let includeAac = false;
      if (mixedAudio && WinAny.AudioEncoder && WinAny.AudioData) {
        try {
          const aSup = await WinAny.AudioEncoder.isConfigSupported({
            codec: "mp4a.40.2",
            sampleRate: 48000,
            numberOfChannels: 2,
            bitrate: 160_000,
          });
          includeAac = Boolean(aSup.supported);
        } catch {
          includeAac = false;
        }
      }

      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: { codec: "avc", width, height },
        ...(includeAac ? { audio: { codec: "aac", sampleRate: 48000, numberOfChannels: 2 } } : {}),
        fastStart: "in-memory",
      });

      const videoEncoder = new WinAny.VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (err) => console.error("VideoEncoder error:", err),
      });
      videoEncoder.configure({
        codec: chosenCodec,
        width,
        height,
        bitrate: opts.bitrate ?? 8_000_000,
        framerate: fps,
      });

      if (includeAac && mixedAudio && WinAny.AudioEncoder && WinAny.AudioData) {
        const audioEncoder = new WinAny.AudioEncoder({
          output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
          error: (err) => console.error("AudioEncoder error:", err),
        });
        audioEncoder.configure({
          codec: "mp4a.40.2",
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 160_000,
        });
        const left = mixedAudio.getChannelData(0);
        const right = mixedAudio.numberOfChannels > 1 ? mixedAudio.getChannelData(1) : left;
        const chunkFrames = 1024;
        for (let offset = 0; offset < mixedAudio.length; offset += chunkFrames) {
          const len = Math.min(chunkFrames, mixedAudio.length - offset);
          const planar = new Float32Array(len * 2);
          planar.set(left.subarray(offset, offset + len), 0);
          planar.set(right.subarray(offset, offset + len), len);
          const audioData = new WinAny.AudioData({
            format: "f32-planar",
            sampleRate: 48000,
            numberOfFrames: len,
            numberOfChannels: 2,
            timestamp: Math.round((offset / 48000) * 1_000_000),
            data: planar,
          });
          audioEncoder.encode(audioData);
          audioData.close();
        }
        await audioEncoder.flush();
        audioEncoder.close();
      }

      for (let i = 0; i < totalFrames; i++) {
        const t = i / fps;
        const seekTasks: Promise<void>[] = [];
        for (const clip of visualClips) {
          if (t >= clip.start - 0.5 && t <= clip.start + clip.duration + 0.1) {
            const el = mediaElements.get(clip.id);
            if (el instanceof HTMLVideoElement) {
              seekTasks.push(seekVideoElement(el, computeClipMediaTime(clip, t), 900));
            }
          }
        }
        if (seekTasks.length) await Promise.all(seekTasks);

        renderSequenceFrame(ctx, { project, sequence, time: t, mediaElements });
        const frame = new WinAny.VideoFrame(canvas, {
          timestamp: Math.round((i / fps) * 1_000_000),
          duration: Math.round((1 / fps) * 1_000_000),
        });
        videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();

        if (videoEncoder.encodeQueueSize > 8) {
          await videoEncoder.flush();
        }
        if (i % 4 === 0) {
          onProgress?.(Math.min(97, Math.round(18 + (i / totalFrames) * 79)));
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      await videoEncoder.flush();
      videoEncoder.close();
      muxer.finalize();

      for (const el of mediaElements.values()) {
        if (el instanceof HTMLVideoElement) el.src = "";
      }
      onProgress?.(100);
      return {
        blob: new Blob([target.buffer], { type: "video/mp4" }),
        mimeType: "video/mp4",
        ext: "mp4",
      };
    }
  }

  // Path B: Universal MediaRecorder fallback with WebAudio MediaStreamAudioDestinationNode
  const stream = canvas.captureStream(fps);
  let audioCtx: AudioContext | null = null;
  if (mixedAudio && typeof AudioContext !== "undefined") {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const bufSrc = audioCtx.createBufferSource();
    bufSrc.buffer = mixedAudio;
    bufSrc.connect(dest);
    bufSrc.start();
    const track = dest.stream.getAudioTracks()[0];
    if (track) stream.addTrack(track);
  }

  const mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find((m) =>
    typeof MediaRecorder !== "undefined" ? MediaRecorder.isTypeSupported(m) : false,
  ) || "video/webm";
  const ext: "mp4" | "webm" = mime.startsWith("video/mp4") ? "mp4" : "webm";

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate ?? 6_000_000 });
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  };
  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });
  recorder.start(200);

  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps;
    for (const clip of visualClips) {
      if (t >= clip.start && t <= clip.start + clip.duration) {
        const el = mediaElements.get(clip.id);
        if (el instanceof HTMLVideoElement) await seekVideoElement(el, computeClipMediaTime(clip, t), 500);
      }
    }
    renderSequenceFrame(ctx, { project, sequence, time: t, mediaElements });
    if (i % 5 === 0) onProgress?.(Math.min(96, Math.round(18 + (i / totalFrames) * 78)));
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  recorder.stop();
  const blob = await stopped;
  if (audioCtx) void audioCtx.close().catch(() => undefined);
  for (const el of mediaElements.values()) {
    if (el instanceof HTMLVideoElement) el.src = "";
  }
  onProgress?.(100);
  return { blob, mimeType: mime, ext };
}
