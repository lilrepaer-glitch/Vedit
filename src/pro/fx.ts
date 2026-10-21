// F6: Pro VFX, Color Grading, Chroma Key, Speed Control & Transitions (PLAN.md §3.1, §3.3, §4.1)

import type { VeditEngine } from "../core/engine.js";
import type { Clip, EffectInstance, ID } from "../core/types.js";

export interface ColorGradePreset {
  id: string;
  label: string;
  params: {
    brightness: number;
    contrast: number;
    saturation: number;
    gamma: number;
  };
}

export const COLOR_GRADE_PRESETS: ColorGradePreset[] = [
  {
    id: "neutral",
    label: "Neutral Rec.709",
    params: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 },
  },
  {
    id: "cinematic-contrast",
    label: "Cinematic Punch",
    params: { brightness: -0.02, contrast: 1.18, saturation: 1.12, gamma: 0.96 },
  },
  {
    id: "warm-golden",
    label: "Golden Hour Warm",
    params: { brightness: 0.03, contrast: 1.08, saturation: 1.24, gamma: 1.04 },
  },
  {
    id: "cool-noir",
    label: "Moody Cool Noir",
    params: { brightness: -0.04, contrast: 1.25, saturation: 0.68, gamma: 0.92 },
  },
  {
    id: "vivid-social",
    label: "Vivid Social Pop",
    params: { brightness: 0.02, contrast: 1.14, saturation: 1.35, gamma: 1.0 },
  },
];

export interface ColorGradeOptions {
  preset?: string;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
}

/** Applies or updates a color grade effect on a clip (transactional undo). */
export function applyColorGrade(
  engine: VeditEngine,
  clipId: ID,
  opts: ColorGradeOptions,
  trackId?: ID,
): EffectInstance {
  const base = COLOR_GRADE_PRESETS.find((p) => p.id === opts.preset)?.params ?? {
    brightness: 0,
    contrast: 1,
    saturation: 1,
    gamma: 1,
  };
  const params = {
    preset: opts.preset ?? "custom",
    brightness: opts.brightness ?? base.brightness,
    contrast: opts.contrast ?? base.contrast,
    saturation: opts.saturation ?? base.saturation,
    gamma: opts.gamma ?? base.gamma,
  };
  const { clip } = engine.findClipAnywhere(clipId);
  const existing = clip.effects.find((e) => e.type === "color-grade" || e.type === "color");
  if (existing) {
    return engine.updateEffect(clipId, existing.id, params, trackId);
  }
  return engine.addEffect(clipId, "color-grade", params, trackId);
}

export interface ChromaKeyOptions {
  /** Hex color like "#00ff00" or "0x00ff00" or "blue" */
  color?: string;
  /** 0.01 (strict) .. 1.0 (wide) */
  similarity?: number;
  /** 0.0 (hard edge) .. 1.0 (soft feather) */
  blend?: number;
  /** Suppress green/blue color spill around hair/edges */
  despill?: boolean;
}

/** Applies green/blue screen chroma keying with optional edge spill suppression. */
export function applyChromaKey(
  engine: VeditEngine,
  clipId: ID,
  opts: ChromaKeyOptions = {},
  trackId?: ID,
): EffectInstance {
  const params = {
    color: opts.color ?? "#00ff00",
    similarity: opts.similarity ?? 0.28,
    blend: opts.blend ?? 0.08,
    despill: opts.despill ?? true,
  };
  const { clip } = engine.findClipAnywhere(clipId);
  const existing = clip.effects.find((e) => e.type === "chroma-key" || e.type === "chromakey");
  if (existing) {
    return engine.updateEffect(clipId, existing.id, params, trackId);
  }
  return engine.addEffect(clipId, "chroma-key", params, trackId);
}

/**
 * Sets playback speed (0.25x .. 4.0x) on a clip and proportionally updates timeline duration
 * so source media `[in .. out]` stretches or compresses cleanly without truncation.
 */
export function setClipSpeed(
  engine: VeditEngine,
  clipId: ID,
  speed: number,
  trackId?: ID,
): Clip {
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 8) {
    throw new Error("Clip speed must be between 0.1x and 8.0x");
  }
  return engine.transaction(`clip.speed ${speed.toFixed(2)}x`, () => {
    const { clip } = trackId ? engine.findClip(trackId, clipId) : engine.findClipAnywhere(clipId);
    const prevSpeedEff = clip.effects.find((e) => e.type === "speed");
    const prevSpeed = Number(prevSpeedEff?.params?.rate ?? 1) || 1;
    const sourceSpan = clip.out > clip.in ? clip.out - clip.in : clip.duration * prevSpeed;
    const newDuration = Math.max(0.05, Number((sourceSpan / speed).toFixed(4)));
    clip.duration = newDuration;
    clip.out = Number((clip.in + sourceSpan).toFixed(4));
    if (prevSpeedEff) {
      engine.updateEffect(clipId, prevSpeedEff.id, { rate: speed }, trackId);
    } else {
      engine.addEffect(clipId, "speed", { rate: speed }, trackId);
    }
    return clip;
  });
}

/** Adds smooth fade-in / fade-out transitions on a clip. */
export function applyFadeTransition(
  engine: VeditEngine,
  clipId: ID,
  opts: { fadeIn?: number; fadeOut?: number },
  trackId?: ID,
): EffectInstance {
  const params = {
    inDuration: Math.max(0, Number(opts.fadeIn ?? 0.5)),
    outDuration: Math.max(0, Number(opts.fadeOut ?? 0.5)),
  };
  const { clip } = engine.findClipAnywhere(clipId);
  const existing = clip.effects.find((e) => e.type === "fade");
  if (existing) {
    return engine.updateEffect(clipId, existing.id, params, trackId);
  }
  return engine.addEffect(clipId, "fade", params, trackId);
}
