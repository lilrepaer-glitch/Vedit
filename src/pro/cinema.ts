// F8: Pro Cinema Pipeline — 3D .cube Film Stock LUTs, 2-Pass Optical Stabilization & PiP / Split-Screen Layouts

import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve as resolvePath } from "node:path";
import type { VeditEngine } from "../core/engine.js";
import { ffmpegPath, probeMedia, run } from "../core/media.js";
import type { Asset, Clip, EffectInstance, ID } from "../core/types.js";

export type BuiltInLutId =
  | "kodak-2383"
  | "teal-orange-blockbuster"
  | "fuji-eterna-soft"
  | "bleach-bypass"
  | "cyberpunk-neon";

export interface LutPresetInfo {
  id: BuiltInLutId;
  label: string;
  description: string;
}

export const BUILTIN_LUTS: LutPresetInfo[] = [
  { id: "kodak-2383", label: "Kodak 2383 Print Film", description: "Rich cinema film S-curve with warm skin tones & deep shadows" },
  { id: "teal-orange-blockbuster", label: "Blockbuster Teal & Orange", description: "Cool cyan shadows paired with warm golden highlights" },
  { id: "fuji-eterna-soft", label: "Fuji Eterna Soft Cinema", description: "Gentle highlight rolloff and pastel documentary palette" },
  { id: "bleach-bypass", label: "Silver Bleach Bypass", description: "Gritty high-contrast desaturated silver retention look" },
  { id: "cyberpunk-neon", label: "Cyberpunk Neon Night", description: "Magenta/cyan split toning for night & sci-fi scenes" },
];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function sCurve(x: number, strength: number): number {
  const centered = x - 0.5;
  return clamp01(0.5 + centered * (1 + strength * (1 - 4 * centered * centered * 0.6)));
}

function transformRgbForLut(id: BuiltInLutId, r: number, g: number, b: number): [number, number, number] {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  switch (id) {
    case "kodak-2383": {
      const cr = sCurve(r * 1.03 + 0.01 * luma, 0.32);
      const cg = sCurve(g * 1.0, 0.30);
      const cb = sCurve(b * 0.96 + (1 - luma) * 0.03, 0.28);
      return [cr, cg, cb];
    }
    case "teal-orange-blockbuster": {
      const shadowWeight = Math.pow(1 - luma, 1.5);
      const hiWeight = Math.pow(luma, 1.3);
      return [
        clamp01(sCurve(r, 0.25) + hiWeight * 0.08 - shadowWeight * 0.05),
        clamp01(sCurve(g, 0.22) + shadowWeight * 0.02 + hiWeight * 0.02),
        clamp01(sCurve(b, 0.22) + shadowWeight * 0.10 - hiWeight * 0.06),
      ];
    }
    case "fuji-eterna-soft": {
      const lift = 0.03;
      const roll = 0.95;
      return [
        clamp01(lift + (luma + (r - luma) * 0.88) * roll),
        clamp01(lift + (luma + (g - luma) * 0.92 + 0.012) * roll),
        clamp01(lift + (luma + (b - luma) * 0.90 + 0.015) * roll),
      ];
    }
    case "bleach-bypass": {
      const desatR = luma + (r - luma) * 0.38;
      const desatG = luma + (g - luma) * 0.38;
      const desatB = luma + (b - luma) * 0.42;
      return [sCurve(desatR, 0.55), sCurve(desatG, 0.55), sCurve(desatB, 0.55)];
    }
    case "cyberpunk-neon": {
      const shadow = 1 - luma;
      return [
        clamp01(sCurve(r, 0.30) + luma * 0.08 + shadow * 0.04),
        clamp01(sCurve(g, 0.25) - luma * 0.04 + shadow * 0.03),
        clamp01(sCurve(b, 0.30) + shadow * 0.12 + luma * 0.05),
      ];
    }
  }
}

