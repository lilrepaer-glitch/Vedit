import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VeditEngine } from "../src/core/engine.js";
import { buildMcpServer, type McpContext } from "../src/mcp/server.js";

async function connect(): Promise<{ client: Client; ctx: McpContext }> {
  const ctx: McpContext = { engine: new VeditEngine(VeditEngine.createProject("MCP test")) };
  const server = buildMcpServer(ctx);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, ctx };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) };
}

describe("MCP server", () => {
  it("vypíše tools podle plánu §4.1", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      "health",
      "project.get_state",
      "project.create",
      "media.import",
      "media.list",
      "timeline.get_timeline",
      "timeline.add_clip",
      "timeline.cut",
      "timeline.trim",
      "timeline.move",
      "timeline.delete",
      "captions.generate",
      "captions.edit",
      "captions.translate",
      "captions.export",
      "animation.list_presets",
      "animation.apply_preset",
      "animation.set_keyframes",
      "effect.apply",
      "gen.video",
      "gen.audio",
      "gen.job_status",
      "export.render",
      "undo",
      "redo",
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.length).toBeGreaterThanOrEqual(28);
  });

  it("health funguje", async () => {
    const { client } = await connect();
    const res = await call(client, "health");
    expect(res.isError).toBe(false);
    expect(res.json().ok).toBe(true);
  });

  it("celý workflow: import → klip → cut → titulky → preset → undo", async () => {
    const { client } = await connect();

    const imp = await call(client, "media.import", {
      name: "video.mp4",
      path: "/tmp/video.mp4",
      kind: "video",
      duration: 20,
    });
    expect(imp.isError).toBe(false);
    const assetId = imp.json().asset.id;

    const add = await call(client, "timeline.add_clip", { assetId, start: 0, duration: 10, in: 0, out: 10 });
    expect(add.isError).toBe(false);
    const clipId = add.json().clip.id;

    const cut = await call(client, "timeline.cut", { clipId, at: 4 });
    expect(cut.isError).toBe(false);
    expect(cut.json().left.duration).toBeCloseTo(4);
    const leftId = cut.json().left.id;

    const tl = await call(client, "timeline.get_timeline");
    expect(tl.json().tracks.flatMap((t: { clips: unknown[] }) => t.clips)).toHaveLength(2);

    const caps = await call(client, "captions.generate", {
      text: "Ahoj světe toto je Vedit",
      start: 0,
      end: 4,
    });
    expect(caps.isError).toBe(false);
    expect(caps.json().captions.length).toBeGreaterThan(2);

    const srt = await call(client, "captions.export", { format: "srt" });
    expect(srt.json().srt).toContain("Ahoj");

    const anim = await call(client, "animation.apply_preset", { clipId: leftId, preset: "fade-in" });
    expect(anim.isError).toBe(false);
    expect(anim.json().clip.keyframes.length).toBeGreaterThan(0);

    const undo = await call(client, "undo");
    expect(undo.json().ok).toBe(true);
  });

  it("gen.video vrací simulovaný job + asset", async () => {
    const { client } = await connect();
    const res = await call(client, "gen.video", { prompt: "ohňostroj nad městem", duration: 5 });
    expect(res.isError).toBe(false);
    const { jobId, assetId } = res.json();
    expect(jobId).toBeTruthy();
    expect(assetId).toBeTruthy();
    const job = await call(client, "gen.job_status", { jobId });
    expect(job.json().job.status).toBe("done");
  });

  it("export.render vrací job", async () => {
    const { client } = await connect();
    const res = await call(client, "export.render", { format: "mp4" });
    expect(res.isError).toBe(false);
    expect(res.json().jobId).toBeTruthy();
  });

  it("chybové stavy vrací isError", async () => {
    const { client } = await connect();
    const res = await call(client, "media.get_info", { assetId: "neexistuje" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("asset not found");
  });

  it("caption translate nahradí titulky překladem", async () => {
    const { client } = await connect();
    await call(client, "captions.generate", {
      segments: [
        { text: "Hello", start: 0, end: 1 },
        { text: "world", start: 1, end: 2 },
      ],
    });
    const res = await call(client, "captions.translate", {
      replace: true,
      segments: [
        { text: "Ahoj", start: 0, end: 1 },
        { text: "světe", start: 1, end: 2 },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.json().captions.map((c: { text: string }) => c.text)).toEqual(["Ahoj", "světe"]);
  });

  it("F1: roll/slip/slide přes MCP", async () => {
    const { client } = await connect();
    const imp = await call(client, "media.import", {
      name: "v.mp4",
      path: "/tmp/v.mp4",
      kind: "video",
      duration: 20,
    });
    const assetId = imp.json().asset.id;
    const c1 = await call(client, "timeline.add_clip", { assetId, start: 0, duration: 4, in: 0, out: 4 });
    const c2 = await call(client, "timeline.add_clip", { assetId, start: 4, duration: 4, in: 4, out: 8 });
    const roll = await call(client, "timeline.roll", { clipId: c1.json().clip.id, delta: 1 });
    expect(roll.isError).toBe(false);
    expect(roll.json().left.duration).toBeCloseTo(5);
    const slip = await call(client, "timeline.slip", { clipId: c2.json().clip.id, delta: -1 });
    expect(slip.isError).toBe(false);
    expect(slip.json().clip.in).toBeCloseTo(4);
    const slide = await call(client, "timeline.slide", { clipId: c2.json().clip.id, delta: 0.5 });
    expect(slide.isError).toBe(false);
    expect(slide.json().clip.start).toBeCloseTo(5.5);
  });

  it("F1: media.get_frames vrací skutečné JPEG", async () => {
    const { client } = await connect();
    const { generateTestClip } = await import("../src/core/media.js");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "vedit-mcp-"));
    const file = join(dir, "x.mp4");
    await generateTestClip(file, { seconds: 1, size: "320x240", rate: 25 });
    const res = await call(client, "media.get_frames", { path: file, times: [0.2], width: 160 });
    expect(res.isError).toBe(false);
    const frame = res.json().frames[0];
    const buf = Buffer.from(frame.jpegBase64, "base64");
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);

    const probe = await call(client, "media.probe", { path: file });
    expect(probe.json().probe.width).toBe(320);
    expect(probe.json().probe.hasAudio).toBe(true);
  }, 60000);
});
