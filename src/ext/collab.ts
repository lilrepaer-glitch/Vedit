// F5 — Collaboration, Project Versioning / Checkpoints, Structural Diff & Merge,
// Timecoded Review Notes, Chapter Markers, and Guardrail Audit Log (PLAN.md §3.1, §4.1, §7, §9).

import { randomUUID } from "node:crypto";
import type { VeditEngine } from "../core/engine.js";
import {
  sequenceDuration,
  type AuditEntry,
  type Clip,
  type Project,
  type ProjectSnapshotMeta,
  type ReviewComment,
  type TimelineMarker,
} from "../core/types.js";

function uid(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

// ---------- Audit Log (Guardrails — PLAN.md §4, §9) ----------

export function recordAudit(
  project: Project,
  actor: AuditEntry["actor"],
  action: string,
  summary: string,
): AuditEntry {
  const entry: AuditEntry = {
    id: uid("aud"),
    timestamp: new Date().toISOString(),
    actor,
    action,
    summary,
  };
  project.auditLog ??= [];
  project.auditLog.push(entry);
  if (project.auditLog.length > 500) {
    project.auditLog.splice(0, project.auditLog.length - 500);
  }
  return entry;
}

export function listAuditLog(project: Project, limit = 50): AuditEntry[] {
  const log = project.auditLog ?? [];
  return log.slice(-Math.max(1, limit)).reverse();
}

// ---------- Named Version Checkpoints / Snapshots ----------

export function saveSnapshot(
  engine: VeditEngine,
  label: string,
  author = "editor",
): Omit<ProjectSnapshotMeta, "snapshot"> {
  const { snapshots: _s, auditLog: _a, ...cleanCopy } = structuredClone(engine.project);
  const seq = engine.activeSequence();
  const clipCount = seq.tracks.reduce((sum, t) => sum + t.clips.length, 0);
  const meta: ProjectSnapshotMeta = {
    id: uid("snap"),
    label: label.trim() || `Checkpoint ${(engine.project.snapshots?.length ?? 0) + 1}`,
    author,
    createdAt: new Date().toISOString(),
    sequenceDuration: sequenceDuration(seq),
    clipCount,
    snapshot: cleanCopy,
  };
  engine.project.snapshots ??= [];
  engine.project.snapshots.push(meta);
  recordAudit(engine.project, "api", "snapshot.save", `Saved checkpoint "${meta.label}" by ${author}`);
  const { snapshot: _omit, ...summary } = meta;
  return summary;
}

export function listSnapshots(engine: VeditEngine): Array<Omit<ProjectSnapshotMeta, "snapshot">> {
  return (engine.project.snapshots ?? []).map(({ snapshot: _omit, ...rest }) => rest);
}

export function restoreSnapshot(engine: VeditEngine, snapshotId: string): Omit<ProjectSnapshotMeta, "snapshot"> {
  const found = (engine.project.snapshots ?? []).find((s) => s.id === snapshotId);
  if (!found) throw new Error(`snapshot not found: ${snapshotId}`);
  const preservedSnapshots = structuredClone(engine.project.snapshots ?? []);
  const preservedAudit = structuredClone(engine.project.auditLog ?? []);
  const restored = structuredClone(found.snapshot);

  engine.transaction(`restore snapshot: ${found.label}`, () => {
    engine.project.name = restored.name;
    engine.project.assets = restored.assets;
    engine.project.sequences = restored.sequences;
    engine.project.activeSequenceId = restored.activeSequenceId;
    engine.project.comments = restored.comments;
    engine.project.markers = restored.markers;
    engine.project.installedPacks = restored.installedPacks;
    engine.project.snapshots = preservedSnapshots;
    engine.project.auditLog = preservedAudit;
  });

  recordAudit(engine.project, "api", "snapshot.restore", `Restored checkpoint "${found.label}" (${snapshotId})`);
  const { snapshot: _omit, ...summary } = found;
  return summary;
}

// ---------- Structural Project Diff (PLAN.md §4.1 `project.diff`) ----------

export interface ProjectDiffResult {
  baseName: string;
  targetName: string;
  durationBefore: number;
  durationAfter: number;
  durationDelta: number;
  assets: { added: string[]; removed: string[] };
  tracks: { added: string[]; removed: string[] };
  clips: { added: string[]; removed: string[]; modified: Array<{ id: string; name: string; fields: string[] }> };
  captions: { added: string[]; removed: string[]; modified: string[] };
  commentsAdded: number;
  markersAdded: number;
  summary: string;
}

function flattenClips(p: Project): Map<string, Clip> {
  const m = new Map<string, Clip>();
  for (const s of p.sequences) {
    for (const t of s.tracks) {
      for (const c of t.clips) m.set(c.id, c);
    }
  }
  return m;
}

function diffClipFields(a: Clip, b: Clip): string[] {
  const changed: string[] = [];
  if (a.name !== b.name) changed.push("name");
  if (Math.abs(a.start - b.start) > 1e-4) changed.push("start");
  if (Math.abs(a.duration - b.duration) > 1e-4) changed.push("duration");
  if (Math.abs(a.in - b.in) > 1e-4 || Math.abs(a.out - b.out) > 1e-4) changed.push("trim");
  if (JSON.stringify(a.transform) !== JSON.stringify(b.transform)) changed.push("transform");
  if (JSON.stringify(a.keyframes) !== JSON.stringify(b.keyframes)) changed.push("keyframes");
  if (JSON.stringify(a.effects) !== JSON.stringify(b.effects)) changed.push("effects");
  return changed;
}

export function diffProjects(
  base: Pick<Project, "name" | "assets" | "sequences" | "activeSequenceId" | "comments" | "markers">,
  target: Pick<Project, "name" | "assets" | "sequences" | "activeSequenceId" | "comments" | "markers">,
): ProjectDiffResult {
  const baseSeq = base.sequences.find((s) => s.id === base.activeSequenceId) ?? base.sequences[0]!;
  const targetSeq = target.sequences.find((s) => s.id === target.activeSequenceId) ?? target.sequences[0]!;
  const durationBefore = sequenceDuration(baseSeq);
  const durationAfter = sequenceDuration(targetSeq);

  const baseAssets = new Set(base.assets.map((a) => a.id));
  const targetAssets = new Set(target.assets.map((a) => a.id));
  const assetsAdded = target.assets.filter((a) => !baseAssets.has(a.id)).map((a) => a.name);
  const assetsRemoved = base.assets.filter((a) => !targetAssets.has(a.id)).map((a) => a.name);

  const baseTracks = new Set(baseSeq.tracks.map((t) => t.id));
  const targetTracks = new Set(targetSeq.tracks.map((t) => t.id));
  const tracksAdded = targetSeq.tracks.filter((t) => !baseTracks.has(t.id)).map((t) => t.name);
  const tracksRemoved = baseSeq.tracks.filter((t) => !targetTracks.has(t.id)).map((t) => t.name);

  const clipsA = flattenClips(base as Project);
  const clipsB = flattenClips(target as Project);
  const clipsAdded: string[] = [];
  const clipsRemoved: string[] = [];
  const clipsModified: Array<{ id: string; name: string; fields: string[] }> = [];

  for (const [id, c] of clipsB) {
    const prev = clipsA.get(id);
    if (!prev) clipsAdded.push(c.name);
    else {
      const fields = diffClipFields(prev, c);
      if (fields.length > 0) clipsModified.push({ id, name: c.name, fields });
    }
  }
  for (const [id, c] of clipsA) {
    if (!clipsB.has(id)) clipsRemoved.push(c.name);
  }

  const capsA = new Map(baseSeq.captions.map((c) => [c.id, c]));
  const capsB = new Map(targetSeq.captions.map((c) => [c.id, c]));
  const capsAdded = targetSeq.captions.filter((c) => !capsA.has(c.id)).map((c) => c.text);
  const capsRemoved = baseSeq.captions.filter((c) => !capsB.has(c.id)).map((c) => c.text);
  const capsModified = targetSeq.captions
    .filter((c) => {
      const p = capsA.get(c.id);
      return p && (p.text !== c.text || Math.abs(p.start - c.start) > 1e-4 || Math.abs(p.end - c.end) > 1e-4);
    })
    .map((c) => c.text);

  const commentsAdded = Math.max(0, (target.comments?.length ?? 0) - (base.comments?.length ?? 0));
  const markersAdded = Math.max(0, (target.markers?.length ?? 0) - (base.markers?.length ?? 0));

  const delta = durationAfter - durationBefore;
  const summary = [
    `Duration ${durationBefore.toFixed(2)}s → ${durationAfter.toFixed(2)}s (${delta >= 0 ? "+" : ""}${delta.toFixed(2)}s)`,
    `clips +${clipsAdded.length} / -${clipsRemoved.length} / ~${clipsModified.length}`,
    `assets +${assetsAdded.length} / -${assetsRemoved.length}`,
    `captions +${capsAdded.length} / -${capsRemoved.length} / ~${capsModified.length}`,
  ].join(" • ");

  return {
    baseName: base.name,
    targetName: target.name,
    durationBefore,
    durationAfter,
    durationDelta: delta,
    assets: { added: assetsAdded, removed: assetsRemoved },
    tracks: { added: tracksAdded, removed: tracksRemoved },
    clips: { added: clipsAdded, removed: clipsRemoved, modified: clipsModified },
    captions: { added: capsAdded, removed: capsRemoved, modified: capsModified },
    commentsAdded,
    markersAdded,
    summary,
  };
}

// ---------- Collaborative Project Merge ----------

export interface MergeResult {
  importedAssets: number;
  importedTracks: number;
  importedCaptions: number;
  importedComments: number;
  importedMarkers: number;
}

/**
 * Non-destructive collaborative merge from a second editor's `.vedit` project state:
 * merges missing assets, imports new tracks/clips without overwriting local edits,
 * and unions review comments, markers, and non-duplicate captions inside one atomic undo step.
 */
export function mergeProjectChanges(
  engine: VeditEngine,
  incoming: Project,
  author = "collaborator",
): MergeResult {
  return engine.transaction(`merge from ${incoming.name}`, () => {
    const existingAssets = new Set(engine.project.assets.map((a) => a.id));
    let importedAssets = 0;
    for (const asset of incoming.assets) {
      if (!existingAssets.has(asset.id)) {
        engine.project.assets.push(structuredClone(asset));
        existingAssets.add(asset.id);
        importedAssets++;
      }
    }

    const localSeq = engine.activeSequence();
    const incomingSeq =
      incoming.sequences.find((s) => s.id === incoming.activeSequenceId) ?? incoming.sequences[0];
    const existingTracks = new Set(localSeq.tracks.map((t) => t.id));
    const existingClips = new Set(localSeq.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    let importedTracks = 0;

    if (incomingSeq) {
      for (const track of incomingSeq.tracks) {
        if (!existingTracks.has(track.id)) {
          const clone = structuredClone(track);
          clone.name = `${track.name} (${author})`;
          localSeq.tracks.push(clone);
          importedTracks++;
        } else {
          const targetTrack = localSeq.tracks.find((t) => t.id === track.id)!;
          for (const clip of track.clips) {
            if (!existingClips.has(clip.id)) {
              targetTrack.clips.push(structuredClone(clip));
              existingClips.add(clip.id);
            }
          }
        }
      }
    }

    const existingCaps = new Set(localSeq.captions.map((c) => `${c.start.toFixed(2)}:${c.text}`));
    let importedCaptions = 0;
    for (const cap of incomingSeq?.captions ?? []) {
      const key = `${cap.start.toFixed(2)}:${cap.text}`;
      if (!existingCaps.has(key)) {
        localSeq.captions.push(structuredClone(cap));
        existingCaps.add(key);
        importedCaptions++;
      }
    }

    engine.project.comments ??= [];
    const existingCommentIds = new Set(engine.project.comments.map((c) => c.id));
    let importedComments = 0;
    for (const c of incoming.comments ?? []) {
      if (!existingCommentIds.has(c.id)) {
        engine.project.comments.push(structuredClone(c));
        importedComments++;
      }
    }

    engine.project.markers ??= [];
    const existingMarkerIds = new Set(engine.project.markers.map((m) => m.id));
    let importedMarkers = 0;
    for (const m of incoming.markers ?? []) {
      if (!existingMarkerIds.has(m.id)) {
        engine.project.markers.push(structuredClone(m));
        importedMarkers++;
      }
    }

    recordAudit(
      engine.project,
      "api",
      "collab.merge",
      `Merged "${incoming.name}" (+${importedAssets} assets, +${importedTracks} tracks, +${importedCaptions} captions)`,
    );
    return { importedAssets, importedTracks, importedCaptions, importedComments, importedMarkers };
  });
}

// ---------- Timecoded Review Notes & Chapter Markers ----------

export function addReviewComment(
  engine: VeditEngine,
  input: { author?: string; text: string; timecode: number },
): ReviewComment {
  if (!input.text.trim()) throw new Error("comment text is required");
  const comment: ReviewComment = {
    id: uid("cmt"),
    author: input.author?.trim() || "Reviewer",
    text: input.text.trim(),
    timecode: Math.max(0, input.timecode),
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  engine.transaction("add review comment", () => {
    engine.project.comments ??= [];
    engine.project.comments.push(comment);
  });
  return comment;
}

export function resolveReviewComment(engine: VeditEngine, commentId: string, resolved = true): ReviewComment {
  const found = (engine.project.comments ?? []).find((c) => c.id === commentId);
  if (!found) throw new Error(`comment not found: ${commentId}`);
  engine.transaction("resolve review comment", () => {
    const target = engine.project.comments!.find((c) => c.id === commentId)!;
    target.resolved = resolved;
  });
  return engine.project.comments!.find((c) => c.id === commentId)!;
}

export function deleteReviewComment(engine: VeditEngine, commentId: string): void {
  engine.transaction("delete review comment", () => {
    engine.project.comments = (engine.project.comments ?? []).filter((c) => c.id !== commentId);
  });
}

export function addTimelineMarker(
  engine: VeditEngine,
  input: { time: number; label: string; color?: string },
): TimelineMarker {
  const marker: TimelineMarker = {
    id: uid("mkr"),
    time: Math.max(0, input.time),
    label: input.label.trim() || "Marker",
    color: input.color ?? "#4f8cff",
  };
  engine.transaction("add marker", () => {
    engine.project.markers ??= [];
    engine.project.markers.push(marker);
    engine.project.markers.sort((a, b) => a.time - b.time);
  });
  return marker;
}

function fmtYouTubeTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

export function exportYouTubeChapters(project: Project): {
  markers: TimelineMarker[];
  youtubeDescription: string;
} {
  let markers = [...(project.markers ?? [])].sort((a, b) => a.time - b.time);
  if (markers.length === 0) {
    const seq = project.sequences.find((s) => s.id === project.activeSequenceId) ?? project.sequences[0];
    const clips = (seq?.tracks.flatMap((t) => t.clips) ?? []).sort((a, b) => a.start - b.start);
    markers = clips.map((c, idx) => ({
      id: `auto-${idx}`,
      time: idx === 0 ? 0 : c.start,
      label: c.name.replace(/\.[^.]+$/, ""),
    }));
  }
  if (markers.length === 0 || markers[0]!.time > 0) {
    markers = [{ id: "auto-intro", time: 0, label: "Intro" }, ...markers];
  }
  const youtubeDescription = markers.map((m) => `${fmtYouTubeTime(m.time)} ${m.label}`).join("\n");
  return { markers, youtubeDescription };
}
