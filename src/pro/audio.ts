// F6: Pro Audio DSP Engine — Voice Enhance / Denoise, Auto-Ducking & EBU R128 Loudness (PLAN.md §3.1, §4.1)

import { mkdir } from "node:fs/promises";
import { basename, extname, join, resolve as resolvePath } from "node:path";
import type { VeditEngine } from "../core/engine.js";
import { ffmpegPath, probeMedia, run } from "../core/media.js";
import { detectSilences } from "../ai/analysis.js";
import type { Asset, Clip, ID } from "../core/types.js";

export interface AudioEnhanceOptions {
  /** Clip ID or Asset ID to process */
  clipId?: ID;
  assetId?: ID;
  /** Output directory for rendered clean audio asset */
  outDir?: string;
  /** Noise floor reduction in dB (-80..-20, default -25) */
  noiseFloor?: number;
  /** Enable vocal presence EQ boost around 3.2 kHz */
  voicePresence?: boolean;
  /** Target EBU R128 integrated loudness in LUFS (default -16 LUFS) */
  loudnessLufs?: number;
}

export interface AudioEnhanceResult {
  asset: Asset;
  clip?: Clip;
  outPath: string;
  filtersApplied: string[];
  duration: number;
}

/**
 * Enhances speech/audio via real FFmpeg DSP chain:
 * highpass rumble removal + FFT spectral denoise (`afftdn`) + vocal clarity EQ + compressor + `loudnorm`.
 */
