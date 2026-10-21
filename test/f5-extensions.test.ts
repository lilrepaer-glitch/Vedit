import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VeditEngine } from "../src/core/engine.js";
import { generateTestClip, probeMedia } from "../src/core/media.js";
import { renderSequence } from "../src/render/export.js";
import { WatchFolderManager } from "../src/ext/delivery.js";
import { createApp } from "../src/server/app.js";
import { buildMcpServer } from "../src/mcp/server.js";

describe("F5 — Extensions: Multi-Codec Presets, Watch Folders, Marketplace, Collab & MCP Resources/Prompts", () => {
  it("renders real H.265/HEVC (.mp4), Apple ProRes 422 (.mov), and VP9 (.webm) outputs", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-f5-codecs-"));
    const srcClip = join(tmp, "source.mp4");
    await generateTestClip(srcClip, { seconds: 1, size: "320x180", rate: 24 });

    const engine = new VeditEngine(VeditEngine.createProject("Codec Matrix"));
    const seq = engine.activeSequence();
    seq.width = 320;
    seq.height = 180;
    seq.fps = 24;
    const asset = engine.addAsset({
      name: "source.mp4",
      kind: "video",
      path: srcClip,
      duration: 1,
      width: 320,
      height: 180,
      hasAudio: true,
    });
    const track = engine.addTrack("video", "V1");
    engine.addClip({ trackId: track.id, assetId: asset.id, name: "shot", start: 0, duration: 1, in: 0, out: 1 });

    const hevcOut = join(tmp, "out-hevc.mp4");
    await renderSequence(engine.project, { outPath: hevcOut, codec: "h265", width: 320, height: 180, fps: 24 });
    const hevcProbe = await probeMedia(hevcOut);
    expect(hevcProbe.videoCodec).toBe("hevc");

    const proresOut = join(tmp, "out-prores.mov");
    await renderSequence(engine.project, { outPath: proresOut, preset: "prores-master", width: 320, height: 180, fps: 24 });
    const proresProbe = await probeMedia(proresOut);
    expect(proresProbe.videoCodec).toContain("prores");
    expect(proresProbe.audioCodec).toBe("pcm_s16le");

    const webmOut = join(tmp, "out-vp9.webm");
    await renderSequence(engine.project, { outPath: webmOut, preset: "webm-vp9", width: 320, height: 180, fps: 24 });
    const webmProbe = await probeMedia(webmOut);
    expect(webmProbe.videoCodec).toBe("vp9");
    expect(webmProbe.audioCodec).toBe("opus");
  }, 60_000);

  it("automatically renders new footage dropped into a Watch Folder", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-f5-watch-"));
    const inbox = join(tmp, "inbox");
    const output = join(tmp, "output");
    const sample = join(tmp, "raw.mp4");
    await generateTestClip(sample, { seconds: 1, size: "320x180", rate: 24 });

    const manager = new WatchFolderManager();
    try {
      let renderedOut = "";
      await manager.start(
        { inboxDir: inbox, outputDir: output, preset: "webm-vp9", pollMs: 120 },
        (item) => {
          renderedOut = item.outPath;
        },
      );

      await copyFile(sample, join(inbox, "drop-clip.mp4"));

      for (let i = 0; i < 60 && !renderedOut; i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(renderedOut).toContain("drop-clip-webm-vp9.webm");
      const probed = await probeMedia(renderedOut);
      expect(probed.duration).toBeGreaterThan(0.5);
      expect(manager.list()[0]!.processedCount).toBe(1);
    } finally {
      manager.stopAll();
    }
  }, 45_000);

  it("supports checkpoints, structural diff, collaborative merge, review notes, chapters & Marketplace packs via REST", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "vedit-f5-collab-"));
    const { app } = createApp({ token: "dev", dataDir: tmp });
    const auth = <T extends request.Test>(t: T) => t.set("Authorization", "Bearer dev");

    const created = await auth(request(app).post("/api/v1/projects").send({ name: "Team Cut", sample: true }));
    const id = created.body.project.id as string;

    // 1. Save initial checkpoint
    const snapRes = await auth(request(app).post(`/api/v1/projects/${id}/snapshots`).send({ label: "Rough Cut v1" }));
    expect(snapRes.status).toBe(201);
    const snapId = snapRes.body.snapshot.id as string;

    // 2. Install custom Marketplace pack from file & apply template + plugin
    const packFile = join(tmp, "brand.veditpack.json");
    await writeFile(
      packFile,
      JSON.stringify({
        id: "tpl-custom-brand",
        kind: "template",
        name: "Brand Opener Pack",
        author: "Studio Partner",
        version: "1.2.0",
        category: "Brand",
        description: "Custom studio lower-third + chapter pack",
        params: [{ key: "brand", label: "Brand", defaultValue: "Vedit Labs" }],
        blueprint: {
          captions: [{ text: "Presented by {{brand}}", start: 0, end: 2.5 }],
          markers: [{ time: 0, label: "{{brand}} Intro" }],
          animationPreset: "fade-in",
        },
      }),
    );

    const instRes = await auth(
      request(app).post(`/api/v1/projects/${id}/marketplace/install`).send({ filePath: packFile }),
    );
    expect(instRes.status).toBe(201);

    const applyRes = await auth(
      request(app)
        .post(`/api/v1/projects/${id}/marketplace/apply-template`)
        .send({ templateId: "tpl-custom-brand", params: { brand: "Prague Studio" } }),
    );
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.captionsAdded).toBe(1);

    const lutRes = await auth(
      request(app)
        .post(`/api/v1/projects/${id}/marketplace/run-plugin`)
        .send({ pluginId: "plg-cinematic-lut", params: { look: "teal-orange" } }),
    );
    expect(lutRes.status).toBe(200);
    expect(lutRes.body.clipsGraded).toBeGreaterThan(0);

    // 3. Review comments & YouTube chapters
    const cmt = await auth(
      request(app).post(`/api/v1/projects/${id}/comments`).send({ author: "Director", text: "Tighten cut here", timecode: 3.5 }),
    );
    expect(cmt.status).toBe(201);
    const resolved = await auth(
      request(app).patch(`/api/v1/projects/${id}/comments/${cmt.body.comment.id}`).send({ resolved: true }),
    );
    expect(resolved.body.comment.resolved).toBe(true);

    const chapters = await auth(request(app).get(`/api/v1/projects/${id}/chapters`));
    expect(chapters.body.youtubeDescription).toContain("00:00 Prague Studio Intro");

    // 4. Structural diff against Rough Cut v1 checkpoint
    const diffRes = await auth(request(app).post(`/api/v1/projects/${id}/diff`).send({ snapshotId: snapId }));
    expect(diffRes.status).toBe(200);
    expect(diffRes.body.diff.captions.added).toContain("Presented by Prague Studio");
    expect(diffRes.body.diff.clips.modified.length).toBeGreaterThan(0);

    // 5. Collaborative merge from second editor's project
    const collabEngine = new VeditEngine(VeditEngine.createProject("Sound Designer Pass"));
    const sfxAsset = collabEngine.addAsset({ name: "whoosh.wav", kind: "audio", path: "/audio/whoosh.wav", duration: 2 });
    const sfxTrack = collabEngine.addTrack("audio", "SFX Pass");
    collabEngine.addClip({ trackId: sfxTrack.id, assetId: sfxAsset.id, start: 1, duration: 2, in: 0, out: 2 });

    const mergeRes = await auth(
      request(app).post(`/api/v1/projects/${id}/merge`).send({ project: collabEngine.project, author: "SoundTeam" }),
    );
    expect(mergeRes.body.merged.importedAssets).toBe(1);
    expect(mergeRes.body.merged.importedTracks).toBe(1);

    // 6. Restore original checkpoint
    const restRes = await auth(request(app).post(`/api/v1/projects/${id}/snapshots/${snapId}/restore`).send());
    expect(restRes.status).toBe(200);
  });

  it("exposes MCP Resources, Workflow Prompts, project.diff, and export.queue_status", async () => {
    const { engine } = VeditEngine.createSampleProject();
    const mcp = buildMcpServer({ engine });
    const client = new Client({ name: "f5-mcp-client", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(st), client.connect(ct)]);

    // Resources (PLAN §4.2)
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("vedit://project/state");
    expect(uris).toContain("vedit://project/timeline");
    expect(uris).toContain("vedit://project/captions");
    expect(uris).toContain("vedit://project/jobs");
    expect(uris).toContain("vedit://marketplace/catalog");

    const tlRead = await client.readResource({ uri: "vedit://project/timeline" });
    const tlJson = JSON.parse((tlRead.contents[0] as { text: string }).text);
    expect(tlJson.tracks.length).toBeGreaterThan(0);

    // Workflow Prompts (PLAN §4.2)
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining(["highlight-reel", "shorts-from-longform", "promo-spot", "captions-translate-export"]),
    );
    const promptMsg = await client.getPrompt({ name: "shorts-from-longform", arguments: { hookTitle: "Insane Trick" } });
    expect((promptMsg.messages[0]?.content as { text: string }).text).toContain("Insane Trick");

    // Tools: snapshot → template → project.diff → export.queue_status
    const snapCall = await client.callTool({ name: "project.snapshot", arguments: { label: "Before Shorts" } });
    const snapId = JSON.parse((snapCall.content as Array<{ text: string }>)[0]!.text).snapshot.id;

    await client.callTool({ name: "marketplace.apply_template", arguments: { templateId: "tpl-tiktok-shorts" } });

    const diffCall = await client.callTool({ name: "project.diff", arguments: { snapshotId: snapId } });
    const diffJson = JSON.parse((diffCall.content as Array<{ text: string }>)[0]!.text);
    expect(diffJson.diff.captions.added.length).toBeGreaterThanOrEqual(2);

    const queueCall = await client.callTool({ name: "export.queue_status", arguments: {} });
    const queueJson = JSON.parse((queueCall.content as Array<{ text: string }>)[0]!.text);
    expect(queueJson.total).toBe(0);
  });
});
