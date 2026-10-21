// F9: Multicam Studio — Acoustic Cross-Correlation Audio Sync & Live Multi-Angle Switcher

import { existsSync } from "node:fs";
import type { VeditEngine } from "../core/engine.js";
import { ffmpegPath, run } from "../core/media.js";
import type { Asset, Clip, ID, Track } from "../core/types.js";

export interface MulticamAngleSync {
  assetId: ID;
  assetName: string;
  trackId: ID;
  clipId: ID;
  offsetSec: number;
  timelineStart: number;
  confidence: number;
}

export interface MulticamSyncResult {
  referenceAssetId: ID;
  sampleRate: number;
  angles: MulticamAngleSync[];
}

export interface MulticamCutSpec {
  time: number;
  angleIndex?: number;
  trackId?: ID;
}

export interface MulticamCutResult {
  programTrackId: ID;
  segmentCount: number;
  clips: Clip[];
}

/** Extracts mono 16-bit PCM samples at `sampleRate` Hz from an audio/video file. */
async function decodeMonoPcm(filePath: string, sampleRate: number, maxDurationSec = 45): Promise<Float32Array> {
  const res = await run(ffmpegPath(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-t",
    String(maxDurationSec),
    "-i",
    filePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "s16le",
    "pipe:1",
  ]);
  if (res.code !== 0 || res.stdout.length < 4) {
    return new Float32Array(0);
  }
  const count = Math.floor(res.stdout.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = res.stdout.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/** Computes RMS amplitude envelope in steps of `hop` samples for rapid cross-correlation. */
function computeEnvelope(samples: Float32Array, hop: number): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  const n = Math.max(1, Math.floor(samples.length / hop));
  const env = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    let sumSq = 0;
    const base = i * hop;
    for (let j = 0; j < hop; j++) {
      const s = samples[base + j] ?? 0;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / hop);
    env[i] = rms;
    mean += rms;
  }
  mean /= n;
  for (let i = 0; i < n; i++) {
    env[i] = env[i]! - mean;
  }
  return env;
}

/**
 * Finds the lag `lagSamples` where `target[t - lag]` best matches `ref[t]`:
 * If `target` started recording `Δ` seconds BEFORE `ref` (so the clap appears at `t_target = t_ref + Δ`),
 * then `target` must be delayed on timeline relative to `ref` by `-Δ` (i.e., if `target` started LATER than `ref`,
 * the clap appears EARLIER in `target` at `t_target = t_ref - delay`, so `timelineOffset = +delay`).
 */
