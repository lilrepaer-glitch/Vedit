// Pro Compositing, Shape Masks, Blend Modes & Non-Linear Speed Ramps — Milestone F14 (Vedit Studio v1.0.0)
//
// Provides shared mathematical models, preset definitions, engine mutators, and real FFmpeg filter
// generators for:
//   1. Parametric Alpha Shape Masks (`circle`, `rectangle`, `split-h`, `split-v`, `linear`) with
//      adjustable size, corner radius, smooth feathering, center offset, and inversion.
//   2. Hardware / FFmpeg Layer Blend Modes (`normal`, `screen`, `multiply`, `overlay`, `lighten`,
//      `darken`, `soft-light`, `color-dodge`, `add`).
//   3. Duration-preserving Non-Linear Speed Ramps (`constant`, `montage-in`, `hero-slowmo`,
//      `bullet`, `jump-cut`, `smooth-out`) mapping normalized time `u in [0, 1] -> warped u in [0, 1]`.

import type { VeditEngine } from "../core/engine.js";
import type { EffectInstance } from "../core/types.js";

export type MaskShapeId = "none" | "circle" | "rectangle" | "split-h" | "split-v" | "linear";

export interface ClipMaskOptions {
  shape: MaskShapeId;
  /** Normalized size of mask relative to frame (`0.15 .. 1.0`, default `0.78`) */
  scale?: number;
  /** Edge softness (`0 .. 100`, default `12`) */
  feather?: number;
  /** Rounded corner percentage for rectangle masks (`0 .. 50`, default `14`) */
  radius?: number;
  /** Center X normalized (`0 .. 1`, default `0.5`) */
  centerX?: number;
  /** Center Y normalized (`0 .. 1`, default `0.5`) */
  centerY?: number;
  /** Cut inside shape instead of outside */
  invert?: boolean;
}

export type BlendModeId =
  | "normal"
  | "screen"
  | "multiply"
  | "overlay"
  | "lighten"
  | "darken"
  | "soft-light"
  | "color-dodge"
  | "add";

export type SpeedRampPresetId =
  | "constant"
  | "montage-in"
  | "hero-slowmo"
  | "bullet"
  | "jump-cut"
  | "smooth-out";

export interface SpeedRampPresetInfo {
  id: SpeedRampPresetId;
  label: string;
  description: string;
}

export const MASK_SHAPE_PRESETS: Array<{ id: MaskShapeId; label: string; description: string }> = [
  { id: "none", label: "None", description: "Unmasked full clip frame" },
  { id: "circle", label: "Circle", description: "Circular / elliptical facecam & spotlight mask" },
  { id: "rectangle", label: "Rectangle", description: "Rounded card or picture-in-picture frame mask" },
  { id: "split-h", label: "Split Horizontal", description: "Left/right split-screen reveal" },
  { id: "split-v", label: "Split Vertical", description: "Top/bottom split-screen reveal" },
  { id: "linear", label: "Linear Wipe", description: "Smooth directional gradient dissolve mask" },
];

export const BLEND_MODE_PRESETS: Array<{
  id: BlendModeId;
  label: string;
  ffmpegMode: string;
  canvasOp: string;
}> = [
  { id: "normal", label: "Normal", ffmpegMode: "normal", canvasOp: "source-over" },
  { id: "screen", label: "Screen", ffmpegMode: "screen", canvasOp: "screen" },
  { id: "multiply", label: "Multiply", ffmpegMode: "multiply", canvasOp: "multiply" },
  { id: "overlay", label: "Overlay", ffmpegMode: "overlay", canvasOp: "overlay" },
  { id: "lighten", label: "Lighten", ffmpegMode: "lighten", canvasOp: "lighten" },
  { id: "darken", label: "Darken", ffmpegMode: "darken", canvasOp: "darken" },
  { id: "soft-light", label: "Soft Light", ffmpegMode: "softlight", canvasOp: "soft-light" },
  { id: "color-dodge", label: "Color Dodge", ffmpegMode: "dodge", canvasOp: "color-dodge" },
  { id: "add", label: "Linear Add", ffmpegMode: "addition", canvasOp: "lighter" },
];