export async function enhanceAudio(
  engine: VeditEngine,
  opts: AudioEnhanceOptions,
): Promise<AudioEnhanceResult> {
  let targetClip: Clip | undefined;
  let sourceAsset: Asset | undefined;

  if (opts.clipId) {
    targetClip = engine.findClipAnywhere(opts.clipId).clip;
    sourceAsset = engine.findAsset(targetClip.assetId);
  } else if (opts.assetId) {
    sourceAsset = engine.findAsset(opts.assetId);
  } else {
    const seq = engine.activeSequence();
    targetClip = seq.tracks.flatMap((t) => t.clips)[0];
    if (targetClip) sourceAsset = engine.findAsset(targetClip.assetId);
  }
  if (!sourceAsset) {
    throw new Error("No audio/video asset found to enhance");
  }

  const outDir = resolvePath(opts.outDir ?? ".vedit/audio");
  await mkdir(outDir, { recursive: true });
  const stem = basename(sourceAsset.path, extname(sourceAsset.path));
  const outPath = join(outDir, `${stem}-enhanced-${Date.now()}.wav`);

  const nf = Math.max(-80, Math.min(-20, opts.noiseFloor ?? -25));
  const lufs = Math.max(-36, Math.min(-8, opts.loudnessLufs ?? -16));
  const filters: string[] = [
    "highpass=f=80",
    `afftdn=nf=${nf}`,
  ];
  if (opts.voicePresence !== false) {
    filters.push("equalizer=f=3200:t=q:w=1.2:g=3.0");
  }
  filters.push(
    "acompressor=threshold=-18dB:ratio=3:attack=10:release=120",
    `loudnorm=I=${lufs.toFixed(1)}:TP=-1.5:LRA=11`,
  );

  const res = await run(ffmpegPath(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    sourceAsset.path,
    "-vn",
    "-af",
    filters.join(","),
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
  if (res.code !== 0) {
    throw new Error(`FFmpeg audio enhance failed: ${res.stderr.trim()}`);
  }

  const info = await probeMedia(outPath);
  const created = engine.transaction("audio.enhance", () => {
    const newAsset = engine.addAsset({
      name: `${stem} (Enhanced)`,
      kind: "audio",
      path: outPath,
      duration: info.duration,
      sizeBytes: info.sizeBytes,
      audioCodec: info.audioCodec,
      hasAudio: true,
    });
    if (targetClip && sourceAsset!.kind === "audio") {
      targetClip.assetId = newAsset.id;
    } else if (targetClip) {
      // Keep video clip intact, mute raw camera audio on video clip via -60dB gain and lay clean WAV onto audio track
      engine.addEffect(targetClip.id, "audio-volume", { gainDb: -60 });
      const seq = engine.activeSequence();
      const audioTrack =
        seq.tracks.find((t) => t.kind === "audio" && !t.locked) ??
        engine.addTrack("audio", "Enhanced Voice");
      engine.addClip({
        trackId: audioTrack.id,
        assetId: newAsset.id,
        name: `${targetClip.name} (Enhanced Audio)`,
        start: targetClip.start,
        duration: Math.min(targetClip.duration, info.duration),
        in: targetClip.in,
        out: Math.min(targetClip.out, info.duration),
      });
    }
    return newAsset;
  });

  return {
    asset: created,
    clip: targetClip,
    outPath,
    filtersApplied: filters,
    duration: info.duration,
  };
}

export interface AudioDuckOptions {
  /** Clip ID of the background music clip to duck */
  musicClipId: ID;
  /** Voice clip ID (or asset ID) whose speech triggers ducking */
  voiceClipId?: ID;
  voiceAssetId?: ID;
  /** Attenuation during speech in dB (negative, e.g. -14) */
  reductionDb?: number;
  /** Silence threshold for speech detection on voice source */
  noiseDb?: number;
  outDir?: string;
}

export interface SpeechInterval {
  start: number;
  end: number;
}

export interface AudioDuckResult {
  musicClip: Clip;
  duckedAsset: Asset;
  outPath: string;
  speechIntervals: SpeechInterval[];
  reductionDb: number;
}

/**
 * Automatically ducks a background music clip whenever speech is active on the voice track/clip.
 * Computes exact speech intervals on timeline, renders ducked WAV via FFmpeg volume expressions,
 * and swaps the music clip's asset inside a single undoable transaction.
 */
export async function duckMusicUnderVoice(
  engine: VeditEngine,
  opts: AudioDuckOptions,
): Promise<AudioDuckResult> {
  const { clip: musicClip } = engine.findClipAnywhere(opts.musicClipId);
  const musicAsset = engine.findAsset(musicClip.assetId);

  let voicePath: string | undefined;
  let voiceTimelineOffset = 0;
  let voiceIn = 0;
  let voiceSpan = 0;

  if (opts.voiceClipId) {
    const { clip: vClip } = engine.findClipAnywhere(opts.voiceClipId);
    const vAsset = engine.findAsset(vClip.assetId);
    voicePath = vAsset.path;
    voiceTimelineOffset = vClip.start;
    voiceIn = vClip.in;
    voiceSpan = vClip.duration;
  } else if (opts.voiceAssetId) {
    const vAsset = engine.findAsset(opts.voiceAssetId);
    voicePath = vAsset.path;
    voiceSpan = vAsset.duration ?? musicClip.duration;
  } else {
    const seq = engine.activeSequence();
    const other = seq.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id !== musicClip.id && engine.findAsset(c.assetId).hasAudio !== false);
    if (other) {
      const vAsset = engine.findAsset(other.assetId);
      voicePath = vAsset.path;
      voiceTimelineOffset = other.start;
      voiceIn = other.in;
      voiceSpan = other.duration;
    }
  }

  if (!voicePath) {
    throw new Error("No voice source clip or asset found to trigger ducking");
  }

  const vInfo = await probeMedia(voicePath);
  const totalVoiceDur = vInfo.duration;
  const silences = await detectSilences(voicePath, {
    noiseDb: opts.noiseDb ?? -32,
    minDuration: 0.15,
  });

  // Complement of silences within [voiceIn .. voiceIn + voiceSpan] mapped to music clip local time
  const winEnd = voiceSpan > 0 ? Math.min(totalVoiceDur, voiceIn + voiceSpan) : totalVoiceDur;
  const speechOnTimeline: SpeechInterval[] = [];
  let cursor = voiceIn;
  for (const s of silences) {
    const sStart = Math.max(voiceIn, s.start);
    const sEnd = Math.min(winEnd, s.end);
    if (sStart > cursor + 0.04) {
      speechOnTimeline.push({
        start: voiceTimelineOffset + (cursor - voiceIn),
        end: voiceTimelineOffset + (sStart - voiceIn),
      });
    }
    cursor = Math.max(cursor, sEnd);
  }
  if (winEnd > cursor + 0.04) {
    speechOnTimeline.push({
      start: voiceTimelineOffset + (cursor - voiceIn),
      end: voiceTimelineOffset + (winEnd - voiceIn),
    });
  }

  // Convert timeline speech windows into music-clip-local windows [0 .. musicClip.duration]
  const localWindows: SpeechInterval[] = speechOnTimeline
    .map((w) => ({
      start: Math.max(0, w.start - musicClip.start - 0.08),
      end: Math.min(musicClip.duration, w.end - musicClip.start + 0.15),
    }))
    .filter((w) => w.end - w.start > 0.05);

  const reductionDb = opts.reductionDb != null ? -Math.abs(opts.reductionDb) : -14;
  const outDir = resolvePath(opts.outDir ?? ".vedit/audio");
  await mkdir(outDir, { recursive: true });
  const stem = basename(musicAsset.path, extname(musicAsset.path));
  const outPath = join(outDir, `${stem}-ducked-${Date.now()}.wav`);

  const volFilters =
    localWindows.length > 0
      ? localWindows.map(
          (w) => `volume=enable='between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})':volume=${reductionDb}dB`,
        )
      : ["anull"];

  const res = await run(ffmpegPath(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    musicClip.in.toFixed(3),
    "-t",
    musicClip.duration.toFixed(3),
    "-i",
    musicAsset.path,
    "-vn",
    "-af",
    volFilters.join(","),
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
  if (res.code !== 0) {
    throw new Error(`FFmpeg audio ducking failed: ${res.stderr.trim()}`);
  }

  const info = await probeMedia(outPath);
  const duckedAsset = engine.transaction("audio.duck", () => {
    const added = engine.addAsset({
      name: `${musicAsset.name} (Ducked ${reductionDb}dB)`,
      kind: "audio",
      path: outPath,
      duration: info.duration,
      sizeBytes: info.sizeBytes,
      audioCodec: info.audioCodec,
      hasAudio: true,
    });
    musicClip.assetId = added.id;
    musicClip.in = 0;
    musicClip.out = info.duration;
    musicClip.duration = info.duration;
    return added;
  });

  return {
    musicClip,
    duckedAsset,
    outPath,
    speechIntervals: localWindows,
    reductionDb,
  };
}
