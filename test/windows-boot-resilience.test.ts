import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import request from "supertest";
import { startServer } from "../src/server/index.js";
import { ffmpegPath, run } from "../src/core/media.js";
import { compareSemver } from "../src/pro/updater.js";

describe("Windows Desktop Instant-Boot, Drag-and-Drop & NSIS Self-Updater Resilience (v0.5.3)", () => {
  it("configures custom NSIS in-place Update template (`installer.nsi`), `dragDropEnabled: false`, and accurate semver comparison", async () => {
    const tauriConfPath = resolve(process.cwd(), "apps/desktop/src-tauri/tauri.conf.json");
    const conf = JSON.parse(await readFile(tauriConfPath, "utf8")) as {
      app: { windows: Array<{ dragDropEnabled?: boolean }> };
      bundle: { windows: { allowDowngrades?: boolean; nsis: { template?: string } } };
    };
    expect(conf.app.windows[0]?.dragDropEnabled).toBe(false);
    expect(conf.bundle.windows.allowDowngrades).toBe(true);
    expect(conf.bundle.windows.nsis.template).toBe("installer.nsi");

    const nsi = await readFile(resolve(process.cwd(), "apps/desktop/src-tauri/installer.nsi"), "utf8");
    expect(nsi).toContain("Update ${PRODUCTNAME} in place (Recommended - fast update, keeps all projects & settings)");
    expect(nsi).toContain("Clean reinstall v${VERSION}");
    expect(nsi).toContain("SkipIfUpdateOrPassive");
    expect(nsi).not.toContain("nsExec::");

    expect(compareSemver("0.5.3", "0.5.2")).toBe(1);
    expect(compareSemver("0.5.3", "0.5.3")).toBe(0);
    expect(compareSemver("0.5.1", "0.5.3")).toBe(-1);
    expect(compareSemver("0.1.0", "0.1.0-beta.2")).toBe(1);
  });

  it("opens port immediately (<500ms), answers CORS/PNA preflight, and streams dropped media files straight onto a target track & timestamp", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-boot-"));
    const sampleMp4 = join(tmp, "dropped-video.mp4");
    await run(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=1.2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      sampleMp4,
    ]);
    const videoBytes = await readFile(sampleMp4);

    const t0 = Date.now();
    const inst = startServer({ port: 0, host: "127.0.0.1", token: "dev", sample: true, dataDir: tmp, quiet: true });

    try {
      await new Promise<void>((resolveReady, reject) => {
        if (inst.server.listening) return resolveReady();
        inst.server.once("listening", () => resolveReady());
        inst.server.once("error", reject);
      });
      expect(Date.now() - t0).toBeLessThan(500);

      const preflight = await request(inst.app)
        .options("/api/v1/projects")
        .set("Origin", "https://tauri.localhost")
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "authorization,content-type")
        .set("Access-Control-Request-Private-Network", "true")
        .expect(204);
      expect(preflight.headers["access-control-allow-private-network"]).toBe("true");

      const projs = await request(inst.app)
        .get("/api/v1/projects")
        .set("Authorization", "Bearer dev")
        .expect(200);
      const pid = projs.body.projects[0].id as string;
      const projDetail = await request(inst.app)
        .get(`/api/v1/projects/${pid}`)
        .set("Authorization", "Bearer dev")
        .expect(200);
      const vTrackId = projDetail.body.project.sequences[0].tracks.find((t: { kind: string }) => t.kind === "video").id as string;

      // Simulate Windows Explorer Drag & Drop onto track `vTrackId` at exact timestamp `at = 2.75s`
      const dropped = await request(inst.app)
        .post(`/api/v1/projects/${pid}/assets/upload?name=gameplay_clip.mp4&insert=true&at=2.75&trackId=${vTrackId}`)
        .set("Authorization", "Bearer dev")
        .set("Content-Type", "application/octet-stream")
        .send(videoBytes)
        .expect(201);
      expect(dropped.body.asset.name).toBe("gameplay_clip.mp4");
      expect(dropped.body.clip.start).toBeCloseTo(2.75, 2);
      expect(dropped.body.clip.duration).toBeGreaterThan(1.0);
    } finally {
      await new Promise<void>((r) => inst.server.close(() => r()));
      await new Promise((r) => setTimeout(r, 200));
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});
