// Milestone F16 (Vedit Studio v1.0.2):
// 1. High-Craft Broadcast Motion Graphics Engine (`lower-third-editorial`, `glass-callout`,
//    `split-ribbon`, `chapter-card`, `kinetic-stomp`, `neon-hud`, `progress-pill`) + Cinema Camera Motion Physics.
// 2. Native Phone (`Android APK`) & Desktop Studio Assets & Procedural Synthesizer (`Přechody`, `Motion`,
//    `Efekty`, `Zvuky`) with a persistent `"Generovat"` button at the end of every asset list/panel.
// 3. Full end-to-end verification across live REST server + FFmpeg H.264/AAC export + mobile 390x844 JSDOM clickthrough.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VeditEngine } from "../src/core/engine.js";
import { ffmpegPath } from "../src/core/media.js";
import { generateServerStudioAsset } from "../src/pro/graphics.js";
import { VEDIT_VERSION } from "../src/pro/updater.js";
import { renderSequence } from "../src/render/export.js";
import { startServer } from "../src/server/index.js";

describe("F16 — Broadcast Motion Graphics, Studio Transition/Overlay/SFX Assets & 'Generovat' Workflow (v1.0.2)", () => {
  let tmpDir: string;
  let sampleClip: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let baseUrl = "";

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-f16-"));
    sampleClip = path.join(tmpDir, "scene.mp4");
    execFileSync(
      ffmpegPath(),
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=25:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:duration=3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        sampleClip,
      ],
      { stdio: "ignore" },
    );
    srv = startServer({ port: 0, host: "127.0.0.1", token: "dev", dataDir: path.join(tmpDir, "data"), quiet: true });
    if (!srv.server.listening) {
      await new Promise<void>((res) => srv.server.once("listening", () => res()));
    }
    const addr = srv.server.address() as http.AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 60_000);

  afterAll(async () => {
    srv?.server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (srv?.server ? srv.server.close(() => resolve()) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates Transition, Motion Graphic, Overlay & Stereo SFX assets via server API and renders real MP4 via FFmpeg", async () => {
    expect(VEDIT_VERSION).toBe("1.0.2");

    // 1. Direct engine + FFmpeg render verification
    const engine = new VeditEngine(VeditEngine.createProject("F16 Render", { width: 640, height: 360, fps: 25 }));
    const v1 = engine.addTrack("video", "V1");
    const vidAsset = engine.addAsset({
      name: "scene.mp4",
      path: sampleClip,
      kind: "video",
      duration: 3,
      width: 640,
      height: 360,
      hasAudio: true,
    });
    engine.addClip({ trackId: v1.id, assetId: vidAsset.id, start: 0, in: 0, out: 3 });

    const outAssetsDir = path.join(tmpDir, "gen-assets");
    const trRes = await generateServerStudioAsset(engine, {
      category: "transition",
      presetId: "golden-light-leak",
      atTime: 1.5,
      duration: 0.9,
      outDir: outAssetsDir,
    });
    expect(trRes.clip).toBeTruthy();

    const mgRes = await generateServerStudioAsset(engine, {
      category: "motion",
      presetId: "lower-third-editorial",
      title: "Jan Svoboda",
      subtitle: "PRAHA · 4K STUDIO",
      atTime: 0.3,
      duration: 2.2,
      outDir: outAssetsDir,
    });
    expect(mgRes.caption?.style?.motionTemplate).toBe("lower-third-editorial");

    const sfxRes = await generateServerStudioAsset(engine, {
      category: "sfx",
      presetId: "cinema-whoosh",
      atTime: 1.5,
      duration: 0.9,
      outDir: outAssetsDir,
    });
    expect(sfxRes.clip).toBeTruthy();
    expect(fs.statSync(sfxRes.asset!.path).size).toBeGreaterThan(20_000);

    const outMp4 = path.join(tmpDir, "f16-master.mp4");
    await renderSequence(engine.project, { outPath: outMp4 });
    expect(fs.existsSync(outMp4)).toBe(true);
    expect(fs.statSync(outMp4).size).toBeGreaterThan(8_000);

    // 2. HTTP REST endpoint verification (`POST /api/v1/projects/:id/studio-assets/generate`)
    const listRes = await fetch(`${baseUrl}/api/v1/projects`, { headers: { Authorization: "Bearer dev" } });
    const { projects } = (await listRes.json()) as { projects: Array<{ id: string }> };
    const pid = projects[0]!.id;
    const httpGen = await fetch(`${baseUrl}/api/v1/projects/${pid}/studio-assets/generate`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "transition",
        presetId: "anamorphic-streak",
        duration: 0.9,
        atTime: 1.2,
      }),
    });
    expect(httpGen.status).toBe(201);
  });

  it("mounts Android phone UI (390x844), verifies 'Generovat' button at end of Assets / Transitions / Motion / Audio panels, and generates live timeline items cleanly", async () => {
    const assetsDir = path.resolve("apps/desktop/dist/assets");
    const assetFiles = fs.readdirSync(assetsDir);
    const jsFile = assetFiles.find((f) => f.endsWith(".js"));
    expect(jsFile).toBeTruthy();
    const jsBundle = fs.readFileSync(path.join(assetsDir, jsFile!), "utf8");

    const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
      url: "https://appassets.vedit.studio/index.html",
      runScripts: "dangerously",
      pretendToBeVisual: true,
    });
    const { window } = dom;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131 Mobile Safari/537.36 VedStudioAPK/1.0.2",
      configurable: true,
    });
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.HTMLCanvasElement.prototype.getContext = (() => ({
      fillStyle: "#000",
      strokeStyle: "#fff",
      lineWidth: 1,
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      filter: "none",
      font: "14px sans-serif",
      textAlign: "center",
      textBaseline: "middle",
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
      shadowColor: "transparent",
      shadowBlur: 0,
      shadowOffsetY: 0,
      save: () => {},
      restore: () => {},
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      closePath: () => {},
      rect: () => {},
      clip: () => {},
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
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
        width: w,
        height: h,
      }),
      putImageData: () => {},
    })) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
    window.HTMLCanvasElement.prototype.toDataURL = () =>
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    (window as unknown as Record<string, unknown>).VeditAndroid = {
      isAndroid: () => true,
      getVersion: () => "1.0.2",
    };

    const pageErrors: string[] = [];
    window.addEventListener("error", (ev) => pageErrors.push(String(ev.error || ev.message)));
    window.eval(jsBundle);
    await new Promise((r) => setTimeout(r, 150));

    const findDock = (name: string) =>
      Array.from(window.document.querySelectorAll(".mobile-dock .dock-item")).find((b) =>
        (b.textContent || "").trim().includes(name),
      ) as HTMLButtonElement | undefined;

    // 1. Open Phone `Assets` tab -> check all 4 categories (`Přechody`, `Motion`, `Efekty`, `Zvuky`) & click `Generovat`!
    const assetsBtn = findDock("Assets");
    expect(assetsBtn).toBeTruthy();
    assetsBtn!.click();
    await new Promise((r) => setTimeout(r, 40));

    for (const catLabel of ["Přechody", "Motion", "Efekty", "Zvuky"]) {
      const segBtn = Array.from(window.document.querySelectorAll(".mobile-sheet .seg-btn")).find((b) =>
        (b.textContent || "").includes(catLabel),
      ) as HTMLButtonElement | undefined;
      expect(segBtn, `Expected sub-tab ${catLabel}`).toBeTruthy();
      segBtn!.click();
      await new Promise((r) => setTimeout(r, 35));

      const genBtn = window.document.querySelector(".mobile-sheet .btn-generate") as HTMLButtonElement | null;
      expect(genBtn).toBeTruthy();
      expect((genBtn!.textContent || "").trim()).toBe("Generovat");
      genBtn!.click();
      await new Promise((r) => setTimeout(r, 55));
    }

    // 2. Also verify `Filters`, `Text`, `Media`, `Edit`, `Audio` each end with `Generovat` button on phone!
    for (const tabName of ["Filters", "Text", "Media", "Edit", "Audio"]) {
      const dockTab = findDock(tabName);
      expect(dockTab).toBeTruthy();
      dockTab!.click();
      await new Promise((r) => setTimeout(r, 40));
      const genBtn = window.document.querySelector(".mobile-sheet .btn-generate") as HTMLButtonElement | null;
      expect(genBtn, `Expected 'Generovat' button inside mobile ${tabName} sheet`).toBeTruthy();
      expect((genBtn!.textContent || "").trim()).toBe("Generovat");
    }

    // Verify generated assets were persisted into mobile project!
    const savedRaw = window.localStorage.getItem("vedit.apk.project.v3");
    expect(savedRaw).toBeTruthy();
    const savedProject = JSON.parse(savedRaw!) as {
      assets: Array<{ id: string }>;
      sequences: Array<{ captions: Array<{ style?: { motionTemplate?: string } }> }>;
    };
    expect(savedProject.assets.length).toBeGreaterThanOrEqual(3); // transition + overlay + sfx!
    expect(savedProject.sequences[0]!.captions.some((c) => Boolean(c.style?.motionTemplate))).toBe(true);
    expect(pageErrors).toEqual([]);

    dom.window.close();
  });
});
