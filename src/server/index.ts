// Entry point: starts the REST+WS API server (vedit serve).

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { createApp, ProjectRegistry } from "./app.js";
import { attachWs } from "./ws.js";
import { VeditEngine } from "../core/engine.js";
import { generateTestClip, probeMedia, run, ffmpegPath } from "../core/media.js";

export interface StartOptions {
  port?: number;
  host?: string;
  token?: string | null;
  sample?: boolean;
  dataDir?: string;
  quiet?: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Demo projekt s reálnými ukázkovými klipy (generované přes FFmpeg lavfi),
 * aby UI mělo co ukázat hned po startu.
 */
export async function seedDemoProject(registry: ProjectRegistry, dataDir: string): Promise<void> {
  const mediaDir = resolvePath(dataDir, "media");
  await mkdir(mediaDir, { recursive: true });
  const clipA = resolvePath(mediaDir, "demo_zaber_01.mp4");
  const clipB = resolvePath(mediaDir, "demo_zaber_02.mp4");
  const music = resolvePath(mediaDir, "demo_hudba.wav");
  if (!(await exists(clipA))) await generateTestClip(clipA, { seconds: 5, kind: "testsrc", freq: 440 });
  if (!(await exists(clipB))) await generateTestClip(clipB, { seconds: 4, kind: "smptebars", freq: 660 });
  if (!(await exists(music))) {
    await run(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
      "-t", "9", music, "-y",
    ]);
  }

  const engine = new VeditEngine(VeditEngine.createProject("Demo projekt"));
  const v1 = engine.addTrack("video", "V1");
  const a1 = engine.addTrack("audio", "A1");

  const probeA = await probeMedia(clipA);
  const probeB = await probeMedia(clipB);
  const probeM = await probeMedia(music);

  const assetA = engine.addAsset({
    name: "demo_zaber_01.mp4",
    kind: "video",
    path: clipA,
    duration: probeA.duration,
    width: probeA.width,
    height: probeA.height,
    fps: probeA.fps,
    sizeBytes: probeA.sizeBytes,
    videoCodec: probeA.videoCodec,
    audioCodec: probeA.audioCodec,
    hasAudio: probeA.hasAudio,
    source: { provider: "vedit-demo", model: "lavfi-testsrc2", prompt: "demo záběr", simulated: true },
  });
  const assetB = engine.addAsset({
    name: "demo_zaber_02.mp4",
    kind: "video",
    path: clipB,
    duration: probeB.duration,
    width: probeB.width,
    height: probeB.height,
    fps: probeB.fps,
    sizeBytes: probeB.sizeBytes,
    videoCodec: probeB.videoCodec,
    audioCodec: probeB.audioCodec,
    hasAudio: probeB.hasAudio,
    source: { provider: "vedit-demo", model: "lavfi-smptebars", prompt: "barevné pruhy", simulated: true },
  });
  const assetM = engine.addAsset({
    name: "demo_hudba.wav",
    kind: "audio",
    path: music,
    duration: probeM.duration,
    sizeBytes: probeM.sizeBytes,
    audioCodec: probeM.audioCodec,
    hasAudio: true,
    source: { provider: "vedit-demo", model: "lavfi-sine", prompt: "podkladová hudba", simulated: true },
  });

  const c1 = engine.addClip({ trackId: v1.id, assetId: assetA.id, start: 0, duration: 3, in: 0.5, out: 3.5 });
  const c2 = engine.addClip({ trackId: v1.id, assetId: assetB.id, start: 3, duration: 2.5, in: 0.5, out: 3 });
  engine.addClip({ trackId: a1.id, assetId: assetM.id, start: 0, duration: 5.5, in: 1, out: 6.5 });
  engine.applyAnimationPreset(c1.id, "fade-in");
  engine.applyAnimationPreset(c2.id, "slide-in-left");
  engine.addCaption({ text: "Vedit — demo projekt", start: 0.3, end: 2.2 });
  engine.addCaption({ text: "F1: reálný render přes FFmpeg", start: 3.1, end: 5.2 });
  registry.add(engine);
}

export function startServer(opts: StartOptions = {}) {
  const port = opts.port ?? Number(process.env.VEDIT_PORT ?? 47000);
  const host = opts.host ?? process.env.VEDIT_HOST ?? "127.0.0.1";
  const dataDir = resolvePath(opts.dataDir ?? process.env.VEDIT_DATA ?? ".vedit");
  const token =
    opts.token !== undefined
      ? opts.token
      : process.env.VEDIT_API_TOKEN ?? randomBytes(16).toString("hex");

  let hub: ReturnType<typeof attachWs> | null = null;

  const { app, registry } = createApp({
    token: token ?? undefined,
    dataDir,
    onChange: (projectId, label, engine) =>
      hub?.broadcast({ type: "change", projectId, label, jobs: engine.project.jobs }),
    onJob: (projectId, engine) =>
      hub?.broadcast({ type: "job", projectId, jobs: engine.project.jobs }),
  });

  const server = createServer(app);
  hub = attachWs(server, registry);

  void (async () => {
    if (opts.sample !== false) {
      try {
        await seedDemoProject(registry, dataDir);
      } catch (err) {
        if (!opts.quiet) console.warn(`demo projekt se nepodařilo vytvořit: ${(err as Error).message}`);
        registry.create("Demo projekt", true);
      }
    }
    server.listen(port, host, () => {
      if (!opts.quiet) {
        console.log(`Vedit API  běží na http://${host}:${port}`);
        console.log(`WebSocket  ws://${host}:${port}/ws`);
        console.log(`Data dir   ${dataDir}`);
        if (token) console.log(`API token  ${token}`);
        const first = registry.list()[0];
        if (first) console.log(`Demo projekt  ${first.id} (${first.name})`);
      }
    });
  })();

  return { server, app, registry, port, host, token };
}

// přímé spuštění: node dist/server/index.js
if (process.argv[1] && process.argv[1].endsWith("server/index.js")) {
  startServer();
}

export { createApp, ProjectRegistry } from "./app.js";
export { attachWs } from "./ws.js";
