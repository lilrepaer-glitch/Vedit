import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFrame, extractPeaks, generateTestClip, probeMedia } from "../src/core/media.js";

let dir: string;
let clip: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vedit-media-"));
  clip = join(dir, "klip.mp4");
  await generateTestClip(clip, { seconds: 2, size: "320x240", rate: 25, kind: "testsrc", freq: 440 });
}, 60000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("media engine (F1, reálný FFmpeg)", () => {
  it("probe vrátí skutečná metadata", async () => {
    const info = await probeMedia(clip);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeGreaterThan(1.5);
    expect(info.duration).toBeLessThan(2.5);
    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
    expect(info.fps).toBeCloseTo(25);
    expect(info.videoCodec).toBe("h264");
    expect(info.sizeBytes).toBeGreaterThan(0);
  });

  it("extractFrame vrátí JPEG", async () => {
    const jpeg = await extractFrame(clip, 1, { width: 160 });
    expect(jpeg.length).toBeGreaterThan(500);
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
  });

  it("extractPeaks vrátí waveform", async () => {
    const peaks = await extractPeaks(clip, 100);
    expect(peaks).toHaveLength(100);
    expect(Math.max(...peaks)).toBeGreaterThan(0);
  });

  it("probe neexistujícího souboru selže", async () => {
    await expect(probeMedia(join(dir, "neexistuje.mp4"))).rejects.toThrow(/ffprobe/);
  });
});
