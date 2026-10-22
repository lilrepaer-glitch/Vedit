import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { VeditEngine } from "../src/core/engine.js";
import { ffmpegPath, run, probeMedia } from "../src/core/media.js";
import { analyzeFrameScopes } from "../src/pro/scopes.js";
import { syncMulticamClips, applyMulticamCuts } from "../src/pro/multicam.js";
import { reverseClip, freezeFrameClip } from "../src/pro/cinema.js";
import { evaluateKeyframeCurve, renderSequence } from "../src/render/export.js";
import { createApp } from "../src/server/app.js";
import { buildMcpServer } from "../src/mcp/server.js";

describe("F9 — Broadcast Video Scopes, Acoustic Multicam Sync, Eased Keyframe Curves, Reverse & Freeze Frame", () => {
  let workDir: string;
  let camAPath: string;
  let camBPath: string;
  let brightClipPath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vedit-f9-"));
    camAPath = join(workDir, "camA.mp4");
    camBPath = join(workDir, "camB.mp4");
    brightClipPath = join(workDir, "bright.mp4");

    // Camera A: 3.0s clip with an unmistakable 880 Hz slate clap burst between 1.25s and 1.45s
    const rA = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=3.0",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=3.0,volume='if(between(t,1.25,1.45),1.0,0.01)':eval=frame",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      camAPath,
    ]);
    expect(rA.code).toBe(0);

    // Camera B: started recording 0.75s AFTER Camera A -> same clap burst occurs at t = 0.50s..0.70s!
    const rB = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "smptebars=size=320x180:rate=24:duration=2.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=2.5,volume='if(between(t,0.50,0.70),1.0,0.01)':eval=frame",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      camBPath,
    ]);
    expect(rB.code).toBe(0);

    // Overexposed pure-white test clip to trigger Broadcast Highlight Clipping QC warning (>98 IRE)
    const rW = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:size=320x180:rate=24:duration=1.0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      brightClipPath,
    ]);
    expect(rW.code).toBe(0);
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("computes accurate Broadcast RGB Histograms, 48-col IRE Waveform & Highlight Clipping QC", async () => {
    const engine = new VeditEngine(VeditEngine.createProject("Scopes QC"));
    const v1 = engine.addTrack("video", "V1");
    const aBars = engine.addAsset({ name: "bars.mp4", kind: "video", path: camBPath, duration: 2.5 });
    const aWhite = engine.addAsset({ name: "white.mp4", kind: "video", path: brightClipPath, duration: 1.0 });

    engine.addClip({ trackId: v1.id, assetId: aBars.id, start: 0, duration: 1.5, in: 0, out: 1.5 });
    engine.addClip({ trackId: v1.id, assetId: aWhite.id, start: 1.5, duration: 1.0, in: 0, out: 1.0 });

    const legal = await analyzeFrameScopes(engine, { time: 0.5 });
    expect(legal.histogramBins).toBe(64);
    expect(legal.waveform.length).toBe(48);
    expect(legal.metrics.avgLumaIre).toBeGreaterThan(15);

    const clipped = await analyzeFrameScopes(engine, { time: 1.8 });
    expect(clipped.status).toBe("highlight-clipping");
    expect(clipped.metrics.whiteClippingPct).toBeGreaterThan(80);
  });

  it("acoustically synchronizes multi-camera angles with sub-20ms accuracy and switches program cuts", async () => {
    const engine = new VeditEngine(VeditEngine.createProject("Multicam Interview"));
    const a1 = engine.addAsset({ name: "CamA-Wide.mp4", kind: "video", path: camAPath, duration: 3.0, hasAudio: true });
    const a2 = engine.addAsset({ name: "CamB-Tight.mp4", kind: "video", path: camBPath, duration: 2.5, hasAudio: true });

    const synced = await syncMulticamClips(engine, { assetIds: [a1.id, a2.id], sampleRate: 4000 });
    expect(synced.angles.length).toBe(2);
    // Cam A starts at 0.00s, Cam B must be delayed by +0.75s (±0.03s) so both claps hit t = 1.25s simultaneously!
    expect(synced.angles[0]!.timelineStart).toBeCloseTo(0, 2);
    expect(Math.abs(synced.angles[1]!.timelineStart - 0.75)).toBeLessThan(0.04);
    expect(synced.angles[1]!.confidence).toBeGreaterThan(0.75);

    const switched = applyMulticamCuts(engine, {
      cuts: [
        { time: 0, angleIndex: 0 },
        { time: 1.2, angleIndex: 1 },
        { time: 2.2, angleIndex: 0 },
      ],
    });
    expect(switched.segmentCount).toBe(3);

    const rendered = join(workDir, "multicam-program.mp4");
    await renderSequence(engine.project, { outPath: rendered, width: 320, height: 180, fps: 15 });
    expect((await stat(rendered)).size).toBeGreaterThan(1000);
  }, 45_000);

  it("renders eased keyframe curves (`ease-in-out`, `ease-in`, `hold`) + reverses clips & inserts ripple freeze-frames", async () => {
    const engine = new VeditEngine(VeditEngine.createProject("Curves + Time Remap"));
    const v1 = engine.addTrack("video", "V1");
    const asset = engine.addAsset({ name: "action.mp4", kind: "video", path: camAPath, duration: 3.0, width: 320, height: 180, hasAudio: true });
    const clip = engine.addClip({ trackId: v1.id, assetId: asset.id, start: 0, duration: 2.0, in: 0, out: 2.0 });

    engine.updateClip(clip.id, {
      keyframes: [
        { time: 0, property: "x", value: -100, easing: "ease-in" },
        { time: 1, property: "x", value: 100, easing: "hold" },
        { time: 2, property: "x", value: 0, easing: "ease-in-out" },
        { time: 0, property: "opacity", value: 0.2, easing: "ease-in-out" },
        { time: 1, property: "opacity", value: 1.0, easing: "linear" },
      ],
    });

    const updated = engine.findClipAnywhere(clip.id).clip;
    // At u = 0.5 on quadratic ease-in (-100 -> +100): -100 + 200 * 0.25 = -50
    expect(evaluateKeyframeCurve(updated, "x", 0.5, 0)).toBeCloseTo(-50, 2);
    // On `hold` segment [1..2), value stays at +100 right until t = 2.0
    expect(evaluateKeyframeCurve(updated, "x", 1.7, 0)).toBeCloseTo(100, 2);

    const outEased = join(workDir, "eased.mp4");
    await renderSequence(engine.project, { outPath: outEased, width: 320, height: 180, fps: 15 });
    expect((await stat(outEased)).size).toBeGreaterThan(1000);

    // Reverse clip
    const rev = await reverseClip(engine, clip.id, { outDir: join(workDir, "rev") });
    expect(rev.reversedAsset.tags).toContain("reversed");
    expect((await probeMedia(rev.outPath)).duration ?? 0).toBeGreaterThan(2.5);

    // Freeze frame at t = 1.0s with 1.5s ripple hold -> total track span grows from 2.0s to 3.5s (3 clips: left + freeze + right)!
    const frz = await freezeFrameClip(engine, clip.id, { at: 1.0, holdDuration: 1.5, outDir: join(workDir, "frz") });
    expect(frz.freezeClip.duration).toBeCloseTo(1.5, 2);
    const finalClips = engine.findTrack(v1.id).clips.sort((a, b) => a.start - b.start);
    expect(finalClips.length).toBe(3);
    expect(finalClips[2]!.start + finalClips[2]!.duration).toBeCloseTo(3.5, 2);
  }, 45_000);

  it("exposes F9 endpoints over REST API and MCP Server", async () => {
    const dataDir = join(workDir, "api-data");
    const { app, registry } = createApp({ token: "dev", dataDir });
    const auth = <T extends request.Test>(t: T) => t.set("Authorization", "Bearer dev");

    const health = await request(app).get("/api/v1/health").expect(200);
    expect(health.body.version).toBe("0.7.0");

    const created = await auth(request(app).post("/api/v1/projects").send({ name: "F9 Studio", sample: false })).expect(201);
    const pid = created.body.project.id as string;
    const engine = registry.get(pid);
    engine.addAsset({ name: "CamA.mp4", kind: "video", path: camAPath, duration: 3.0, hasAudio: true });
    engine.addAsset({ name: "CamB.mp4", kind: "video", path: camBPath, duration: 2.5, hasAudio: true });

    const syncHttp = await auth(request(app).post(`/api/v1/projects/${pid}/multicam/sync`).send({})).expect(200);
    expect(syncHttp.body.angles.length).toBe(2);

    const cutsHttp = await auth(
      request(app).post(`/api/v1/projects/${pid}/multicam/cuts`).send({ autoIntervalSec: 1.0 }),
    ).expect(200);
    expect(cutsHttp.body.segmentCount).toBeGreaterThanOrEqual(2);

    const scopesHttp = await auth(request(app).get(`/api/v1/projects/${pid}/scopes?time=0.5`)).expect(200);
    expect(scopesHttp.body.histogramBins).toBe(64);

    const mcp = buildMcpServer(() => engine);
    const client = new Client({ name: "f9-mcp", version: "0.5.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(st), client.connect(ct)]);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of [
      "cinema.scopes",
      "cinema.reverse",
      "cinema.freeze_frame",
      "multicam.sync",
      "multicam.cuts",
      "keyframes.set_curve",
    ]) {
      expect(tools).toContain(expected);
    }
    await client.close();
  }, 45_000);
});
