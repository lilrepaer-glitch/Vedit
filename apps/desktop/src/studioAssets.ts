// Vedit Studio — High-Craft Motion Graphics, Procedural Optical Transitions, Overlays,
// Camera Motion Physics & 44.1 kHz Stereo PCM Sound FX Synthesis Engine (v1.0.2 — Milestone F16).
// 100% pure TypeScript with zero external dependencies — runs identically at 60 FPS on Android APK,
// Desktop WebView, WebCodecs MP4 Exporter, and Node/JSDOM verification suites.

export type MotionGraphicTemplateId =
  | "lower-third-editorial"
  | "glass-callout"
  | "split-ribbon"
  | "chapter-card"
  | "kinetic-stomp"
  | "neon-hud"
  | "progress-pill";

export type VisualAssetCategory = "transition" | "overlay";

export type ProceduralVisualPresetId =
  | "golden-light-leak"
  | "anamorphic-streak"
  | "film-flash-burn"
  | "shutter-matte-wipe"
  | "prism-glitch-hit"
  | "iris-portal"
  | "cinema-grain-dust"
  | "bokeh-shimmer"
  | "rec-viewfinder-hud"
  | "gradient-aurora-bg";

export type StudioSfxPresetId =
  | "cinema-whoosh"
  | "sub-impact-boom"
  | "shimmer-riser"
  | "camera-shutter"
  | "digital-glitch-sfx"
  | "velvet-ambient";

export type CameraMotionPresetId =
  | "ken-burns-in"
  | "ken-burns-out"
  | "glide-pan-right"
  | "glide-pan-left"
  | "spring-pop"
  | "handheld-cinema"
  | "whip-zoom"
  | "dutch-float";

export interface MotionGraphicTemplateDef {
  id: MotionGraphicTemplateId;
  label: string;
  badge: string;
  defaultTitle: string;
  defaultSubtitle: string;
  defaultColor: string;
  defaultAccent: string;
  defaultX: number;
  defaultY: number;
  defaultFontSize: number;
  defaultDuration: number;
}

export interface StudioVisualAssetDef {
  id: ProceduralVisualPresetId;
  category: VisualAssetCategory;
  label: string;
  badge: string;
  primaryColor: string;
  accentColor: string;
  defaultDuration: number;
  blendMode: "normal" | "screen" | "add" | "overlay" | "soft-light";
}

export interface StudioAudioAssetDef {
  id: StudioSfxPresetId;
  label: string;
  badge: string;
  defaultDuration: number;
  accentColor: string;
}

export interface CameraMotionPresetDef {
  id: CameraMotionPresetId;
  label: string;
  badge: string;
}

export const MOTION_GRAPHIC_TEMPLATES: readonly MotionGraphicTemplateDef[] = [
  {
    id: "lower-third-editorial",
    label: "Editorial Bar",
    badge: "Lower Third",
    defaultTitle: "Alex Novák",
    defaultSubtitle: "CREATIVE DIRECTOR · STUDIO",
    defaultColor: "#ffffff",
    defaultAccent: "#3b82f6",
    defaultX: 0.28,
    defaultY: 0.82,
    defaultFontSize: 48,
    defaultDuration: 3.6,
  },
  {
    id: "glass-callout",
    label: "Glass Callout",
    badge: "Capsule",
    defaultTitle: "Prague · 4K Cinema",
    defaultSubtitle: "LIVE LOCATION",
    defaultColor: "#f8fafc",
    defaultAccent: "#22c55e",
    defaultX: 0.5,
    defaultY: 0.16,
    defaultFontSize: 40,
    defaultDuration: 3.4,
  },
  {
    id: "split-ribbon",
    label: "Broadcast Ribbon",
    badge: "Headline",
    defaultTitle: "BREAKING STORY",
    defaultSubtitle: "EXCLUSIVE REPORT",
    defaultColor: "#09090b",
    defaultAccent: "#f97316",
    defaultX: 0.34,
    defaultY: 0.8,
    defaultFontSize: 46,
    defaultDuration: 3.8,
  },
  {
    id: "chapter-card",
    label: "Chapter Index",
    badge: "Editorial",
    defaultTitle: "The New Era",
    defaultSubtitle: "01 // CHAPTER",
    defaultColor: "#ffffff",
    defaultAccent: "#eab308",
    defaultX: 0.5,
    defaultY: 0.5,
    defaultFontSize: 60,
    defaultDuration: 3.2,
  },
  {
    id: "kinetic-stomp",
    label: "Kinetic Impact",
    badge: "Dynamic",
    defaultTitle: "FAST BOLD CUTS",
    defaultSubtitle: "60 FPS MOTION",
    defaultColor: "#ffffff",
    defaultAccent: "#ec4899",
    defaultX: 0.5,
    defaultY: 0.5,
    defaultFontSize: 66,
    defaultDuration: 2.8,
  },
  {
    id: "neon-hud",
    label: "HUD Frame Tag",
    badge: "Tech Spec",
    defaultTitle: "TARGET LOCKED",
    defaultSubtitle: "ISO 800 · 24.00 FPS",
    defaultColor: "#f8fafc",
    defaultAccent: "#06b6d4",
    defaultX: 0.5,
    defaultY: 0.22,
    defaultFontSize: 44,
    defaultDuration: 3.4,
  },
  {
    id: "progress-pill",
    label: "Progress Capsule",
    badge: "Timer Bar",
    defaultTitle: "Watch Next Step",
    defaultSubtitle: "STEP PROGRESS",
    defaultColor: "#ffffff",
    defaultAccent: "#8b5cf6",
    defaultX: 0.5,
    defaultY: 0.86,
    defaultFontSize: 38,
    defaultDuration: 4.0,
  },
];

export const STUDIO_VISUAL_ASSETS: readonly StudioVisualAssetDef[] = [
  {
    id: "golden-light-leak",
    category: "transition",
    label: "Golden Light Leak",
    badge: "Optical Burn",
    primaryColor: "#f59e0b",
    accentColor: "#ef4444",
    defaultDuration: 1.0,
    blendMode: "screen",
  },
  {
    id: "anamorphic-streak",
    category: "transition",
    label: "Anamorphic Streak",
    badge: "Lens Flare",
    primaryColor: "#38bdf8",
    accentColor: "#818cf8",
    defaultDuration: 0.9,
    blendMode: "screen",
  },
  {
    id: "film-flash-burn",
    category: "transition",
    label: "Kodak Film Burn",
    badge: "Halation",
    primaryColor: "#fb923c",
    accentColor: "#fef08a",
    defaultDuration: 0.85,
    blendMode: "screen",
  },
  {
    id: "shutter-matte-wipe",
    category: "transition",
    label: "Slanted Matte Wipe",
    badge: "Clean Wipe",
    primaryColor: "#18181b",
    accentColor: "#3b82f6",
    defaultDuration: 0.8,
    blendMode: "normal",
  },
  {
    id: "prism-glitch-hit",
    category: "transition",
    label: "Prism RGB Glitch",
    badge: "Chromatic",
    primaryColor: "#06b6d4",
    accentColor: "#f43f5e",
    defaultDuration: 0.7,
    blendMode: "screen",
  },
  {
    id: "iris-portal",
    category: "transition",
    label: "Cinema Iris Wipe",
    badge: "Aperture",
    primaryColor: "#09090b",
    accentColor: "#f59e0b",
    defaultDuration: 0.9,
    blendMode: "normal",
  },
  {
    id: "cinema-grain-dust",
    category: "overlay",
    label: "35mm Film Gate",
    badge: "Letterbox",
    primaryColor: "#fbbf24",
    accentColor: "#ffffff",
    defaultDuration: 4.0,
    blendMode: "normal",
  },
  {
    id: "bokeh-shimmer",
    category: "overlay",
    label: "Soft Depth Bokeh",
    badge: "Particles",
    primaryColor: "#f472b6",
    accentColor: "#60a5fa",
    defaultDuration: 4.5,
    blendMode: "screen",
  },
  {
    id: "rec-viewfinder-hud",
    category: "overlay",
    label: "Viewfinder HUD",
    badge: "Frame UI",
    primaryColor: "#ef4444",
    accentColor: "#e4e4e7",
    defaultDuration: 4.0,
    blendMode: "normal",
  },
  {
    id: "gradient-aurora-bg",
    category: "overlay",
    label: "Velvet Mesh BG",
    badge: "Backdrop",
    primaryColor: "#1d4ed8",
    accentColor: "#7c3aed",
    defaultDuration: 5.0,
    blendMode: "normal",
  },
];

