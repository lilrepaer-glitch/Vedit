// F7: Pure 32-bit RGBA Vector Shapes, Callouts & SVG Overlay Layer Generator (PLAN.md §3.3)
// Generates crisp transparent PNG assets with zero external native image libraries and places them on Graphics tracks.

import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { VeditEngine } from "../core/engine.js";
import type { Asset, Clip } from "../core/types.js";

export type VectorGraphicPreset =
  | "lower-third-card"
  | "callout-arrow"
  | "spotlight-ring"
  | "pill-badge"
  | "progress-ribbon"
  | "custom-svg";

export interface AddGraphicOverlayOptions {
  kind: VectorGraphicPreset;
  width?: number;
  height?: number;
  primaryColor?: string;
  accentColor?: string;
  /** Raw `<svg>...</svg>` string when `kind === "custom-svg"` */
  svgMarkup?: string;
  start?: number;
  duration?: number;
  x?: number;
  y?: number;
  animationPreset?: string;
  label?: string;
  outDir?: string;
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(hexOrName: string | undefined, fallback: RGBA): RGBA {
  if (!hexOrName) return fallback;
  const s = hexOrName.trim();
  const named: Record<string, string> = {
    white: "#ffffff",
    black: "#000000",
    red: "#ef4444",
    green: "#22c55e",
    blue: "#3b82f6",
    yellow: "#eab308",
    cyan: "#06b6d4",
    purple: "#a855f7",
    orange: "#f97316",
    none: "#00000000",
    transparent: "#00000000",
  };
  const h = (named[s.toLowerCase()] ?? s).replace(/^#/, "");
  if (h.length === 6) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 255,
    };
  }
  if (h.length === 8) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16),
    };
  }
  return fallback;
}

class RgbaCanvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  blendPixel(x: number, y: number, c: RGBA, cov = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || cov <= 0 || c.a <= 0) return;
    const sa = (c.a / 255) * Math.min(1, cov);
    const i = (y * this.width + x) * 4;
    const da = this.data[i + 3]! / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 1e-6) return;
    this.data[i] = Math.round((c.r * sa + this.data[i]! * da * (1 - sa)) / outA);
    this.data[i + 1] = Math.round((c.g * sa + this.data[i + 1]! * da * (1 - sa)) / outA);
    this.data[i + 2] = Math.round((c.b * sa + this.data[i + 2]! * da * (1 - sa)) / outA);
    this.data[i + 3] = Math.round(outA * 255);
  }

  fillRoundedRect(rx: number, ry: number, rw: number, rh: number, radius: number, color: RGBA): void {
    const r = Math.max(0, Math.min(radius, rw / 2, rh / 2));
    const x0 = Math.max(0, Math.floor(rx - 1));
    const y0 = Math.max(0, Math.floor(ry - 1));
    const x1 = Math.min(this.width - 1, Math.ceil(rx + rw + 1));
    const y1 = Math.min(this.height - 1, Math.ceil(ry + rh + 1));
    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    const hx = rw / 2 - r;
    const hy = rh / 2 - r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = Math.max(Math.abs(x + 0.5 - cx) - hx, 0);
        const dy = Math.max(Math.abs(y + 0.5 - cy) - hy, 0);
        const dist = Math.hypot(dx, dy) - r;
        if (dist < 0.75) {
          this.blendPixel(x, y, color, Math.min(1, 0.75 - dist));
        }
      }
    }
  }

  strokeCircle(cx: number, cy: number, radius: number, thickness: number, color: RGBA): void {
    const outer = radius + thickness / 2;
    const inner = Math.max(0, radius - thickness / 2);
    const x0 = Math.max(0, Math.floor(cx - outer - 2));
    const y0 = Math.max(0, Math.floor(cy - outer - 2));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + outer + 2));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + outer + 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const covOuter = Math.min(1, Math.max(0, outer + 0.5 - d));
        const covInner = Math.min(1, Math.max(0, d - (inner - 0.5)));
        this.blendPixel(x, y, color, Math.min(covOuter, covInner));
      }
    }
  }

  fillCircle(cx: number, cy: number, radius: number, color: RGBA): void {
    const x0 = Math.max(0, Math.floor(cx - radius - 2));
    const y0 = Math.max(0, Math.floor(cy - radius - 2));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius + 2));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius + 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d < radius + 0.6) {
          this.blendPixel(x, y, color, Math.min(1, radius + 0.6 - d));
        }
      }
    }
  }

  drawThickLine(x0: number, y0: number, x1: number, y1: number, width: number, color: RGBA): void {
    const half = width / 2;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 2));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(x0, x1) + half + 2));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 2));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(y0, y1) + half + 2));
    const vx = x1 - x0;
    const vy = y1 - y0;
    const lenSq = vx * vx + vy * vy || 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5 - x0;
        const py = y + 0.5 - y0;
        const t = Math.max(0, Math.min(1, (px * vx + py * vy) / lenSq));
        const d = Math.hypot(px - t * vx, py - t * vy);
        if (d < half + 0.6) {
          this.blendPixel(x, y, color, Math.min(1, half + 0.6 - d));
        }
      }
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encodes raw RGBA pixels into a standards-compliant 32-bit transparent PNG buffer. */
export function encodeRgbaPng(canvas: RgbaCanvas): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.width, 0);
  ihdr.writeUInt32BE(canvas.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = canvas.width * 4;
  const raw = Buffer.alloc((stride + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0; // filter None
    raw.set(canvas.data.subarray(y * stride, (y + 1) * stride), rowOffset + 1);
  }
  const compressed = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderSvgPrimitives(canvas: RgbaCanvas, svg: string): void {
  const attr = (tag: string, name: string): string | undefined => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag);
    return m?.[1];
  };
  for (const m of svg.matchAll(/<(rect|circle|line)\b[^>]*>/gi)) {
    const tag = m[0];
    const kind = m[1]!.toLowerCase();
    const fill = parseColor(attr(tag, "fill"), { r: 59, g: 130, b: 246, a: 235 });
    const stroke = parseColor(attr(tag, "stroke"), { r: 255, g: 255, b: 255, a: 255 });
    const sw = Number(attr(tag, "stroke-width") ?? 4);
    if (kind === "rect") {
      canvas.fillRoundedRect(
        Number(attr(tag, "x") ?? 0),
        Number(attr(tag, "y") ?? 0),
        Number(attr(tag, "width") ?? 120),
        Number(attr(tag, "height") ?? 60),
        Number(attr(tag, "rx") ?? 0),
        fill,
      );
    } else if (kind === "circle") {
      const cx = Number(attr(tag, "cx") ?? canvas.width / 2);
      const cy = Number(attr(tag, "cy") ?? canvas.height / 2);
      const r = Number(attr(tag, "r") ?? 40);
      if (attr(tag, "fill") !== "none") canvas.fillCircle(cx, cy, r, fill);
      if (attr(tag, "stroke")) canvas.strokeCircle(cx, cy, r, sw, stroke);
    } else if (kind === "line") {
      canvas.drawThickLine(
        Number(attr(tag, "x1") ?? 0),
        Number(attr(tag, "y1") ?? 0),
        Number(attr(tag, "x2") ?? 100),
        Number(attr(tag, "y2") ?? 100),
        sw,
        stroke,
      );
    }
  }
}

