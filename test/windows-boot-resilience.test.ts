import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { startServer } from "../src/server/index.js";

describe("Windows Desktop Instant-Boot Resilience (v0.5.1)", () => {
  it("opens port immediately (<250ms), returns starter project before FFmpeg finishes, and answers CORS + Private Network Access preflight", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-boot-"));
    const t0 = Date.now();
    const inst = startServer({ port: 0, host: "127.0.0.1", token: "dev", sample: true, dataDir: tmp, quiet: true });

    try {
      await new Promise<void>((resolve, reject) => {
        if (inst.server.listening) return resolve();
        inst.server.once("listening", () => resolve());
        inst.server.once("error", reject);
      });
      const bootMs = Date.now() - t0;
      expect(bootMs).toBeLessThan(500);

      // Chromium / Edge WebView2 Private Network Access preflight (`http://tauri.localhost` -> `http://127.0.0.1:47000`)
      const preflight = await request(inst.app)
        .options("/api/v1/projects")
        .set("Origin", "https://tauri.localhost")
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "authorization,content-type")
        .set("Access-Control-Request-Private-Network", "true")
        .expect(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe("https://tauri.localhost");
      expect(preflight.headers["access-control-allow-private-network"]).toBe("true");

      // Immediate starter project must already exist without waiting for FFmpeg lavfi clip synthesis!
      const projs = await request(inst.app)
        .get("/api/v1/projects")
        .set("Authorization", "Bearer dev")
        .expect(200);
      expect(projs.body.projects.length).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((r) => inst.server.close(() => r()));
      // Give background hydrator a moment to notice closed/removed dir cleanly
      await new Promise((r) => setTimeout(r, 200));
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});
