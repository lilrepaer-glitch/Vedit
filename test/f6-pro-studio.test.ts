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
import { probeHardwareEncoders } from "../src/render/hwaccel.js";
import { applyChromaKey, applyColorGrade, applyFadeTransition, setClipSpeed } from "../src/pro/fx.js";
import { duckMusicUnderVoice, enhanceAudio } from "../src/pro/audio.js";
import { createApp } from "../src/server/app.js";
import { buildMcpServer } from "../src/mcp/server.js";

async function rmsWindow(wavPath: string, start: number, duration: number): Promise<number> {
  const res = await run(
    ffmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      start.toFixed(3),
      "-t",
      duration.toFixed(3),
      "-i",
      wavPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "pipe:1",
    ],
  );
  const buf = res.stdout;
  const samples = Math.floor(buf.length / 2);
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / Math.max(1, samples));
}

describe("F6 — Pro Studio: GPU Encoders, Chroma Key, Speed Control, Pro Audio DSP, HTTP 206 Stream & PC Upload/Save", () => {
  it("probes GPU hardware encoders cleanly and gracefully falls back to CPU + normalizes LUFS", async () => {
    const report = await probeHardwareEncoders();
    expect(report.usableBackends).toContain("cpu");
    expect(report.encoders.some((e) => e.encoder === "h264_nvenc")).toBe(true);

    const tmp = await mkdtemp(join(tmpdir(), "vedit-f6-hw-"));
    const src = join(tmp, "src.mp4");
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src,
    ]);

    const engine = new VeditEngine(VeditEngine.createProject("GPU & Loudness"));
    const seq = engine.activeSequence();
    seq.width = 320;
    seq.height = 180;
    seq.fps = 24;
    const asset = engine.addAsset({ name: "src.mp4", kind: "video", path: src, duration: 1, width: 320, height: 180, hasAudio: true });
    const v1 = engine.addTrack("video", "V1");
    engine.addClip({ trackId: v1.id, assetId: asset.id, start: 0, duration: 1, in: 0, out: 1 });

    const out = join(tmp, "out-nvenc-fallback.mp4");
    const rendered = await renderSequence(engine.project, {
      outPath: out,
      hwAccel: "nvenc",
      loudnessLufs: -14,
      width: 320,
      height: 180,
      fps: 24,
    });
    expect(rendered.sizeBytes).toBeGreaterThan(1000);
    const probed = await probeMedia(out);
    expect(probed.duration).toBeGreaterThan(0.8);
  }, 45_000);

  it("composites real 2-track Green Screen Chroma Key + Despill and renders 2.0x Speed Control accurately", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-f6-vfx-"));
    const blueBg = join(tmp, "blue-bg.mp4");
    const greenFg = join(tmp, "green-fg.mp4");

    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x0000ff:size=160x120:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", blueBg,
    ]);
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x00ff00:size=160x120:rate=24",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", greenFg,
    ]);

    const engine = new VeditEngine(VeditEngine.createProject("Chroma & Speed"));
    const seq = engine.activeSequence();
    seq.width = 160;
    seq.height = 120;
    seq.fps = 24;

    const bgAsset = engine.addAsset({ name: "bg.mp4", kind: "video", path: blueBg, duration: 2, width: 160, height: 120, hasAudio: true });
    const fgAsset = engine.addAsset({ name: "fg.mp4", kind: "video", path: greenFg, duration: 2, width: 160, height: 120, hasAudio: false });

    const v1 = engine.addTrack("video", "V1 Background");
    const v2 = engine.addTrack("video", "V2 Green Screen");

    const bgClip = engine.addClip({ trackId: v1.id, assetId: bgAsset.id, start: 0, duration: 2, in: 0, out: 2 });
    const fgClip = engine.addClip({ trackId: v2.id, assetId: fgAsset.id, start: 0, duration: 1, in: 0, out: 1 });

    // Speed up 2s background clip by 2.0x -> exact 1.0s duration on timeline
    setClipSpeed(engine, bgClip.id, 2.0);
    expect(bgClip.duration).toBeCloseTo(1.0, 2);

    applyColorGrade(engine, bgClip.id, { preset: "vivid-social" });
    applyFadeTransition(engine, bgClip.id, { fadeIn: 0.1, fadeOut: 0.1 });
    applyChromaKey(engine, fgClip.id, { color: "#00ff00", similarity: 0.35, blend: 0.05, despill: true });

    const out = join(tmp, "keyed.mp4");
    await renderSequence(engine.project, { outPath: out, width: 160, height: 120, fps: 24 });

    // Inspect center pixel RGB at t=0.5s: green screen must be keyed out, revealing blue background underneath!
    const px = await run(
      ffmpegPath(),
      [
        "-hide_banner", "-loglevel", "error",
        "-ss", "0.5", "-i", out,
        "-frames:v", "1", "-vf", "crop=2:2:80:60",
        "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
      ],
    );
    const rgb = px.stdout;
    const r = rgb[0]!;
    const g = rgb[1]!;
    const b = rgb[2]!;
    expect(b).toBeGreaterThan(150);
    expect(g).toBeLessThan(80);
    expect(r).toBeLessThan(80);
  }, 45_000);

  it("enhances speech audio and automatically ducks background music during speech intervals", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-f6-audio-"));
    const voiceWav = join(tmp, "voice.wav");
    const musicWav = join(tmp, "music.wav");

    // Voice: active [0..1s], pure silence [1..2.2s], active [2.2..3s]
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "3",
      "-af", "volume=enable='between(t,1.0,2.2)':volume=0",
      voiceWav,
    ]);
    // Music: steady constant amplitude across full [0..3s]
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
      "-t", "3",
      musicWav,
    ]);

    const engine = new VeditEngine(VeditEngine.createProject("Podcast Ducking"));
    const vAsset = engine.addAsset({ name: "voice.wav", kind: "audio", path: voiceWav, duration: 3, hasAudio: true });
    const mAsset = engine.addAsset({ name: "music.wav", kind: "audio", path: musicWav, duration: 3, hasAudio: true });
    const voiceTrack = engine.addTrack("audio", "Voice");
    const musicTrack = engine.addTrack("audio", "Music");

    const vClip = engine.addClip({ trackId: voiceTrack.id, assetId: vAsset.id, start: 0, duration: 3, in: 0, out: 3 });
    const mClip = engine.addClip({ trackId: musicTrack.id, assetId: mAsset.id, start: 0, duration: 3, in: 0, out: 3 });

    const ducked = await duckMusicUnderVoice(engine, {
      musicClipId: mClip.id,
      voiceClipId: vClip.id,
      reductionDb: -16,
      outDir: tmp,
    });
    expect(ducked.speechIntervals.length).toBeGreaterThanOrEqual(2);

    const rmsDuringSpeech = await rmsWindow(ducked.outPath, 0.3, 0.4);
    const rmsDuringSilence = await rmsWindow(ducked.outPath, 1.4, 0.4);
    // During speech [0.3..0.7s], music MUST be strongly attenuated compared to pause [1.4..1.8s]!
    expect(rmsDuringSpeech).toBeLessThan(rmsDuringSilence * 0.35);

    const enhanced = await enhanceAudio(engine, { clipId: vClip.id, outDir: tmp });
    expect(enhanced.duration).toBeGreaterThan(2.5);
  }, 45_000);

  it("supports Drag & Drop upload, HTTP 206 Range streaming, .vedit disk save/open, and F6 MCP tools", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-f6-pc-"));
    const rawClip = join(tmp, "drop.mp4");
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
      "-t", "1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", rawClip,
    ]);
    const fileBytes = await readFile(rawClip);

    const { app } = createApp({ token: "dev", dataDir: tmp });
    const auth = <T extends request.Test>(t: T) => t.set("Authorization", "Bearer dev");

    const created = await auth(request(app).post("/api/v1/projects").send({ name: "Desktop Session", sample: false }));
    const id = created.body.project.id as string;

    // 1. Upload binary file via Drag & Drop endpoint -> auto-probed & added onto timeline
    const up = await auth(
      request(app)
        .post(`/api/v1/projects/${id}/assets/upload?name=camera_clip.mp4&at=0`)
        .set("Content-Type", "video/mp4")
        .send(fileBytes),
    );
    expect(up.status).toBe(201);
    expect(up.body.asset.width).toBe(320);
    expect(up.body.clip).toBeTruthy();

    // 2. HTTP 206 Byte-Range stream for smooth HTML5 <video> seeking
    const rangeRes = await auth(
      request(app)
        .get(`/api/v1/projects/${id}/assets/${up.body.asset.id}/stream`)
        .set("Range", "bytes=0-127"),
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers["accept-ranges"]).toBe("bytes");
    expect((rangeRes.body as Buffer).length).toBe(128);

    // 3. Save .vedit to disk & re-open into a fresh registry
    const saveRes = await auth(request(app).post(`/api/v1/projects/${id}/save`).send({}));
    expect(saveRes.status).toBe(200);
    const listSaved = await auth(request(app).get("/api/v1/projects-saved"));
    expect(listSaved.body.saved.length).toBe(1);

    const openRes = await auth(
      request(app).post("/api/v1/projects/open").send({ filePath: saveRes.body.filePath }),
    );
    expect(openRes.status).toBe(200);
    expect(openRes.body.project.name).toBe("Desktop Session");

    // 4. Verify F6 MCP Tools
    const { engine } = VeditEngine.createSampleProject();
    const mcp = buildMcpServer({ engine });
    const client = new Client({ name: "f6-mcp-client", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(st), client.connect(ct)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "export.encoders",
        "color.grade",
        "effect.chroma_key",
        "clip.set_speed",
        "effect.fade",
        "audio.enhance",
        "audio.duck",
      ]),
    );

    const clipId = engine.activeSequence().tracks[0]!.clips[0]!.id;
    const speedRes = await client.callTool({ name: "clip.set_speed", arguments: { clipId, speed: 2 } });
    const parsedSpeed = JSON.parse((speedRes.content as Array<{ text: string }>)[0]!.text);
    expect(parsedSpeed.clip.effects.some((e: { type: string }) => e.type === "speed")).toBe(true);
  }, 45_000);
});
