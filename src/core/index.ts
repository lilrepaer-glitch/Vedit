export * from "./types.js";
export * from "./schemas.js";
export * from "./presets.js";
export * from "./engine.js";

import { readFile, writeFile } from "node:fs/promises";
import type { Project } from "./types.js";
import { parseProject, serializeProject } from "./schemas.js";
import { VeditEngine } from "./engine.js";

/** Save a project to the open .vedit JSON format (PLAN.md §6). */
export async function saveProject(project: Project, filePath: string): Promise<void> {
  await writeFile(filePath, serializeProject(project) + "\n", "utf8");
}

/** Load a .vedit project file; throws with a validation error on bad data. */
export async function loadProject(filePath: string): Promise<Project> {
  const text = await readFile(filePath, "utf8");
  return parseProject(JSON.parse(text));
}

/** Load a project file into an engine, or create a fresh one. */
export async function loadOrInitEngine(filePath: string, name = "Untitled"): Promise<VeditEngine> {
  try {
    const project = await loadProject(filePath);
    return new VeditEngine(project);
  } catch {
    const engine = new VeditEngine(VeditEngine.createProject(name));
    await saveProject(engine.project, filePath);
    return engine;
  }
}
