// Milestone F14 (Vedit Studio v1.0.0 Flagship Verification Suite):
// 1. Duration-preserving monotonic Speed Ramp curve math (`evaluateSpeedRampProgress`)
// 2. Parametric Alpha Shape Masks (`circle`, `rectangle`, `split-h`, `split-v`, `linear`, `invert`, `feather`) + FFmpeg render
// 3. Layer Blend Modes (`screen`, `multiply`, `overlay`, `soft-light`, `color-dodge`) + FFmpeg render
// 4. REST API + MCP Tools + Multi-Turn AI Copilot (`speed_ramp`, `mask`, `blend`, `marker`)
// 5. Real Compiled Production Bundle UI Clickthrough (Interactive ◆ Keyframes, Shape Masks, Blend Modes, Speed Ramps, +M Markers, PNG Snapshot)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { JSDOM, VirtualConsole } from "jsdom";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { VeditEngine } from "../src/core/engine.js";
import { ffmpegPath } from "../src/core/media.js";
import { startServer } from "../src/server/index.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { renderSequence } from "../src/render/export.js";
import { runStudioCopilot } from "../src/ai/orchestrator.js";
import { VEDIT_VERSION } from "../src/pro/updater.js";
import {
  BLEND_MODE_PRESETS,
  MASK_SHAPE_PRESETS,
  SPEED_RAMP_PRESETS,
  applyClipBlend,
  applyClipMask,
  applySpeedRamp,
  buildMaskFfmpegFilter,
  evaluateSpeedRampProgress,
} from "../src/pro/compositing.js";

