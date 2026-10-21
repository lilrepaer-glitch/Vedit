// F3: AI střihové operace (PLAN.md §3.4) — auto-cut tich, highlight, beat sync,
// auto-reframe a motion tracking. Vše transakčně (jedno undo).

import type { VeditEngine } from "../core/engine.js";
import type { Clip, Track } from "../core/types.js";
import { clipEnd } from "../core/types.js";
import {
  detectBeats,
  detectScenes,
  detectSilences,
  trackMotion,
  windowEnergy,
  type TimeRegion,
} from "./analysis.js";

const MAX_T = 3600;

function intersects(a: TimeRegion, b: TimeRegion): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Komplement tich v rámci [from, to] = ponechané segmenty. */
function keptSegments(from: number, to: number, silences: TimeRegion[]): Array<[number, number]> {
  const clamped = silences
    .map((s) => ({ start: Math.max(from, s.start), end: Math.min(to, s.end) }))
    .filter((s) => intersects(s, { start: from, end: to }) && s.end - s.start > 0.02)
    .sort((a, b) => a.start - b.start);
  const kept: Array<[number, number]> = [];
  let cursor = from;
  for (const s of clamped) {
    if (s.start - cursor > 0.05) kept.push([cursor, s.start]);
    cursor = Math.max(cursor, s.end);
  }
  if (to - cursor > 0.05) kept.push([cursor, to]);
  return kept;
}

export interface RemoveSilencesResult {
  trackId: string;
  removedGaps: number;
  savedDuration: number;
  clips: Clip[];
}

/**
 * „Vyhoď ticha" — detekuje ticha v klipech na stopě a zavře mezery
 * (ripple collapse). Stopa se přestaví z ponechaných segmentů.
 */
export async function removeSilences(
  engine: VeditEngine,
  opts: {
    trackId?: string;
    clipId?: string;
    noiseDb?: number;
    minSilence?: number;
    padding?: number;
  } = {},
): Promise<RemoveSilencesResult> {
  const seq = engine.activeSequence();
  let track: Track;
  if (opts.clipId) {
    track = engine.findClipAnywhere(opts.clipId).track;
  } else if (opts.trackId) {
    track = engine.findTrack(opts.trackId);
  } else {
    track = seq.tracks.find((t) => t.kind === "video" || t.kind === "audio")!;
    if (!track) throw new Error("No track found for analysis");
  }
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  if (clips.length === 0) throw new Error(`Track ${track.name} has no clips`);

  interface Plan {
    clip: Clip;
    assetPath: string;
    kept: Array<[number, number]>;
    gaps: number;
    removedGaps: number;
  }
  const plans: Plan[] = [];
  for (const clip of clips) {
    const asset = engine.findAsset(clip.assetId);
    const silences = await detectSilences(asset.path, {
      noiseDb: opts.noiseDb,
      minDuration: opts.minSilence,
    });
    const pad = opts.padding ?? 0.08;
    const padded = silences.map((s) => ({ start: s.start + pad, end: s.end - pad })).filter((s) => s.end > s.start);
    const inPt = clip.in;
    const outPt = clip.out;
    const kept = keptSegments(inPt, outPt, padded);
    const removedGaps = padded.filter((s) => s.start >= inPt - 0.01 && s.end <= outPt + 0.01).length;
    plans.push({
      clip,
      assetPath: asset.path,
      kept,
      gaps: clip.duration - kept.reduce((a, [s, e]) => a + (e - s), 0),
      removedGaps,
    });
  }

  const beforeDuration = clips.reduce((a, c) => a + c.duration, 0);
  const newClips = engine.transaction("ai.removeSilences", () => {
    // celá stopa se přestaví: odstranit klipy, naskládat ponechané segmenty těsně za sebe
    for (const p of plans) engine.deleteClip(p.clip.id, track.id);
    let cursor = clips[0]!.start;
    const created: Clip[] = [];
    for (const p of plans) {
      for (const [s, e] of p.kept) {
        const duration = e - s;
        const clip = engine.addClip({
          trackId: track.id,
          assetId: p.clip.assetId,
          start: cursor,
          duration,
          in: s,
          out: e,
          name: p.clip.name,
        });
        // zachovat transformaci a efekty originálu
        engine.updateClip(clip.id, { transform: p.clip.transform }, track.id);
        for (const effect of p.clip.effects) {
          engine.addEffect(clip.id, effect.type, effect.params, track.id);
        }
        created.push(clip);
        cursor += duration;
      }
    }
    return created;
  });

  const afterDuration = newClips.reduce((a, c) => a + c.duration, 0);
  return {
    trackId: track.id,
    removedGaps: plans.reduce((a, p) => a + p.removedGaps, 0),
    savedDuration: Number((beforeDuration - afterDuration).toFixed(3)),
    clips: newClips,
  };
}

export interface HighlightResult {
  trackId: string;
  clips: Clip[];
  totalDuration: number;
  scores: Array<{ assetTime: number; score: number }>;
}