export async function addGraphicOverlay(
  engine: VeditEngine,
  opts: AddGraphicOverlayOptions,
): Promise<{ asset: Asset; clip: Clip; outPath: string }> {
  const width = opts.width ?? (opts.kind === "spotlight-ring" ? 260 : 520);
  const height = opts.height ?? (opts.kind === "spotlight-ring" ? 260 : 120);
  const primary = parseColor(opts.primaryColor, { r: 17, g: 24, b: 39, a: 228 });
  const accent = parseColor(opts.accentColor, { r: 59, g: 130, b: 246, a: 255 });

  const canvas = new RgbaCanvas(width, height);
  switch (opts.kind) {
    case "lower-third-card":
      canvas.fillRoundedRect(12, 16, width - 24, height - 32, 14, primary);
      canvas.fillRoundedRect(12, 16, 10, height - 32, 5, accent);
      break;
    case "pill-badge":
      canvas.fillRoundedRect(12, 20, width - 24, height - 40, (height - 40) / 2, accent);
      break;
    case "spotlight-ring":
      canvas.strokeCircle(width / 2, height / 2, Math.min(width, height) * 0.4, 10, accent);
      break;
    case "callout-arrow":
      canvas.drawThickLine(28, height - 28, width - 36, 28, 10, accent);
      canvas.drawThickLine(width - 36, 28, width - 86, 30, 10, accent);
      canvas.drawThickLine(width - 36, 28, width - 40, 78, 10, accent);
      break;
    case "progress-ribbon":
      canvas.fillRoundedRect(8, height / 2 - 8, width - 16, 16, 8, primary);
      canvas.fillRoundedRect(8, height / 2 - 8, (width - 16) * 0.72, 16, 8, accent);
      break;
    case "custom-svg":
      renderSvgPrimitives(
        canvas,
        opts.svgMarkup ?? `<svg><rect x="16" y="16" width="${width - 32}" height="${height - 32}" rx="16" fill="#2563eb"/></svg>`,
      );
      break;
  }

  const outDir = resolvePath(opts.outDir ?? ".vedit/graphics");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `graphic-${opts.kind}-${Date.now()}.png`);
  await writeFile(outPath, encodeRgbaPng(canvas));

  const start = opts.start ?? 0;
  const duration = opts.duration ?? 3;

  return engine.transaction(`graphics.add "${opts.kind}"`, () => {
    const asset = engine.addAsset({
      name: opts.label ?? `${opts.kind}.png`,
      kind: "image",
      path: outPath,
      width,
      height,
      duration,
      hasAudio: false,
    });
    const seq = engine.activeSequence();
    const gTrack =
      seq.tracks.find((t) => t.kind === "graphics" && !t.locked) ??
      engine.addTrack("graphics", "Graphics");
    const clip = engine.addClip({
      trackId: gTrack.id,
      assetId: asset.id,
      name: opts.label ?? opts.kind,
      start,
      duration,
      in: 0,
      out: duration,
    });
    if (opts.x != null || opts.y != null) {
      engine.updateClip(clip.id, {
        transform: {
          ...clip.transform,
          x: opts.x ?? (opts.kind === "lower-third-card" ? -280 : 0),
          y: opts.y ?? (opts.kind === "lower-third-card" ? 260 : 0),
        },
      });
    } else if (opts.kind === "lower-third-card") {
      engine.updateClip(clip.id, {
        transform: { ...clip.transform, x: -240, y: 240 },
      });
    }
    if (opts.animationPreset) {
      engine.applyAnimationPreset(clip.id, opts.animationPreset);
    }
    if (opts.label) {
      engine.addCaption({ text: opts.label, start, end: start + duration });
    }
    return { asset, clip, outPath };
  });
}

export interface ServerStudioAssetRequest {
  category: "transition" | "motion" | "overlay" | "sfx";
  presetId?: string;
  title?: string;
  subtitle?: string;
  primaryColor?: string;
  accentColor?: string;
  duration?: number;
  intensity?: number;
  prompt?: string;
  atTime?: number;
  outDir: string;
}

