// F3: audio/video analýza pro AI střih (PLAN.md §3.4) — reálný signálový processing.
// Ticho, scény, beaty, pohyb — přes FFmpeg dekódování + PCM/frame analýzu v Node.

import { run, ffmpegPath } from "../core/media.js";

export interface TimeRegion {
  start: number;
  end: number;
}

export interface MotionPoint {
  t: number;
  /** normalizovaný těžiště pohybu 0..1 (x = vodorovně) */
  x: number;
  y: number;
  /** intenzita pohybu 0..1 */
  strength: number;
}

/** Detekce ticha přes ffmpeg silencedetect. */
export async function detectSilences(
  path: string,
  opts: { noiseDb?: number; minDuration?: number } = {},
): Promise<TimeRegion[]> {
  const noiseDb = opts.noiseDb ?? -35;
  const minDuration = opts.minDuration ?? 0.4;
  const res = await run(ffmpegPath(), [
    "-hide_banner",
    "-i", path,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
    "-f", "null", "-",
  ]);
  // silencedetect loguje na stderr: silence_start / silence_end
  const regions: TimeRegion[] = [];
  let start: number | null = null;
  for (const line of res.stderr.split("\n")) {
    const s = /silence_start:\s*([\d.]+)/.exec(line);
    if (s) start = Number(s[1]);
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start != null) {
      regions.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  // neuzavřené ticho na konci souboru
  if (start != null) {
    const probeEnd = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(res.stderr);
    const total = probeEnd
      ? Number(probeEnd[1]) * 3600 + Number(probeEnd[2]) * 60 + Number(probeEnd[3])
      : start + minDuration;
    regions.push({ start, end: total });
  }
  return regions;
}

/** Detekce střihů/scén přes ffmpeg scene score. */
export async function detectScenes(
  path: string,
  opts: { threshold?: number } = {},
): Promise<number[]> {
  const threshold = opts.threshold ?? 0.3;
  const res = await run(ffmpegPath(), [
    "-hide_banner",
    "-i", path,
    "-vf", `select='gt(scene,${threshold})',showinfo`,
    "-f", "null", "-",
  ]);
  const times: number[] = [];
  for (const line of res.stderr.split("\n")) {
    const m = /pts_time:\s*([\d.]+)/.exec(line);
    if (m && /showinfo/.test(line)) times.push(Number(m[1]));
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

/**
 * Detekce beatů (úderů) v hudbě — energie PCM po frámech,
 * onset = polovlně usměrněný tok energie + peak picking.
 */
export async function detectBeats(
  path: string,
  opts: { sensitivity?: number; minBeatSec?: number } = {},
): Promise<number[]> {
  const sensitivity = opts.sensitivity ?? 1.4;
  const minBeatSec = opts.minBeatSec ?? 0.25;
  const sampleRate = 11025;
  const frameSize = 512;
  const res = await run(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error",
    "-i", path,
    "-map", "a:0",
    "-ac", "1", "-ar", String(sampleRate),
    "-f", "s16le", "-",
  ]);
  if (res.code !== 0 || res.stdout.length < frameSize * 4) {
    throw new Error(`audio dekódování pro beaty selhalo (${path})`);
  }
  const total = Math.floor(res.stdout.length / 2);
  const frames = Math.floor(total / frameSize);
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const v = res.stdout.readInt16LE((base + i) * 2) / 32768;
      sum += v * v;
    }
    energy[f] = sum / frameSize;
  }
  // onset strength = usměrněný tok energie
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    flux[f] = Math.max(0, energy[f]! - energy[f - 1]!);
  }
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, frames);
  const beats: number[] = [];
  const minFrames = Math.ceil((minBeatSec * sampleRate) / frameSize);
  const look = 2;
  for (let f = look; f < frames - look; f++) {
    const v = flux[f]!;
    if (v < mean * sensitivity || v <= 0) continue;
    let isPeak = true;
    for (let k = -look; k <= look; k++) {
      if (flux[f + k]! > v) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    const last = beats.length ? beats[beats.length - 1]! : -Infinity;
    const t = (f * frameSize) / sampleRate;
    if (t - last < minBeatSec) continue;
    beats.push(Number(t.toFixed(3)));
  }
  void minFrames;
  return beats;
}

