// MCP Streamable HTTP entry: lokální endpoint pro klienty bez stdio.

import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VeditEngine } from "../core/engine.js";
import { buildMcpServer, type McpContext } from "./server.js";

export function createMcpHttpApp(ctx: McpContext) {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req: Request, res: Response) => {
    // stateless: nový server+transport per request (jednoduché a spolehlivé pro F0)
    const server = buildMcpServer({ ...ctx, engine: ctx.engine });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "use POST /mcp (Streamable HTTP)" });
  });

  return app;
}

export function startMcpHttp(opts: { port?: number; host?: string; engine?: VeditEngine } = {}) {
  const ctx: McpContext = {
    engine: opts.engine ?? new VeditEngine(VeditEngine.createProject("Untitled")),
  };
  const app = createMcpHttpApp(ctx);
  const port = opts.port ?? Number(process.env.VEDIT_MCP_PORT ?? 47001);
  const host = opts.host ?? "127.0.0.1";
  const server = app.listen(port, host, () => {
    console.log(`Vedit MCP (HTTP) na http://${host}:${port}/mcp`);
  });
  return { server, app, ctx };
}
