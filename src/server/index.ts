// Entry point: starts the REST+WS API server (vedit serve).

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createApp, ProjectRegistry } from "./app.js";
import { attachWs } from "./ws.js";
import { VeditEngine } from "../core/engine.js";

export interface StartOptions {
  port?: number;
  host?: string;
  token?: string | null;
  sample?: boolean;
  quiet?: boolean;
}

export function startServer(opts: StartOptions = {}) {
  const port = opts.port ?? Number(process.env.VEDIT_PORT ?? 47000);
  const host = opts.host ?? process.env.VEDIT_HOST ?? "127.0.0.1";
  const token =
    opts.token !== undefined
      ? opts.token
      : process.env.VEDIT_API_TOKEN ?? randomBytes(16).toString("hex");

  let hub: ReturnType<typeof attachWs> | null = null;

  const { app, registry } = createApp({
    token: token ?? undefined,
    onChange: (projectId, label, engine) =>
      hub?.broadcast({ type: "change", projectId, label, jobs: engine.project.jobs }),
    onJob: (projectId, engine) =>
      hub?.broadcast({ type: "job", projectId, jobs: engine.project.jobs }),
  });

  if (opts.sample !== false) {
    const sample = VeditEngine.createSampleProject();
    registry.add(sample.engine);
  }

  const server = createServer(app);
  hub = attachWs(server, registry);

  server.listen(port, host, () => {
    if (!opts.quiet) {
      console.log(`Vedit API  běží na http://${host}:${port}`);
      console.log(`WebSocket  ws://${host}:${port}/ws`);
      if (token) console.log(`API token  ${token}`);
      const first = registry.list()[0];
      if (first) console.log(`Demo projekt  ${first.id} (${first.name})`);
    }
  });

  return { server, app, registry, port, host, token };
}

// přímé spuštění: node dist/server/index.js
if (process.argv[1] && process.argv[1].endsWith("server/index.js")) {
  startServer();
}

export { createApp, ProjectRegistry } from "./app.js";
export { attachWs } from "./ws.js";