describe("F14 — Vedit Studio v1.0.0: Motion Keyframes, Shape Masks, Blend Modes, Speed Ramps & Frame Snapshot", () => {
  let tmpDir: string;
  let sampleVideoA: string;
  let sampleVideoB: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-f14-"));
    sampleVideoA = path.join(tmpDir, "clipA.mp4");
    sampleVideoB = path.join(tmpDir, "clipB.mp4");

    const ff = ffmpegPath();
    execFileSync(
      ff,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x180:rate=24:duration=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        sampleVideoA,
      ],
      { stdio: "ignore" },
    );

    execFileSync(
      ff,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x3b82f6:size=320x180:rate=24:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        sampleVideoB,
      ],
      { stdio: "ignore" },
    );

    srv = startServer({ port: 0, host: "127.0.0.1", token: "dev", dataDir: path.join(tmpDir, "data"), quiet: true });
    if (!srv.server.listening) {
      await new Promise<void>((res) => srv.server.once("listening", () => res()));
    }
    const addr = srv.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    srv?.server?.closeAllConnections?.();
    await new Promise<void>((res) => (srv?.server ? srv.server.close(() => res()) : res()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("verifies v1.0.0 flagship version & strictly monotonic duration-preserving speed-ramp curves", () => {
    expect(VEDIT_VERSION).toBe("1.0.0");
    expect(MASK_SHAPE_PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(BLEND_MODE_PRESETS.length).toBeGreaterThanOrEqual(9);
    expect(SPEED_RAMP_PRESETS.length).toBeGreaterThanOrEqual(6);

    for (const preset of SPEED_RAMP_PRESETS) {
      expect(evaluateSpeedRampProgress(preset.id, 0)).toBe(0);
      expect(evaluateSpeedRampProgress(preset.id, 1)).toBeCloseTo(1, 5);
      let prev = 0;
      for (let i = 1; i <= 50; i++) {
        const cur = evaluateSpeedRampProgress(preset.id, i / 50);
        expect(cur).toBeGreaterThan(prev);
        expect(cur).toBeLessThanOrEqual(1);
        prev = cur;
      }
    }

    // Hero Slow-Mo moves faster at start/end and slower through the center!
    const earlyDelta = evaluateSpeedRampProgress("hero-slowmo", 0.2) - evaluateSpeedRampProgress("hero-slowmo", 0);
    const midDelta = evaluateSpeedRampProgress("hero-slowmo", 0.6) - evaluateSpeedRampProgress("hero-slowmo", 0.4);
    expect(earlyDelta).toBeGreaterThan(midDelta);
  });

  it("renders multi-layer feathered alpha Shape Masks + Blend Modes cleanly through real FFmpeg export", async () => {
    const engine = new VeditEngine(VeditEngine.createProject("F14 Render Test", { width: 320, height: 180, fps: 24 }));
    const seq = engine.activeSequence();
    const v1 = engine.addTrack("video", "V1 Base");
    const v2 = engine.addTrack("video", "V2 Overlay");

    const a1 = engine.addAsset({ name: "base.mp4", path: sampleVideoA, kind: "video", duration: 2, width: 320, height: 180 });
    const a2 = engine.addAsset({ name: "overlay.mp4", path: sampleVideoB, kind: "video", duration: 2, width: 320, height: 180 });

    const baseClip = engine.addClip({ trackId: v1.id, assetId: a1.id, start: 0, in: 0, out: 1.5, duration: 1.5 });
    const overClip = engine.addClip({ trackId: v2.id, assetId: a2.id, start: 0, in: 0, out: 1.5, duration: 1.5 });

    applySpeedRamp(engine, baseClip.id, "montage-in", 1);
    const maskFx = applyClipMask(engine, overClip.id, { shape: "circle", scale: 0.72, feather: 20 });
    const blendFx = applyClipBlend(engine, overClip.id, "screen", 0.9);

    expect(maskFx?.type).toBe("mask");
    expect(blendFx?.type).toBe("blend");
    expect(buildMaskFfmpegFilter({ shape: "circle", scale: 0.72, feather: 20 })).toContain("format=yuva420p,geq=");

    const outMp4 = path.join(tmpDir, "f14_masked_blended.mp4");
    const rendered = await renderSequence(engine.project, { outPath: outMp4, width: 320, height: 180, fps: 24 });
    expect(rendered.warnings).toEqual([]);
    expect(fs.existsSync(outMp4)).toBe(true);
    expect(fs.statSync(outMp4).size).toBeGreaterThan(1500);
  });

  it("exposes REST endpoints, MCP tools, and multi-turn AI Copilot actions for masks, blends, speed ramps & markers", async () => {
    const createRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "F14 API Project", sample: false }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    const pid = project.id;
    const mkTrackRes = await fetch(`${baseUrl}/api/v1/projects/${pid}/tracks`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "video", name: "V1" }),
    });
    const { track: createdVTrack } = (await mkTrackRes.json()) as { track: { id: string } };
    const vTrackId = createdVTrack.id;

    const presetsRes = await fetch(`${baseUrl}/api/v1/compositing/presets`, {
      headers: { Authorization: "Bearer dev" },
    });
    expect(presetsRes.ok).toBe(true);

    const assetRes = await fetch(`${baseUrl}/api/v1/projects/${pid}/assets`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "shot.mp4", path: sampleVideoA, kind: "video", duration: 2 }),
    });
    const { asset } = (await assetRes.json()) as { asset: { id: string } };

    const clipRes = await fetch(`${baseUrl}/api/v1/projects/${pid}/clips`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: vTrackId, assetId: asset.id, start: 0, duration: 2, in: 0, out: 2 }),
    });
    const { clip } = (await clipRes.json()) as { clip: { id: string } };

    // REST mask + blend + speed-ramp + marker create/delete
    for (const [sub, payload] of [
      [`clips/${clip.id}/mask`, { shape: "rectangle", scale: 0.8, feather: 18 }],
      [`clips/${clip.id}/blend`, { mode: "soft-light" }],
      [`clips/${clip.id}/speed-ramp`, { preset: "bullet", intensity: 1 }],
    ] as const) {
      const r = await fetch(`${baseUrl}/api/v1/projects/${pid}/${sub}`, {
        method: "POST",
        headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(r.ok).toBe(true);
    }

    const mkRes = await fetch(`${baseUrl}/api/v1/projects/${pid}/markers`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ time: 0.75, label: "M1" }),
    });
    expect(mkRes.status).toBe(201);
    const { marker } = (await mkRes.json()) as { marker: { id: string } };

    const delMk = await fetch(`${baseUrl}/api/v1/projects/${pid}/markers/${marker.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer dev" },
    });
    expect(delMk.ok).toBe(true);

    // MCP Tools check
    const engine = new VeditEngine(VeditEngine.createProject("MCP F14"));
    const mcpTrack = engine.addTrack("video", "V1");
    const mcpAsset = engine.addAsset({ name: "mcp.mp4", path: sampleVideoA, kind: "video", duration: 2 });
    const mcpClip = engine.addClip({
      trackId: mcpTrack.id,
      assetId: mcpAsset.id,
      start: 0,
      in: 0,
      out: 2,
      duration: 2,
    });

    const mcp = buildMcpServer({ engine });
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "f14-verifier", version: "1.0.0" });
    await Promise.all([mcp.connect(t1), client.connect(t2)]);

    const r1 = await client.callTool({ name: "vfx.apply_mask", arguments: { clipId: mcpClip.id, shape: "circle", feather: 16 } });
    expect(r1.isError).toBeFalsy();
    const r2 = await client.callTool({ name: "vfx.apply_blend", arguments: { clipId: mcpClip.id, mode: "overlay" } });
    expect(r2.isError).toBeFalsy();
    const r3 = await client.callTool({ name: "vfx.apply_speed_ramp", arguments: { clipId: mcpClip.id, preset: "hero-slowmo" } });
    expect(r3.isError).toBeFalsy();
    await client.close();

    // AI Studio Copilot offline fallback check
    const copilotRes = await runStudioCopilot(engine, "Apply bullet time speed ramp, circle mask, and screen blend mode", {
      selectedClipId: mcpClip.id,
    });
    expect(copilotRes.stepsExecuted.some((s) => s.step === "clip.speed_ramp")).toBe(true);
    expect(copilotRes.stepsExecuted.some((s) => s.step === "vfx.mask")).toBe(true);
    expect(copilotRes.stepsExecuted.some((s) => s.step === "vfx.blend")).toBe(true);
  });

  it("mounts compiled v1.0.0 production bundle in JSDOM and interactively clicks Keyframes, Speed Ramps, Shape Masks, Blend Modes & Markers with zero errors", async () => {
    const distDir = path.resolve("apps/desktop/dist");
    const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
    const errors: string[] = [];
    const vc = new VirtualConsole();
    let pngAnchorTriggered = false;
    vc.on("jsdomError", (err) => {
      if (err.message.includes("Not implemented: navigation to another Document")) {
        pngAnchorTriggered = true;
        return;
      }
      errors.push(err.message);
    });

    const dom = new JSDOM(html, {
      url: baseUrl,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: vc,
    });
    const w = dom.window as unknown as Window & typeof globalThis & { __VEDIT_PORT__?: number };
    const port = (srv.server.address() as http.AddressInfo).port;
    w.__VEDIT_PORT__ = port;
    Object.defineProperty(w, "innerWidth", { value: 1366, configurable: true });
    Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    w.HTMLCanvasElement.prototype.getContext = (() => ({
      save: () => {},
      restore: () => {},
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      measureText: (txt: string) => ({ width: txt.length * 8 }),
      fillText: () => {},
      strokeText: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      getImageData: (_x: number, _y: number, gw: number, gh: number) => ({
        data: new Uint8ClampedArray(Math.max(4, gw * gh * 4)),
        width: gw,
        height: gh,
      }),
      putImageData: () => {},
    })) as unknown as typeof w.HTMLCanvasElement.prototype.getContext;
    w.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(input), baseUrl).toString();
      const { signal: _sig, ...safeInit } = init ?? {};
      return globalThis.fetch(target, safeInit);
    }) as typeof fetch;

    for (const cssTag of Array.from(w.document.querySelectorAll('link[rel="stylesheet"]'))) {
      const href = cssTag.getAttribute("href")?.replace(/^\.\//, "").replace(/^\//, "");
      if (href && fs.existsSync(path.join(distDir, href))) {
        const st = w.document.createElement("style");
        st.textContent = fs.readFileSync(path.join(distDir, href), "utf8");
        w.document.head.appendChild(st);
      }
    }
    for (const sc of Array.from(w.document.querySelectorAll('script[src]'))) {
      const src = sc.getAttribute("src")?.replace(/^\.\//, "").replace(/^\//, "");
      if (src && fs.existsSync(path.join(distDir, src))) {
        const inline = w.document.createElement("script");
        inline.textContent = fs.readFileSync(path.join(distDir, src), "utf8");
        w.document.body.appendChild(inline);
      }
    }

    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(350);

    // Seed a clip in the active project so interactive clip controls apply to a live clip
    const listRes = await globalThis.fetch(`${baseUrl}/api/v1/projects`, { headers: { Authorization: "Bearer dev" } });
    const { projects } = (await listRes.json()) as { projects: Array<{ id: string }> };
    const activePid = projects[0]!.id;
    const pRes = await globalThis.fetch(`${baseUrl}/api/v1/projects/${activePid}`, { headers: { Authorization: "Bearer dev" } });
    const { project: activeProj } = (await pRes.json()) as { project: { sequences: Array<{ tracks: Array<{ id: string; kind: string }> }> } };
    const trId = activeProj.sequences[0]!.tracks.find((t) => t.kind === "video")!.id;
    const aRes = await globalThis.fetch(`${baseUrl}/api/v1/projects/${activePid}/assets`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hero.mp4", path: sampleVideoA, kind: "video", duration: 2 }),
    });
    const { asset: seededAsset } = (await aRes.json()) as { asset: { id: string } };
    await globalThis.fetch(`${baseUrl}/api/v1/projects/${activePid}/clips`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: trId, assetId: seededAsset.id, start: 0, duration: 2, in: 0, out: 2 }),
    });

    // Click "+M" timeline marker button
    const clickByText = async (label: string) => {
      const btn = Array.from(w.document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === label,
      );
      expect(btn, `Expected button "${label}" to exist`).toBeTruthy();
      btn!.click();
      await wait(90);
    };

    try {
      await clickByText("+M");
      await clickByText("Edit");
      await clickByText("Bullet Time");
      await clickByText("◆ + Keyframe");
      await clickByText("Canvas");
      await clickByText("Circle");
      await clickByText("Screen");
      await clickByText("PNG");

      const rootText = w.document.getElementById("root")?.textContent ?? "";
      expect(pngAnchorTriggered).toBe(true);
      expect(errors).toEqual([]);
      expect(rootText).not.toContain("Vedit Studio Recovery");
      expect(rootText).toContain("hero.mp4 · Ramp · Mask");
      expect(rootText).toContain("M1");

      const verifyRes = await globalThis.fetch(`${baseUrl}/api/v1/projects/${activePid}`, {
        headers: { Authorization: "Bearer dev" },
      });
      const { project: finalProj } = (await verifyRes.json()) as {
        project: {
          markers: Array<{ label: string }>;
          sequences: Array<{ tracks: Array<{ clips: Array<{ keyframes: unknown[]; effects: Array<{ type: string }> }> }> }>;
        };
      };
      expect(finalProj.markers.length).toBeGreaterThanOrEqual(1);
      const editedClip = finalProj.sequences[0]!.tracks[0]!.clips[0]!;
      expect(editedClip.keyframes.length).toBeGreaterThanOrEqual(6);
      expect(editedClip.effects.some((e) => e.type === "speed-ramp")).toBe(true);
      expect(editedClip.effects.some((e) => e.type === "mask")).toBe(true);
      expect(editedClip.effects.some((e) => e.type === "blend")).toBe(true);
    } finally {
      dom.window.close();
    }
  });
});
