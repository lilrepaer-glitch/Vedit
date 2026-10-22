import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { VeditEngine } from "../src/core/engine.js";
import { ffmpegPath, run, probeMedia } from "../src/core/media.js";
import {
  BUILTIN_LUTS,
  ensureBuiltInCubeLut,
  applyCubeLut,
  stabilizeClip,
  applyLayoutPreset,
} from "../src/pro/cinema.js";
import { exportEdl, exportFcpXml } from "../src/pro/interchange.js";
import { runStudioCopilot } from "../src/ai/orchestrator.js";
import { renderSequence } from "../src/render/export.js";
import { createApp } from "../src/server/app.js";
import { buildMcpServer } from "../src/mcp/server.js";

describe("F8 — Cinema 3D .cube LUTs, 2-Pass VidStab, PiP/Split Layouts, GIF Palette Export, EDL/FCPXML & AI Studio Copilot", () => {
  let workDir: string;
  let sampleVideo: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vedit-f8-"));
    sampleVideo = join(workDir, "sample.mp4");
    const res = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=1.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      sampleVideo,
    ]);
    expect(res.code).toBe(0);
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("generates standards-compliant 17x17x17 .cube LUTs and renders real FFmpeg lut3d output + optimal-palette .gif", async () => {
    expect(BUILTIN_LUTS.length).toBeGreaterThanOrEqual(5);
    const cubePath = await ensureBuiltInCubeLut("kodak-2383", join(workDir, "luts"));
    const cubeText = await readFile(cubePath, "utf8");
    expect(cubeText).toContain("LUT_3D_SIZE 17");

    const engine = new VeditEngine(VeditEngine.createProject("LUT + GIF Test"));
    const vTrack = engine.addTrack("video", "V1");
    const asset = engine.addAsset({ name: "hero.mp4", path: sampleVideo, kind: "video", duration: 1.5, width: 320, height: 180, fps: 24 });
    const clip = engine.addClip({ trackId: vTrack.id, assetId: asset.id, start: 0, duration: 1.2, in: 0, out: 1.2 });

    await applyCubeLut(engine, clip.id, { lutId: "kodak-2383", outDir: join(workDir, "luts") });
    applyLayoutPreset(engine, clip.id, "pip-bottom-right");
    expect(engine.findClipAnywhere(clip.id).clip.effects?.some((e) => e.type === "lut3d")).toBe(true);
    expect(engine.findClipAnywhere(clip.id).clip.transform.scaleX).toBeCloseTo(0.32);

    const mp4Out = join(workDir, "graded.mp4");
    const mp4Res = await renderSequence(engine.project, { outPath: mp4Out, width: 320, height: 180, fps: 15 });
    expect((await stat(mp4Res.outPath)).size).toBeGreaterThan(1000);

    const gifOut = join(workDir, "preview.gif");
    const gifRes = await renderSequence(engine.project, { outPath: gifOut, preset: "animated-gif" });
    expect(gifRes.codec).toBe("gif");
    const gifStat = await stat(gifOut);
    expect(gifStat.size).toBeGreaterThan(500);
    const gifHeader = (await readFile(gifOut)).subarray(0, 6).toString("ascii");
    expect(gifHeader.startsWith("GIF8")).toBe(true);
  }, 45_000);

  it("stabilizes shaky camera footage via 2-pass FFmpeg VidStab optical analysis", async () => {
    const engine = new VeditEngine(VeditEngine.createProject("Stabilize Test"));
    const vTrack = engine.addTrack("video", "V1");
    const asset = engine.addAsset({ name: "shaky.mp4", path: sampleVideo, kind: "video", duration: 1.5, width: 320, height: 180, fps: 24 });
    const clip = engine.addClip({ trackId: vTrack.id, assetId: asset.id, start: 0, duration: 1.2, in: 0, out: 1.2 });

    const stab = await stabilizeClip(engine, clip.id, { outDir: join(workDir, "stab") });
    expect(["vidstab-2pass", "deshake"]).toContain(stab.method);
    const info = await probeMedia(stab.outPath);
    expect(info.duration ?? 0).toBeGreaterThan(1.0);
  }, 45_000);

  it("exports valid CMX 3600 .edl and Final Cut Pro / DaVinci Resolve FCPXML v1.10 (.fcpxml)", () => {
    const engine = new VeditEngine(VeditEngine.createProject("Cinema Master Cut"));
    const vTrack = engine.addTrack("video", "V1");
    const asset = engine.addAsset({ name: "scene01.mp4", path: sampleVideo, kind: "video", duration: 1.5, width: 1920, height: 1080, fps: 24 });
    engine.addClip({ trackId: vTrack.id, assetId: asset.id, start: 0, duration: 1.5, in: 0, out: 1.5, label: "Opening Shot" });

    const edl = exportEdl(engine.project);
    expect(edl).toContain("TITLE:");
    expect(edl).toContain("FCM: NON-DROP FRAME");
    expect(edl).toContain("001  SCENE01M V     C        00:00:00:00");

    const xml = exportFcpXml(engine.project);
    expect(xml).toContain('<fcpxml version="1.10">');
    expect(xml).toContain("<asset-clip");
    expect(xml).toContain("scene01.mp4");
  });

  it("executes multi-step AI Studio Copilot workflows via REST and MCP with automatic checkpoint protection", async () => {
    const dataDir = join(workDir, "server-data");
    const { app, registry } = createApp({ token: "dev", dataDir });
    const auth = <T extends request.Test>(t: T) => t.set("Authorization", "Bearer dev");

    const health = await request(app).get("/api/v1/health").expect(200);
    expect(health.body.version).toBe("0.6.2");

    const created = await auth(request(app).post("/api/v1/projects").send({ name: "F8 Studio", sample: false })).expect(201);
    const pid = created.body.project.id as string;
    const engine = registry.get(pid);
    const vTrack = engine.addTrack("video", "V1");
    const asset = engine.addAsset({ name: "clipA.mp4", path: sampleVideo, kind: "video", duration: 1.5, width: 320, height: 180, fps: 24 });
    engine.addClip({ trackId: vTrack.id, assetId: asset.id, start: 0, duration: 1.5, in: 0, out: 1.5 });

    // Tag asset via REST
    const patched = await auth(
      request(app).patch(`/api/v1/projects/${pid}/assets/${asset.id}`).send({ tags: ["hero", "b-roll"] }),
    ).expect(200);
    expect(patched.body.asset.tags).toEqual(["hero", "b-roll"]);

    // Run multi-step AI Copilot via REST
    const copilotRes = await auth(
      request(app).post(`/api/v1/projects/${pid}/copilot`).send({
        prompt: 'Apply Kodak 2383 LUT, fade in, add lower third "Prague Cinema"',
      }),
    ).expect(200);
    expect(copilotRes.body.checkpointId).toBeTruthy();
    expect(copilotRes.body.stepsExecuted.length).toBeGreaterThanOrEqual(3);
    expect((engine.project.snapshots ?? []).some((v) => v.id === copilotRes.body.checkpointId)).toBe(true);
    expect((engine.project.auditLog ?? []).some((a) => a.action === "ai.copilot")).toBe(true);

    // EDL & FCPXML REST endpoints
    const edlHttp = await auth(request(app).get(`/api/v1/projects/${pid}/export/edl`)).expect(200);
    expect(edlHttp.text).toContain("FCM: NON-DROP FRAME");
    const xmlHttp = await auth(request(app).get(`/api/v1/projects/${pid}/export/fcpxml`)).expect(200);
    expect(xmlHttp.text).toContain('<fcpxml version="1.10">');

    // MCP tools verification
    const mcpServer = buildMcpServer(() => engine);
    const client = new Client({ name: "f8-test", version: "0.4.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const expected of [
      "ai.orchestrate",
      "cinema.list_luts",
      "cinema.apply_lut",
      "cinema.stabilize",
      "cinema.layout",
      "export.edl",
      "export.fcpxml",
      "media.update",
    ]) {
      expect(names).toContain(expected);
    }

    const direct = await runStudioCopilot(engine, "Apply teal orange LUT and picture-in-picture layout", { dataDir });
    expect(direct.stepsExecuted.length).toBeGreaterThanOrEqual(2);
    await client.close();
  }, 45_000);
});
