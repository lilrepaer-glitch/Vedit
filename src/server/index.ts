// Entry point: starts the local REST + WebSocket API server (vedit serve).

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { createApp, ProjectRegistry } from "./app.js";
import { attachWs } from "./ws.js";
import { VeditEngine } from "../core/engine.js";
import { listSavedProjects, loadProjectFromDisk } from "../pro/persistence.js";

export interface StartOptions {
  port?: number;
  host?: string;
  token?: string | null;
  sample?: boolean;
  dataDir?: string;
  quiet?: boolean;
}

/**
 * Seeds a clean, silent, ready-to-edit studio sequence (`Untitled Edit`)
 * with empty `V1`, `V2 Overlay`, and `A1 Audio` tracks — zero synthetic test bars or sine beeps.
 */
export async function seedCleanStarterProject(registry: ProjectRegistry, dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  try {
    const saved = await listSavedProjects(dataDir);
    if (saved.length > 0) {
      for (const item of saved.slice(0, 10)) {
        try {
          const loaded = await loadProjectFromDisk(item.filePath);
          registry.add(loaded);
        } catch {
          /* skip unreadable project file */
        }
      }
      if (registry.list().length > 0) return;
    }
  } catch {
    /* ignore empty save dir */
  }

  const engine = new VeditEngine(VeditEngine.createProject("Untitled Edit"));
  engine.addTrack("video", "V1");
  engine.addTrack("graphics", "V2 Overlay");
  engine.addTrack("audio", "A1 Audio");
  registry.add(new VeditEngine(engine.project));
}

export const seedDemoProject = seedCleanStarterProject;

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

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (!opts.quiet) {
      console.error(`Vedit API server error on ${host}:${port}: ${err.message}`);
    }
  });

  // Start listening immediately (<25ms) with a clean empty studio project, and restore saved disk projects if present
  if (opts.sample !== false && registry.list().length === 0) {
    const clean = new VeditEngine(VeditEngine.createProject("Untitled Edit"));
    clean.addTrack("video", "V1");
    clean.addTrack("graphics", "V2 Overlay");
    clean.addTrack("audio", "A1 Audio");
    registry.add(new VeditEngine(clean.project));
    void listSavedProjects(dataDir)
      .then(async (saved) => {
        for (const item of saved.slice(0, 10)) {
          try {
            const loaded = await loadProjectFromDisk(item.filePath);
            if (!registry.has(loaded.project.id)) registry.add(loaded);
          } catch {
            /* ignore unreadable file */
          }
        }
      })
      .catch(() => undefined);
  }

  server.listen(port, host, () => {
    if (!opts.quiet) {
      console.log(`Vedit API  running on http://${host}:${port}`);
      console.log(`WebSocket  ws://${host}:${port}/ws`);
      console.log(`Data dir   ${dataDir}`);
      if (token) console.log(`API token  ${token}`);
    }
  });

  return { server, app, registry, port, host, token };
}

if (process.argv[1] && process.argv[1].endsWith("server/index.js")) {
  startServer();
}

export { createApp, ProjectRegistry } from "./app.js";
export { attachWs } from "./ws.js";
