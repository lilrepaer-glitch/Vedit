import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VeditEngine } from "../src/core/engine.js";
import { generateTestClip, probeMedia, run, ffmpegPath } from "../src/core/media.js";
import { buildRenderArgs, renderSequence } from "../src/render/export.js";

let dir: string;
let clipA: string;
let clipB: string;
let music: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vedit-render-"));
  clipA = join(dir, "a.mp4");
  clipB = join(dir, "b.mp4");
  music = join(dir, "m.wav");
  await generateTestClip(clipA, { seconds: 2, size: "320x240", rate: 25, kind: "testsrc", freq: 440 });
  await generateTestClip(clipB, { seconds: 2, size: "320x240", rate: 25, kind: "smptebars", freq: 660 });
  await run(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
    "-t", "4", music, "-y",
  ]);
}, 120000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function buildProject() {
  const engine = new VeditEngine(VeditEngine.createProject("Render test", { width: 320, height: 240, fps: 25 }));
  const v1 = engine.addTrack("video", "V1");
  const a1 = engine.addTrack("audio", "A1");
  const pa = { duration: 2, width: 320, height: 240, fps: 25, hasAudio: true };
  const assetA = engine.addAsset({ name: "a.mp4", kind: "video", path: clipA, ...pa, videoCodec: "h264", audioCodec: "aac" });
  const assetB = engine.addAsset({ name: "b.mp4", kind: "video", path: clipB, ...pa, videoCodec: "h264", audioCodec: "aac" });
  const assetM = engine.addAsset({ name: "m.wav", kind: "audio", path: music, duration: 4, hasAudio: true, audioCodec: "pcm_s16le" });
  const c1 = engine.addClip({ trackId: v1.id, assetId: assetA.id, start: 0, duration: 2, in: 0, out: 2 });
  const c2 = engine.addClip({ trackId: v1.id, assetId: assetB.id, start: 2, duration: 2, in: 0, out: 2 });
  engine.addClip({ trackId: a1.id, assetId: assetM.id, start: 0, duration: 4, in: 0, out: 4 });
  return { engine, c1, c2 };
}

describe("render pipeline (F1)", () => {
  it("buildRenderArgs sestaví overlay + titulky + audio mix", () => {
    const { engine, c1 } = buildProject();
    engine.addCaption({ text: "titulek", start: 0.2, end: 1.2 });
    engine.addEffect(c1.id, "color", { brightness: 0.1, saturation: 1.2 });
    const plan = buildRenderArgs(engine.project, { outPath: join(dir, "out.mp4") });
    const fc = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
    expect(fc).toContain("overlay=x=");
    expect(fc).toContain("subtitles=");
    // 2 video klipy se zvukem + 1 hudba = 3 audio vstupy do mixu
    expect(fc).toContain("amix=inputs=3");
    expect(fc).toContain("eq=b=0.1:saturation=1.2");
    expect(plan.srt?.content).toContain("titulek");
    expect(plan.duration).toBeCloseTo(4, 1);
  });

  it("renderSequence vytvoří skutečné video", async () => {
    const { engine, c1 } = buildProject();
    engine.applyAnimationPreset(c1.id, "fade-in");
    engine.addCaption({ text: "hotovo", start: 0.5, end: 1.5 });
    const out = join(dir, "render.mp4");
    const progress: number[] = [];
    const result = await renderSequence(engine.project, {
      outPath: out,
      onProgress: (p) => progress.push(p),
    });
    expect(result.sizeBytes).toBeGreaterThan(1000);
    const info = await probeMedia(out);
    expect(info.duration).toBeGreaterThan(3.5);
    expect(info.duration).toBeLessThan(5);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.width).toBe(320);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(100);
    const s = await stat(out);
    expect(s.size).toBe(result.sizeBytes);
  }, 120000);

  it("offline médium se přeskočí s varováním", async () => {
    const engine = new VeditEngine(VeditEngine.createProject("Offline", { width: 320, height: 240, fps: 25 }));
    const v1 = engine.addTrack("video", "V1");
    const asset = engine.addAsset({ name: "chybi.mp4", kind: "video", path: join(dir, "chybi.mp4"), duration: 2 });
    engine.addClip({ trackId: v1.id, assetId: asset.id, start: 0, duration: 2 });
    const plan = buildRenderArgs(engine.project, { outPath: join(dir, "offline.mp4") });
    expect(plan.warnings.some((w) => w.includes("offline médium"))).toBe(true);
  });
});