/**
 * „Udělej highlight" — skóruje okna zdroje (pohyb + audio energie + střihy scén)
 * a sestaví nejlepší části do nové stopy „Highlights" (těsně za sebou).
 */
export async function buildHighlight(
  engine: VeditEngine,
  opts: {
    trackId?: string;
    assetId?: string;
    clipId?: string;
    targetDuration?: number;
    windowSec?: number;
    hopSec?: number;
  } = {},
): Promise<HighlightResult> {
  const seq = engine.activeSequence();
  const targetDuration = opts.targetDuration ?? 15;
  const windowSec = opts.windowSec ?? 2;
  const hopSec = opts.hopSec ?? 1;

  // zdroje: klipy ze stopy / konkrétní klip / celé assetové médium
  interface Source {
    assetId: string;
    name: string;
    from: number;
    to: number;
    mapToAssetTime: (t: number) => number;
  }
  const sources: Source[] = [];
  if (opts.clipId) {
    const { clip } = engine.findClipAnywhere(opts.clipId);
    sources.push({
      assetId: clip.assetId,
      name: clip.name,
      from: clip.in,
      to: clip.out,
      mapToAssetTime: (t) => t,
    });
  } else if (opts.assetId) {
    const asset = engine.findAsset(opts.assetId);
    sources.push({
      assetId: asset.id,
      name: asset.name,
      from: 0,
      to: asset.duration ?? MAX_T,
      mapToAssetTime: (t) => t,
    });
  } else {
    const track = opts.trackId ? engine.findTrack(opts.trackId) : seq.tracks.find((t) => t.kind === "video");
    if (!track || track.clips.length === 0) throw new Error("No source clips available for highlight");
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      sources.push({
        assetId: clip.assetId,
        name: clip.name,
        from: clip.in,
        to: clip.out,
        mapToAssetTime: (t) => t,
      });
    }
  }

  // skórování oken v časech assetu
  const scored: Array<{ assetId: string; name: string; start: number; end: number; score: number }> = [];
  for (const src of sources) {
    const asset = engine.findAsset(src.assetId);
    const [motion, energy, scenes] = await Promise.all([
      trackMotion(asset.path, { fps: 4 }).catch(() => []),
      windowEnergy(asset.path, { windowSec, hopSec }),
      detectScenes(asset.path, { threshold: 0.25 }).catch(() => []),
    ]);
    for (const w of energy) {
      if (w.start < src.from - 0.01 || w.end > src.to + 0.01) continue;
      const motionSlice = motion.filter((m) => m.t >= w.start && m.t < w.end);
      const motionScore = motionSlice.length
        ? motionSlice.reduce((a, m) => a + m.strength, 0) / motionSlice.length
        : 0;
      const sceneScore = Math.min(1, scenes.filter((t) => t >= w.start && t < w.end).length * 0.35);
      // okno se může překrývat se sousedy — skóre = energie + pohyb + bonus za scénu
      scored.push({
        assetId: src.assetId,
        name: src.name,
        start: w.start,
        end: w.end,
        score: Number((w.energy * 0.4 + motionScore * 0.45 + sceneScore * 0.15).toFixed(4)),
      });
    }
  }
  if (scored.length === 0) throw new Error("Could not score any highlight windows");

  // výběr nejlepších nepřekrývajících se oken do targetDuration
  const picked: typeof scored = [];
  let total = 0;
  for (const w of [...scored].sort((a, b) => b.score - a.score)) {
    if (total + (w.end - w.start) > targetDuration + 0.25) continue;
    const overlaps = picked.some(
      (p) => p.assetId === w.assetId && w.start < p.end - 0.05 && p.start < w.end - 0.05,
    );
    if (overlaps) continue;
    picked.push(w);
    total += w.end - w.start;
    if (total >= targetDuration) break;
  }
  if (picked.length === 0) throw new Error("No highlight window fit within target duration");

  // sestavení na novou stopu Highlights (podle času v assetu)
  picked.sort((a, b) => (a.assetId === b.assetId ? a.start - b.start : a.assetId.localeCompare(b.assetId)));
  const trackName = `Highlights (${total.toFixed(1)}s)`;
  const newClips = engine.transaction("ai.highlight", () => {
    const track = engine.addTrack("video", trackName);
    let cursor = 0;
    const created: Clip[] = [];
    for (const w of picked) {
      const clip = engine.addClip({
        trackId: track.id,
        assetId: w.assetId,
        start: cursor,
        duration: w.end - w.start,
        in: w.start,
        out: w.end,
        name: w.name,
      });
      created.push(clip);
      cursor += w.end - w.start;
    }
    return created;
  });

  return {
    trackId: newClips[0] ? engine.findClipAnywhere(newClips[0].id).track.id : "",
    clips: newClips,
    totalDuration: Number(total.toFixed(3)),
    scores: scored.sort((a, b) => b.score - a.score).slice(0, 10).map((w) => ({ assetTime: w.start, score: w.score })),
  };
}

