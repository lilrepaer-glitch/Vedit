// F5 — Pro Delivery: Render Queue Status, Multi-Platform Batch Export & Watch Folders
// (PLAN.md §3.6, §4.1: `export.queue_status`, batch export, watch-folders).

import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve as resolvePath } from "node:path";
import { VeditEngine } from "../core/engine.js";
import { probeMedia } from "../core/media.js";
import { EXPORT_PRESETS, renderSequence, resolveExportPreset, type RenderResult } from "../render/export.js";
import { applyTemplate } from "./marketplace.js";

export interface QueueSummary {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  jobs: Array<{
    id: string;
    type: string;
    status: string;
    progress: number;
    preset?: string;
    outPath?: string;
    error?: string;
  }>;
}

export function getQueueStatus(engine: VeditEngine): QueueSummary {
  const jobs = engine.project.jobs;
  return {
    total: jobs.length,
    queued: jobs.filter((j) => j.status === "queued").length,
    running: jobs.filter((j) => j.status === "running").length,
    done: jobs.filter((j) => j.status === "done").length,
    failed: jobs.filter((j) => j.status === "failed").length,
    jobs: jobs.slice(-20).map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      progress: j.progress,
      preset: typeof j.input.preset === "string" ? j.input.preset : undefined,
      outPath: typeof j.output?.outPath === "string" ? j.output.outPath : undefined,
      error: j.error,
    })),
  };
}

export function listExportPresets() {
  return EXPORT_PRESETS;
}

/**
 * Queue multiple export deliverables in one batch (e.g. YouTube 1080p + TikTok 9:16 + ProRes Master).
 */
export function runBatchExport(
  engine: VeditEngine,
  presetIds: string[],
  opts: { renderDir: string; onUpdate?: () => void },
): { batchId: string; jobIds: string[] } {
  if (!presetIds.length) throw new Error("at least one preset ID is required for batch export");
  const batchId = `batch-${randomUUID().slice(0, 8)}`;
  const jobIds: string[] = [];

  for (const presetId of presetIds) {
    const preset = resolveExportPreset(presetId);
    if (!preset) throw new Error(`unknown export preset: ${presetId}`);
    const job = engine.createJob("render", {
      batchId,
      preset: preset.id,
      format: preset.format,
      codec: preset.codec,
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
      simulated: false,
    });
    jobIds.push(job.id);
    const outPath = resolvePath(opts.renderDir, `${job.id}-${preset.id}.${preset.format}`);

    void (async () => {
      try {
        engine.updateJob(job.id, { status: "running", progress: 2 });
        opts.onUpdate?.();
        const result = await renderSequence(engine.project, {
          outPath,
          preset: preset.id,
          onProgress: (pct) => {
            engine.updateJob(job.id, { progress: pct });
            opts.onUpdate?.();
          },
        });
        engine.updateJob(job.id, {
          status: "done",
          progress: 100,
          output: {
            batchId,
            preset: preset.id,
            codec: result.codec,
            outPath: result.outPath,
            duration: result.duration,
            width: result.width,
            height: result.height,
            fps: result.fps,
            sizeBytes: result.sizeBytes,
            warnings: result.warnings,
          },
        });
        opts.onUpdate?.();
      } catch (err) {
        engine.updateJob(job.id, { status: "failed", error: (err as Error).message });
        opts.onUpdate?.();
      }
    })();
  }

  return { batchId, jobIds };
}

// ---------- Watch Folders (PLAN.md §3.6) ----------

const WATCH_MEDIA_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);

export interface WatchFolderConfig {
  id?: string;
  inboxDir: string;
  outputDir: string;
  preset?: string;
  templateId?: string;
  pollMs?: number;
}

export interface WatchProcessedItem {
  sourcePath: string;
  outPath: string;
  preset: string;
  sizeBytes: number;
  processedAt: string;
}

export interface ActiveWatcherInfo {
  id: string;
  inboxDir: string;
  outputDir: string;
  preset: string;
  templateId?: string;
  processedCount: number;
  history: WatchProcessedItem[];
}

interface InternalWatcher {
  id: string;
  inboxDir: string;
  outputDir: string;
  preset: string;
  templateId?: string;
  timer: ReturnType<typeof setInterval>;
  seen: Set<string>;
  inFlight: Set<string>;
  history: WatchProcessedItem[];
  onRendered?: (item: WatchProcessedItem) => void;
}

