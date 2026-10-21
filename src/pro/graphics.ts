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