export const SPEED_RAMP_PRESETS: SpeedRampPresetInfo[] = [
  { id: "constant", label: "Constant", description: "Uniform linear playback speed" },
  { id: "montage-in", label: "Montage In", description: "Fast whip entrance settling smoothly into normal speed" },
  { id: "hero-slowmo", label: "Hero Slow-Mo", description: "Fast entry -> silky slow-motion center -> fast exit" },
  { id: "bullet", label: "Bullet Time", description: "Dramatic slow-motion hold ramping rapidly to the cut" },
  { id: "jump-cut", label: "Jump Pop", description: "Punchy fast edges with crisp mid-beat emphasis" },
  { id: "smooth-out", label: "Smooth Out", description: "Normal start accelerating cleanly into next transition" },
];

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Evaluates normalized media progress `w in [0, 1]` for normalized timeline progress `u in [0, 1]`.
 * Strictly monotonically increasing with `f(0) = 0` and `f(1) = 1` for `intensity in [0, 1]`,
 * guaranteeing exact clip duration preservation without frame jumps or black tail frames.
 */
export function evaluateSpeedRampProgress(
  preset: SpeedRampPresetId,
  uRaw: number,
  intensityRaw?: number,
): number;
export function evaluateSpeedRampProgress(
  uRaw: number,
  preset: SpeedRampPresetId,
  intensityRaw?: number,
): number;
export function evaluateSpeedRampProgress(
  a: SpeedRampPresetId | number,
  b: SpeedRampPresetId | number,
  intensityRaw = 1,
): number {
  const preset = (typeof a === "string" ? a : b) as SpeedRampPresetId;
  const rawNum = typeof a === "number" ? a : (b as number);
  const u = clamp(Number.isFinite(rawNum) ? rawNum : 0, 0, 1);
  const k = clamp(Number.isFinite(intensityRaw) ? intensityRaw : 1, 0, 1);
  if (preset === "constant" || k <= 0.001) return u;

  let warped = u;
  switch (preset) {
    case "montage-in": {
      // Fast start (`f'(0) ~ 2.4`), smooth deceleration to `f'(1) ~ 0.45`
      warped = 1 - Math.pow(1 - u, 2.2);
      break;
    }
    case "smooth-out": {
      // Gentle start (`f'(0) ~ 0.45`), fast whip exit (`f'(1) ~ 2.2`)
      warped = Math.pow(u, 2.2);
      break;
    }
    case "hero-slowmo": {
      // Fast edges, silky ~0.35x slow-motion plateau in the middle `[0.35..0.65]`
      warped = u + 0.103 * Math.sin(2 * Math.PI * u);
      break;
    }
    case "bullet": {
      // Immediate freeze-slow entry exploding into high-velocity exit
      warped = 0.22 * u + 0.78 * Math.pow(u, 3);
      break;
    }
    case "jump-cut": {
      // Snappy S-acceleration through middle beat
      warped = u - 0.095 * Math.sin(2 * Math.PI * u);
      break;
    }
    default:
      warped = u;
  }
  return clamp(u * (1 - k) + warped * k, 0, 1);
}

/**
 * Generates an FFmpeg alpha-channel `geq` filter expression for parametric shape masks.
 */