export const STUDIO_AUDIO_ASSETS: readonly StudioAudioAssetDef[] = [
  { id: "cinema-whoosh", label: "Cinema Air Whoosh", badge: "Transition", defaultDuration: 0.9, accentColor: "#38bdf8" },
  { id: "sub-impact-boom", label: "Deep Sub Drop", badge: "Impact", defaultDuration: 1.5, accentColor: "#f97316" },
  { id: "shimmer-riser", label: "Warm Tension Riser", badge: "Build-Up", defaultDuration: 2.0, accentColor: "#a855f7" },
  { id: "camera-shutter", label: "35mm Shutter Click", badge: "Cut Hit", defaultDuration: 0.45, accentColor: "#eab308" },
  { id: "digital-glitch-sfx", label: "Clean Glitch Hit", badge: "Stutter", defaultDuration: 0.65, accentColor: "#ec4899" },
  { id: "velvet-ambient", label: "Velvet Drone Pad", badge: "Atmosphere", defaultDuration: 4.0, accentColor: "#22c55e" },
];

export const CAMERA_MOTION_PRESETS: readonly CameraMotionPresetDef[] = [
  { id: "ken-burns-in", label: "Cinema Push-In", badge: "1.00 → 1.18×" },
  { id: "ken-burns-out", label: "Cinema Pull-Out", badge: "1.20 → 1.00×" },
  { id: "glide-pan-right", label: "Glide Pan Right", badge: "Smooth Pan" },
  { id: "glide-pan-left", label: "Glide Pan Left", badge: "Smooth Pan" },
  { id: "spring-pop", label: "Spring Entrance", badge: "Overshoot" },
  { id: "handheld-cinema", label: "Handheld Drift", badge: "Organic 24p" },
  { id: "whip-zoom", label: "Whip Zoom Punch", badge: "Fast In" },
  { id: "dutch-float", label: "Subtle Tilt Float", badge: "Cinema Roll" },
];

// ---------- Pure High-Precision Easing & Deterministic Seed Math ----------

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function easeOutExpo(t: number): number {
  const x = clamp01(t);
  return x >= 0.999 ? 1 : 1 - Math.pow(2, -10 * x);
}

export function easeInOutQuart(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2;
}