/** Writes a standards-compliant 17x17x17 `.cube` 3D LUT file to disk. */
export async function ensureBuiltInCubeLut(lutId: BuiltInLutId, outDir = ".vedit/luts"): Promise<string> {
  const dir = resolvePath(outDir);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${lutId}.cube`);
  const size = 17;
  const lines: string[] = [
    `TITLE "Vedit ${lutId}"`,
    `LUT_3D_SIZE ${size}`,
    "DOMAIN_MIN 0.0 0.0 0.0",
    "DOMAIN_MAX 1.0 1.0 1.0",
  ];
  // Standard .cube ordering: Red fastest, then Green, then Blue
  for (let bi = 0; bi < size; bi++) {
    const b = bi / (size - 1);
    for (let gi = 0; gi < size; gi++) {
      const g = gi / (size - 1);
      for (let ri = 0; ri < size; ri++) {
        const r = ri / (size - 1);
        const [or, og, ob] = transformRgbForLut(lutId, r, g, b);
        lines.push(`${or.toFixed(6)} ${og.toFixed(6)} ${ob.toFixed(6)}`);
      }
    }
  }
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

export async function applyCubeLut(
  engine: VeditEngine,
  clipId: ID,
  opts: { lutId?: BuiltInLutId; filePath?: string; intensity?: number; outDir?: string },
): Promise<{ effect: EffectInstance; cubePath: string }> {
  const cubePath = opts.filePath
    ? resolvePath(opts.filePath)
    : await ensureBuiltInCubeLut(opts.lutId ?? "kodak-2383", opts.outDir ?? ".vedit/luts");
  const { clip } = engine.findClipAnywhere(clipId);
  const params = {
    lutId: opts.lutId ?? basename(cubePath, ".cube"),
    filePath: cubePath,
    intensity: Math.max(0, Math.min(1, opts.intensity ?? 1)),
  };
  const existing = clip.effects.find((e) => e.type === "lut3d");
  const effect = existing
    ? engine.updateEffect(clipId, existing.id, params)
    : engine.addEffect(clipId, "lut3d", params);
  return { effect, cubePath };
}

export interface StabilizeOptions {
  shakiness?: number;
  smoothing?: number;
  outDir?: string;
}

/**
 * Stabilizes shaky footage using real FFmpeg 2-pass VidStab (`vidstabdetect` -> `vidstabtransform`)
 * with automatic fallback to FFmpeg single-pass `deshake` if VidStab is absent.
 */
export async function stabilizeClip(
  engine: VeditEngine,
  clipId: ID,
  opts: StabilizeOptions = {},
): Promise<{ clip: Clip; stabilizedAsset: Asset; outPath: string; method: "vidstab-2pass" | "deshake" }> {
  const { clip } = engine.findClipAnywhere(clipId);
  const srcAsset = engine.findAsset(clip.assetId);
  const outDir = resolvePath(opts.outDir ?? ".vedit/stabilized");
  await mkdir(outDir, { recursive: true });
  const stem = basename(srcAsset.path, extname(srcAsset.path));
  const stamp = Date.now();
  const trfPath = join(outDir, `${stem}-${stamp}.trf`).replace(/\\/g, "/").replace(/:/g, "\\:");
  const outPath = join(outDir, `${stem}-stabilized-${stamp}.mp4`);

  const shakiness = Math.max(1, Math.min(10, Math.round(opts.shakiness ?? 5)));
  const smoothing = Math.max(1, Math.min(60, Math.round(opts.smoothing ?? 12)));

  let method: "vidstab-2pass" | "deshake" = "vidstab-2pass";
  const pass1 = await run(ffmpegPath(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    srcAsset.path,
    "-vf",
    `vidstabdetect=shakiness=${shakiness}:accuracy=9:result='${trfPath}'`,
    "-f",
    "null",
    "-",
  ]);

  let encodeRes = pass1;
  if (pass1.code === 0) {
    encodeRes = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      srcAsset.path,
      "-vf",
      `vidstabtransform=smoothing=${smoothing}:input='${trfPath}':interpol=bilinear`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "19",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      outPath,
    ]);
  }

  if (encodeRes.code !== 0) {
    method = "deshake";
    encodeRes = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      srcAsset.path,
      "-vf",
      "deshake",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "19",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      outPath,
    ]);
  }
  if (encodeRes.code !== 0) {
    throw new Error(`Video stabilization failed: ${encodeRes.stderr.trim()}`);
  }

  const info = await probeMedia(outPath);
  const stabilizedAsset = engine.transaction(`clip.stabilize "${clip.name}"`, () => {
    const added = engine.addAsset({
      name: `${stem} (Stabilized).mp4`,
      kind: "video",
      path: outPath,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      sizeBytes: info.sizeBytes,
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec,
      hasAudio: info.hasAudio,
      tags: [...(srcAsset.tags ?? []), "stabilized"],
    });
    clip.assetId = added.id;
    return added;
  });

  return { clip, stabilizedAsset, outPath, method };
}

export type LayoutPresetId =
  | "pip-bottom-right"
  | "pip-bottom-left"
  | "pip-top-right"
  | "pip-top-left"
  | "split-left"
  | "split-right"
  | "full-reset";

/** Applies Picture-in-Picture (PiP) or Split-Screen multi-track layout geometry to a clip. */
export function applyLayoutPreset(engine: VeditEngine, clipId: ID, layout: LayoutPresetId): Clip {
  const seq = engine.activeSequence();
  const w = seq.width;
  const h = seq.height;
  const pipScale = 0.32;
  const padX = Math.round(w * 0.30);
  const padY = Math.round(h * 0.30);

  const map: Record<LayoutPresetId, { x: number; y: number; scaleX: number; scaleY: number }> = {
    "pip-bottom-right": { x: padX, y: padY, scaleX: pipScale, scaleY: pipScale },
    "pip-bottom-left": { x: -padX, y: padY, scaleX: pipScale, scaleY: pipScale },
    "pip-top-right": { x: padX, y: -padY, scaleX: pipScale, scaleY: pipScale },
    "pip-top-left": { x: -padX, y: -padY, scaleX: pipScale, scaleY: pipScale },
    "split-left": { x: -Math.round(w / 4), y: 0, scaleX: 0.5, scaleY: 0.5 },
    "split-right": { x: Math.round(w / 4), y: 0, scaleX: 0.5, scaleY: 0.5 },
    "full-reset": { x: 0, y: 0, scaleX: 1, scaleY: 1 },
  };
  const target = map[layout];
  const { clip } = engine.findClipAnywhere(clipId);
  return engine.updateClip(clipId, {
    transform: {
      ...clip.transform,
      ...target,
    },
  });
}

/**
 * F9: Reverses video (and audio when present) on a clip via FFmpeg `reverse` + `areverse`,
 * registers the reversed asset with `#reversed`, and links it to the clip.
 */
export async function reverseClip(
  engine: VeditEngine,
  clipId: ID,
  opts: { outDir?: string } = {},
): Promise<{ clip: Clip; reversedAsset: Asset; outPath: string }> {
  const { clip } = engine.findClipAnywhere(clipId);
  const srcAsset = engine.findAsset(clip.assetId);
  const dir = resolvePath(opts.outDir ?? join(process.cwd(), ".vedit-data", "reversed"));
  await mkdir(dir, { recursive: true });

  const base = basename(srcAsset.path, extname(srcAsset.path));
  const outPath = join(dir, `${base}-rev-${clip.id.slice(0, 6)}.mp4`);

  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", srcAsset.path, "-vf", "reverse"];
  if (srcAsset.hasAudio || srcAsset.kind === "audio") {
    args.push("-af", "areverse", "-c:a", "aac", "-b:a", "160k");
  } else {
    args.push("-an");
  }
  args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", outPath);

  const res = await run(ffmpegPath(), args);
  if (res.code !== 0) {
    throw new Error(`Reverse clip failed: ${res.stderr}`);
  }

  const info = await probeMedia(outPath);
  const reversedAsset = engine.addAsset({
    name: `${srcAsset.name} (Reversed)`,
    kind: srcAsset.kind,
    path: outPath,
    duration: info.duration ?? srcAsset.duration,
    width: info.width ?? srcAsset.width,
    height: info.height ?? srcAsset.height,
    fps: info.fps ?? srcAsset.fps,
    hasAudio: info.hasAudio,
    tags: Array.from(new Set([...(srcAsset.tags ?? []), "reversed"])),
  });

  const updated = engine.updateClip(clipId, { assetId: reversedAsset.id });
  return { clip: updated, reversedAsset, outPath };
}

/**
 * F9: Captures a sharp full-resolution PNG still frame from `clipId` at timeline time `at`,
 * splits the clip if needed, ripples later clips forward, and inserts a `holdDuration` freeze-frame clip.
 */
export async function freezeFrameClip(
  engine: VeditEngine,
  clipId: ID,
  opts: { at?: number; holdDuration?: number; outDir?: string } = {},
): Promise<{ freezeClip: Clip; stillAsset: Asset; outPath: string }> {
  const { track, clip } = engine.findClipAnywhere(clipId);
  const srcAsset = engine.findAsset(clip.assetId);
  const holdDuration = Math.max(0.2, Math.min(30, Number(opts.holdDuration ?? 1.5)));
  const relOffset = opts.at != null
    ? Math.max(0, Math.min(clip.duration, opts.at - clip.start))
    : clip.duration / 2;
  const sourceTime = Math.max(0, clip.in + relOffset);

  const dir = resolvePath(opts.outDir ?? join(process.cwd(), ".vedit-data", "freezes"));
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, `freeze-${clip.id.slice(0, 6)}-${Math.round(sourceTime * 1000)}ms.png`);

  const res = await run(ffmpegPath(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    sourceTime.toFixed(3),
    "-i",
    srcAsset.path,
    "-frames:v",
    "1",
    outPath,
  ]);
  if (res.code !== 0) {
    throw new Error(`Freeze frame extraction failed: ${res.stderr}`);
  }

  const stillAsset = engine.addAsset({
    name: `Freeze @ ${sourceTime.toFixed(2)}s (${srcAsset.name})`,
    kind: "image",
    path: outPath,
    width: srcAsset.width,
    height: srcAsset.height,
    tags: ["freeze-frame"],
  });

  const insertAt = Number((clip.start + relOffset).toFixed(4));
  // Split target clip cleanly if freeze occurs strictly inside clip body
  if (relOffset > 0.05 && relOffset < clip.duration - 0.05) {
    engine.splitClip(clip.id, insertAt, track.id);
  }

  // Shift all clips on `track` starting at or after `insertAt - 1e-4` forward by `holdDuration`
  const currentTrack = engine.findTrack(track.id);
  const downstream = [...currentTrack.clips]
    .filter((c) => c.start >= insertAt - 1e-3)
    .sort((a, b) => b.start - a.start);
  for (const c of downstream) {
    engine.moveClip(c.id, Number((c.start + holdDuration).toFixed(4)), track.id, track.id);
  }

  const freezeClip = engine.addClip({
    trackId: track.id,
    assetId: stillAsset.id,
    start: insertAt,
    duration: holdDuration,
    in: 0,
    out: holdDuration,
    name: `❄ Freeze (${holdDuration.toFixed(1)}s)`,
  });

  return { freezeClip, stillAsset, outPath };
}
