import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VeditEngine } from "../src/core/engine.js";
import { generateTestClip, probeMedia } from "../src/core/media.js";
import {
  CAMERA_MOVES,
  GEN_PROVIDERS,
  buildDirectedPrompt,
  callProvider,
  providerAvailability,
  resolveProvider,
} from "../src/ai/gen.js";
import { createApp } from "../src/server/app.js";
import { buildMcpServer } from "../src/mcp/server.js";

const ENV_KEYS = [
  "FAL_KEY",
  "VEDIT_FAL_BASE_URL",
  "REPLICATE_API_TOKEN",
  "VEDIT_REPLICATE_BASE_URL",
  "GOOGLE_API_KEY",
  "VEDIT_GOOGLE_BASE_URL",
  "VEDIT_WAN_URL",
  "VEDIT_HUNYUAN_CMD",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function listenServer(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("F4 — Vedit Gen (cloud + local providers, continuity, timeline insertion)", () => {
  it("exposes all cloud & local providers, models, and camera moves", () => {
    expect(GEN_PROVIDERS.length).toBeGreaterThanOrEqual(12);
    expect(CAMERA_MOVES.length).toBeGreaterThanOrEqual(10);

    process.env.FAL_KEY = "test-fal-key";
    const avail = providerAvailability();
    expect(avail.find((p) => p.id === "stub")?.available).toBe(true);
    expect(avail.find((p) => p.id === "fal")?.available).toBe(true);
    expect(avail.find((p) => p.id === "kling")?.available).toBe(false);

    // Auto-selects configured real provider when none explicitly specified
    expect(resolveProvider({ prompt: "ocean waves", kind: "video" }).id).toBe("fal");
  });

  it("executes full fal.ai queue → poll → result → binary download pipeline", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-gen-fal-"));
    const sampleMp4 = join(tmp, "sample.mp4");
    await generateTestClip(sampleMp4, { seconds: 1, size: "320x180", rate: 24 });
    const mp4Bytes = await readFile(sampleMp4);

    let statusChecks = 0;
    let receivedBody: Record<string, unknown> = {};

    const { server, url } = await listenServer((req, res) => {
      if (req.method === "POST" && req.url === "/fal-ai/veo3.1") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          receivedBody = JSON.parse(raw);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              request_id: "req-123",
              status_url: `${url}/fal-ai/veo3.1/requests/req-123/status`,
              response_url: `${url}/fal-ai/veo3.1/requests/req-123`,
            }),
          );
        });
        return;
      }
      if (req.url === "/fal-ai/veo3.1/requests/req-123/status") {
        statusChecks++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: statusChecks < 2 ? "IN_PROGRESS" : "COMPLETED" }));
        return;
      }
      if (req.url === "/fal-ai/veo3.1/requests/req-123") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ video: { url: `${url}/media/veo-out.mp4` } }));
        return;
      }
      if (req.url === "/media/veo-out.mp4") {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(mp4Bytes);
        return;
      }
      res.writeHead(404).end();
    });

    try {
      process.env.FAL_KEY = "fal-live-key";
      process.env.VEDIT_FAL_BASE_URL = url;

      const prov = resolveProvider({ prompt: "neon street at rain", kind: "video", provider: "fal" });
      const outPath = await callProvider(
        prov,
        {
          prompt: "neon street at rain",
          kind: "video",
          provider: "fal",
          cameraMove: "push-in",
          promptKeyframes: [
            { time: 0, prompt: "wide alley puddle reflection" },
            { time: 2.5, prompt: "cyclist rides past glowing sign" },
          ],
          duration: 5,
        },
        "job-fal-1",
        tmp,
        { pollIntervalMs: 25 },
      );

      expect(statusChecks).toBe(2);
      expect(String(receivedBody.prompt)).toContain("smooth dolly push-in");
      expect(String(receivedBody.prompt)).toContain("[2.5s] cyclist rides past glowing sign");
      const probe = await probeMedia(outPath);
      expect(probe.width).toBe(320);
      expect(probe.duration).toBeGreaterThan(0.5);
    } finally {
      server.close();
    }
  }, 30_000);

  it("executes Replicate predictions & Google Veo long-running operations", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-gen-cloud-"));
    const sampleMp4 = join(tmp, "sample.mp4");
    await generateTestClip(sampleMp4, { seconds: 1, size: "320x180", rate: 24 });
    const mp4Bytes = await readFile(sampleMp4);

    let repPolls = 0;
    let veoPolls = 0;

    const { server, url } = await listenServer((req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/models/minimax/video-01/predictions")) {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "pred-1", status: "processing", urls: { get: `${url}/predictions/pred-1` } }));
        return;
      }
      if (req.url === "/predictions/pred-1") {
        repPolls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            repPolls < 2
              ? { id: "pred-1", status: "processing" }
              : { id: "pred-1", status: "succeeded", output: `${url}/out.mp4` },
          ),
        );
        return;
      }
      if (req.method === "POST" && req.url?.includes(":predictLongRunning")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "operations/veo-op-1", done: false }));
        return;
      }
      if (req.url?.startsWith("/operations/veo-op-1")) {
        veoPolls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            veoPolls < 2
              ? { name: "operations/veo-op-1", done: false }
              : {
                  name: "operations/veo-op-1",
                  done: true,
                  response: {
                    generateVideoResponse: { generatedSamples: [{ video: { uri: `${url}/out.mp4` } }] },
                  },
                },
          ),
        );
        return;
      }
      if (req.url?.startsWith("/out.mp4")) {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(mp4Bytes);
        return;
      }
      res.writeHead(404).end();
    });

    try {
      process.env.REPLICATE_API_TOKEN = "r8_test";
      process.env.VEDIT_REPLICATE_BASE_URL = url;
      process.env.GOOGLE_API_KEY = "g_test";
      process.env.VEDIT_GOOGLE_BASE_URL = url;

      const repOut = await callProvider(
        resolveProvider({ prompt: "desert highway", kind: "video", provider: "replicate" }),
        { prompt: "desert highway", kind: "video", provider: "replicate" },
        "job-rep",
        tmp,
        { pollIntervalMs: 20 },
      );
      expect((await stat(repOut)).size).toBe(mp4Bytes.length);

      const veoOut = await callProvider(
        resolveProvider({ prompt: "glacier calving", kind: "video", provider: "google" }),
        { prompt: "glacier calving", kind: "video", provider: "google" },
        "job-veo",
        tmp,
        { pollIntervalMs: 20 },
      );
      expect((await stat(veoOut)).size).toBe(mp4Bytes.length);
    } finally {
      server.close();
    }
  }, 30_000);

  it("extracts last frame for shot continuity, inserts clip sequentially onto timeline, and undoes atomically via REST + MCP", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-gen-cont-"));
    const shot1File = join(tmp, "shot1.mp4");
    await generateTestClip(shot1File, { seconds: 2, size: "320x180", rate: 24 });
    const mp4Bytes = await readFile(shot1File);

    let capturedRefImage = "";
    let capturedPrompt = "";

    const { server, url } = await listenServer((req, res) => {
      if (req.method === "POST" && req.url === "/generate") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const parsed = JSON.parse(raw);
          capturedRefImage = String(parsed.reference_image ?? "");
          capturedPrompt = String(parsed.prompt ?? "");
          res.writeHead(200, { "content-type": "video/mp4" });
          res.end(mp4Bytes);
        });
        return;
      }
      res.writeHead(404).end();
    });

    try {
      process.env.VEDIT_WAN_URL = url;
      const { app, registry } = createApp({ token: "dev", dataDir: tmp });
      const projRes = await request(app)
        .post("/api/v1/projects")
        .set("Authorization", "Bearer dev")
        .send({ name: "Continuity Cut" });
      const projectId = projRes.body.project.id as string;

      // Place Shot 1 (0s → 2s) on timeline
      const a1 = await request(app)
        .post(`/api/v1/projects/${projectId}/assets`)
        .set("Authorization", "Bearer dev")
        .send({
          name: "shot1.mp4",
          kind: "video",
          path: shot1File,
          source: { prompt: "astronaut stepping onto red Martian ridge" },
        });
      const t1 = await request(app)
        .post(`/api/v1/projects/${projectId}/tracks`)
        .set("Authorization", "Bearer dev")
        .send({ kind: "video", name: "V1" });
      const c1 = await request(app)
        .post(`/api/v1/projects/${projectId}/clips`)
        .set("Authorization", "Bearer dev")
        .send({ trackId: t1.body.track.id, assetId: a1.body.asset.id, start: 0, duration: 2, in: 0, out: 2 });

      // Generate Shot 2 via Wan Local with continuity from Shot 1 clip
      const genRes = await request(app)
        .post(`/api/v1/projects/${projectId}/gen/video`)
        .set("Authorization", "Bearer dev")
        .send({
          prompt: "camera orbits astronaut looking at distant dust storm",
          provider: "wan-local",
          cameraMove: "orbit",
          continuityFromClipId: c1.body.clip.id,
        });
      expect(genRes.status).toBe(201);

      // Poll until done
      let job = genRes.body;
      for (let i = 0; i < 60; i++) {
        const jr = await request(app)
          .get(`/api/v1/jobs/${genRes.body.jobId}`)
          .set("Authorization", "Bearer dev");
        job = jr.body.job;
        if (job.status === "done" || job.status === "failed") break;
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(job.status).toBe("done");
      expect(capturedRefImage.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(capturedPrompt).toContain("Seamless visual continuity");
      expect(capturedPrompt).toContain("astronaut stepping onto red Martian ridge");

      const engine = registry.get(projectId);
      const v1 = engine.activeSequence().tracks[0]!;
      expect(v1.clips).toHaveLength(2);
      expect(v1.clips[1]!.start).toBeCloseTo(2, 1);

      const genAsset = engine.findAsset(job.output.assetId);
      expect(genAsset.source?.provider).toBe("wan-local");
      expect(genAsset.source?.cameraMove).toBe("orbit");
      expect(genAsset.source?.continuityFrom).toBe(c1.body.clip.id);

      // Single undo removes both inserted clip and generated asset
      expect(engine.undo()).toBe(true);
      expect(engine.activeSequence().tracks[0]!.clips).toHaveLength(1);

      // Verify MCP gen.* tools (PLAN §4.1)
      const mcp = buildMcpServer({ engine });
      const client = new Client({ name: "f4-test", version: "0.1.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(st), client.connect(ct)]);
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);
      for (const expected of ["gen.providers", "gen.video", "gen.image", "gen.music", "gen.sfx", "gen.voice", "gen.job_status"]) {
        expect(toolNames).toContain(expected);
      }
    } finally {
      server.close();
    }
  }, 45_000);

  it("compiles directed prompt cleanly", () => {
    const d = buildDirectedPrompt(
      {
        prompt: "forest waterfall",
        kind: "video",
        cameraMove: "crane",
        style: "35mm anamorphic film",
        negativePrompt: "watermark, blur",
      },
      { previousPrompt: "misty pine canopy" },
    );
    expect(d).toContain("forest waterfall");
    expect(d).toContain("sweeping crane jib rise");
    expect(d).toContain("35mm anamorphic film");
    expect(d).toContain("misty pine canopy");
    expect(d).toContain("Avoid: watermark, blur");
  });
});
