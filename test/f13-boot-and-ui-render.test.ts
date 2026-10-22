import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { startServer } from "../src/server/index.js";

const DESKTOP_DIST = resolve(process.cwd(), "apps", "desktop", "dist");

function create2dCanvasMock() {
  return {
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    transform() {},
    setTransform() {},
    fillRect() {},
    clearRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    roundRect() {},
    rect() {},
    arc() {},
    clip() {},
    stroke() {},
    fill() {},
    setLineDash() {},
    drawImage() {},
    fillText() {},
    strokeText() {},
    measureText: (t: string) => ({ width: String(t).length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
    }),
    putImageData() {},
    canvas: { width: 640, height: 360 },
  };
}

async function bootRealProductionBundle(opts: {
  url: string;
  width: number;
  height: number;
  waitMs?: number;
  setup?: (win: Window & typeof globalThis) => void;
}) {
  const html = readFileSync(join(DESKTOP_DIST, "index.html"), "utf8");
  const match = /src="\/assets\/([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error("Production JS asset missing from dist/index.html");
  const jsCode = readFileSync(join(DESKTOP_DIST, "assets", match[1]), "utf8");

  const dom = new JSDOM(html, {
    url: opts.url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  Object.defineProperty(win, "innerWidth", { value: opts.width, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: opts.height, configurable: true });
  (win as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  win.HTMLCanvasElement.prototype.getContext = (() => create2dCanvasMock()) as never;
  win.HTMLMediaElement.prototype.pause = () => {};
  win.HTMLMediaElement.prototype.load = () => {};
  win.HTMLMediaElement.prototype.play = () => Promise.resolve();
  win.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as never;

  opts.setup?.(win);

  const errors: string[] = [];
  win.addEventListener("error", (ev) => {
    errors.push(ev.error?.stack || ev.message || String(ev));
  });
  win.addEventListener("unhandledrejection", (ev) => {
    errors.push(String((ev as PromiseRejectionEvent).reason));
  });

  win.eval(jsCode);
  await new Promise((r) => setTimeout(r, opts.waitMs ?? 350));

  for (const label of ["Media", "Edit", "Adjust", "Filters", "Text", "Canvas", "Audio", "AI", "API", "Export"]) {
    const btn = Array.from(win.document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").trim().includes(label),
    );
    if (btn) {
      btn.click();
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const rootHtml = win.document.getElementById("root")?.innerHTML ?? "";
  const rootText = win.document.getElementById("root")?.textContent ?? "";
  dom.window.close();
  return { errors, rootHtml, rootText };
}

describe("F13 — Real Production Bundle Boot & Zero-Black-Screen UI Render Verification (v0.9.2)", () => {
  beforeAll(() => {
    if (!existsSync(join(DESKTOP_DIST, "index.html"))) {
      execFileSync("npm", ["--prefix", "apps/desktop", "run", "build"], { stdio: "inherit" });
    }
  });

  it("boots Android APK production bundle cleanly on fresh launch and clicks through every tool tab & modal with zero errors", async () => {
    const res = await bootRealProductionBundle({
      url: "https://appassets.vedit.studio/index.html",
      width: 412,
      height: 915,
      setup: (w) => {
        w.VeditAndroid = {
          isAndroid: () => true,
          getVersion: () => "0.9.2",
        };
      },
    });
    expect(res.errors).toEqual([]);
    expect(res.rootText).not.toContain("Vedit Studio Recovery");
    expect(res.rootText).not.toContain("Loading Vedit Studio");
    expect(res.rootHtml.length).toBeGreaterThan(15000);
  });

  it("boots Android APK cleanly even with legacy/incomplete localStorage project missing effects, keyframes, transform & captions", async () => {
    const res = await bootRealProductionBundle({
      url: "https://appassets.vedit.studio/index.html",
      width: 412,
      height: 915,
      setup: (w) => {
        w.VeditAndroid = {
          isAndroid: () => true,
          getVersion: () => "0.9.2",
        };
        w.localStorage.setItem(
          "vedit.apk.project.v3",
          JSON.stringify({
            id: "legacy-proj",
            name: "Legacy v0.8 Project",
            activeSequenceId: "seq-legacy",
            assets: [{ id: "a1", name: "clip.mp4", kind: "video", path: "blob:https://appassets.vedit.studio/stale" }],
            sequences: [
              {
                id: "seq-legacy",
                name: "Main",
                width: 1080,
                height: 1920,
                fps: 30,
                tracks: [
                  {
                    id: "t1",
                    name: "V1",
                    kind: "video",
                    clips: [{ id: "c1", assetId: "a1", name: "clip.mp4", start: 0, duration: 4.5, in: 0, out: 4.5 }],
                  },
                ],
              },
            ],
          }),
        );
      },
    });
    expect(res.errors).toEqual([]);
    expect(res.rootText).not.toContain("Vedit Studio Recovery");
    expect(res.rootText).toContain("Legacy v0.8 Project");
    expect(res.rootHtml.length).toBeGreaterThan(15000);
  });

  it("boots Windows Desktop bundle cleanly both against live Node HTTP server AND in standalone fallback when sidecar is blocked", async () => {
    // 1) Live Desktop HTTP server boot
    const tmpDir = mkdtempSync(join(tmpdir(), "vedit-f13-boot-"));
    const srv = startServer({ port: 0, host: "127.0.0.1", token: "dev", sample: true, dataDir: tmpDir, quiet: true });
    await new Promise<void>((r) => {
      if (srv.server.listening) r();
      else srv.server.once("listening", () => r());
    });
    const port = (srv.server.address() as AddressInfo).port;
    try {
      const liveRes = await bootRealProductionBundle({
        url: `http://127.0.0.1:${port}/`,
        width: 1440,
        height: 900,
        setup: (w) => {
          w.fetch = ((input: string | URL, init?: RequestInit) =>
            globalThis.fetch(new URL(String(input), `http://127.0.0.1:${port}/`), {
              method: init?.method,
              headers: init?.headers as Record<string, string>,
              body: init?.body as BodyInit | null | undefined,
            })) as never;
          (w as unknown as { WebSocket: unknown }).WebSocket = class {
            close() {}
          };
        },
      });
      expect(liveRes.errors).toEqual([]);
      expect(liveRes.rootText).not.toContain("Vedit Studio Recovery");
      expect(liveRes.rootText).not.toContain("Loading Vedit Studio");
      expect(liveRes.rootHtml.length).toBeGreaterThan(20000);
    } finally {
      await new Promise<void>((r) => srv.server.close(() => r()));
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // 2) Windows Tauri fallback boot when Node sidecar is unreachable / blocked by Antivirus
    const fallbackRes = await bootRealProductionBundle({
      url: "http://tauri.localhost/",
      width: 1440,
      height: 900,
      waitMs: 2200,
      setup: (w) => {
        w.fetch = (async () => {
          throw new TypeError("Failed to fetch");
        }) as never;
        (w as unknown as { WebSocket: unknown }).WebSocket = class {
          close() {}
        };
      },
    });
    expect(fallbackRes.errors).toEqual([]);
    expect(fallbackRes.rootText).not.toContain("Vedit Studio Recovery");
    expect(fallbackRes.rootText).not.toContain("Loading Vedit Studio");
    expect(fallbackRes.rootHtml.length).toBeGreaterThan(20000);
  });
});