function synthesizeNodeStereoWav(preset: string, durationSec: number, seed: number): Buffer {
  const sampleRate = 44100;
  const numChannels = 2;
  const dur = Math.max(0.25, Math.min(8, durationSec));
  const frames = Math.floor(sampleRate * dur);
  const dataBytes = frames * numChannels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * 2, 28);
  buf.writeUInt16LE(numChannels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  let low = 0;
  let band = 0;
  let phase1 = 0;
  let phase2 = 0;
  let rng = (Math.floor(seed * 977) + 12345) >>> 0;
  const nextWhite = () => {
    rng = (1664525 * rng + 1013904223) >>> 0;
    return rng / 2147483648 - 1;
  };

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const p = i / Math.max(1, frames - 1);
    let l = 0;
    let r = 0;
    if (preset === "sub-impact-boom") {
      const env = Math.exp(-3.4 * p) * Math.min(1, t / 0.006);
      phase1 += (2 * Math.PI * (34 + 92 * Math.exp(-16 * p))) / sampleRate;
      const sig = Math.sin(phase1) * env * 0.88 + nextWhite() * Math.exp(-42 * p) * 0.4;
      l = sig;
      r = sig * 0.98;
    } else if (preset === "shimmer-riser") {
      const env = Math.pow(p, 2.0) * (p > 0.96 ? (1 - p) / 0.04 : 1);
      const sw = 1 + 1.35 * p * p;
      phase1 += (2 * Math.PI * 196 * sw) / sampleRate;
      phase2 += (2 * Math.PI * 293.66 * sw) / sampleRate;
      const white = nextWhite();
      const f = 2 * Math.sin((Math.PI * (300 + 4000 * p * p)) / sampleRate);
      low += f * band;
      band += f * (white - low - 0.35 * band);
      l = (Math.sin(phase1) * 0.35 + Math.sin(phase2) * 0.28) * env + band * env * 0.4;
      r = l * 0.96;
    } else if (preset === "camera-shutter") {
      const dt = Math.max(0, t - 0.075);
      const sig = Math.exp(-95 * t) * nextWhite() * 0.9 + (t >= 0.075 ? Math.exp(-85 * dt) * nextWhite() * 0.7 : 0);
      l = sig;
      r = sig * 0.94;
    } else if (preset === "velvet-ambient") {
      const env = Math.min(1, t / 0.35) * Math.min(1, (dur - t) / 0.45) * 0.55;
      phase1 += (2 * Math.PI * 130.81) / sampleRate;
      phase2 += (2 * Math.PI * 196.0) / sampleRate;
      const sig = (Math.sin(phase1) * 0.45 + Math.sin(phase2) * 0.35) * env;
      l = sig;
      r = sig;
    } else {
      // Aerodynamic transition whoosh (L -> R stereo sweep)
      const env = Math.pow(Math.sin(p * Math.PI), 1.45);
      const f = 2 * Math.sin((Math.PI * Math.min(8000, 220 + 2600 * env)) / sampleRate);
      const white = nextWhite();
      low += f * band;
      band += f * (white - low - 0.42 * band);
      phase1 += (2 * Math.PI * (58 + 75 * env)) / sampleRate;
      const sig = band * env * 1.35 + Math.sin(phase1) * env * 0.35;
      l = sig * Math.cos(p * Math.PI * 0.5);
      r = sig * Math.sin(p * Math.PI * 0.5);
    }
    const clampSample = (x: number) => Math.round(Math.max(-1, Math.min(1, Math.tanh(x * 1.15))) * 32760);
    buf.writeInt16LE(clampSample(l), offset);
    buf.writeInt16LE(clampSample(r), offset + 2);
    offset += 4;
  }
  return buf;
}