function estimateOffsetSec(
  refPcm: Float32Array,
  targetPcm: Float32Array,
  sampleRate: number,
  maxOffsetSec: number,
): { offsetSec: number; confidence: number } {
  if (refPcm.length < 32 || targetPcm.length < 32) {
    return { offsetSec: 0, confidence: 0 };
  }

  // Stage 1: Coarse search on 10ms RMS energy envelope
  const hop = Math.max(1, Math.round(sampleRate / 200)); // 5ms envelope frames
  const envRate = sampleRate / hop;
  const refEnv = computeEnvelope(refPcm, hop);
  const tgtEnv = computeEnvelope(targetPcm, hop);
  const maxEnvLag = Math.min(Math.round(maxOffsetSec * envRate), Math.max(refEnv.length, tgtEnv.length) - 2);

  // Precompute full-signal norms so edge lags that clip active speech/claps never get artificially boosted!
  let fullEnvNormA = 0;
  for (let i = 0; i < refEnv.length; i++) fullEnvNormA += refEnv[i]! * refEnv[i]!;
  let fullEnvNormB = 0;
  for (let i = 0; i < tgtEnv.length; i++) fullEnvNormB += tgtEnv[i]! * tgtEnv[i]!;
  const fullEnvDenom = Math.sqrt(fullEnvNormA * fullEnvNormB);

  let bestEnvLag = 0;
  let bestScore = -Infinity;

  for (let lag = -maxEnvLag; lag <= maxEnvLag; lag++) {
    // At timeline shift `lag` (`target` starts at `lag / envRate` on timeline):
    // timeline time `t` corresponds to `ref[t]` and `tgt[t - lag]`.
    const tStart = Math.max(0, lag);
    const tEnd = Math.min(refEnv.length, tgtEnv.length + lag);
    const overlap = tEnd - tStart;
    if (overlap < 10) continue;

    let dot = 0;
    for (let t = tStart; t < tEnd; t++) {
      dot += refEnv[t]! * tgtEnv[t - lag]!;
    }
    const ncc = fullEnvDenom > 1e-9 ? dot / fullEnvDenom : 0;
    if (ncc > bestScore) {
      bestScore = ncc;
      bestEnvLag = lag;
    }
  }

  // Stage 2: Fine sample-accurate refinement directly on waveform around `bestEnvLag * hop ± 2*hop`
  let fullWaveNormA = 0;
  for (let i = 0; i < refPcm.length; i++) fullWaveNormA += refPcm[i]! * refPcm[i]!;
  let fullWaveNormB = 0;
  for (let i = 0; i < targetPcm.length; i++) fullWaveNormB += targetPcm[i]! * targetPcm[i]!;
  const fullWaveDenom = Math.sqrt(fullWaveNormA * fullWaveNormB);

  const centerSampleLag = bestEnvLag * hop;
  const searchRadius = hop * 3;
  let bestSampleLag = centerSampleLag;
  let bestWaveScore = -Infinity;

  for (let lag = centerSampleLag - searchRadius; lag <= centerSampleLag + searchRadius; lag++) {
    const tStart = Math.max(0, lag);
    const tEnd = Math.min(refPcm.length, targetPcm.length + lag);
    const overlap = tEnd - tStart;
    if (overlap < 64) continue;

    let dot = 0;
    for (let t = tStart; t < tEnd; t++) {
      dot += refPcm[t]! * targetPcm[t - lag]!;
    }
    const ncc = fullWaveDenom > 1e-9 ? dot / fullWaveDenom : 0;
    if (ncc > bestWaveScore) {
      bestWaveScore = ncc;
      bestSampleLag = lag;
    }
  }

  const confidence = Number(Math.max(0, Math.min(1, Math.max(bestScore, bestWaveScore))).toFixed(3));
  return {
    offsetSec: Number((bestSampleLag / sampleRate).toFixed(4)),
    confidence,
  };
}

/**
 * Automatically synchronizes 2+ multi-camera / multi-mic assets using acoustic cross-correlation
 * and places aligned camera tracks onto the active sequence.
 */
export async function syncMulticamClips(
  engine: VeditEngine,
  opts: { assetIds?: ID[]; maxOffsetSec?: number; sampleRate?: number } = {},
): Promise<MulticamSyncResult> {
  const sampleRate = Math.max(1000, Math.min(16000, Math.round(opts.sampleRate ?? 4000)));
  const maxOffsetSec = Math.max(1, Math.min(60, Number(opts.maxOffsetSec ?? 15)));

  const candidates: Asset[] = opts.assetIds?.length
    ? opts.assetIds.map((id) => engine.findAsset(id))
    : engine.project.assets.filter((a) => (a.kind === "video" || a.kind === "audio") && existsSync(a.path));

  if (candidates.length < 2) {
    throw new Error("Multicam sync requires at least 2 imported video/audio assets.");
  }

  const pcms = await Promise.all(candidates.map((a) => decodeMonoPcm(a.path, sampleRate)));
  const refAsset = candidates[0]!;
  const refPcm = pcms[0]!;

  const rawOffsets = candidates.map((asset, idx) => {
    if (idx === 0) return { asset, offsetSec: 0, confidence: 1 };
    const est = estimateOffsetSec(refPcm, pcms[idx]!, sampleRate, maxOffsetSec);
    return { asset, ...est };
  });

  // Shift all starts so the earliest angle sits at `t = 0.000s` (never negative timeline start!)
  const minOffset = Math.min(...rawOffsets.map((o) => o.offsetSec));
  const angles: MulticamAngleSync[] = [];

  for (let i = 0; i < rawOffsets.length; i++) {
    const item = rawOffsets[i]!;
    const timelineStart = Number((item.offsetSec - minOffset).toFixed(4));
    const kind = item.asset.kind === "audio" ? "audio" : "video";
    const track = engine.addTrack(kind, `Cam ${i + 1} — ${item.asset.name}`);
    const dur = Math.max(0.2, Number(item.asset.duration ?? 3));
    const clip = engine.addClip({
      trackId: track.id,
      assetId: item.asset.id,
      start: timelineStart,
      duration: dur,
      in: 0,
      out: dur,
      name: `Angle ${i + 1} (${item.asset.name})`,
    });
    angles.push({
      assetId: item.asset.id,
      assetName: item.asset.name,
      trackId: track.id,
      clipId: clip.id,
      offsetSec: item.offsetSec,
      timelineStart,
      confidence: item.confidence,
    });
  }

  return {
    referenceAssetId: refAsset.id,
    sampleRate,
    angles,
  };
}