export interface BeatSyncResult {
  beats: number[];
  splits: Clip[];
}

/**
 * Beat sync — střihy klipu přesně na údery hudby.
 * Beaty se detekují v hudebním assetu a přemapují na timeline přes hudební klip
 * (pokud existuje), jinak se berou jako offset od začátku klipu.
 */
export async function beatSync(
  engine: VeditEngine,
  opts: {
    clipId: string;
    musicAssetId: string;
    sensitivity?: number;
    minBeatSec?: number;
  },
): Promise<BeatSyncResult> {
  const { clip: videoClip } = engine.findClipAnywhere(opts.clipId);
  const music = engine.findAsset(opts.musicAssetId);
  const beats = await detectBeats(music.path, {
    sensitivity: opts.sensitivity,
    minBeatSec: opts.minBeatSec,
  });

  // mapování: hudební klip na timeline (pokud je), jinak přímé časy
  const seq = engine.activeSequence();
  let offset = videoClip.start;
  let musicIn = 0;
  for (const track of seq.tracks) {
    const musicClip = track.clips.find((c) => c.assetId === music.id);
    if (musicClip) {
      offset = musicClip.start;
      musicIn = musicClip.in;
      break;
    }
  }

  const cuts = beats
    .map((b) => offset + (b - musicIn))
    .filter((t) => t > videoClip.start + 0.1 && t < clipEnd(videoClip) - 0.1)
    .sort((a, b) => a - b);

  const splits = engine.transaction("ai.beatSync", () => {
    const created: Clip[] = [];
    let current = videoClip;
    for (const t of cuts) {
      if (t <= current.start + 0.05 || t >= clipEnd(current) - 0.05) continue;
      const [left, right] = engine.splitClip(current.id, t);
      created.push(left, right);
      current = right;
    }
    return created;
  });

  return { beats, splits };
}

export interface TrackMotionResult {
  keyframes: number;
  clip: Clip;
}

/** Motion tracking → keyframy cílového klipu (grafika sleduje pohyb). */
export async function trackMotionTo(
  engine: VeditEngine,
  opts: { sourceAssetId?: string; sourceClipId?: string; targetClipId: string; strength?: number },
): Promise<TrackMotionResult> {
  const { clip: target } = engine.findClipAnywhere(opts.targetClipId);
  let assetId = opts.sourceAssetId;
  let sourceSpan: { start: number; in: number; out: number } | null = null;
  if (opts.sourceClipId) {
    const { clip } = engine.findClipAnywhere(opts.sourceClipId);
    assetId = clip.assetId;
    sourceSpan = { start: clip.start, in: clip.in, out: clip.out };
  }
  if (!assetId) throw new Error("zadej sourceAssetId nebo sourceClipId");
  const asset = engine.findAsset(assetId);
  const seq = engine.activeSequence();
  const strength = opts.strength ?? 1;

  const motion = await trackMotion(asset.path, { fps: 5 });
  const keyframes: Array<{ time: number; property: string; value: number; easing?: string }> = [];
  for (const m of motion) {
    // body mimo zdrojový klip se ignorují; čas se mapuje na timeline
    const assetTime = sourceSpan ? sourceSpan.in + (m.t - 0) : m.t;
    if (sourceSpan && (assetTime < sourceSpan.in - 0.01 || assetTime > sourceSpan.out + 0.01)) continue;
    const globalT = sourceSpan ? sourceSpan.start + (assetTime - sourceSpan.in) : m.t;
    const localT = globalT - target.start;
    if (localT < -0.01 || localT > target.duration + 0.01) continue;
    keyframes.push({
      time: Number(Math.max(0, localT).toFixed(3)),
      property: "x",
      value: Number(((0.5 - m.x) * seq.width * strength).toFixed(1)),
      easing: "linear",
    });
    keyframes.push({
      time: Number(Math.max(0, localT).toFixed(3)),
      property: "y",
      value: Number(((0.5 - m.y) * seq.height * strength).toFixed(1)),
      easing: "linear",
    });
  }
  if (keyframes.length === 0) throw new Error("No motion detected in target clip range");

  engine.transaction("ai.trackMotion", () => {
    engine.addKeyframes(target.id, keyframes);
  });
  return { keyframes: keyframes.length, clip: target };
}

/**
 * Auto-reframe — vycentruje pohyb v klipu (pan keyframy) pro výřez na jiný
 * poměr stran (např. 9:16). Výstupní poměr se řídí exportem (width/height).
 */
export async function autoReframe(
  engine: VeditEngine,
  opts: { clipId: string; strength?: number },
): Promise<TrackMotionResult> {
  const { clip } = engine.findClipAnywhere(opts.clipId);
  return trackMotionTo(engine, {
    sourceClipId: clip.id,
    targetClipId: clip.id,
    strength: opts.strength ?? 1,
  });
}
