// MCP stdio entry: `vedit mcp` — pro Claude Desktop, Cursor, Claude Code apod.

import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VeditEngine } from "../core/engine.js";
import { loadProject, saveProject } from "../core/index.js";
import { buildMcpServer, type McpContext } from "./server.js";

export async function startStdio(projectPath?: string): Promise<void> {
  const file = resolve(projectPath ?? process.env.VEDIT_PROJECT ?? ".vedit/project.vedit");

  const load = async (path: string) => {
    const project = await loadProject(path);
    ctx.engine = new VeditEngine(project);
  };

  const ctx: McpContext = {
    engine: new VeditEngine(VeditEngine.createProject("Untitled")),
    save: () => saveProject(ctx.engine.project, file),
    open: load,
  };

  try {
    await load(file);
  } catch {
    await saveProject(ctx.engine.project, file);
  }

  const server = buildMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  console.error(`vedit MCP (stdio) připojen, projekt: ${file}`);
}

// přímé spuštění
if (process.argv[1] && process.argv[1].endsWith("mcp/stdio.js")) {
  void startStdio();
}

export { buildMcpServer } from "./server.js";