export function easeOutBackSpring(t: number, overshoot = 1.15): number {
  const x = clamp01(t);
  const c1 = overshoot;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export function seededRand(seed: number, index: number): number {
  const x = Math.sin((seed + 1) * 12.9898 + (index + 1) * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function colorToRgba(hexOrColor: string | undefined, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const clean = (hexOrColor || "#3b82f6").replace("#", "").trim();
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }
  if (clean.length === 3) {
    const r = parseInt(clean[0]! + clean[0]!, 16) || 0;
    const g = parseInt(clean[1]! + clean[1]!, 16) || 0;
    const b = parseInt(clean[2]! + clean[2]!, 16) || 0;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }
  return `rgba(59,130,246,${a.toFixed(3)})`;
}

/** Universal text-width helper safe on both GPU Canvas2D and minimal headless/JSDOM mocks. */
function measureTextWidth(ctx: CanvasRenderingContext2D, text: string, approxPx: number): number {
  if (typeof ctx.measureText === "function") {
    const res = ctx.measureText(text);
    if (res && typeof res.width === "number" && res.width > 0) return res.width;
  }
  return text.length * approxPx * 0.56;
}

function safeLinearGradient(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  stops: Array<[number, string]>,
): CanvasGradient | string {
  if (typeof ctx.createLinearGradient === "function") {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [offset, col] of stops) g.addColorStop(offset, col);
    return g;
  }
  return stops[0]?.[1] || "#ffffff";
}

function safeRadialGradient(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  r0: number,
  x1: number,
  y1: number,
  r1: number,
  stops: Array<[number, string]>,
): CanvasGradient | string {
  if (typeof ctx.createRadialGradient === "function") {
    const g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
    for (const [offset, col] of stops) g.addColorStop(offset, col);
    return g;
  }
  return stops[0]?.[1] || "#ffffff";
}

/** Universal rounded-rect path using `moveTo + lineTo + quadraticCurveTo` with graceful fallback when `quadraticCurveTo` is absent. */
export function drawSmoothRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const safeW = Math.max(0, w);
  const safeH = Math.max(0, h);
  const r = Math.max(0, Math.min(radius, safeW / 2, safeH / 2));
  ctx.beginPath();
  if (r <= 0.01 || typeof ctx.quadraticCurveTo !== "function") {
    ctx.moveTo(x, y);
    ctx.lineTo(x + safeW, y);
    ctx.lineTo(x + safeW, y + safeH);
    ctx.lineTo(x, y + safeH);
    ctx.closePath();
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + safeW - r, y);
  ctx.quadraticCurveTo(x + safeW, y, x + safeW, y + r);
  ctx.lineTo(x + safeW, y + safeH - r);
  ctx.quadraticCurveTo(x + safeW, y + safeH, x + safeW - r, y + safeH);
  ctx.lineTo(x + r, y + safeH);
  ctx.quadraticCurveTo(x, y + safeH, x, y + safeH - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------- Camera Motion Keyframe Curve Builder ----------

export function buildCameraMotionKeyframes(
  preset: CameraMotionPresetId,
  duration: number,
  seed = 1,
): Array<{ time: number; property: string; value: number; easing: string }> {
  const d = Math.max(0.35, Number(duration.toFixed(3)));
  const jitter = (seededRand(seed, 3) - 0.5) * 0.04;
  switch (preset) {
    case "ken-burns-in": {
      const target = Number((1.18 + jitter).toFixed(3));
      return [
        { time: 0, property: "scaleX", value: 1, easing: "cinema" },
        { time: d, property: "scaleX", value: target, easing: "cinema" },
        { time: 0, property: "scaleY", value: 1, easing: "cinema" },
        { time: d, property: "scaleY", value: target, easing: "cinema" },
        { time: 0, property: "y", value: 0, easing: "cinema" },
        { time: d, property: "y", value: -18, easing: "cinema" },
      ];
    }
    case "ken-burns-out": {
      const start = Number((1.2 + jitter).toFixed(3));
      return [
        { time: 0, property: "scaleX", value: start, easing: "cinema" },
        { time: d, property: "scaleX", value: 1, easing: "cinema" },
        { time: 0, property: "scaleY", value: start, easing: "cinema" },
        { time: d, property: "scaleY", value: 1, easing: "cinema" },
      ];
    }
    case "glide-pan-right":
      return [
        { time: 0, property: "scaleX", value: 1.15, easing: "cinema" },
        { time: d, property: "scaleX", value: 1.15, easing: "cinema" },
        { time: 0, property: "scaleY", value: 1.15, easing: "cinema" },
        { time: d, property: "scaleY", value: 1.15, easing: "cinema" },
        { time: 0, property: "x", value: -88, easing: "cinema" },
        { time: d, property: "x", value: 88, easing: "cinema" },
      ];
    case "glide-pan-left":
      return [
        { time: 0, property: "scaleX", value: 1.15, easing: "cinema" },
        { time: d, property: "scaleX", value: 1.15, easing: "cinema" },
        { time: 0, property: "scaleY", value: 1.15, easing: "cinema" },
        { time: d, property: "scaleY", value: 1.15, easing: "cinema" },
        { time: 0, property: "x", value: 88, easing: "cinema" },
        { time: d, property: "x", value: -88, easing: "cinema" },
      ];
    case "spring-pop": {
      const intro = Number(Math.min(0.42, d * 0.4).toFixed(3));
      return [
        { time: 0, property: "scaleX", value: 0.78, easing: "spring" },
        { time: intro, property: "scaleX", value: 1, easing: "spring" },
        { time: 0, property: "scaleY", value: 0.78, easing: "spring" },
        { time: intro, property: "scaleY", value: 1, easing: "spring" },
        { time: 0, property: "opacity", value: 0, easing: "ease-out" },
        { time: Number((intro * 0.65).toFixed(3)), property: "opacity", value: 1, easing: "ease-out" },
      ];
    }
    case "handheld-cinema": {
      const q1 = Number((d * 0.25).toFixed(3));
      const q2 = Number((d * 0.5).toFixed(3));
      const q3 = Number((d * 0.75).toFixed(3));
      return [
        { time: 0, property: "scaleX", value: 1.06, easing: "ease-in-out" },
        { time: d, property: "scaleX", value: 1.08, easing: "ease-in-out" },
        { time: 0, property: "scaleY", value: 1.06, easing: "ease-in-out" },
        { time: d, property: "scaleY", value: 1.08, easing: "ease-in-out" },
        { time: 0, property: "x", value: -9, easing: "ease-in-out" },
        { time: q1, property: "x", value: 11, easing: "ease-in-out" },
        { time: q2, property: "x", value: -7, easing: "ease-in-out" },
        { time: q3, property: "x", value: 8, easing: "ease-in-out" },
        { time: d, property: "x", value: -4, easing: "ease-in-out" },
        { time: 0, property: "y", value: 6, easing: "ease-in-out" },
        { time: q2, property: "y", value: -8, easing: "ease-in-out" },
        { time: d, property: "y", value: 4, easing: "ease-in-out" },
        { time: 0, property: "rotation", value: -0.6, easing: "ease-in-out" },
        { time: q2, property: "rotation", value: 0.7, easing: "ease-in-out" },
        { time: d, property: "rotation", value: -0.3, easing: "ease-in-out" },
      ];
    }
    case "whip-zoom": {
      const hit = Number(Math.min(0.32, d * 0.35).toFixed(3));
      return [
        { time: 0, property: "scaleX", value: 1.38, easing: "expo-out" },
        { time: hit, property: "scaleX", value: 1.02, easing: "expo-out" },
        { time: d, property: "scaleX", value: 1.08, easing: "cinema" },
        { time: 0, property: "scaleY", value: 1.38, easing: "expo-out" },
        { time: hit, property: "scaleY", value: 1.02, easing: "expo-out" },
        { time: d, property: "scaleY", value: 1.08, easing: "cinema" },
      ];
    }
    case "dutch-float":
      return [
        { time: 0, property: "scaleX", value: 1.1, easing: "cinema" },
        { time: d, property: "scaleX", value: 1.15, easing: "cinema" },
        { time: 0, property: "scaleY", value: 1.1, easing: "cinema" },
        { time: d, property: "scaleY", value: 1.15, easing: "cinema" },
        { time: 0, property: "rotation", value: -2.2, easing: "cinema" },
        { time: d, property: "rotation", value: 1.8, easing: "cinema" },
      ];
  }
}

// ---------- Broadcast 60 FPS Motion Graphics Renderer ----------

export interface MotionGraphicRenderInput {
  template: MotionGraphicTemplateId;
  title: string;
  subtitle?: string;
  color?: string;
  accentColor?: string;
  bgColor?: string;
  bgOpacity?: number;
  x?: number;
  y?: number;
  fontSize?: number;
  elapsed: number;
  duration: number;
}

export function drawMotionGraphicOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mg: MotionGraphicRenderInput,
): { boxX: number; boxY: number; boxW: number; boxH: number } {
  const dur = Math.max(0.25, mg.duration);
  const t = Math.max(0, Math.min(dur, mg.elapsed));
  const progress = clamp01(t / dur);
  const intro = easeOutExpo(t / Math.min(0.48, dur * 0.35));
  const springIn = easeOutBackSpring(t / Math.min(0.45, dur * 0.34), 1.05);
  const outro = dur - t < 0.3 ? easeOutExpo((dur - t) / 0.3) : 1;
  const visibility = clamp01(Math.min(intro, outro));

  const sf = Math.max(0.32, height / 1080);
  const cx = (mg.x ?? 0.5) * width;
  const cy = (mg.y ?? 0.8) * height;
  const fontPx = Math.max(15, Math.round((mg.fontSize ?? 48) * sf));
  const subFontPx = Math.max(10, Math.round(fontPx * 0.44));
  const titleText = mg.title || "Vedit Motion";
  const subText = (mg.subtitle ?? "").trim();
  const primaryCol = mg.color || "#ffffff";
  const accentCol = mg.accentColor || "#3b82f6";
  const family = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  ctx.save();
  ctx.font = `700 ${fontPx}px ${family}`;
  const titleW = Math.max(60 * sf, measureTextWidth(ctx, titleText, fontPx));
  ctx.font = `600 ${subFontPx}px ${family}`;
  const subW = subText ? measureTextWidth(ctx, subText, subFontPx) * 1.14 : 0;

  let boxW = Math.max(titleW, subW) + 56 * sf;
  let boxH = (subText ? fontPx * 1.75 : fontPx * 1.32) + 28 * sf;

  if (mg.template === "lower-third-editorial") {
    const barH = boxH;
    const wipe = easeOutExpo(Math.max(0, (t - 0.05) / 0.38)) * outro;
    boxW = Math.max(titleW, subW) + 58 * sf;
    const leftX = cx - boxW / 2;
    const topY = cy - barH / 2;

    ctx.globalAlpha = clamp01(visibility);
    // Frosted obsidian plate
    ctx.fillStyle = colorToRgba(mg.bgColor || "#09090b", (mg.bgOpacity ?? 0.78) * wipe);
    drawSmoothRoundRect(ctx, leftX + 10 * sf, topY, (boxW - 10 * sf) * wipe, barH, 12 * sf);
    ctx.fill();

    // Subtle top specular highlight
    ctx.strokeStyle = `rgba(255,255,255,${(0.14 * wipe).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, 1.2 * sf);
    ctx.stroke();

    // Vertical glowing accent pillar
    const pillarH = barH * intro * outro;
    ctx.shadowColor = colorToRgba(accentCol, 0.65);
    ctx.shadowBlur = Math.round(14 * sf);
    ctx.fillStyle = accentCol;
    drawSmoothRoundRect(ctx, leftX, cy - pillarH / 2, Math.max(4, 6.5 * sf), pillarH, 4 * sf);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Masked text slide
    ctx.save();
    drawSmoothRoundRect(ctx, leftX + 12 * sf, topY - 4 * sf, boxW * wipe, barH + 8 * sf, 0);
    ctx.clip?.();
    const slideOffset = (1 - wipe) * (-28 * sf);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${fontPx}px ${family}`;
    ctx.fillStyle = primaryCol;
    ctx.fillText(titleText, leftX + 24 * sf + slideOffset, subText ? topY + barH * 0.4 : cy);

    if (subText) {
      const subAlpha = easeOutExpo(Math.max(0, (t - 0.14) / 0.32)) * outro;
      ctx.globalAlpha = clamp01(subAlpha);
      ctx.font = `600 ${subFontPx}px ${family}`;
      ctx.fillStyle = accentCol;
      ctx.fillText(subText.toUpperCase(), leftX + 25 * sf + slideOffset * 0.5, topY + barH * 0.76);
    }
    ctx.restore();
    ctx.restore();
    return { boxX: leftX, boxY: topY, boxW, boxH: barH };
  }

  if (mg.template === "glass-callout") {
    const badgePad = subText ? subW + 34 * sf : 0;
    boxW = titleW + badgePad + 68 * sf;
    boxH = Math.max(54 * sf, fontPx * 1.62);
    const scale = (0.86 + 0.14 * springIn) * (dur - t < 0.25 ? 0.94 + 0.06 * outro : 1);

    ctx.globalAlpha = visibility;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = Math.round(22 * sf);
    ctx.shadowOffsetY = Math.round(6 * sf);
    ctx.fillStyle = colorToRgba(mg.bgColor || "#0c0c12", mg.bgOpacity ?? 0.86);
    drawSmoothRoundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, boxH / 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = Math.max(1, 1.4 * sf);
    ctx.stroke();

    // Pulsing live beacon dot
    const pulse = 0.5 + 0.5 * Math.sin(t * 6.2);
    const dotX = -boxW / 2 + 26 * sf;
    ctx.fillStyle = colorToRgba(accentCol, 0.26 + 0.22 * pulse);
    ctx.beginPath();
    ctx.arc(dotX, 0, (9 + 3.5 * pulse) * sf, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = accentCol;
    ctx.beginPath();
    ctx.arc(dotX, 0, 5.2 * sf, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${fontPx}px ${family}`;
    ctx.fillStyle = primaryCol;
    ctx.fillText(titleText, dotX + 18 * sf, 0);

    if (subText) {
      const pillW = subW + 20 * sf;
      const pillH = subFontPx * 1.75;
      const px = boxW / 2 - pillW - 12 * sf;
      ctx.fillStyle = colorToRgba(accentCol, 0.2);
      drawSmoothRoundRect(ctx, px, -pillH / 2, pillW, pillH, pillH / 2);
      ctx.fill();
      ctx.font = `700 ${subFontPx}px ${family}`;
      ctx.textAlign = "center";
      ctx.fillStyle = accentCol;
      ctx.fillText(subText.toUpperCase(), px + pillW / 2, 0);
    }

    ctx.restore();
    return { boxX: cx - boxW / 2, boxY: cy - boxH / 2, boxW, boxH };
  }

  if (mg.template === "split-ribbon") {
    const mainW = titleW + 46 * sf;
    const mainH = fontPx * 1.42;
    const tagW = Math.max(110 * sf, subW + 30 * sf);
    const tagH = subFontPx * 1.9;
    boxW = Math.max(mainW, tagW + 24 * sf);
    boxH = mainH + (subText ? tagH * 0.85 : 0);

    const inMain = easeOutExpo(t / 0.34) * outro;
    const inTag = easeOutExpo(Math.max(0, (t - 0.1) / 0.34)) * outro;
    const leftX = cx - boxW / 2;
    const topY = cy - boxH / 2;

    ctx.globalAlpha = visibility;
    // Upper crisp white/light headline bar
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.48)";
    ctx.shadowBlur = Math.round(18 * sf);
    ctx.fillStyle = "#fafafa";
    drawSmoothRoundRect(ctx, leftX, topY + (subText ? tagH * 0.72 : 0), mainW * inMain, mainH, 8 * sf);
    ctx.fill();
    ctx.shadowBlur = 0;

    drawSmoothRoundRect(ctx, leftX, topY, mainW * inMain, boxH + 10 * sf, 0);
    ctx.clip?.();
    ctx.font = `800 ${fontPx}px ${family}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#09090b";
    ctx.fillText(titleText, leftX + 22 * sf, topY + (subText ? tagH * 0.72 : 0) + mainH / 2);
    ctx.restore();

    // Accent upper tag ribbon
    if (subText) {
      ctx.save();
      ctx.globalAlpha = clamp01(inTag);
      ctx.fillStyle = accentCol;
      drawSmoothRoundRect(ctx, leftX + 12 * sf, topY, tagW * inTag, tagH, 6 * sf);
      ctx.fill();
      ctx.font = `800 ${subFontPx}px ${family}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(subText.toUpperCase(), leftX + 24 * sf, topY + tagH / 2);
      ctx.restore();
    }

    ctx.restore();
    return { boxX: leftX, boxY: topY, boxW, boxH };
  }

  if (mg.template === "chapter-card") {
    boxW = Math.max(titleW + 70 * sf, 280 * sf);
    boxH = fontPx * 2.55;
    ctx.globalAlpha = visibility;
    ctx.translate(cx, cy);

    // Subtle dark vignette backing
    ctx.fillStyle = colorToRgba("#09090b", (mg.bgOpacity ?? 0.68) * intro);
    drawSmoothRoundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 16 * sf);
    ctx.fill();
    ctx.strokeStyle = colorToRgba(accentCol, 0.35);
    ctx.lineWidth = Math.max(1, 1.3 * sf);
    ctx.stroke();

    // Chapter tag + animated hairline divider
    const tagLabel = (subText || "01 // CHAPTER").toUpperCase();
    ctx.font = `800 ${subFontPx}px ${family}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = accentCol;
    ctx.fillText(tagLabel, 0, -fontPx * 0.62);

    const ruleW = (boxW - 72 * sf) * easeInOutQuart(Math.min(1, t / 0.45)) * outro;
    ctx.fillStyle = colorToRgba(accentCol, 0.85);
    ctx.fillRect(-ruleW / 2, -fontPx * 0.24, ruleW, Math.max(1.5, 2.2 * sf));

    ctx.font = `800 ${fontPx}px ${family}`;
    ctx.fillStyle = primaryCol;
    ctx.fillText(titleText, 0, fontPx * 0.36 + (1 - intro) * 18 * sf);

    ctx.restore();
    return { boxX: cx - boxW / 2, boxY: cy - boxH / 2, boxW, boxH };
  }

  if (mg.template === "kinetic-stomp") {
    const words = titleText.trim().split(/\s+/).slice(0, 4);
    const lineH = fontPx * 1.12;
    boxW = Math.max(titleW, 180 * sf) + 56 * sf;
    boxH = words.length * lineH + (subText ? subFontPx * 2.2 : 24 * sf);

    ctx.globalAlpha = outro;
    ctx.translate(cx, cy);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const startY = -((words.length - 1) * lineH) / 2 - (subText ? subFontPx * 0.65 : 0);
    words.forEach((word, idx) => {
      const wt = clamp01((t - idx * 0.075) / 0.26);
      if (wt <= 0.005) return;
      const wScale = easeOutBackSpring(wt, 1.12);
      const wy = startY + idx * lineH;
      const isLast = idx === words.length - 1;

      ctx.save();
      ctx.globalAlpha = clamp01(wt * outro);
      ctx.translate(0, wy);
      ctx.scale(wScale, wScale);
      if (isLast) {
        const wMeasure = measureTextWidth(ctx, word, fontPx) + 26 * sf;
        ctx.fillStyle = accentCol;
        drawSmoothRoundRect(ctx, -wMeasure / 2, -fontPx * 0.52, wMeasure, fontPx * 1.04, 10 * sf);
        ctx.fill();
      }
      ctx.shadowColor = "rgba(0,0,0,0.65)";
      ctx.shadowBlur = Math.round(14 * sf);
      ctx.font = `900 ${fontPx}px ${family}`;
      ctx.fillStyle = isLast ? "#ffffff" : primaryCol;
      ctx.fillText(word, 0, 0);
      ctx.restore();
    });

    if (subText) {
      const subVis = clamp01((t - words.length * 0.07) / 0.25) * outro;
      ctx.globalAlpha = subVis;
      ctx.font = `700 ${subFontPx}px ${family}`;
      ctx.fillStyle = accentCol;
      ctx.fillText(subText.toUpperCase(), 0, startY + words.length * lineH + subFontPx * 0.5);
    }

    ctx.restore();
    return { boxX: cx - boxW / 2, boxY: cy - boxH / 2, boxW, boxH };
  }

  if (mg.template === "neon-hud") {
    boxW = Math.max(titleW, subW) + 74 * sf;
    boxH = fontPx * 2.15;
    const expand = 1.18 - 0.18 * intro;

    ctx.globalAlpha = visibility;
    ctx.translate(cx, cy);
    ctx.scale(expand, expand);

    ctx.fillStyle = colorToRgba("#050810", 0.72);
    ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);

    // Precision L-corner brackets
    const br = Math.min(18 * sf, boxH * 0.34);
    ctx.strokeStyle = accentCol;
    ctx.lineWidth = Math.max(1.5, 2.6 * sf);
    ctx.shadowColor = colorToRgba(accentCol, 0.7);
    ctx.shadowBlur = Math.round(10 * sf);
    const corners: Array<[number, number, number, number]> = [
      [-boxW / 2, -boxH / 2, 1, 1],
      [boxW / 2, -boxH / 2, -1, 1],
      [-boxW / 2, boxH / 2, 1, -1],
      [boxW / 2, boxH / 2, -1, -1],
    ];
    for (const [bx, by, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(bx + dx * br, by);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx, by + dy * br);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${fontPx}px ${family}`;
    ctx.fillStyle = primaryCol;
    ctx.fillText(titleText, 0, subText ? -fontPx * 0.2 : 0);

    if (subText) {
      ctx.font = `600 ${subFontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillStyle = accentCol;
      ctx.fillText(subText.toUpperCase(), 0, fontPx * 0.52);
    }

    ctx.restore();
    return { boxX: cx - boxW / 2, boxY: cy - boxH / 2, boxW, boxH };
  }

  // `progress-pill`: sleek capsule with live 0 -> 100% progress bar fill across duration
  boxW = Math.max(titleW + 110 * sf, 290 * sf);
  boxH = fontPx * 1.95;
  ctx.globalAlpha = visibility;
  ctx.translate(cx, cy);

  ctx.fillStyle = colorToRgba("#0b0b10", 0.88);
  drawSmoothRoundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 16 * sf);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = Math.max(1, 1.2 * sf);
  ctx.stroke();

  const innerW = boxW - 36 * sf;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(fontPx * 0.82)}px ${family}`;
  ctx.fillStyle = primaryCol;
  ctx.fillText(titleText, -innerW / 2, -boxH * 0.14);

  ctx.textAlign = "right";
  ctx.font = `700 ${subFontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillStyle = accentCol;
  ctx.fillText(`${Math.round(progress * 100)}%`, innerW / 2, -boxH * 0.14);

  const trackY = boxH * 0.24;
  const trackH = Math.max(4, 7 * sf);
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  drawSmoothRoundRect(ctx, -innerW / 2, trackY - trackH / 2, innerW, trackH, trackH / 2);
  ctx.fill();

  const fillW = Math.max(trackH, innerW * progress);
  ctx.fillStyle = safeLinearGradient(ctx, -innerW / 2, 0, innerW / 2, 0, [
    [0, accentCol],
    [1, primaryCol],
  ]);
  drawSmoothRoundRect(ctx, -innerW / 2, trackY - trackH / 2, fillW, trackH, trackH / 2);
  ctx.fill();

  ctx.restore();
  return { boxX: cx - boxW / 2, boxY: cy - boxH / 2, boxW, boxH };
}

// ---------- High-Resolution Procedural Optical Transitions & Overlays Renderer ----------

export interface ProceduralFxParams {
  preset: ProceduralVisualPresetId;
  primaryColor?: string;
  accentColor?: string;
  intensity?: number; // 0..100
  seed?: number;
}

export function drawProceduralFxClip(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  localTime: number,
  duration: number,
  params: ProceduralFxParams,
  extraAlpha = 1,
): void {
  const dur = Math.max(0.15, duration);
  const p = clamp01(localTime / dur);
  const bell = Math.sin(p * Math.PI); // 0 -> 1.0 peak at exact cut midpoint (p = 0.5) -> 0
  const c1 = params.primaryColor || "#f59e0b";
  const c2 = params.accentColor || "#ef4444";
  const strength = clamp01((params.intensity ?? 90) / 100) * extraAlpha;
  const seed = Number(params.seed ?? 7);

  ctx.save();

  switch (params.preset) {
    case "golden-light-leak": {
      ctx.globalCompositeOperation = "screen";
      // Sweeping multi-lobe optical flare across frame peaking at midpoint
      for (let i = 0; i < 4; i++) {
        const sweepX = width * (-0.25 + 1.5 * p + (seededRand(seed, i) - 0.5) * 0.24);
        const sweepY = height * (0.2 + 0.6 * seededRand(seed, i + 10));
        const rad = Math.max(width, height) * (0.45 + 0.42 * bell);
        ctx.fillStyle = safeRadialGradient(ctx, sweepX, sweepY, 0, sweepX, sweepY, rad, [
          [0, colorToRgba("#fffbeb", 0.92 * bell * strength)],
          [0.32, colorToRgba(i % 2 === 0 ? c1 : c2, 0.76 * bell * strength)],
          [1, "rgba(0,0,0,0)"],
        ]);
        ctx.fillRect(0, 0, width, height);
      }
      // Peak optical exposure veil right at cut point so shot change is 100% seamless
      if (bell > 0.55) {
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = colorToRgba("#fff7ed", Math.pow((bell - 0.55) / 0.45, 1.4) * 0.94 * strength);
        ctx.fillRect(0, 0, width, height);
      }
      break;
    }

    case "anamorphic-streak": {
      ctx.globalCompositeOperation = "screen";
      const cy = height * (0.48 + 0.06 * Math.sin(p * Math.PI * 2));
      const streakH = Math.max(12, height * (0.06 + 0.34 * bell));
      ctx.fillStyle = safeLinearGradient(ctx, 0, cy - streakH, 0, cy + streakH, [
        [0, "rgba(0,0,0,0)"],
        [0.5, colorToRgba(c1, 0.95 * bell * strength)],
        [1, "rgba(0,0,0,0)"],
      ]);
      ctx.fillRect(0, cy - streakH, width, streakH * 2);

      const cx = width * (0.15 + 0.7 * p);
      const coreR = Math.max(width, height) * (0.35 + 0.5 * bell);
      ctx.fillStyle = safeRadialGradient(ctx, cx, cy, 0, cx, cy, coreR, [
        [0, colorToRgba("#ffffff", 0.96 * bell * strength)],
        [0.28, colorToRgba(c1, 0.8 * bell * strength)],
        [0.62, colorToRgba(c2, 0.45 * bell * strength)],
        [1, "rgba(0,0,0,0)"],
      ]);
      ctx.fillRect(0, 0, width, height);
      break;
    }

    case "film-flash-burn": {
      ctx.globalCompositeOperation = "screen";
      const bloom = Math.pow(bell, 0.75) * strength;
      ctx.fillStyle = safeRadialGradient(
        ctx,
        width * 0.5,
        height * 0.5,
        width * 0.05 * (1 - bell),
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.9,
        [
          [0, colorToRgba("#ffffff", 0.98 * bloom)],
          [0.45, colorToRgba(c2, 0.85 * bloom)],
          [0.8, colorToRgba(c1, 0.75 * bloom)],
          [1, colorToRgba("#dc2626", 0.4 * bloom)],
        ],
      );
      ctx.fillRect(0, 0, width, height);
      break;
    }

    case "shutter-matte-wipe": {
      const blades = 5;
      const bladeH = Math.ceil(height / blades) + 2;
      const slant = width * 0.14;
      for (let b = 0; b < blades; b++) {
        const localP = clamp01(p * 1.24 - b * 0.06);
        let xStart = 0;
        let xEnd = 0;
        if (localP <= 0.5) {
          xStart = -slant;
          xEnd = (width + slant * 2) * easeInOutQuart(localP * 2) - slant;
        } else {
          xStart = (width + slant * 2) * easeInOutQuart((localP - 0.5) * 2) - slant;
          xEnd = width + slant;
        }
        if (xEnd - xStart <= 1) continue;
        const y0 = b * Math.floor(height / blades);
        ctx.fillStyle = c1;
        ctx.beginPath();
        ctx.moveTo(xStart + slant * 0.5, y0);
        ctx.lineTo(xEnd + slant * 0.5, y0);
        ctx.lineTo(xEnd - slant * 0.5, y0 + bladeH);
        ctx.lineTo(xStart - slant * 0.5, y0 + bladeH);
        ctx.closePath();
        ctx.fill();

        // Crisp accent edge highlight
        const edgeX = localP <= 0.5 ? xEnd : xStart;
        ctx.fillStyle = c2;
        ctx.fillRect(edgeX - 3, y0, 6, bladeH);
      }
      break;
    }

    case "prism-glitch-hit": {
      ctx.globalCompositeOperation = "screen";
      const slices = 12;
      const frameQuant = Math.floor(p * 18);
      for (let s = 0; s < slices; s++) {
        const active = seededRand(seed + frameQuant, s) > 0.35;
        if (!active) continue;
        const sy = (s / slices) * height;
        const sh = (height / slices) * (0.4 + 0.7 * seededRand(seed, s + frameQuant));
        const shift = (seededRand(seed * 3 + frameQuant, s) - 0.5) * width * 0.55 * bell;
        const barW = width * (0.35 + 0.65 * seededRand(seed, s * 2));
        const sx = (width - barW) / 2 + shift;
        ctx.fillStyle = colorToRgba(s % 2 === 0 ? c1 : c2, 0.72 * bell * strength);
        ctx.fillRect(sx, sy, barW, sh);
      }
      if (bell > 0.72) {
        ctx.fillStyle = colorToRgba("#ffffff", (bell - 0.72) * 3.1 * strength);
        ctx.fillRect(0, 0, width, height);
      }
      break;
    }

    case "iris-portal": {
      const maxR = Math.hypot(width, height) * 0.62;
      const ringR = p <= 0.5 ? maxR * easeInOutQuart(p * 2) : maxR * easeInOutQuart((1 - p) * 2);
      ctx.fillStyle = colorToRgba(c1, 0.96 * strength);
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, ringR, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = c2;
      ctx.lineWidth = Math.max(3, maxR * 0.02);
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, ringR, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }

    case "cinema-grain-dust": {
      // Authentic 2.39:1 anamorphic cinema matte bars + warm film halation + animated micro specs
      const barH = Math.round(height * 0.1);
      ctx.fillStyle = "#050507";
      ctx.fillRect(0, 0, width, barH);
      ctx.fillRect(0, height - barH, width, barH);

      // Subtle corner warm halation
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = safeRadialGradient(ctx, width * 0.1, height * 0.15, 0, width * 0.1, height * 0.15, width * 0.55, [
        [0, colorToRgba(c1, (0.14 + 0.05 * Math.sin(localTime * 5)) * strength)],
        [1, "rgba(0,0,0,0)"],
      ]);
      ctx.fillRect(0, 0, width, height);

      // Clean film specs (24fps stepped)
      const fStep = Math.floor(localTime * 24);
      ctx.globalCompositeOperation = "source-over";
      for (let i = 0; i < 16; i++) {
        const gx = seededRand(seed + fStep, i) * width;
        const gy = barH + seededRand(seed + fStep, i + 40) * (height - barH * 2);
        const gr = 0.8 + seededRand(seed, i) * 1.8;
        ctx.fillStyle = `rgba(255,250,240,${(0.12 * strength).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(gx, gy, gr, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    case "bokeh-shimmer": {
      ctx.globalCompositeOperation = "screen";
      for (let i = 0; i < 18; i++) {
        const speed = 0.06 + seededRand(seed, i + 20) * 0.14;
        const bx = ((seededRand(seed, i) + localTime * speed * 0.35) % 1.2 - 0.1) * width;
        const by = (1.1 - ((seededRand(seed, i + 50) + localTime * speed) % 1.2)) * height;
        const br = Math.min(width, height) * (0.03 + 0.085 * seededRand(seed, i + 80));
        const shimmer = 0.55 + 0.45 * Math.sin(localTime * 2.4 + i);
        const col = i % 2 === 0 ? c1 : c2;
        ctx.fillStyle = safeRadialGradient(ctx, bx, by, 0, bx, by, br, [
          [0, colorToRgba(col, 0.32 * shimmer * strength)],
          [0.72, colorToRgba(col, 0.16 * shimmer * strength)],
          [1, "rgba(0,0,0,0)"],
        ]);
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    case "rec-viewfinder-hud": {
      const pad = Math.min(width, height) * 0.055;
      const len = Math.min(width, height) * 0.05;
      ctx.strokeStyle = colorToRgba(c2, 0.82 * strength);
      ctx.lineWidth = Math.max(1.5, Math.min(width, height) * 0.0028);

      const corners: Array<[number, number, number, number]> = [
        [pad, pad, 1, 1],
        [width - pad, pad, -1, 1],
        [pad, height - pad, 1, -1],
        [width - pad, height - pad, -1, -1],
      ];
      for (const [cx0, cy0, dx, dy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx0 + dx * len, cy0);
        ctx.lineTo(cx0, cy0);
        ctx.lineTo(cx0, cy0 + dy * len);
        ctx.stroke();
      }

      // Center crosshair
      const ch = Math.min(width, height) * 0.018;
      ctx.strokeStyle = colorToRgba(c2, 0.45 * strength);
      ctx.beginPath();
      ctx.moveTo(width / 2 - ch, height / 2);
      ctx.lineTo(width / 2 + ch, height / 2);
      ctx.moveTo(width / 2, height / 2 - ch);
      ctx.lineTo(width / 2, height / 2 + ch);
      ctx.stroke();

      // Blinking REC dot + live timecode
      const blink = Math.sin(localTime * Math.PI * 2) > -0.25 ? 1 : 0.25;
      const dotR = Math.max(4, Math.min(width, height) * 0.011);
      ctx.fillStyle = colorToRgba(c1, blink * strength);
      ctx.beginPath();
      ctx.arc(pad + dotR * 2.2, pad + dotR * 2.4, dotR, 0, Math.PI * 2);
      ctx.fill();

      const fontPx = Math.max(11, Math.round(Math.min(width, height) * 0.026));
      ctx.font = `700 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = colorToRgba("#ffffff", 0.9 * strength);
      ctx.fillText("REC  4K 24FPS", pad + dotR * 4.4, pad + dotR * 2.4);

      const secs = Math.floor(localTime);
      const frames = Math.floor((localTime - secs) * 24);
      const tc = `00:00:${String(secs % 60).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
      ctx.textAlign = "right";
      ctx.fillText(tc, width - pad - dotR, height - pad - dotR * 2);
      break;
    }

    case "gradient-aurora-bg": {
      ctx.fillStyle = "#070912";
      ctx.fillRect(0, 0, width, height);
      const phase = localTime * 0.85;
      const orbs: Array<[number, number, string]> = [
        [0.3 + 0.18 * Math.cos(phase), 0.35 + 0.15 * Math.sin(phase), c1],
        [0.72 + 0.16 * Math.sin(phase * 0.8), 0.65 + 0.16 * Math.cos(phase * 0.9), c2],
        [0.5 + 0.14 * Math.sin(phase * 1.2 + 1), 0.28 + 0.12 * Math.cos(phase), "#0ea5e9"],
      ];
      for (const [ox, oy, col] of orbs) {
        ctx.fillStyle = safeRadialGradient(
          ctx,
          ox * width,
          oy * height,
          0,
          ox * width,
          oy * height,
          Math.max(width, height) * 0.68,
          [
            [0, colorToRgba(col, 0.62 * strength)],
            [1, "rgba(0,0,0,0)"],
          ],
        );
        ctx.fillRect(0, 0, width, height);
      }
      break;
    }
  }

  ctx.restore();
}

// ---------- High-DPI Card Preview Thumbnail Renderers (Browser / Android Canvas -> PNG Data URL) ----------

function svgFallbackPreview(c1: string, c2: string, label: string, w = 320, h = 180): string {
  const safe = label.replace(/[<>&"']/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="#0c0e16"/><circle cx="${Math.round(w * 0.5)}" cy="${Math.round(h * 0.5)}" r="${Math.round(h * 0.58)}" fill="url(#g)" opacity="0.72"/><text x="50%" y="54%" fill="#ffffff" font-family="sans-serif" font-weight="700" font-size="18" text-anchor="middle">${safe}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function hasWorkingCanvasToDataUrl(canvas: HTMLCanvasElement): boolean {
  const fnStr = Function.prototype.toString.call(canvas.toDataURL || "");
  return fnStr.includes("[native code]") || fnStr.includes("data:");
}

function isHeadlessJsdom(): boolean {
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent || "")) return true;
  if (typeof document !== "undefined") {
    const probe = document.createElement("canvas");
    if (!hasWorkingCanvasToDataUrl(probe)) return true;
  }
  return false;
}

export function renderVisualAssetPreviewDataUrl(
  preset: ProceduralVisualPresetId,
  primaryColor?: string,
  accentColor?: string,
  seed = 7,
  w = 320,
  h = 180,
): string {
  const c1 = primaryColor || "#f59e0b";
  const c2 = accentColor || "#3b82f6";
  if (typeof document === "undefined" || isHeadlessJsdom()) {
    return svgFallbackPreview(c1, c2, preset, w, h);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return svgFallbackPreview(c1, c2, preset, w, h);

  // Rich studio slate checker/gradient backdrop so transparent optical transitions look unmistakable
  if (typeof ctx.createLinearGradient === "function") {
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, "#121520");
    bg.addColorStop(0.5, "#1e293b");
    bg.addColorStop(1, "#0f172a");
    ctx.fillStyle = bg;
  } else {
    ctx.fillStyle = "#121520";
  }
  ctx.fillRect(0, 0, w, h);

  // Subtle split indicator showing Clip A | Clip B underneath transition previews
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.stroke();

  drawProceduralFxClip(ctx, w, h, 0.42, 1.0, {
    preset,
    primaryColor: c1,
    accentColor: c2,
    intensity: 95,
    seed,
  });

  try {
    return canvas.toDataURL("image/png") || svgFallbackPreview(c1, c2, preset, w, h);
  } catch {
    return svgFallbackPreview(c1, c2, preset, w, h);
  }
}

export function renderMotionGraphicPreviewDataUrl(
  template: MotionGraphicTemplateId,
  title: string,
  subtitle: string,
  color: string,
  accentColor: string,
  w = 320,
  h = 180,
): string {
  if (typeof document === "undefined" || isHeadlessJsdom()) {
    return svgFallbackPreview(accentColor || "#3b82f6", "#09090b", title || template, w, h);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return svgFallbackPreview(accentColor || "#3b82f6", "#09090b", title || template, w, h);

  if (typeof ctx.createLinearGradient === "function") {
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, "#111827");
    bg.addColorStop(1, "#09090b");
    ctx.fillStyle = bg;
  } else {
    ctx.fillStyle = "#09090b";
  }
  ctx.fillRect(0, 0, w, h);

  drawMotionGraphicOverlay(ctx, w, h, {
    template,
    title,
    subtitle,
    color,
    accentColor,
    x: 0.5,
    y: 0.52,
    fontSize: 84,
    elapsed: 0.65,
    duration: 2.0,
  });

  try {
    return canvas.toDataURL("image/png") || svgFallbackPreview(accentColor || "#3b82f6", "#09090b", title || template, w, h);
  } catch {
    return svgFallbackPreview(accentColor || "#3b82f6", "#09090b", title || template, w, h);
  }
}

// ---------- Studio 44.1 kHz 16-bit Stereo PCM WAV Synthesizer ----------
// Uses resonant state-variable bandpass filters, stereo panning envelopes, harmonic chords & soft clipping
// so every generated transition whoosh / impact / riser sounds crisp and musical on phone & studio speakers.

export function synthesizeStudioSfxWav(
  preset: StudioSfxPresetId,
  durationSec?: number,
  seed = 1,
): Uint8Array {
  const def = STUDIO_AUDIO_ASSETS.find((a) => a.id === preset) ?? STUDIO_AUDIO_ASSETS[0]!;
  const dur = Math.max(0.25, Math.min(8, durationSec ?? def.defaultDuration));
  const sampleRate = 44100;
  const numChannels = 2;
  const frames = Math.floor(sampleRate * dur);
  const dataBytes = frames * numChannels * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  // Two-pole Chamberlin SVF filter state + PRNG
  let low = 0;
  let band = 0;
  let phase1 = 0;
  let phase2 = 0;
  let phase3 = 0;
  let rng = (Math.floor(seed * 977) + 12345) >>> 0;
  const nextWhite = () => {
    rng = (1664525 * rng + 1013904223) >>> 0;
    return (rng / 2147483648) - 1;
  };

  const pitchVar = 0.94 + seededRand(seed, 5) * 0.14;
  let byteOffset = 44;

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const p = i / Math.max(1, frames - 1);
    let monoL = 0;
    let monoR = 0;

    if (preset === "cinema-whoosh") {
      // Aerodynamic filtered noise sweep panning smoothly Left -> Right across the cut
      const env = Math.pow(Math.sin(p * Math.PI), 1.45);
      const cutoffHz = (220 + 2600 * Math.pow(env, 1.3)) * pitchVar;
      const f = 2 * Math.sin((Math.PI * Math.min(8000, cutoffHz)) / sampleRate);
      const q = 0.42;
      const white = nextWhite();
      low += f * band;
      const high = white - low - q * band;
      band += f * high;

      // Subtle low sub body underneath the air whoosh
      phase1 += (2 * Math.PI * (58 + 75 * env) * pitchVar) / sampleRate;
      const sub = Math.sin(phase1) * env * 0.36;
      const pan = p; // 0 = left, 1 = right
      const sig = band * env * 1.35 + sub;
      monoL = sig * Math.cos(pan * Math.PI * 0.5);
      monoR = sig * Math.sin(pan * Math.PI * 0.5);
    } else if (preset === "sub-impact-boom") {
      const env = Math.exp(-3.4 * p) * Math.min(1, t / 0.006);
      const freq = (34 + 92 * Math.exp(-16 * p)) * pitchVar;
      phase1 += (2 * Math.PI * freq) / sampleRate;
      const transient = nextWhite() * Math.exp(-42 * p) * 0.42;
      const s = Math.sin(phase1) * env * 0.88 + transient;
      monoL = s;
      monoR = s * 0.98;
    } else if (preset === "shimmer-riser") {
      const env = Math.pow(p, 2.1) * (p > 0.96 ? (1 - p) / 0.04 : 1);
      const sweep = 1 + 1.35 * p * p;
      phase1 += (2 * Math.PI * 196 * sweep * pitchVar) / sampleRate;
      phase2 += (2 * Math.PI * 293.66 * sweep * pitchVar) / sampleRate;
      phase3 += (2 * Math.PI * 392 * sweep * pitchVar) / sampleRate;
      const white = nextWhite();
      const f = 2 * Math.sin((Math.PI * (300 + 4200 * p * p)) / sampleRate);
      low += f * band;
      band += f * (white - low - 0.35 * band);
      const tonal = (Math.sin(phase1) * 0.34 + Math.sin(phase2) * 0.26 + Math.sin(phase3) * 0.2) * env;
      monoL = tonal + band * env * 0.42;
      monoR = tonal * 0.96 + band * env * 0.46;
    } else if (preset === "camera-shutter") {
      // Crisp dual-curtain mechanical mirror click
      const click1 = Math.exp(-95 * t) * nextWhite() * 0.9;
      const dt = Math.max(0, t - 0.075);
      const click2 = t >= 0.075 ? Math.exp(-85 * dt) * nextWhite() * 0.72 : 0;
      phase1 += (2 * Math.PI * 920) / sampleRate;
      const body = Math.sin(phase1) * Math.exp(-60 * t) * 0.28;
      monoL = click1 + click2 + body;
      monoR = (click1 + click2) * 0.94 + body;
    } else if (preset === "digital-glitch-sfx") {
      const gate = Math.sin(p * Math.PI * 26) > -0.15 ? 1 : 0.06;
      const env = Math.sin(p * Math.PI) * gate;
      const stepFreq = (180 + ((Math.floor(p * 16) * 233) % 980)) * pitchVar;
      phase1 += (2 * Math.PI * stepFreq) / sampleRate;
      const sig = (Math.sign(Math.sin(phase1)) * 0.28 + nextWhite() * 0.34) * env;
      monoL = sig;
      monoR = -sig * 0.85;
    } else {
      // `velvet-ambient`: smooth warm cinema fifth pad with gentle fade in/out
      const env = Math.min(1, t / 0.35) * Math.min(1, (dur - t) / 0.45) * 0.55;
      phase1 += (2 * Math.PI * 130.81 * pitchVar) / sampleRate;
      phase2 += (2 * Math.PI * 196.0 * pitchVar) / sampleRate;
      phase3 += (2 * Math.PI * 246.94 * pitchVar) / sampleRate;
      const pad = Math.sin(phase1) * 0.42 + Math.sin(phase2) * 0.32 + Math.sin(phase3) * 0.22;
      monoL = pad * env;
      monoR = (pad * 0.95 + Math.sin(phase2 * 2) * 0.08) * env;
    }

    const softClip = (x: number) => Math.max(-1, Math.min(1, Math.tanh(x * 1.15)));
    view.setInt16(byteOffset, Math.round(softClip(monoL) * 32760), true);
    view.setInt16(byteOffset + 2, Math.round(softClip(monoR) * 32760), true);
    byteOffset += 4;
  }

  return new Uint8Array(buf);
}

/** Deterministic smart prompt-to-asset mapper when offline or complementing LLM parameters. */
export function inferStudioAssetParamsFromPrompt(
  prompt: string,
  fallbackCategory: "transition" | "motion" | "overlay" | "sfx",
): {
  visualPreset: ProceduralVisualPresetId;
  motionTemplate: MotionGraphicTemplateId;
  sfxPreset: StudioSfxPresetId;
  primaryColor: string;
  accentColor: string;
  title?: string;
  subtitle?: string;
} {
  const q = prompt.toLowerCase();
  let primaryColor = "#3b82f6";
  let accentColor = "#38bdf8";

  if (/zlat|gold|warm|tepl|amber|sun|slun/i.test(q)) {
    primaryColor = "#f59e0b";
    accentColor = "#fbbf24";
  } else if (/červen|red|fire|oheň|burn| flash/i.test(q)) {
    primaryColor = "#ef4444";
    accentColor = "#fb923c";
  } else if (/neon|cyber|fial|purple|pink|růž/i.test(q)) {
    primaryColor = "#a855f7";
    accentColor = "#ec4899";
  } else if (/zelen|green|emerald|matrix|live/i.test(q)) {
    primaryColor = "#10b981";
    accentColor = "#22c55e";
  }

  let visualPreset: ProceduralVisualPresetId =
    fallbackCategory === "overlay" ? "bokeh-shimmer" : "golden-light-leak";
  if (/glitch|rgb|cyber/i.test(q)) visualPreset = "prism-glitch-hit";
  else if (/anamorph|modr|blue|flare|streak/i.test(q)) visualPreset = "anamorphic-streak";
  else if (/burn|flash|kodak|film/i.test(q)) visualPreset = "film-flash-burn";
  else if (/wipe|stěrač|slanted|matte|pruhy/i.test(q)) visualPreset = "shutter-matte-wipe";
  else if (/iris|kruh|circle|portal/i.test(q)) visualPreset = "iris-portal";
  else if (/grain|zrno|35mm|letterbox/i.test(q)) visualPreset = "cinema-grain-dust";
  else if (/hud|rec|kamera|viewfinder/i.test(q)) visualPreset = "rec-viewfinder-hud";
  else if (/bokeh|částic|particle/i.test(q)) visualPreset = "bokeh-shimmer";
  else if (/pozadí|background|mesh|aurora/i.test(q)) visualPreset = "gradient-aurora-bg";

  let motionTemplate: MotionGraphicTemplateId = "lower-third-editorial";
  if (/glass|pill|callout|lokac/i.test(q)) motionTemplate = "glass-callout";
  else if (/ribbon|news|zpráv|banner/i.test(q)) motionTemplate = "split-ribbon";
  else if (/chapter|kapitol|index|01/i.test(q)) motionTemplate = "chapter-card";
  else if (/kinetic|stomp|velk|impact|dynam/i.test(q)) motionTemplate = "kinetic-stomp";
  else if (/hud|tech|frame/i.test(q)) motionTemplate = "neon-hud";
  else if (/progress|bar|timer|krok/i.test(q)) motionTemplate = "progress-pill";

  let sfxPreset: StudioSfxPresetId = "cinema-whoosh";
  if (/boom|sub|drop|impact|bas/i.test(q)) sfxPreset = "sub-impact-boom";
  else if (/riser|gradac|stoup|build/i.test(q)) sfxPreset = "shimmer-riser";
  else if (/shutter|foto|cvak|click/i.test(q)) sfxPreset = "camera-shutter";
  else if (/glitch|stutter/i.test(q)) sfxPreset = "digital-glitch-sfx";
  else if (/pad|ambient|atmos/i.test(q)) sfxPreset = "velvet-ambient";

  const cleanedTitle = prompt.trim().slice(0, 34);
  return {
    visualPreset,
    motionTemplate,
    sfxPreset,
    primaryColor,
    accentColor,
    ...(cleanedTitle ? { title: cleanedTitle, subtitle: "VEDIT STUDIO" } : {}),
  };
}