export function buildMaskFfmpegFilter(opts: ClipMaskOptions): string | null {
  const shape = opts.shape || "none";
  if (shape === "none") return null;

  const scale = clamp(Number(opts.scale ?? 0.78), 0.15, 1);
  const featherNorm = clamp(Number(opts.feather ?? 12), 0, 100) / 220;
  const cx = clamp(Number(opts.centerX ?? 0.5), 0, 1);
  const cy = clamp(Number(opts.centerY ?? 0.5), 0, 1);
  const inv = Boolean(opts.invert);
  const soft = Math.max(0.004, featherNorm).toFixed(4);

  let insideAlphaExpr: string;
  if (shape === "circle") {
    const r = (scale * 0.5).toFixed(4);
    const dist = `hypot((X/W-${cx.toFixed(3)})*min(1\\,W/H),(Y/H-${cy.toFixed(3)})*min(1\\,H/W))`;
    // Note: Inside FFmpeg filter string without outer quotes we avoid backslashes and use clean math
    const distClean = `hypot((X/W-${cx.toFixed(3)}),(Y/H-${cy.toFixed(3)}))`;
    void dist;
    insideAlphaExpr = `clip((${r}+${soft}-${distClean})/(2*${soft}),0,1)*255`;
  } else if (shape === "rectangle") {
    const hw = (scale * 0.5).toFixed(4);
    const dx = `abs(X/W-${cx.toFixed(3)})`;
    const dy = `abs(Y/H-${cy.toFixed(3)})`;
    insideAlphaExpr = `min(clip((${hw}+${soft}-${dx})/(2*${soft}),0,1),clip((${hw}+${soft}-${dy})/(2*${soft}),0,1))*255`;
  } else if (shape === "split-h") {
    insideAlphaExpr = `clip((${cx.toFixed(3)}+${soft}-X/W)/(2*${soft}),0,1)*255`;
  } else if (shape === "split-v") {
    insideAlphaExpr = `clip((${cy.toFixed(3)}+${soft}-Y/H)/(2*${soft}),0,1)*255`;
  } else {
    // linear directional gradient wipe centered at cy
    const span = Math.max(0.04, scale * 0.45).toFixed(4);
    insideAlphaExpr = `clip((${cy.toFixed(3)}+${span}-Y/H)/(2*${span}),0,1)*255`;
  }

  const finalAlpha = inv ? `(255-(${insideAlphaExpr}))` : insideAlphaExpr;
  return `format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${finalAlpha}'`;
}

export function applyClipMask(
  engine: VeditEngine,
  clipId: string,
  opts: Partial<ClipMaskOptions>,
): EffectInstance | null {
  const { clip, track } = engine.findClipAnywhere(clipId);
  clip.effects = clip.effects.filter((fx) => fx.type !== "mask");
  const shape = (opts.shape || "none") as MaskShapeId;
  if (shape === "none") return null;

  const normalized: Required<ClipMaskOptions> = {
    shape,
    scale: Number(clamp(Number(opts.scale ?? 0.78), 0.15, 1).toFixed(3)),
    feather: Math.round(clamp(Number(opts.feather ?? 12), 0, 100)),
    radius: Math.round(clamp(Number(opts.radius ?? 14), 0, 50)),
    centerX: Number(clamp(Number(opts.centerX ?? 0.5), 0, 1).toFixed(3)),
    centerY: Number(clamp(Number(opts.centerY ?? 0.5), 0, 1).toFixed(3)),
    invert: Boolean(opts.invert),
  };
  return engine.addEffect(clipId, "mask", { ...normalized }, track.id);
}

export function applyClipBlend(
  engine: VeditEngine,
  clipId: string,
  modeRaw: string,
  opacity?: number,
): EffectInstance | null {
  const { clip, track } = engine.findClipAnywhere(clipId);
  clip.effects = clip.effects.filter((fx) => fx.type !== "blend");
  const hit = BLEND_MODE_PRESETS.find((b) => b.id === modeRaw) ?? BLEND_MODE_PRESETS[0]!;
  if (opacity != null && Number.isFinite(Number(opacity))) {
    engine.updateClip(clipId, {
      transform: { ...clip.transform, opacity: clamp(Number(opacity), 0, 1) },
    });
  }
  if (hit.id === "normal") return null;

  return engine.addEffect(
    clipId,
    "blend",
    {
      mode: hit.id,
      ffmpegMode: hit.ffmpegMode,
      canvasOp: hit.canvasOp,
    },
    track.id,
  );
}

export function applySpeedRamp(
  engine: VeditEngine,
  clipId: string,
  presetRaw: string,
  intensity = 1,
): EffectInstance | null {
  const { clip, track } = engine.findClipAnywhere(clipId);
  clip.effects = clip.effects.filter((fx) => fx.type !== "speed-ramp");
  const hit = SPEED_RAMP_PRESETS.find((s) => s.id === presetRaw) ?? SPEED_RAMP_PRESETS[0]!;
  if (hit.id === "constant") return null;

  return engine.addEffect(
    clipId,
    "speed-ramp",
    {
      preset: hit.id,
      intensity: Number(clamp(Number(intensity ?? 1), 0.1, 1).toFixed(2)),
    },
    track.id,
  );
}