export async function generateServerStudioAsset(
  engine: VeditEngine,
  req: ServerStudioAssetRequest,
) {
  await mkdir(req.outDir, { recursive: true });
  const seed = Math.floor(1 + Math.random() * 999);
  const at = Math.max(0, Number(req.atTime ?? 0));
  const c1 = req.primaryColor || "#f59e0b";
  const c2 = req.accentColor || "#3b82f6";

  if (req.category === "motion") {
    const tpl = req.presetId || "lower-third-editorial";
    const dur = Math.max(0.6, Number(req.duration ?? 3.4));
    const title = (req.title || req.prompt || "Studio Motion Title").trim();
    const subtitle = (req.subtitle ?? "VEDIT STUDIO").trim();
    const caption = engine.addCaption({
      text: title,
      start: Number(at.toFixed(3)),
      end: Number((at + dur).toFixed(3)),
      style: {
        motionTemplate: tpl,
        subtitle,
        color: req.primaryColor || "#ffffff",
        accentColor: c2,
        x: tpl === "lower-third-editorial" || tpl === "split-ribbon" ? 0.3 : 0.5,
        y: tpl === "glass-callout" || tpl === "neon-hud" ? 0.18 : tpl === "chapter-card" || tpl === "kinetic-stomp" ? 0.5 : 0.82,
        fontSize: tpl === "kinetic-stomp" ? 64 : tpl === "chapter-card" ? 58 : 46,
        bold: true,
      },
    });
    return {
      summary: `Generated Motion Graphic "${title}" (${tpl})`,
      caption,
    };
  }

  if (req.category === "sfx") {
    const preset = req.presetId || "cinema-whoosh";
    const dur = Math.max(0.3, Number(req.duration ?? 1.0));
    const wavPath = resolvePath(join(req.outDir, `sfx-${preset}-${Date.now()}.wav`));
    await writeFile(wavPath, synthesizeNodeStereoWav(preset, dur, seed));
    const startAt = preset.includes("whoosh") || preset.includes("shutter")
      ? Number(Math.max(0, at - dur * 0.45).toFixed(3))
      : Number(at.toFixed(3));
    return engine.transaction(`studio.sfx "${preset}"`, () => {
      const asset = engine.addAsset({
        name: `${preset} #${seed}.wav`,
        kind: "audio",
        path: wavPath,
        duration: dur,
        hasAudio: true,
      });
      const seq = engine.activeSequence();
      const aTrack =
        seq.tracks.find((t) => t.kind === "audio" && !t.locked) ??
        engine.addTrack("audio", "Sound FX");
      const clip = engine.addClip({
        trackId: aTrack.id,
        assetId: asset.id,
        name: req.title || preset,
        start: startAt,
        duration: dur,
        in: 0,
        out: dur,
      });
      return {
        summary: `Generated Sound FX "${clip.name}" (${dur.toFixed(2)}s)`,
        asset,
        clip,
      };
    });
  }

  // Visual Transition or Overlay Asset: real 32-bit RGBA PNG + full-res 60fps `procedural-fx` metadata!
  const preset = req.presetId || (req.category === "transition" ? "golden-light-leak" : "bokeh-shimmer");
  const dur = Math.max(0.3, Number(req.duration ?? (req.category === "transition" ? 0.9 : 4.0)));
  const w = 640;
  const h = 360;
  const canvas = new RgbaCanvas(w, h);
  const colA = parseColor(c1, { r: 245, g: 158, b: 11, a: 225 });
  const colB = parseColor(c2, { r: 59, g: 130, b: 246, a: 225 });
  // Render smooth optical radial glow & accent band into transparent 32-bit PNG so FFmpeg server export has real alpha too!
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - w * 0.5) / (w * 0.52);
      const dy = (y - h * 0.5) / (h * 0.52);
      const radial = Math.max(0, 1 - Math.hypot(dx, dy));
      if (radial > 0.01) {
        const mix = x / w;
        canvas.blendPixel(x, y, {
          r: Math.round(colA.r * (1 - mix) + colB.r * mix),
          g: Math.round(colA.g * (1 - mix) + colB.g * mix),
          b: Math.round(colA.b * (1 - mix) + colB.b * mix),
          a: Math.round(235 * Math.pow(radial, 1.3)),
        });
      }
    }
  }
  const pngPath = resolvePath(join(req.outDir, `fx-${preset}-${Date.now()}.png`));
  await writeFile(pngPath, encodeRgbaPng(canvas));

  const startAt =
    req.category === "transition" ? Number(Math.max(0, at - dur / 2).toFixed(3)) : Number(at.toFixed(3));
  const blendMode = preset.includes("wipe") || preset.includes("grain") || preset.includes("hud") ? "normal" : "screen";

  return engine.transaction(`studio.${req.category} "${preset}"`, () => {
    const asset = engine.addAsset({
      name: `${req.title || preset} #${seed}`,
      kind: "image",
      path: pngPath,
      width: w,
      height: h,
      duration: dur,
      hasAudio: false,
    });
    const seq = engine.activeSequence();
    const gTrack =
      seq.tracks.find((t) => t.kind === "graphics" && !t.locked) ??
      engine.addTrack("graphics", "FX & Transitions");
    const clip = engine.addClip({
      trackId: gTrack.id,
      assetId: asset.id,
      name: req.title || preset,
      start: startAt,
      duration: dur,
      in: 0,
      out: dur,
    });
    engine.addEffect(clip.id, "procedural-fx", {
      preset,
      primaryColor: c1,
      accentColor: c2,
      intensity: Number(req.intensity ?? 92),
      seed,
    });
    if (blendMode !== "normal") {
      engine.addEffect(clip.id, "blend", { mode: blendMode });
    }
    if (req.category === "transition") {
      engine.addKeyframes(clip.id, [
        { time: 0, property: "opacity", value: 0, easing: "ease-out" },
        { time: Number((dur * 0.5).toFixed(3)), property: "opacity", value: 1, easing: "ease-in-out" },
        { time: dur, property: "opacity", value: 0, easing: "ease-in" },
      ]);
    }
    return {
      summary: `Generated ${req.category === "transition" ? "Transition" : "Overlay"} "${clip.name}"`,
      asset,
      clip,
    };
  });
}
