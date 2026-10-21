// F9: Broadcast Video Scopes — Real-Time RGB Parade/Histogram, IRE Waveform & Legal-Range QC

import { existsSync } from "node:fs";
import type { VeditEngine } from "../core/engine.js";
import { ffmpegPath, run } from "../core/media.js";
import type { Asset, Clip } from "../core/types.js";

export interface WaveformColumn {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

export interface BroadcastScopesResult {
  time: number;
  sourceClipId: string | null;
  sourceAssetName: string | null;
  sampleWidth: number;
  sampleHeight: number;
  histogramBins: number;
  lumaHistogram: number[];
  redHistogram: number[];
  greenHistogram: number[];
  blueHistogram: number[];
  waveform: WaveformColumn[];
  metrics: {
    avgLumaIre: number;
    minLumaIre: number;
    maxLumaIre: number;
    blackClippingPct: number;
    whiteClippingPct: number;
    rAvg: number;
    gAvg: number;
    bAvg: number;
    saturationAvg: number;
  };
  status: "broadcast-legal" | "highlight-clipping" | "shadow-crushed" | "both-clipped";
  warnings: string[];
}

function findActiveVisualAtTime(engine: VeditEngine, time: number): { clip: Clip; asset: Asset } | null {
  const seq = engine.activeSequence();
  const hasSolo = seq.tracks.some((t) => t.kind !== "audio" && t.solo);
  // Topmost visible active track wins if stacked, so inspect in reverse order if top-down or last overlay wins:
  // In Vedit's renderer (`src/render/export.ts`), later tracks overlay on top of earlier tracks!
  for (let ti = seq.tracks.length - 1; ti >= 0; ti--) {
    const track = seq.tracks[ti]!;
    if (track.kind === "audio" || track.muted) continue;
    if (hasSolo && !track.solo) continue;
    for (const clip of track.clips) {
      if (time >= clip.start && time < clip.start + clip.duration) {
        const asset = engine.project.assets.find((a) => a.id === clip.assetId);
        if (asset && existsSync(asset.path)) {
          return { clip, asset };
        }
      }
    }
  }
  return null;
}

/**
 * Decodes a real 160×90 RGB24 sample frame at `time` and computes broadcast histograms,
 * 48-column IRE luma waveform, RGB balance, and clipping diagnostics.
 */
export async function analyzeFrameScopes(
  engine: VeditEngine,
  opts: { time?: number; assetPath?: string } = {},
): Promise<BroadcastScopesResult> {
  const time = Math.max(0, Number(opts.time ?? 0));
  const w = 160;
  const h = 90;
  const bins = 64;
  const waveCols = 48;

  let rawRgb: Buffer | null = null;
  let sourceClipId: string | null = null;
  let sourceAssetName: string | null = null;

  if (opts.assetPath && existsSync(opts.assetPath)) {
    sourceAssetName = opts.assetPath.split(/[\\/]/).pop() ?? opts.assetPath;
    const res = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      time.toFixed(3),
      "-i",
      opts.assetPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${w}:${h}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    if (res.code === 0 && res.stdout.length >= w * h * 3) {
      rawRgb = res.stdout;
    }
  } else {
    const active = findActiveVisualAtTime(engine, time);
    if (active) {
      sourceClipId = active.clip.id;
      sourceAssetName = active.asset.name;
      const effSpeed = active.clip.effects.find((e) => e.type === "speed");
      const speed = Math.max(0.1, Math.min(8, Number(effSpeed?.params?.rate ?? effSpeed?.params?.speed ?? 1)));
      const localSeek = active.clip.in + (time - active.clip.start) * speed;
      const args: string[] = ["-hide_banner", "-loglevel", "error"];
      if (active.asset.kind !== "image") {
        args.push("-ss", Math.max(0, localSeek).toFixed(3));
      }
      args.push(
        "-i",
        active.asset.path,
        "-frames:v",
        "1",
        "-vf",
        `scale=${w}:${h}`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      );
      const res = await run(ffmpegPath(), args);
      if (res.code === 0 && res.stdout.length >= w * h * 3) {
        rawRgb = res.stdout;
      }
    }
  }

  if (!rawRgb) {
    rawRgb = Buffer.alloc(w * h * 3, 0);
  }

  const lumaRaw = new Uint32Array(bins);
  const redRaw = new Uint32Array(bins);
  const greenRaw = new Uint32Array(bins);
  const blueRaw = new Uint32Array(bins);
  const colSamples: number[][] = Array.from({ length: waveCols }, () => []);

  const totalPixels = w * h;
  let sumY = 0;
  let minY = 255;
  let maxY = 0;
  let blackClipCount = 0;
  let whiteClipCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSat = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = (py * w + px) * 3;
      const r = rawRgb[idx]!;
      const g = rawRgb[idx + 1]!;
      const b = rawRgb[idx + 2]!;
      // ITU-R BT.709 luma
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      sumR += r;
      sumG += g;
      sumB += b;
      sumY += y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (y < 5) blackClipCount++;
      if (y > 250) whiteClipCount++;

      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      sumSat += maxC === 0 ? 0 : (maxC - minC) / maxC;

      lumaRaw[Math.min(bins - 1, Math.floor((y / 256) * bins))]!++;
      redRaw[Math.min(bins - 1, Math.floor((r / 256) * bins))]!++;
      greenRaw[Math.min(bins - 1, Math.floor((g / 256) * bins))]!++;
      blueRaw[Math.min(bins - 1, Math.floor((b / 256) * bins))]!++;

      const colIdx = Math.min(waveCols - 1, Math.floor((px / w) * waveCols));
      colSamples[colIdx]!.push(Number(((y / 255) * 100).toFixed(2)));
    }
  }

  const normalizeHist = (arr: Uint32Array): number[] => {
    let peak = 1;
    for (let i = 0; i < arr.length; i++) if (arr[i]! > peak) peak = arr[i]!;
    return Array.from(arr, (v) => Number((v / peak).toFixed(4)));
  };

  const waveform: WaveformColumn[] = colSamples.map((samples) => {
    if (samples.length === 0) return { min: 0, p25: 0, median: 0, p75: 0, max: 0 };
    samples.sort((a, b) => a - b);
    const pick = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * (samples.length - 1)))]!;
    return {
      min: pick(0),
      p25: pick(0.25),
      median: pick(0.5),
      p75: pick(0.75),
      max: pick(1),
    };
  });

  const avgLumaIre = Number((((sumY / totalPixels) / 255) * 100).toFixed(2));
  const minLumaIre = Number(((minY / 255) * 100).toFixed(2));
  const maxLumaIre = Number(((maxY / 255) * 100).toFixed(2));
  const blackClippingPct = Number(((blackClipCount / totalPixels) * 100).toFixed(2));
  const whiteClippingPct = Number(((whiteClipCount / totalPixels) * 100).toFixed(2));

  const shadowsCrushed = blackClippingPct > 8 && sourceClipId !== null;
  const highlightsClipped = whiteClippingPct > 3;

  const warnings: string[] = [];
  if (highlightsClipped) warnings.push(`Highlight clipping detected (${whiteClippingPct}% > 98 IRE)`);
  if (shadowsCrushed) warnings.push(`Crushed blacks detected (${blackClippingPct}% < 2 IRE)`);
  if (sourceClipId === null && !opts.assetPath) warnings.push("No active video clip under playhead — showing black reference");

  const status: BroadcastScopesResult["status"] =
    highlightsClipped && shadowsCrushed
      ? "both-clipped"
      : highlightsClipped
        ? "highlight-clipping"
        : shadowsCrushed
          ? "shadow-crushed"
          : "broadcast-legal";

  return {
    time,
    sourceClipId,
    sourceAssetName,
    sampleWidth: w,
    sampleHeight: h,
    histogramBins: bins,
    lumaHistogram: normalizeHist(lumaRaw),
    redHistogram: normalizeHist(redRaw),
    greenHistogram: normalizeHist(greenRaw),
    blueHistogram: normalizeHist(blueRaw),
    waveform,
    metrics: {
      avgLumaIre,
      minLumaIre,
      maxLumaIre,
      blackClippingPct,
      whiteClippingPct,
      rAvg: Number((sumR / totalPixels).toFixed(1)),
      gAvg: Number((sumG / totalPixels).toFixed(1)),
      bAvg: Number((sumB / totalPixels).toFixed(1)),
      saturationAvg: Number(((sumSat / totalPixels) * 100).toFixed(1)),
    },
    status,
    warnings,
  };
}
