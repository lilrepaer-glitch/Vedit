// WebSocket layer — realtime události (PLAN.md §5)

import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { VeditEngine } from "../core/engine.js";
import type { ProjectRegistry } from "./app.js";

export interface WsHub {
  broadcast: (message: unknown) => void;
  close: () => void;
}

export function attachWs(httpServer: Server, registry: ProjectRegistry, path = "/ws"): WsHub {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "hello", projects: registry.list() }));
  });

  const broadcast = (message: unknown) => {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  };

  // engine events → broadcast
  const send = (projectId: string, engine: VeditEngine, label?: string) => {
    broadcast({
      type: label != null ? "change" : "job",
      projectId,
      ...(label != null ? { label } : {}),
      jobs: engine.project.jobs,
    });
  };

  // Projects created after attach are wired through registry opts; to keep the hub
  // simple the caller passes onChange/onJob hooks that call broadcast directly.

  return {
    broadcast,
    close: () => wss.close(),
  };
}

export type { WebSocket };
