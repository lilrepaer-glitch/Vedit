import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import { createApp, type ProjectRegistry } from "../src/server/app.js";
import type { Express } from "express";

let app: Express;
let registry: ProjectRegistry;
const token = "test-token";

beforeAll(() => {
  ({ app, registry } = createApp({ token }));
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

async function createProject(sample = true): Promise<string> {
  const res = await auth(request(app).post("/api/v1/projects").send({ name: "API test", sample }));
  return res.body.project.id as string;
}

describe("REST API", () => {
  it("health je veřejný, zbytek chráněný tokenem", async () => {
    const health = await request(app).get("/api/v1/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    const unauthorized = await request(app).get("/api/v1/projects");
    expect(unauthorized.status).toBe(401);
  });

  it("projekt + timeline + klipy", async () => {
    const id = await createProject();
    const project = await auth(request(app).get(`/api/v1/projects/${id}`));
    expect(project.status).toBe(200);
    expect(project.body.project.sequences).toHaveLength(1);

    const timeline = await auth(request(app).get(`/api/v1/projects/${id}/timeline`));
    expect(timeline.status).toBe(200);
    expect(timeline.body.tracks.length).toBeGreaterThan(0);

    // demo projekt má 3 klipy
    const clips = timeline.body.tracks.flatMap((t: { clips: unknown[] }) => t.clips);
    expect(clips).toHaveLength(3);
  });

  it("import assetu, add clip, split, delete", async () => {
    const id = await createProject(false);
    const assetRes = await auth(
      request(app)
        .post(`/api/v1/projects/${id}/assets`)
        .send({ name: "novy.mp4", kind: "video", path: "/tmp/novy.mp4", duration: 20 }),
    );
    expect(assetRes.status).toBe(201);
    const assetId = assetRes.body.asset.id;

    const trackRes = await auth(
      request(app).post(`/api/v1/projects/${id}/tracks`).send({ kind: "video", name: "V-test" }),
    );
    const trackId = body(trackRes).track.id;

    const clipRes = await auth(
      request(app)
        .post(`/api/v1/projects/${id}/clips`)
        .send({ trackId, assetId, start: 0, duration: 10, in: 0, out: 10 }),
    );
    expect(clipRes.status).toBe(201);
    const clipId = body(clipRes).clip.id;

    const splitRes = await auth(
      request(app).post(`/api/v1/projects/${id}/clips/${clipId}/split`).send({ at: 4 }),
    );
    expect(splitRes.status).toBe(200);
    expect(splitRes.body.left.duration).toBeCloseTo(4);
    const leftId = splitRes.body.left.id;

    const delRes = await auth(request(app).delete(`/api/v1/projects/${id}/clips/${leftId}`));
    expect(delRes.status).toBe(200);

    const undoRes = await auth(request(app).post(`/api/v1/projects/${id}/undo`));
    expect(undoRes.body.ok).toBe(true);

    const timeline = await auth(request(app).get(`/api/v1/projects/${id}/timeline`));
    const clips = timeline.body.tracks.flatMap((t: { clips: unknown[] }) => t.clips);
    expect(clips).toHaveLength(2);
  });

  it("titulky from-text a SRT export", async () => {
    const id = await createProject(false);
    const res = await auth(
      request(app)
        .post(`/api/v1/projects/${id}/captions/from-text`)
        .send({
          segments: [
            { text: "první", start: 0, end: 1 },
            { text: "druhý", start: 1.5, end: 2.5 },
          ],
        }),
    );
    expect(res.status).toBe(201);
    expect(res.body.captions).toHaveLength(2);

    const srt = await auth(request(app).get(`/api/v1/projects/${id}/captions/export.srt`));
    expect(srt.status).toBe(200);
    expect(srt.text).toContain("první");
    expect(srt.text).toContain("00:00:00,000 --> 00:00:01,000");
  });

  it("animace preset přes API", async () => {
    const id = await createProject();
    const timeline = await auth(request(app).get(`/api/v1/projects/${id}/timeline`));
    const clip = timeline.body.tracks.flatMap((t: { clips: Array<{ id: string }> }) => t.clips)[0];
    const res = await auth(
      request(app).post(`/api/v1/projects/${id}/clips/${clip.id}/animation`).send({ preset: "pop-in" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.clip.keyframes.length).toBeGreaterThan(0);
  });

  it("gen.video stub vytvoří job i asset", async () => {
    const id = await createProject(false);
    const res = await auth(
      request(app)
        .post(`/api/v1/projects/${id}/gen/video`)
        .send({ prompt: "slunce nad horami", duration: 4 }),
    );
    expect(res.status).toBe(201);
    const { jobId, assetId } = res.body;
    expect(jobId).toBeTruthy();
    expect(assetId).toBeTruthy();

    const job = await auth(request(app).get(`/api/v1/jobs/${jobId}`));
    expect(job.body.job.status).toBe("done");
    expect(job.body.job.output.note).toContain("F0");

    const assets = await auth(request(app).get(`/api/v1/projects/${id}/assets`));
    const generated = assets.body.assets.find((a: { id: string }) => a.id === assetId);
    expect(generated.kind).toBe("generated");
    expect(generated.source.prompt).toBe("slunce nad horami");
    expect(generated.source.simulated).toBe(true);
  });

  it("export render běží jako reálný job s výstupem ke stažení", async () => {
    const id = await createProject(false);
    // projekt s reálným médiem generovaným přes ffmpeg
    const { generateTestClip } = await import("../src/core/media.js");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "vedit-api-"));
    const clip = join(dir, "t.mp4");
    await generateTestClip(clip, { seconds: 1, size: "320x240", rate: 25 });
    const assetRes = await auth(
      request(app).post(`/api/v1/projects/${id}/assets`).send({ name: "t.mp4", kind: "video", path: clip }),
    );
    // auto-probe doplnil reálná metadata
    expect(assetRes.body.asset.duration).toBeGreaterThan(0.5);
    expect(assetRes.body.asset.width).toBe(320);
    const trackRes = await auth(
      request(app).post(`/api/v1/projects/${id}/tracks`).send({ kind: "video", name: "V1" }),
    );
    await auth(
      request(app)
        .post(`/api/v1/projects/${id}/clips`)
        .send({ trackId: body(trackRes).track.id, assetId: assetRes.body.asset.id, start: 0, duration: 1, in: 0, out: 1 }),
    );

    const res = await auth(request(app).post(`/api/v1/projects/${id}/export`).send({ format: "mp4" }));
    expect(res.status).toBe(201);
    const { jobId } = res.body;

    // počkej na dokončení renderu
    let job: Record<string, { status: string; output?: { outPath?: string } }> | null = null;
    for (let i = 0; i < 60; i++) {
      const j = await auth(request(app).get(`/api/v1/jobs/${jobId}`));
      job = j.body.job;
      if (job!.status === "done" || job!.status === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(job!.status).toBe("done");
    expect(job!.output!.outPath).toBeTruthy();

    const dl = await auth(request(app).get(`/api/v1/jobs/${jobId}/output`));
    expect(dl.status).toBe(200);
    expect(dl.body.length).toBeGreaterThan(1000);
  }, 60000);

  it("frame endpoint vrací reálný JPEG", async () => {
    const id = await createProject(false);
    const { generateTestClip } = await import("../src/core/media.js");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "vedit-api-"));
    const clip = join(dir, "f.mp4");
    await generateTestClip(clip, { seconds: 1, size: "320x240", rate: 25 });
    const assetRes = await auth(
      request(app).post(`/api/v1/projects/${id}/assets`).send({ name: "f.mp4", kind: "video", path: clip }),
    );
    const assetId = assetRes.body.asset.id;
    const frame = await auth(request(app).get(`/api/v1/projects/${id}/assets/${assetId}/frame?t=0.5&width=160`));
    expect(frame.status).toBe(200);
    expect(frame.headers["content-type"]).toContain("image/jpeg");
    expect(frame.body[0]).toBe(0xff);
    expect(frame.body[1]).toBe(0xd8);

    const thumbs = await auth(request(app).get(`/api/v1/projects/${id}/assets/${assetId}/thumbs?count=3`));
    expect(thumbs.body.thumbs).toHaveLength(3);
    expect(thumbs.body.thumbs[0].url).toContain("/frame?");

    const wave = await auth(request(app).get(`/api/v1/projects/${id}/assets/${assetId}/waveform?samples=50`));
    expect(wave.body.peaks).toHaveLength(50);
  }, 60000);

  it("validace vrací 400 s chybovou zprávou", async () => {
    const id = await createProject(false);
    const res = await auth(request(app).post(`/api/v1/projects/${id}/clips`).send({ start: 0 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("trackId");
  });

  it("registry drží projekty", () => {
    expect(registry.list().length).toBeGreaterThan(0);
  });
});

function body(res: request.Response): Record<string, never> & { track: { id: string } } {
  return res.body;
}
