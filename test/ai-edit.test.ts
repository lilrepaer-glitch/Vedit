// F3: AI střih — testy reálného signálového processingu a editačních operací.
// Fixtury: sine/ticho/sine WAV, AM-pulzové beaty, červená→modrá scéna, testsrc2 pohyb.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VeditEngine } from "../src/core/engine.js";
import { run, ffmpegPath, generateTestClip } from "../src/core/media.js";
import {
  detectBeats,
  detectScenes,
  detectSilences,
  trackMotion,
  windowEnergy,
} from "../src/ai/analysis.js";
import {
  autoReframe,
  beatSync,
  buildHighlight,
  removeSilences,
  trackMotionTo,
} from "../src/ai/edit.js";

let dir: string;
let silenceWav: string;
let beatsWav: string;
let sceneMp4: string;
let motionMp4: string;

/** Zápis mono s16le WAV přímo z float vzorků. */
async function writeWav(path: string, samples: Float32Array, sampleRate = 48000): Promise<void> {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vedit-ai-"));
  silenceWav = join(dir, "silence.wav");
  beatsWav = join(dir, "beats.wav");
  sceneMp4 = join(dir, "scene.mp4");
  motionMp4 = join(dir, "motion.mp4");

  // 3 s: sine 0–1, ticho 1–2, sine 2–3
  const sr = 48000;
  const sil = new Float32Array(sr * 3);
  for (let i = 0; i < sr; i++) sil[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
  for (let i = sr * 2; i < sr * 3; i++) sil[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
  await writeWav(silenceWav, sil, sr);

  // 4 s: 50ms pulzy 1 kHz po 0.5 s (beaty na 0.5, 1.0, …, 3.5)
  const beats = new Float32Array(sr * 4);
  for (const t0 of [0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
    const start = Math.round(t0 * sr);
    for (let i = 0; i < Math.round(0.05 * sr); i++) {
      beats[start + i] = 0.7 * Math.sin((2 * Math.PI * 1000 * i) / sr);
    }
  }
  await writeWav(beatsWav, beats, sr);

  // 2 s video: 1 s červená → 1 s modrá (tvrdý střih scény)
  await run(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25:d=1",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
    "-pix_fmt", "yuv420p", sceneMp4, "-y",
  ]);

  // 4 s pohyb (testsrc2) + sine audio pro windowEnergy
  await generateTestClip(motionMp4, { seconds: 4, size: "320x240", rate: 25, kind: "testsrc", freq: 440 });
}, 120000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function engineWithMedia() {
  const engine = new VeditEngine(VeditEngine.createProject("AI test", { width: 320, height: 240, fps: 25 }));
  const v1 = engine.addTrack("video", "V1");
  const a1 = engine.addTrack("audio", "A1");
  const assetSil = engine.addAsset({
    name: "silence.wav", kind: "audio", path: silenceWav, duration: 3,
    hasAudio: true, audioCodec: "pcm_s16le",
  });
  const assetBeats = engine.addAsset({
    name: "beats.wav", kind: "audio", path: beatsWav, duration: 4,
    hasAudio: true, audioCodec: "pcm_s16le",
  });
  const assetMotion = engine.addAsset({
    name: "motion.mp4", kind: "video", path: motionMp4, duration: 4,
    width: 320, height: 240, fps: 25, hasAudio: true, videoCodec: "h264", audioCodec: "aac",
  });
  return { engine, v1, a1, assetSil, assetBeats, assetMotion };
}

describe("analýza (F3)", () => {
  it("detectSilences najde ticho mezi tóny", async () => {
    const regions = await detectSilences(silenceWav);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    const mid = regions[0]!;
    expect(mid.start).toBeGreaterThan(0.6);
    expect(mid.start).toBeLessThan(1.4);
    expect(mid.end).toBeGreaterThan(1.6);
    expect(mid.end).toBeLessThan(2.4);
  });

  it("detectBeats najde AM-pulzy (~2 Hz)", async () => {
    const beats = await detectBeats(beatsWav);
    expect(beats.length).toBeGreaterThanOrEqual(4);
    // každý pulz na 0.5 s má beat ±0.2 s
    for (const t0 of [1, 2, 3]) {
      expect(beats.some((b) => Math.abs(b - t0) < 0.2)).toBe(true);
    }
  });

  it("detectScenes najde tvrdý střih červená→modrá", async () => {
    const scenes = await detectScenes(sceneMp4, { threshold: 0.2 });
    expect(scenes.some((t) => t > 0.75 && t < 1.35)).toBe(true);
  });

  it("trackMotion sleduje pohyb testsrc2", async () => {
    const points = await trackMotion(motionMp4, { fps: 5 });
    expect(points.length).toBeGreaterThan(5);
    expect(points.some((p) => p.strength > 0)).toBe(true);
    const xs = points.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.02);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
    }
  });

  it("windowEnergy normalizuje energii 0..1", async () => {
    const windows = await windowEnergy(motionMp4, { windowSec: 1, hopSec: 0.5 });
    expect(windows.length).toBeGreaterThan(2);
    for (const w of windows) {
      expect(w.energy).toBeGreaterThanOrEqual(0);
      expect(w.energy).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...windows.map((w) => w.energy))).toBeGreaterThan(0.5);
  });
});

