// Real-Time Multi-Track HTML5/WebGL-2D Compositor, Filmstrip Extractor, Live Scopes Analyzer,
// Offline Multi-Track Audio Mixer, and Hardware H.264 + AAC `.mp4` Exporter for Vedit Studio (v0.8.0).
//
// Shared between live 60 FPS interactive playback and frame-accurate `.mp4` export so what the user
// sees on screen (cuts, trims, speed, reverse, freeze frames, color grading, LUTs, transitions,
// blurred 9:16 backgrounds, PiP layers, and draggable styled titles) matches exported output 1:1.

import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { Asset, Caption, Clip, Project, Sequence, Track } from "./api";

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
  const duration = Math.max(0.15, Math.min(clip.duration * 0.8, Number(tx.params?.duration ?? 0.5)));
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
  const look = readClipLook(clip);
  const preset = LOOK_PRESETS.find((p) => p.id === look.id);

  const parts: string[] = [];
  const expMul = Math.pow(2, adj.exposure / 100);
  const brightMul = Math.max(0.1, expMul * (1 + adj.brightness / 120));
  const contrastMul = Math.max(0.2, 1 + adj.contrast / 100);
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
      const eased = rawT * rawT * (3 - 2 * rawT); // smoothstep ease-in-out
      const av = Number(a.value) || 0;
      const bv = Number(b.value) || 0;
      return av + (bv - av) * eased;
    }
  }
  return fallback;
}

export function computeClipMediaTime(clip: Clip, timelineTime: number): number {
  const local = Math.max(0, Math.min(clip.duration, timelineTime - clip.start));
  const speed = getClipSpeed(clip);
  if (isClipReversed(clip)) {
    return Math.max(0, clip.out - local * speed);
  }
  return Math.max(0, clip.in + local * speed);
}

// ---------- Filmstrip Thumbnail Cache ----------

const filmstripCache = new Map<string, string[]>();
const filmstripPending = new Map<string, Promise<string[]>>();

