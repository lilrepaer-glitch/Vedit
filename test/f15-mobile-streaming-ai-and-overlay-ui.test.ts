// Milestone F15 (Vedit Studio v1.0.1):
// 1. Streaming SSE AI pipeline with low-latency reasoning budget (`reasoning` / `reasoning_effort: "low"`),
//    4096 token output budget, sliding idle timeout via `__veditHttpProgress`, and instant native cancellation.
// 2. Macro timeline ops (`auto_shorts`, `batch_captions`, `keyframes`, multi-`split`) for complex long prompts
//    on both Desktop (`runStudioCopilot`) and Android APK (`mobileApi.runCopilot`).
// 3. Mobile layout (`390x844` portrait) overlays `.mobile-sheet` OVER `.mobile-timeline-slot` (`přes timeline`)
//    with full large touch ergonomics (`@media (max-width: 899px)`).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runStudioCopilot } from "../src/ai/orchestrator.js";
import { VeditEngine } from "../src/core/engine.js";
import { ffmpegPath } from "../src/core/media.js";
import { saveApiSettings } from "../src/pro/api-settings.js";
import { VEDIT_VERSION } from "../src/pro/updater.js";

describe("F15 — Streaming Non-Timeout AI, Macro Long-Prompt Edits, Touch Ergonomics & Overlay Bottom Sheet (v1.0.1)", () => {
  let tmpDir: string;
  let clipPath: string;
  let sseServer: http.Server;
  let ssePort = 0;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-f15-"));
    clipPath = path.join(tmpDir, "f15-long.mp4");
    execFileSync(
      ffmpegPath(),
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=25:duration=9.5",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=9.5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        clipPath,
      ],
      { stdio: "ignore" },
    );

    sseServer = http.createServer(async (req, res) => {
      let raw = "";
      req.on("data", (ch) => {
        raw += ch.toString("utf8");
      });
      req.on("end", async () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        if (req.url?.includes("/sse-long")) {
          // Verify full 4096-token budget was requested so long JSON responses never truncate
          expect(Number(body.max_tokens ?? body.max_completion_tokens ?? 0)).toBeGreaterThanOrEqual(4096);
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const targetJson = JSON.stringify({
            reply: "Kompletní střih reels, titulky, barevný grading i plynulý zoom jsou hotové!",
            actions: [
              { op: "aspect", ratio: "9:16" },
              { op: "auto_shorts", segmentDuration: 2.5, maxClips: 4, transitions: true },
              { op: "lut3d", value: "teal-orange-blockbuster" },
              { op: "keyframes", preset: "zoom-in" },
              {
                op: "batch_captions",
                items: [
                  { text: "1. Úvodní hook", start: 0, end: 2.4 },
                  { text: "2. Hlavní myšlenka", start: 2.5, end: 4.9 },
                  { text: "3. Finální pointa", start: 5.0, end: 7.4 },
                ],
              },
            ],
          });
          // Stream response in chunks across wire
          for (let i = 0; i < targetJson.length; i += 35) {
            const slice = targetJson.slice(i, i + 35);
            res.write(`data: ${JSON.stringify({ model: "sse-fast-v1", choices: [{ delta: { content: slice } }] })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"reply":"ok","actions":[]}' } }] }));
      });
    });

    await new Promise<void>((resolve) => {
      sseServer.listen(0, "127.0.0.1", () => {
        const addr = sseServer.address();
        ssePort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => sseServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams complex multi-step Czech prompts (auto_shorts + batch_captions + LUT + motion) end-to-end without timeout", async () => {
    expect(VEDIT_VERSION).toBe("1.0.1");
    saveApiSettings({
      baseUrl: `http://127.0.0.1:${ssePort}/sse-long`,
      apiKey: "sk-test-f15",
      model: "gpt-4o-mini",
    });

    const engine = new VeditEngine(VeditEngine.createProject("F15 Long Prompt Project"));
    const vTrack = engine.addTrack("video", "V1");
    const asset = engine.addAsset({
      name: "f15-long.mp4",
      path: clipPath,
      kind: "video",
      duration: 9.5,
      width: 640,
      height: 360,
    });
    engine.addClip({ trackId: vTrack.id, assetId: asset.id, start: 0, in: 0, out: 9.5 });

    const longPrompt =
      "Udělej z tohohle dlouhého videa dynamické vertikální 9:16 krátké klipy po 2.5 sekundách s prolínačkami, " +
      "nasaď filmový teal-orange LUT, jemný zoom-in pohyb kamery a přidej 3 načasované české titulky k celému videu.";

    const res = await runStudioCopilot(engine, longPrompt);
    expect(res.summary).toContain("Kompletní střih reels");

    const seq = engine.activeSequence();
    expect(seq.width).toBe(1080);
    expect(seq.height).toBe(1920);
    expect(seq.tracks.find((t) => t.id === vTrack.id)!.clips.length).toBe(4);
    expect(seq.captions.length).toBe(3);
    expect(seq.captions[2]!.text).toContain("Finální pointa");
  });

  it("verifies Android native SSE parser, sliding timeout hook, instant abort, and mobile overlay sheet over timeline (`přes timeline`)", async () => {
    const javaSource = fs.readFileSync(
      path.resolve("apps/android/src/com/vedit/studio/MainActivity.java"),
      "utf8",
    );
    expect(javaSource).toContain("readSseStreamAsJson");
    expect(javaSource).toContain("window.__veditHttpProgress");
    expect(javaSource).toContain("public void abortHttpRequest(String requestId)");
    expect(javaSource).toContain('return "1.0.1";');

    const assetsDir = path.resolve("apps/desktop/dist/assets");
    const assetFiles = fs.readdirSync(assetsDir);
    const cssFile = assetFiles.find((f) => f.endsWith(".css"));
    const jsFile = assetFiles.find((f) => f.endsWith(".js"));
    expect(cssFile).toBeTruthy();
    expect(jsFile).toBeTruthy();

    const cssSource = fs.readFileSync(path.join(assetsDir, cssFile!), "utf8");
    expect(cssSource).toContain(".mobile-sheet{position:absolute;left:0;right:0;bottom:var(--mobile-dock-h)");
    expect(cssSource).toContain("@media(max-width:899px)");

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
      value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131 Mobile Safari/537.36 VedStudioAPK/1.0.1",
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
      fillRect: () => {},
      clearRect: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      arc: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      drawImage: () => {},
      fillText: () => {},
      strokeText: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
        width: w,
        height: h,
      }),
    })) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;

    const abortedIds: string[] = [];
    let sawStreamAnd4096 = false;
    (window as unknown as Record<string, unknown>).VeditAndroid = {
      isAndroid: () => true,
      getVersion: () => "1.0.1",
      abortHttpRequest: (reqId: string) => abortedIds.push(reqId),
      httpRequestAsync: (reqId: string, _method: string, _url: string, _headers: string, reqBody: string) => {
        const parsedReq = JSON.parse(reqBody || "{}") as Record<string, unknown>;
        if (parsedReq.stream === true && parsedReq.max_tokens === 4096) {
          sawStreamAnd4096 = true;
        }
        (window as unknown as { __veditHttpProgress?: (id: string, chars: number) => void }).__veditHttpProgress?.(
          reqId,
          320,
        );
        const aiBody = JSON.stringify({
          model: "openrouter/fast-stream",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  reply: "Hotovo — dlouhé zadání zpracováno bez timeoutu!",
                  actions: [{ op: "aspect", ratio: "9:16" }],
                }),
              },
            },
          ],
        });
        const resp = JSON.stringify({ ok: true, status: 200, statusText: "OK", body: aiBody });
        setTimeout(() => {
          const b64 = Buffer.from(resp, "utf8").toString("base64");
          (window as unknown as { __veditResolveHttp?: (id: string, b: string) => void }).__veditResolveHttp?.(
            reqId,
            b64,
          );
        }, 15);
      },
    };

    const pageErrors: string[] = [];
    window.addEventListener("error", (ev) => pageErrors.push(String(ev.error || ev.message)));
    window.eval(jsBundle);

    await new Promise((r) => setTimeout(r, 150));

    // Verify phone layout booted with `.mobile-root` and `.mobile-timeline-slot`
    expect(window.document.querySelector(".mobile-root")).toBeTruthy();
    expect(window.document.querySelector(".mobile-timeline-slot")).toBeTruthy();
    expect(window.document.querySelector(".mobile-sheet")).toBeNull();

    // Configure API key in localStorage and trigger an actual AI prompt inside the mobile sheet!
    window.localStorage.setItem(
      "vedit.apk.apiSettings.v2",
      JSON.stringify({
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test-f15",
        model: "google/gemini-2.5-flash",
      }),
    );

    const dockButtons = Array.from(window.document.querySelectorAll(".mobile-dock .dock-item")) as HTMLButtonElement[];
    expect(dockButtons.length).toBeGreaterThanOrEqual(7);

    const aiDockBtn = dockButtons.find((b) => (b.textContent || "").includes("AI"));
    expect(aiDockBtn).toBeTruthy();
    aiDockBtn!.click();
    await new Promise((r) => setTimeout(r, 50));

    // Sheet overlays OVER `.mobile-timeline-slot` without removing or shrinking `.mobile-timeline-slot`!
    expect(window.document.querySelector(".mobile-sheet.ai-sheet")).toBeTruthy();
    expect(window.document.querySelector(".mobile-timeline-slot")).toBeTruthy();
    const promptTextarea = window.document.querySelector("textarea.ai-prompt-box") as HTMLTextAreaElement | null;
    expect(promptTextarea).toBeTruthy();

    // Send a long prompt right from the phone UI!
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    nativeSetter?.call(promptTextarea!, "Udělej vertikální 9:16 video s rychlým střihem a filmovými barvami.");
    promptTextarea!.dispatchEvent(new window.Event("input", { bubbles: true }));
    const sendBtn = window.document.querySelector('button[aria-label="Send AI prompt"]') as HTMLButtonElement | null;
    expect(sendBtn).toBeTruthy();
    sendBtn!.click();
    await new Promise((r) => setTimeout(r, 90));

    expect(sawStreamAnd4096).toBe(true);
    expect(window.document.body.textContent || "").toContain("Hotovo — dlouhé zadání zpracováno bez timeoutu!");

    // Tapping active dock tab collapses overlay sheet cleanly back down to reveal timeline!
    aiDockBtn!.click();
    await new Promise((r) => setTimeout(r, 40));
    expect(window.document.querySelector(".mobile-sheet")).toBeNull();
    expect(window.document.querySelector(".mobile-timeline-slot")).toBeTruthy();
    expect(pageErrors).toEqual([]);

    dom.window.close();
  });
});
