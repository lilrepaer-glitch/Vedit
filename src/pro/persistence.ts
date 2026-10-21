// F6: Project Disk Persistence (.vedit JSON Save / Open / Autosave — PLAN.md §3.1, §4.1, §6)

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve as resolvePath } from "node:path";
import { VeditEngine } from "../core/engine.js";
import type { Project } from "../core/types.js";

export interface SavedProjectInfo {
  fileName: string;
  filePath: string;
  name: string;
  id: string;
  updatedAt: string;
  sizeBytes: number;
}

function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project"
  );
}

export async function saveProjectToDisk(
  engine: VeditEngine,
  dataDir: string,
  customPath?: string,
): Promise<{ filePath: string; sizeBytes: number; savedAt: string }> {
  const projectsDir = resolvePath(dataDir, "projects");
  await mkdir(projectsDir, { recursive: true });
  const targetPath = customPath
    ? resolvePath(customPath)
    : join(projectsDir, `${slugifyName(engine.project.name)}-${engine.project.id.slice(0, 8)}.vedit`);
  await mkdir(resolvePath(targetPath, ".."), { recursive: true });
  const json = JSON.stringify(engine.project, null, 2);
  await writeFile(targetPath, json, "utf-8");
  const st = await stat(targetPath);
  return {
    filePath: targetPath,
    sizeBytes: st.size,
    savedAt: new Date().toISOString(),
  };
}

export async function loadProjectFromDisk(filePath: string): Promise<VeditEngine> {
  const resolved = resolvePath(filePath);
  const raw = await readFile(resolved, "utf-8");
  const parsed = JSON.parse(raw) as Project;
  if (parsed?.format !== "vedit-project") {
    throw new Error(`Invalid .vedit project file: ${basename(resolved)}`);
  }
  return new VeditEngine(parsed);
}

export async function listSavedProjects(dataDir: string): Promise<SavedProjectInfo[]> {
  const projectsDir = resolvePath(dataDir, "projects");
  await mkdir(projectsDir, { recursive: true });
  const entries = await readdir(projectsDir);
  const items: SavedProjectInfo[] = [];
  for (const entry of entries) {
    if (extname(entry).toLowerCase() !== ".vedit") continue;
    const fp = join(projectsDir, entry);
    try {
      const [raw, st] = await Promise.all([readFile(fp, "utf-8"), stat(fp)]);
      const parsed = JSON.parse(raw) as Project;
      if (parsed?.format !== "vedit-project") continue;
      items.push({
        fileName: entry,
        filePath: fp,
        name: parsed.name,
        id: parsed.id,
        updatedAt: parsed.updatedAt,
        sizeBytes: st.size,
      });
    } catch {
      // skip corrupt or partial files
    }
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