/**
 * Builds a clean multi-angle switched program track ("Multicam Program") across camera tracks,
 * using either explicit angle cut points or automatic interval camera switching.
 */
export function applyMulticamCuts(
  engine: VeditEngine,
  opts: { cuts?: MulticamCutSpec[]; autoIntervalSec?: number } = {},
): MulticamCutResult {
  const seq = engine.activeSequence();
  const angleTracks: Track[] = seq.tracks.filter(
    (t) => t.kind === "video" && t.name !== "Multicam Program" && t.clips.length > 0,
  );
  if (angleTracks.length === 0) {
    throw new Error("No video angle tracks with clips found to switch.");
  }

  const endTime = Math.max(
    ...angleTracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)),
  );
  if (endTime <= 0.05) {
    throw new Error("Timeline angle clips have zero duration.");
  }

  let cuts: MulticamCutSpec[];
  if (opts.cuts && opts.cuts.length > 0) {
    cuts = [...opts.cuts].sort((a, b) => a.time - b.time);
  } else {
    const interval = Math.max(0.4, Number(opts.autoIntervalSec ?? 2.5));
    cuts = [];
    let idx = 0;
    for (let t = 0; t < endTime - 0.05; t += interval) {
      cuts.push({ time: Number(t.toFixed(3)), angleIndex: idx % angleTracks.length });
      idx++;
    }
  }

  // Replace existing Multicam Program track if re-running so switching is cleanly idempotent
  const existingProg = seq.tracks.find((t) => t.name === "Multicam Program");
  if (existingProg) {
    engine.removeTrack(existingProg.id);
  }
  const programTrack = engine.addTrack("video", "Multicam Program");
  const createdClips: Clip[] = [];

  for (let i = 0; i < cuts.length; i++) {
    const cur = cuts[i]!;
    const segStart = Math.max(0, cur.time);
    const segEnd = i + 1 < cuts.length ? Math.min(endTime, cuts[i + 1]!.time) : endTime;
    const segDur = segEnd - segStart;
    if (segDur < 0.05) continue;

    const chosenTrack = cur.trackId
      ? angleTracks.find((t) => t.id === cur.trackId) ?? angleTracks[0]!
      : angleTracks[(cur.angleIndex ?? 0) % angleTracks.length]!;

    // Find active clip on chosen angle covering `segStart` (or nearest clip on that track)
    const srcClip =
      chosenTrack.clips.find((c) => c.start <= segStart + 0.05 && c.start + c.duration > segStart) ??
      chosenTrack.clips[0]!;
    const srcIn = Math.max(0, srcClip.in + Math.max(0, segStart - srcClip.start));
    const availDur = Math.min(segDur, Math.max(0.05, srcClip.out - srcIn));

    const placed = engine.addClip({
      trackId: programTrack.id,
      assetId: srcClip.assetId,
      start: Number(segStart.toFixed(4)),
      duration: Number(availDur.toFixed(4)),
      in: Number(srcIn.toFixed(4)),
      out: Number((srcIn + availDur).toFixed(4)),
      name: `${chosenTrack.name}`,
    });
    createdClips.push(placed);
  }

  return {
    programTrackId: programTrack.id,
    segmentCount: createdClips.length,
    clips: createdClips,
  };
}