export class WatchFolderManager {
  private watchers = new Map<string, InternalWatcher>();

  async start(
    cfg: WatchFolderConfig,
    onRendered?: (item: WatchProcessedItem) => void,
  ): Promise<ActiveWatcherInfo> {
    const inboxDir = resolvePath(cfg.inboxDir);
    const outputDir = resolvePath(cfg.outputDir);
    await mkdir(inboxDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const id = cfg.id ?? `watch-${randomUUID().slice(0, 8)}`;
    if (this.watchers.has(id)) this.stop(id);

    const presetId = cfg.preset ?? "youtube-1080p";
    const preset = resolveExportPreset(presetId);
    if (!preset) throw new Error(`unknown export preset: ${presetId}`);

    const entry: InternalWatcher = {
      id,
      inboxDir,
      outputDir,
      preset: presetId,
      templateId: cfg.templateId,
      seen: new Set<string>(),
      inFlight: new Set<string>(),
      history: [],
      onRendered,
      timer: setInterval(() => {
        void this.scanOnce(entry);
      }, cfg.pollMs ?? 500),
    };
    entry.timer.unref?.();
    this.watchers.set(id, entry);
    await this.scanOnce(entry);
    return this.info(entry);
  }

  private async scanOnce(w: InternalWatcher): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(w.inboxDir);
    } catch {
      return;
    }
    for (const name of entries) {
      const ext = extname(name).toLowerCase();
      if (!WATCH_MEDIA_EXTS.has(ext)) continue;
      const fullPath = join(w.inboxDir, name);
      if (w.seen.has(fullPath) || w.inFlight.has(fullPath)) continue;
      try {
        const st = await stat(fullPath);
        if (!st.isFile() || st.size === 0) continue;
      } catch {
        continue;
      }
      w.inFlight.add(fullPath);
      try {
        const result = await renderSingleWatchedFile(fullPath, w.outputDir, w.preset, w.templateId);
        w.seen.add(fullPath);
        const item: WatchProcessedItem = {
          sourcePath: fullPath,
          outPath: result.outPath,
          preset: w.preset,
          sizeBytes: result.sizeBytes,
          processedAt: new Date().toISOString(),
        };
        w.history.push(item);
        w.onRendered?.(item);
      } catch {
        /* file may still be copying — retry on next tick */
      } finally {
        w.inFlight.delete(fullPath);
      }
    }
  }

  stop(id: string): boolean {
    const found = this.watchers.get(id);
    if (!found) return false;
    clearInterval(found.timer);
    this.watchers.delete(id);
    return true;
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stop(id);
  }

  list(): ActiveWatcherInfo[] {
    return [...this.watchers.values()].map((w) => this.info(w));
  }

  private info(w: InternalWatcher): ActiveWatcherInfo {
    return {
      id: w.id,
      inboxDir: w.inboxDir,
      outputDir: w.outputDir,
      preset: w.preset,
      templateId: w.templateId,
      processedCount: w.history.length,
      history: [...w.history],
    };
  }
}

async function renderSingleWatchedFile(
  mediaPath: string,
  outputDir: string,
  presetId: string,
  templateId?: string,
): Promise<RenderResult> {
  const preset = resolveExportPreset(presetId)!;
  const probe = await probeMedia(mediaPath);
  const engine = new VeditEngine(VeditEngine.createProject(`Watch ${basename(mediaPath)}`));
  const seq = engine.activeSequence();
  seq.width = preset.width ?? (probe.width || 1920);
  seq.height = preset.height ?? (probe.height || 1080);
  seq.fps = preset.fps ?? (probe.fps || 30);

  const asset = engine.addAsset({
    name: basename(mediaPath),
    kind: "video",
    path: mediaPath,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    hasAudio: probe.hasAudio,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
  });
  const track = engine.addTrack("video", "V1");
  const dur = Math.max(0.2, probe.duration);
  engine.addClip({
    trackId: track.id,
    assetId: asset.id,
    name: asset.name,
    start: 0,
    duration: dur,
    in: 0,
    out: dur,
  });

  if (templateId) {
    applyTemplate(engine, templateId, {});
  }

  const stem = basename(mediaPath, extname(mediaPath));
  const outPath = join(outputDir, `${stem}-${preset.id}.${preset.format}`);
  return renderSequence(engine.project, { outPath, preset: preset.id });
}