export function getCachedFilmstrip(assetId: string): string[] | undefined {
  return filmstripCache.get(assetId);
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

// ---------- Core Composite Frame Renderer ----------

export interface RenderFrameOptions {
  project: Project;
  sequence: Sequence;
  time: number;
  mediaElements: Map<string, HTMLVideoElement | HTMLImageElement>;
  splitComparePct?: number | null;
  backdropMode?: "blur" | "black" | "dark" | "white";
}

function drawSingleClipLayer(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  clip: Clip,
  source: HTMLVideoElement | HTMLImageElement,
  localTime: number,
  extraAlpha = 1,
  offsetXRatio = 0,
  extraScale = 1,
  backdropBlurFill = false,
  disableGrading = false,
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

  // Optional blurred full-canvas background fill when aspect ratios differ (e.g. 16:9 inside 9:16)
  const canvasAspect = width / height;
  const srcAspect = srcW / srcH;
  if (backdropBlurFill && Math.abs(canvasAspect - srcAspect) > 0.08) {
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
  const cLeft = Math.max(0, Math.min(0.45, Number(cropFx?.params?.left ?? 0) / 100));
  const cRight = Math.max(0, Math.min(0.45, Number(cropFx?.params?.right ?? 0) / 100));
  const cTop = Math.max(0, Math.min(0.45, Number(cropFx?.params?.top ?? 0) / 100));
  const cBottom = Math.max(0, Math.min(0.45, Number(cropFx?.params?.bottom ?? 0) / 100));

  const sxPx = srcW * cLeft;
  const syPx = srcH * cTop;
  const swPx = Math.max(2, srcW * (1 - cLeft - cRight));
  const shPx = Math.max(2, srcH * (1 - cTop - cBottom));

  const fitMode = String((clip.transform as Record<string, unknown>).fitMode || "contain");
  const baseScale =
    fitMode === "cover" ? Math.max(width / swPx, height / shPx) : Math.min(width / swPx, height / shPx);
  const drawW = swPx * baseScale * Math.abs(sx);
  const drawH = shPx * baseScale * Math.abs(sy);

  const adj = readClipAdjustments(clip);
  const look = readClipLook(clip);
  const lookPreset = LOOK_PRESETS.find((p) => p.id === look.id);

  ctx.save();
  ctx.globalAlpha = alpha;
  if (!disableGrading) {
    const cssFilter = buildClipCssFilter(clip);
    if (cssFilter !== "none") ctx.filter = cssFilter;
  }

  ctx.translate(width / 2 + tx + offsetXRatio * width, height / 2 + ty);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(sx < 0 ? -1 : 1, sy < 0 ? -1 : 1);
  ctx.drawImage(source, sxPx, syPx, swPx, shPx, -drawW / 2, -drawH / 2, drawW, drawH);

  // Subtle color temperature / LUT tint wash
  if (!disableGrading && lookPreset?.warmOverlay && look.intensity > 0) {
    ctx.filter = "none";
    ctx.globalAlpha = alpha * (look.intensity / 100);
    ctx.fillStyle = lookPreset.warmOverlay;
    ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
  }

  // Matte film fade lift
  const fadeLift = disableGrading ? 0 : Math.max(adj.fade, lookPreset?.fadeLift ?? 0);
  if (fadeLift > 0) {
    ctx.filter = "none";
    ctx.globalAlpha = alpha * (fadeLift / 260);
    ctx.fillStyle = "#232329";
    ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
  }
  ctx.restore();

  // Optical vignette
  const vig = disableGrading ? 0 : Math.max(adj.vignette, lookPreset?.vignette ?? 0);
  if (vig > 1) {
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

  // Base canvas fill
  ctx.save();
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  ctx.fillStyle =
    backdropMode === "white" ? "#ffffff" : backdropMode === "dark" ? "#141418" : "#000000";
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  const renderPass = (disableGrading: boolean) => {
    const visualTracks = sequence.tracks.filter((t) => t.kind !== "audio" && !t.muted);
    // Track index 0 is bottom/primary video track; subsequent video/graphics tracks overlay on top
    visualTracks.forEach((track, trackIdx) => {
      const sorted = track.clips.slice().sort((a, b) => a.start - b.start);
      for (let i = 0; i < sorted.length; i++) {
        const clip = sorted[i]!;
        if (time < clip.start || time > clip.start + clip.duration) continue;
        const source = mediaElements.get(clip.id) ?? mediaElements.get(clip.assetId);
        if (!source) continue;

        const localTime = time - clip.start;
        const tx = getClipTransition(clip);
        let alpha = 1;
        let offsetX = 0;
        let extraScale = 1;

        if (tx && localTime < tx.duration) {
          const p = Math.max(0, Math.min(1, localTime / tx.duration));
          const ease = p * p * (3 - 2 * p);
          // Blend outgoing clip underneath during transition window
          const prev = i > 0 ? sorted[i - 1] : undefined;
          if (prev) {
            const prevSrc = mediaElements.get(prev.id) ?? mediaElements.get(prev.assetId);
            if (prevSrc) {
              drawSingleClipLayer(
                ctx,
                width,
                height,
                prev,
                prevSrc,
                Math.max(0, prev.duration - 0.02),
                1,
                0,
                1,
                trackIdx === 0 && backdropMode === "blur",
                disableGrading,
              );
            }
          }
          if (tx.kind === "dissolve") alpha = ease;
          else if (tx.kind === "slide-left") offsetX = 1 - ease;
          else if (tx.kind === "slide-right") offsetX = -(1 - ease);
          else if (tx.kind === "zoom-in") {
            extraScale = 0.78 + 0.22 * ease;
            alpha = ease;
          } else if (tx.kind === "fade-black" || tx.kind === "fade-white") {
            alpha = ease;
          }
        }

        drawSingleClipLayer(
          ctx,
          width,
          height,
          clip,
          source,
          localTime,
          alpha,
          offsetX,
          extraScale,
          trackIdx === 0 && backdropMode === "blur",
          disableGrading,
        );

        if (tx && localTime < tx.duration && (tx.kind === "fade-black" || tx.kind === "fade-white")) {
          const p = localTime / tx.duration;
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - p);
          ctx.fillStyle = tx.kind === "fade-white" ? "#ffffff" : "#000000";
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
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
    renderPass(true); // Before (Original) on left
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, width - splitX, height);
    ctx.clip();
    renderPass(false); // After (Graded) on right
    ctx.restore();

    // Crisp divider handle
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, height);
    ctx.stroke();
    ctx.restore();
  } else {
    renderPass(false);
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

export function analyzeCanvasScopes(canvas: HTMLCanvasElement, time: number) {
  const sampleW = 128;
  const sampleH = 72;
  const off = document.createElement("canvas");
  off.width = sampleW;
  off.height = sampleH;
  const octx = off.getContext("2d", { willReadFrequently: true });
  const bins = 32;
  const rHist = new Array<number>(bins).fill(0);
  const gHist = new Array<number>(bins).fill(0);
  const bHist = new Array<number>(bins).fill(0);
  const lumaHist = new Array<number>(bins).fill(0);

  if (!octx) {
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

  octx.drawImage(canvas, 0, 0, sampleW, sampleH);
  const img = octx.getImageData(0, 0, sampleW, sampleH).data;
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

        src.connect(gainNode);
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
  // H.264 requires even dimensions
  const width = Math.max(16, Math.round(opts.width / 2) * 2);
  const height = Math.max(16, Math.round(opts.height / 2) * 2);
  const totalDuration = Math.max(0.5, getSequenceDuration(sequence));
  const totalFrames = Math.max(1, Math.round(totalDuration * fps));

  // Prepare offscreen media elements per clip so two clips referencing the same asset seek independently
  const mediaElements = new Map<string, HTMLVideoElement | HTMLImageElement>();
  const visualClips = sequence.tracks
    .filter((t) => t.kind !== "audio" && !t.muted)
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

      // Encode mixed stereo audio into AAC first if available
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

      // Seek & encode every composite video frame cleanly
      for (let i = 0; i < totalFrames; i++) {
        const t = i / fps;
        // Seek only clips active at timestamp t
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

        // Backpressure guard so phone RAM stays tiny even on long 1080p videos
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
