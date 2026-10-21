import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VeditEngine } from "../src/core/engine.js";
import { ffmpegPath, probeMedia, run } from "../src/core/media.js";
import { renderSequence } from "../src/render/export.js";
import { addGraphicOverlay } from "../src/pro/graphics.js";
import { captureDesktopClip, generateProjectThumbnail } from "../src/pro/capture.js";
import { createApp } from "../src/server/app.js";
import { buildMcpServer } from "../src/mcp/server.js";

async function measureAudioRms(filePath: string): Promise<number> {
  const res = await run(ffmpegPath(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    filePath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "pipe:1",
  ]);
  const buf = res.stdout;
  const samples = Math.floor(buf.length / 2);
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / Math.max(1, samples));
}

describe("F7 — Studio Capture, DAW Track Mixer (Solo / Gain / Pan), Vector/SVG Graphics & Smart Thumbnails", () => {
  it("generates transparent 32-bit RGBA Vector & custom SVG overlays and composites them cleanly in FFmpeg", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-f7-gfx-"));
    const bgVideo = join(tmp, "bg.mp4");
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x1e293b:size=320x180:rate=24",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", bgVideo,
    ]);

    const engine = new VeditEngine(VeditEngine.createProject("Vector Graphics Composite"));
    const seq = engine.activeSequence();
    seq.width = 320;
    seq.height = 180;
    seq.fps = 24;
    const bgAsset = engine.addAsset({ name: "bg.mp4", kind: "video", path: bgVideo, duration: 1, width: 320, height: 180 });
    const v1 = engine.addTrack("video", "V1");
    engine.addClip({ trackId: v1.id, assetId: bgAsset.id, start: 0, duration: 1, in: 0, out: 1 });

    // 1. Built-in lower-third vector shape
    const lowerThird = await addGraphicOverlay(engine, {
      kind: "lower-third-card",
      width: 200,
      height: 60,
      label: "Lead Editor",
      start: 0,
      duration: 1,
      animationPreset: "fade-in",
      outDir: tmp,
    });
    const pngHead = await readFile(lowerThird.outPath);
    // PNG magic signature + colorType 6 (RGBA)
    expect(pngHead[0]).toBe(137);
    expect(pngHead[1]).toBe(80);
    expect(pngHead[25]).toBe(6);

    // 2. Custom <svg> markup layer
    const customSvg = await addGraphicOverlay(engine, {
      kind: "custom-svg",
      width: 120,
      height: 120,
      svgMarkup: '<svg><circle cx="60" cy="60" r="45" fill="#ef4444" stroke="#ffffff" stroke-width="6"/></svg>',
      start: 0,
      duration: 1,
      outDir: tmp,
    });
    expect(customSvg.clip.name).toBe("custom-svg");

    const renderedOut = join(tmp, "out-with-graphics.mp4");
    const rendered = await renderSequence(engine.project, { outPath: renderedOut, width: 320, height: 180, fps: 24 });
    expect(rendered.sizeBytes).toBeGreaterThan(1500);
  }, 45_000);

  it("honors DAW Track Solo + Per-Track Volume dB fader accurately in FFmpeg audio renders", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-f7-mixer-"));
    const loudMusic = join(tmp, "loud.wav");
    const softVoice = join(tmp, "voice.wav");

    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
      "-t", "1", loudMusic,
    ]);
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000",
      "-t", "1", softVoice,
    ]);

    const engine = new VeditEngine(VeditEngine.createProject("DAW Console Test"));
    const seq = engine.activeSequence();
    seq.width = 160;
    seq.height = 90;
    seq.fps = 24;
    const mAsset = engine.addAsset({ name: "loud.wav", kind: "audio", path: loudMusic, duration: 1, hasAudio: true });
    const vAsset = engine.addAsset({ name: "voice.wav", kind: "audio", path: softVoice, duration: 1, hasAudio: true });
    const a1 = engine.addTrack("audio", "Music Bed");
    const a2 = engine.addTrack("audio", "Solo Voice");
    engine.addClip({ trackId: a1.id, assetId: mAsset.id, start: 0, duration: 1, in: 0, out: 1 });
    engine.addClip({ trackId: a2.id, assetId: vAsset.id, start: 0, duration: 1, in: 0, out: 1 });

    // Solo A2 at 0 dB first
    engine.updateTrack(a2.id, { solo: true, volumeDb: 0 });
    const out0dB = join(tmp, "solo-0db.mov");
    await renderSequence(engine.project, { outPath: out0dB, preset: "prores-master", width: 160, height: 90, fps: 24 });
    const rms0 = await measureAudioRms(out0dB);

    // Lower A2 fader to -12 dB (~0.25x amplitude)
    engine.updateTrack(a2.id, { solo: true, volumeDb: -12 });
    const outMinus12 = join(tmp, "solo-minus12db.mov");
    await renderSequence(engine.project, { outPath: outMinus12, preset: "prores-master", width: 160, height: 90, fps: 24 });
    const rmsMinus12 = await measureAudioRms(outMinus12);

    expect(rmsMinus12).toBeLessThan(rms0 * 0.4);
  }, 45_000);

  it("captures screen clips and automatically selects the sharpest detailed frame for 1280x720 YouTube Thumbnails", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-f7-capture-"));
    const darkIntro = join(tmp, "dark.mp4");
    const detailedHero = join(tmp, "hero.mp4");

    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:size=640x360:rate=24",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", darkIntro,
    ]);
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", detailedHero,
    ]);

    const engine = new VeditEngine(VeditEngine.createProject("Smart Thumbnail Test"));
    const v1 = engine.addTrack("video", "V1");
    const aDark = engine.addAsset({ name: "dark.mp4", kind: "video", path: darkIntro, duration: 2 });
    const aHero = engine.addAsset({ name: "hero.mp4", kind: "video", path: detailedHero, duration: 2 });
    engine.addClip({ trackId: v1.id, assetId: aDark.id, start: 0, duration: 2, in: 0, out: 2 });
    engine.addClip({ trackId: v1.id, assetId: aHero.id, start: 2, duration: 2, in: 0, out: 2 });

    const thumb = await generateProjectThumbnail(engine, { title: "VEDIT STUDIO", outDir: tmp });
    // Must automatically skip the blank [0..2s] intro and pick a frame from the detailed [2..4s] shot!
    expect(thumb.selectedTime).toBeGreaterThanOrEqual(2.0);
    expect(thumb.sizeBytes).toBeGreaterThan(5000);
    const thumbProbe = await probeMedia(thumb.outPath);
    expect(thumbProbe.width).toBe(1280);

    // Also test REST + MCP capture.screen, track.update, graphics.add_overlay, export.thumbnail
    const { app } = createApp({ token: "dev", dataDir: tmp });
    const auth = <T extends request.Test>(t: T) => t.set("Authorization", "Bearer dev");
    const created = await auth(request(app).post("/api/v1/projects").send({ name: "F7 API", sample: false }));
    const pid = created.body.project.id as string;

    const capRes = await auth(request(app).post(`/api/v1/projects/${pid}/capture/screen`).send({ seconds: 1, fps: 12 }));
    expect(capRes.status).toBe(201);
    expect(capRes.body.clip).toBeTruthy();

    const mcp = buildMcpServer({ engine });
    const client = new Client({ name: "f7-mcp-client", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["track.update", "graphics.add_overlay", "capture.screen", "export.thumbnail"]),
    );
  }, 45_000);
});