/**
 * Motion tracking — rozdíly drobných šedých snímků → těžiště pohybu.
 * Vhodné pro auto-reframe a přiřazení grafiky k pohybujícímu se objektu.
 */
export async function trackMotion(
  path: string,
  opts: { fps?: number; width?: number; height?: number } = {},
): Promise<MotionPoint[]> {
  const fps = opts.fps ?? 5;
  const w = opts.width ?? 48;
  const h = opts.height ?? 32;
  const res = await run(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error",
    "-i", path,
    "-vf", `fps=${fps},scale=${w}:${h},format=gray`,
    "-f", "rawvideo", "-",
  ]);
  if (res.code !== 0) {
    throw new Error(`dekódování pro motion tracking selhalo (${path})`);
  }
  const frameSize = w * h;
  const frames = Math.floor(res.stdout.length / frameSize);
  const points: MotionPoint[] = [];
  let maxStrength = 1e-6;
  for (let f = 1; f < frames; f++) {
    const prev = (f - 1) * frameSize;
    const cur = f * frameSize;
    let sum = 0;
    let wx = 0;
    let wy = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(res.stdout[cur + y * w + x]! - res.stdout[prev + y * w + x]!);
        if (d > 12) {
          // jen výraznější rozdíly (šum potlačen)
          sum += d;
          wx += d * x;
          wy += d * y;
        }
      }
    }
    const strength = sum / (w * h * 255);
    if (sum > 0) {
      const point: MotionPoint = {
        t: Number((f / fps).toFixed(3)),
        x: Number((wx / sum / w).toFixed(4)),
        y: Number((wy / sum / h).toFixed(4)),
        strength: Number(strength.toFixed(4)),
      };
      points.push(point);
      if (strength > maxStrength) maxStrength = strength;
    } else {
      points.push({ t: Number((f / fps).toFixed(3)), x: 0.5, y: 0.5, strength: 0 });
    }
  }
  // normalizace intenzity na 0..1
  for (const p of points) {
    p.strength = Number(Math.min(1, p.strength / maxStrength).toFixed(4));
  }
  return points;
}

/** Průměrná audio energie (0..1) po oknech — pro skórování highlightů. */
export async function windowEnergy(
  path: string,
  opts: { windowSec?: number; hopSec?: number } = {},
): Promise<Array<{ start: number; end: number; energy: number }>> {
  const windowSec = opts.windowSec ?? 2;
  const hopSec = opts.hopSec ?? 1;
  const sampleRate = 8000;
  let stdout: Buffer;
  let dur: number;
  try {
    const res = await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error",
      "-i", path,
      "-map", "a:0",
      "-ac", "1", "-ar", String(sampleRate),
      "-f", "s16le", "-",
    ]);
    stdout = res.stdout as unknown as Buffer;
    dur = Math.floor(stdout.length / 2) / sampleRate;
    if (dur <= 0) throw new Error("prázdné audio");
  } catch {
    // video bez audia → nulová energie v oknech podle délky média
    const { probeMedia } = await import("../core/media.js");
    const probe = await probeMedia(path);
    const d = probe.duration ?? 0;
    const zero: Array<{ start: number; end: number; energy: number }> = [];
    for (let t = 0; t + windowSec * 0.5 < d; t += hopSec) {
      zero.push({ start: Number(t.toFixed(3)), end: Number(Math.min(d, t + windowSec).toFixed(3)), energy: 0 });
    }
    return zero;
  }
  const out: Array<{ start: number; end: number; energy: number }> = [];
  let maxE = 1e-9;
  for (let t = 0; t + windowSec * 0.5 < dur; t += hopSec) {
    const s = Math.floor(t * sampleRate);
    const e = Math.min(Math.floor(stdout.length / 2), Math.floor((t + windowSec) * sampleRate));
    let sum = 0;
    for (let i = s; i < e; i += 2) {
      const v = stdout.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    const energy = sum / Math.max(1, (e - s) / 2);
    out.push({ start: Number(t.toFixed(3)), end: Number(Math.min(dur, t + windowSec).toFixed(3)), energy });
    if (energy > maxE) maxE = energy;
  }
  for (const w of out) w.energy = Number((w.energy / maxE).toFixed(4));
  return out;
}
