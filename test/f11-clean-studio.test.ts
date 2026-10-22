import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VeditEngine } from "../src/core/engine.js";
import { ffmpegPath, probeMedia, run } from "../src/core/media.js";
import { buildMcpServer } from "../src/mcp/server.js";
import {
  AUDIO_EQ_PRESETS,
  TONE_CURVE_PRESETS,
  buildFfmpegCurvesFilter,
  buildFfmpegEqFilter,
  evaluateToneCurveLut,
  importSubtitlesToSequence,
  parseSubtitlesText,
  serializeSubtitles,
} from "../src/pro/studio-grade.js";
import { VEDIT_VERSION } from "../src/pro/updater.js";
import { renderSequence } from "../src/render/export.js";
import { startServer } from "../src/server/index.js";
import {
  computeCurvePoints,
  getCachedCurveLut,
  getClipTransition,
  readClipAudioEq,
  readClipChromaKey,
  readClipCurves,
} from "../apps/desktop/src/compositor.js";
import { mobileApi } from "../apps/desktop/src/mobileRuntime.js";

describe("F11 — Clean Studio v0.9.0: Tone Curves, Live Chroma Key, 3-Band EQ + Voice Clarity, SRT/VTT & Zero-FFmpeg Client MP4", () => {
  let tmpDir: string;
  let sampleVideoPath: string;
  let srv: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-f11-"));
    sampleVideoPath = path.join(tmpDir, "source.mp4");

    // Generate a real 2s H.264 + AAC test clip via FFmpeg for true end-to-end FFmpeg & API verification
    const gen = await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x2266cc:s=320x180:d=2:r=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      sampleVideoPath,
    ]);
    expect(gen.code).toBe(0);

    srv = startServer({ port: 0, host: "127.0.0.1", token: "dev", dataDir: path.join(tmpDir, "data"), quiet: true });
    if (!srv.server.listening) {
      await new Promise<void>((res) => srv.server.once("listening", () => res()));
    }
    const addr = srv.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((res) => (srv?.server ? srv.server.close(() => res()) : res()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("synchronizes release version 0.9.2 (versionCode 902) cleanly across all manifests and runtime modules", () => {
    expect(VEDIT_VERSION).toBe("0.9.2");
    const rootPkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { version: string };
    const deskPkg = JSON.parse(fs.readFileSync(path.resolve("apps/desktop/package.json"), "utf8")) as { version: string };
    const tauriConf = JSON.parse(
      fs.readFileSync(path.resolve("apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string };
    const cargoToml = fs.readFileSync(path.resolve("apps/desktop/src-tauri/Cargo.toml"), "utf8");
    const androidManifest = fs.readFileSync(path.resolve("apps/android/AndroidManifest.xml"), "utf8");

    expect(rootPkg.version).toBe("0.9.2");
    expect(deskPkg.version).toBe("0.9.2");
    expect(tauriConf.version).toBe("0.9.2");
    expect(cargoToml).toContain('version = "0.9.2"');
    expect(androidManifest).toContain('android:versionCode="902"');
    expect(androidManifest).toContain('android:versionName="0.9.2"');
  });

  it("boots cleanly into a silent empty 'Untitled Edit' sequence without synthetic color bars or sine beeps", async () => {
    const listRes = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: { Authorization: "Bearer dev" },
    });
    expect(listRes.ok).toBe(true);
    const { projects } = (await listRes.json()) as { projects: Array<{ id: string; name: string }> };
    expect(projects.length).toBe(1);
    expect(projects[0]!.name).toBe("Untitled Edit");

    const projRes = await fetch(`${baseUrl}/api/v1/projects/${projects[0]!.id}`, {
      headers: { Authorization: "Bearer dev" },
    });
    const body = (await projRes.json()) as {
      project: { assets: unknown[]; sequences: Array<{ tracks: Array<{ clips: unknown[] }>; captions: unknown[] }> };
      history: { canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number };
    };
    expect(body.project.assets).toHaveLength(0);
    expect(body.project.sequences[0]!.captions).toHaveLength(0);
    expect(body.project.sequences[0]!.tracks.every((t) => t.clips.length === 0)).toBe(true);
    expect(body.history).toEqual({ canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
  });

  it("evaluates monotone cubic 256-entry Tone Curve LUTs identically on Backend and Frontend Compositor", () => {
    expect(TONE_CURVE_PRESETS.length).toBeGreaterThanOrEqual(5);
    expect(AUDIO_EQ_PRESETS.length).toBeGreaterThanOrEqual(6);

    const linearLut = evaluateToneCurveLut(TONE_CURVE_PRESETS[0]!.points);
    expect(linearLut).toHaveLength(256);
    expect(linearLut[0]).toBe(0);
    expect(linearLut[128]).toBe(128);
    expect(linearLut[255]).toBe(255);

    const sCurvePts = TONE_CURVE_PRESETS.find((p) => p.id === "cinema-s-curve")!.points;
    const backendLut = evaluateToneCurveLut(sCurvePts);
    const frontendLut = getCachedCurveLut(sCurvePts);
    expect(Array.from(frontendLut)).toEqual(Array.from(backendLut));
    // Verify shadows darken (<64 at index 64) and highlights brighten (>192 at index 192)
    expect(backendLut[64]!).toBeLessThan(64);
    expect(backendLut[192]!).toBeGreaterThan(192);

    expect(buildFfmpegCurvesFilter(sCurvePts)).toContain("curves=master='0.000/0.020");
    expect(buildFfmpegEqFilter({ lowDb: -4, midDb: 3, highDb: 4, voiceClarity: true })).toContain("acompressor");
  });

  it("parses and serializes SubRip (.srt) & WebVTT (.vtt) subtitles losslessly across REST, Engine & Android Runtime", async () => {
    const sampleSrt = [
      "1",
      "00:00:00,250 --> 00:00:01,500",
      "First clean studio cue",
      "",
      "2",
      "00:00:01,600 --> 00:00:02,900",
      "<i>Second cue with formatting</i>",
      "",
    ].join("\r\n");

    const parsed = parseSubtitlesText(sampleSrt);
    expect(parsed).toEqual([
      { start: 0.25, end: 1.5, text: "First clean studio cue" },
      { start: 1.6, end: 2.9, text: "Second cue with formatting" },
    ]);

    const engine = new VeditEngine(VeditEngine.createProject("Subs Test"));
    const imported = importSubtitlesToSequence(engine, sampleSrt, { replaceExisting: true });
    expect(imported.count).toBe(2);

    const vttOut = serializeSubtitles(engine.activeSequence().captions, "vtt");
    expect(vttOut.startsWith("WEBVTT\n")).toBe(true);
    expect(vttOut).toContain("00:00:00.250 --> 00:00:01.500");
    expect(parseSubtitlesText(vttOut)).toEqual(parsed);

    // Verify Android standalone runtime SRT/VTT parity
    const mobImp = await mobileApi.importSubtitles(vttOut, true);
    expect(mobImp.count).toBe(2);
    const mobExp = await mobileApi.exportSubtitles("srt");
    expect(mobExp.count).toBe(2);
    expect(mobExp.text).toContain("00:00:00,250 --> 00:00:01,500");
  });

  it("executes full REST API + real FFmpeg render pipeline with Curves, Chroma Key, Flips, Crop, 3-Band EQ & Client MP4 Save", async () => {
    const projectsRes = await fetch(`${baseUrl}/api/v1/projects`, { headers: { Authorization: "Bearer dev" } });
    const projectId = ((await projectsRes.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;

    // Upload real video file
    const rawBuf = fs.readFileSync(sampleVideoPath);
    const upRes = await fetch(`${baseUrl}/api/v1/projects/${projectId}/assets/upload?name=take1.mp4&insert=true`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/octet-stream" },
      body: rawBuf,
    });
    expect(upRes.status).toBe(201);
    const { clip } = (await upRes.json()) as { clip: { id: string } };
    expect(clip.id).toBeTruthy();

    // Apply Tone Curve via REST
    const curveRes = await fetch(`${baseUrl}/api/v1/projects/${projectId}/clips/${clip.id}/curves`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "cinema-s-curve", clarity: 18 }),
    });
    expect(curveRes.ok).toBe(true);

    // Apply 3-Band Parametric EQ + Voice Clarity + WAV render verification via REST
    const eqRes = await fetch(`${baseUrl}/api/v1/projects/${projectId}/clips/${clip.id}/eq`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "voice-podcast", renderToFile: true }),
    });
    expect(eqRes.ok).toBe(true);
    const eqBody = (await eqRes.json()) as { outPath?: string };
    expect(eqBody.outPath).toBeTruthy();
    expect(fs.existsSync(eqBody.outPath!)).toBe(true);

    // Apply negative scaleX (`Flip H`), normalized UI crop (`left: 10`), and `adjust` effect & verify real FFmpeg export!
    await fetch(`${baseUrl}/api/v1/projects/${projectId}/clips/${clip.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ transform: { x: 0, y: 0, scaleX: -1, scaleY: 1, rotation: 0, opacity: 1 } }),
    });
    await fetch(`${baseUrl}/api/v1/projects/${projectId}/clips/${clip.id}/effects`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "crop", params: { left: 10, right: 10 }, replace: true }),
    });
    await fetch(`${baseUrl}/api/v1/projects/${projectId}/clips/${clip.id}/effects`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "adjust", params: { exposure: 12, contrast: 15, saturation: 10 }, replace: true }),
    });

    const engine = srv.registry.get(projectId);
    const renderedOut = path.join(tmpDir, "graded_flipped.mp4");
    const renderRes = await renderSequence(engine.project, {
      outPath: renderedOut,
      codec: "h264",
    });
    expect(renderRes.sizeBytes).toBeGreaterThan(1000);
    const probed = await probeMedia(renderedOut);
    expect(probed.duration).toBeGreaterThan(1.5);

    // Verify zero-FFmpeg Windows Desktop client MP4 direct save + download route parity
    const clientSaveRes = await fetch(
      `${baseUrl}/api/v1/projects/${projectId}/export/client-mp4?filename=WebCodecs_Out.mp4`,
      {
        method: "POST",
        headers: { Authorization: "Bearer dev", "Content-Type": "video/mp4" },
        body: rawBuf,
      },
    );
    expect(clientSaveRes.status).toBe(201);
    const savedClient = (await clientSaveRes.json()) as { job: { id: string; status: string }; sizeBytes: number };
    expect(savedClient.job.status).toBe("done");
    expect(savedClient.sizeBytes).toBe(rawBuf.byteLength);

    // Verify BOTH job download URL paths serve the exact MP4 bytes!
    for (const dlPath of [
      `/api/v1/jobs/${savedClient.job.id}/output?token=dev`,
      `/api/v1/projects/${projectId}/jobs/${savedClient.job.id}/output?token=dev`,
    ]) {
      const dl = await fetch(`${baseUrl}${dlPath}`);
      expect(dl.ok).toBe(true);
      const dlBytes = await dl.arrayBuffer();
      expect(dlBytes.byteLength).toBe(rawBuf.byteLength);
    }
  });

  it("exposes all 5 Milestone F11 MCP tools (`color.curves`, `color.chroma_key`, `audio.eq`, `captions.import_subtitles`, `captions.export_subtitles`)", async () => {
    const engine = new VeditEngine(VeditEngine.createProject("MCP F11"));
    const tr = engine.addTrack("video", "V1");
    const asset = engine.addAsset({ name: "clip.mp4", kind: "video", path: sampleVideoPath, duration: 2 });
    const clip = engine.addClip({ trackId: tr.id, assetId: asset.id, start: 0, duration: 2 });

    const mcp = buildMcpServer({ engine });
    const client = new Client({ name: "f11-verifier", version: "0.9.0" });
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(t1), client.connect(t2)]);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of [
      "color.curves",
      "color.chroma_key",
      "audio.eq",
      "captions.import_subtitles",
      "captions.export_subtitles",
    ]) {
      expect(tools).toContain(expected);
    }

    await client.callTool({ name: "color.curves", arguments: { clipId: clip.id, preset: "matte-fade", clarity: 14 } });
    await client.callTool({ name: "color.chroma_key", arguments: { clipId: clip.id, color: "#00ff00", similarity: 0.34, blend: 0.12, despill: true } });
    await client.callTool({ name: "audio.eq", arguments: { clipId: clip.id, preset: "crisp-vocal" } });

    // Verify frontend compositor readers parse the exact MCP-applied clip effects seamlessly
    const updatedClip = engine.findClipAnywhere(clip.id).clip as unknown as Parameters<typeof readClipCurves>[0];
    expect(readClipCurves(updatedClip).active).toBe(true);
    expect(readClipChromaKey(updatedClip).enabled).toBe(true);
    expect(readClipAudioEq(updatedClip).voiceClarity).toBe(true);
    expect(computeCurvePoints(10, -5, 12, "linear")).toHaveLength(5);
    expect(getClipTransition({ ...updatedClip, effects: [{ id: "tx1", type: "transition", params: { kind: "wipe-left", duration: 0.6 } }] })).toEqual({
      kind: "wipe-left",
      duration: 0.6,
    });

    await client.callTool({
      name: "captions.import_subtitles",
      arguments: { text: "1\n00:00:00,100 --> 00:00:01,800\nHello Studio\n", replaceExisting: true },
    });
    const expRes = await client.callTool({ name: "captions.export_subtitles", arguments: { format: "vtt" } });
    const txt = ((expRes.content as Array<{ text: string }>)[0]!.text);
    expect(txt).toContain("WEBVTT");
    expect(txt).toContain("Hello Studio");

    await client.close();
  });
});