describe("AI střih operace (F3)", () => {
  it("removeSilences zavře mezery a je jedním undo", async () => {
    const { engine, a1, assetSil } = engineWithMedia();
    const c1 = engine.addClip({ trackId: a1.id, assetId: assetSil.id, start: 0, duration: 3, in: 0, out: 3 });
    const result = await removeSilences(engine, { clipId: c1.id });
    expect(result.savedDuration).toBeGreaterThan(0.5);
    expect(result.savedDuration).toBeLessThan(1.5);
    expect(result.clips.length).toBe(2);
    expect(result.removedGaps).toBe(1);
    const track = engine.findTrack(a1.id);
    const total = track.clips.reduce((a, c) => a + c.duration, 0);
    expect(total).toBeLessThan(2.5);
    // kompaktní reflow — klipy na sebe navazují od 0
    const sorted = [...track.clips].sort((x, y) => x.start - y.start);
    expect(sorted[0]!.start).toBeCloseTo(0, 2);
    expect(sorted[1]!.start).toBeCloseTo(sorted[0]!.duration, 2);
    // jedno undo vrátí původní klip
    expect(engine.undo()).toBe(true);
    expect(engine.findTrack(a1.id).clips.length).toBe(1);
  });

  it("buildHighlight sestaví nejlepší okna do stopy Highlights", async () => {
    const { engine, assetMotion } = engineWithMedia();
    const result = await buildHighlight(engine, {
      assetId: assetMotion.id,
      targetDuration: 2,
      windowSec: 1,
      hopSec: 0.5,
    });
    expect(result.clips.length).toBeGreaterThanOrEqual(1);
    expect(result.totalDuration).toBeGreaterThan(0.5);
    expect(result.totalDuration).toBeLessThanOrEqual(2.3);
    const seq = engine.activeSequence();
    const track = seq.tracks.find((t) => t.name.startsWith("Highlights"));
    expect(track).toBeTruthy();
    expect(track!.clips.length).toBe(result.clips.length);
  });

  it("beatSync rozdělí klip na beaty hudby", async () => {
    const { engine, v1, a1, assetBeats, assetMotion } = engineWithMedia();
    const video = engine.addClip({ trackId: v1.id, assetId: assetMotion.id, start: 0, duration: 2, in: 0, out: 2 });
    engine.addClip({ trackId: a1.id, assetId: assetBeats.id, start: 0, duration: 4, in: 0, out: 4 });
    const result = await beatSync(engine, { clipId: video.id, musicAssetId: assetBeats.id });
    expect(result.beats.length).toBeGreaterThanOrEqual(4);
    expect(result.splits.length).toBeGreaterThanOrEqual(2);
    const track = engine.findTrack(v1.id);
    // střihy se propsaly na videostopu (2 klipy na každý řez)
    expect(track.clips.length).toBeGreaterThan(2);
  });

  it("autoReframe dá pan keyframy podle pohybu", async () => {
    const { engine, v1, assetMotion } = engineWithMedia();
    const clip = engine.addClip({ trackId: v1.id, assetId: assetMotion.id, start: 0, duration: 4, in: 0, out: 4 });
    const result = await autoReframe(engine, { clipId: clip.id });
    expect(result.keyframes).toBeGreaterThan(10);
    expect(clip.keyframes.length).toBeGreaterThan(10);
    expect(clip.keyframes.some((k) => k.property === "x")).toBe(true);
    expect(clip.keyframes.some((k) => k.property === "y")).toBe(true);
    // transakční undo (po undo je potřeba znovu najít klip — projekt se obnoví ze snapshotu)
    expect(engine.undo()).toBe(true);
    expect(engine.findClipAnywhere(clip.id).clip.keyframes.length).toBe(0);
  });

  it("trackMotionTo propojí pohyb zdroje s grafikou", async () => {
    const { engine, v1, assetMotion } = engineWithMedia();
    const src = engine.addClip({ trackId: v1.id, assetId: assetMotion.id, start: 0, duration: 4, in: 0, out: 4 });
    const target = engine.addClip({
      trackId: v1.id, assetId: assetMotion.id, start: 1, duration: 2, in: 0, out: 2, name: "grafika",
    });
    const result = await trackMotionTo(engine, {
      sourceClipId: src.id,
      targetClipId: target.id,
      strength: 0.5,
    });
    expect(result.keyframes).toBeGreaterThan(4);
    const times = target.keyframes.map((k) => k.time);
    // jen časy v rozsahu cílového klipu
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(2.01);
    }
  });
});
