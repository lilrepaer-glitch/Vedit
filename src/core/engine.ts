// VeditEngine — timeline operations core (PLAN.md §3, §5 "sdílejí stejné jádro operací")
// All mutations are transactional: each op records undo/redo snapshots.

import { randomUUID } from "node:crypto";
import {
  type Asset,
  type AssetKind,
  type Caption,
  type Clip,
  type EffectInstance,
  type ID,
  type Job,
  type JobStatus,
  type JobType,
  type Keyframe,
  type Project,
  type Sequence,
  type Track,
  type TrackKind,
  clipEnd,
  sequenceDuration,
} from "./types.js";
import { ANIMATION_PRESETS } from "./presets.js";

function now(): string {
  return new Date().toISOString();
}

function newId(): ID {
  return randomUUID();
}

interface ProjectSnapshot {
  assets: Asset[];
  sequences: Sequence[];
  activeSequenceId: ID;
}

interface Command {
  label: string;
  before: ProjectSnapshot;
  after: ProjectSnapshot;
}

export interface AddClipInput {
  trackId: ID;
  assetId: ID;
  start: number;
  duration?: number;
  in?: number;
  out?: number;
  name?: string;
}

export type EngineEvent =
  | { type: "change"; label: string }
  | { type: "job"; job: Job };

type Listener = (event: EngineEvent) => void;

export class VeditEngine {
  project: Project;
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners: Listener[] = [];

  constructor(project?: Project) {
    this.project = project ?? VeditEngine.createProject("Untitled");
  }

  static createProject(
    name: string,
    opts: { width?: number; height?: number; fps?: number } = {},
  ): Project {
    const seq: Sequence = {
      id: newId(),
      name: `${name} — Sequence 01`,
      width: opts.width ?? 1920,
      height: opts.height ?? 1080,
      fps: opts.fps ?? 30,
      tracks: [],
      captions: [],
    };
    return {
      format: "vedit-project",
      formatVersion: 1,
      id: newId(),
      name,
      createdAt: now(),
      updatedAt: now(),
      assets: [],
      sequences: [seq],
      activeSequenceId: seq.id,
      jobs: [],
    };
  }

  /** Seed a small demo project (used by the server for the first-run UI). */
  static createSampleProject(): { engine: VeditEngine; assets: Asset[]; clips: Clip[] } {
    const engine = new VeditEngine(VeditEngine.createProject("Demo projekt"));
    const v1 = engine.addTrack("video", "V1");
    const a1 = engine.addTrack("audio", "A1");
    const video = engine.addAsset({
      name: "ukazka_zaberu.mp4",
      kind: "video",
      path: "/media/ukazka_zaberu.mp4",
      duration: 30,
      width: 1920,
      height: 1080,
      fps: 30,
    });
    const music = engine.addAsset({
      name: "hudba_podklad.mp3",
      kind: "audio",
      path: "/media/hudba_podklad.mp3",
      duration: 45,
    });
    const clipA = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 8, in: 2, out: 10 });
    const clipB = engine.addClip({ trackId: v1.id, assetId: video.id, start: 8, duration: 6, in: 14, out: 20 });
    const clipC = engine.addClip({ trackId: a1.id, assetId: music.id, start: 0, duration: 14, in: 0, out: 14 });
    return { engine, assets: [video, music], clips: [clipA, clipB, clipC] };
  }

  // ---- events ----

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: EngineEvent): void {
    for (const l of this.listeners) l(event);
  }

  // ---- queries ----

  activeSequence(): Sequence {
    const seq = this.project.sequences.find((s) => s.id === this.project.activeSequenceId);
    if (!seq) throw new Error("active sequence not found");
    return seq;
  }

  findTrack(trackId: ID): Track {
    const track = this.activeSequence().tracks.find((t) => t.id === trackId);
    if (!track) throw new Error(`track not found: ${trackId}`);
    return track;
  }

  findClip(trackId: ID, clipId: ID): { track: Track; clip: Clip; index: number } {
    const track = this.findTrack(trackId);
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index < 0) throw new Error(`clip not found: ${clipId}`);
    return { track, clip: track.clips[index]!, index };
  }

  /** Find a clip by id on any track of the active sequence. */
  findClipAnywhere(clipId: ID): { track: Track; clip: Clip; index: number } {
    for (const track of this.activeSequence().tracks) {
      const index = track.clips.findIndex((c) => c.id === clipId);
      if (index >= 0) return { track, clip: track.clips[index]!, index };
    }
    throw new Error(`clip not found: ${clipId}`);
  }

  findAsset(assetId: ID): Asset {
    const asset = this.project.assets.find((a) => a.id === assetId);
    if (!asset) throw new Error(`asset not found: ${assetId}`);
    return asset;
  }

  timeline(): {
    sequence: Sequence;
    duration: number;
    tracks: Array<Track & { clips: Array<Clip & { end: number }> }>;
  } {
    const seq = this.activeSequence();
    return {
      sequence: seq,
      duration: sequenceDuration(seq),
      tracks: seq.tracks.map((t) => ({
        ...t,
        clips: [...t.clips]
          .sort((a, b) => a.start - b.start)
          .map((c) => ({ ...c, end: clipEnd(c) })),
      })),
    };
  }

  // ---- transactions / undo ----

  private snapshot(): ProjectSnapshot {
    return structuredClone({
      assets: this.project.assets,
      sequences: this.project.sequences,
      activeSequenceId: this.project.activeSequenceId,
    });
  }

  private restore(snap: ProjectSnapshot): void {
    this.project.assets = snap.assets;
    this.project.sequences = snap.sequences;
    this.project.activeSequenceId = snap.activeSequenceId;
    this.project.updatedAt = now();
  }

  private commit(label: string, mutate: () => void): void {
    if (this.txDepth > 0) {
      // uvnitř transakce: mutuje se, snapshot se zaznamená navenek
      mutate();
      return;
    }
    const before = this.snapshot();
    mutate();
    const after = this.snapshot();
    this.undoStack.push({ label, before, after });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.project.updatedAt = now();
    this.emit({ type: "change", label });
  }

  private txDepth = 0;

  /**
   * Více operací jako jeden undo krok (AI workflow: voiceover = asset + klip + titulky).
   * Při chybě se stav vrátí zpět.
   */
  transaction<T>(label: string, fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    const before = this.snapshot();
    this.txDepth = 1;
    try {
      const result = fn();
      this.txDepth = 0;
      const after = this.snapshot();
      this.undoStack.push({ label, before, after });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.project.updatedAt = now();
      this.emit({ type: "change", label });
      return result;
    } catch (err) {
      this.txDepth = 0;
      this.restore(before);
      this.emit({ type: "change", label: `rollback: ${label}` });
      throw err;
    }
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    this.restore(cmd.before);
    this.redoStack.push(cmd);
    this.emit({ type: "change", label: `undo: ${cmd.label}` });
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    this.restore(cmd.after);
    this.undoStack.push(cmd);
    this.emit({ type: "change", label: `redo: ${cmd.label}` });
    return true;
  }

  get undoLabels(): string[] {
    return this.undoStack.map((c) => c.label);
  }

  get redoLabels(): string[] {
    return this.redoStack.map((c) => c.label);
  }

  // ---- assets ----

  addAsset(input: Omit<Asset, "id" | "createdAt">): Asset {
    const asset: Asset = { id: newId(), createdAt: now(), ...input };
    this.commit(`asset.add "${asset.name}"`, () => {
      this.project.assets.push(asset);
    });
    return asset;
  }

  removeAsset(assetId: ID): void {
    const used = this.project.sequences.some((s) =>
      s.tracks.some((t) => t.clips.some((c) => c.assetId === assetId)),
    );
    if (used) throw new Error("asset is used by clips; remove the clips first");
    const index = this.project.assets.findIndex((a) => a.id === assetId);
    if (index < 0) throw new Error(`asset not found: ${assetId}`);
    this.commit(`asset.remove "${this.project.assets[index]!.name}"`, () => {
      this.project.assets.splice(index, 1);
    });
  }

  // ---- tracks ----

  addTrack(kind: TrackKind, name?: string): Track {
    const seq = this.activeSequence();
    const count = seq.tracks.filter((t) => t.kind === kind).length + 1;
    const prefix = kind === "video" ? "V" : kind === "audio" ? "A" : kind === "text" ? "T" : "G";
    const track: Track = {
      id: newId(),
      name: name ?? `${prefix}${count}`,
      kind,
      muted: false,
      solo: false,
      locked: false,
      clips: [],
    };
    this.commit(`track.add "${track.name}"`, () => {
      seq.tracks.push(track);
    });
    return track;
  }

  updateTrack(
    trackId: ID,
    patch: Partial<Pick<Track, "name" | "muted" | "solo" | "locked" | "volumeDb" | "pan">>,
  ): Track {
    const seq = this.activeSequence();
    const track = seq.tracks.find((t) => t.id === trackId);
    if (!track) throw new Error(`track not found: ${trackId}`);
    this.commit(`track.update "${track.name}"`, () => {
      if (patch.name !== undefined) track.name = patch.name;
      if (patch.muted !== undefined) track.muted = patch.muted;
      if (patch.solo !== undefined) track.solo = patch.solo;
      if (patch.locked !== undefined) track.locked = patch.locked;
      if (patch.volumeDb !== undefined) track.volumeDb = Math.max(-60, Math.min(18, patch.volumeDb));
      if (patch.pan !== undefined) track.pan = Math.max(-1, Math.min(1, patch.pan));
    });
    return track;
  }

  removeTrack(trackId: ID): void {
    const seq = this.activeSequence();
    const index = seq.tracks.findIndex((t) => t.id === trackId);
    if (index < 0) throw new Error(`track not found: ${trackId}`);
    this.commit(`track.remove "${seq.tracks[index]!.name}"`, () => {
      seq.tracks.splice(index, 1);
    });
  }

  // ---- clips ----

  addClip(input: AddClipInput): Clip {
    const track = this.findTrack(input.trackId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const asset = this.findAsset(input.assetId);
    const sourceIn = input.in ?? 0;
    const sourceOut = input.out ?? (asset.duration != null ? asset.duration : sourceIn + 5);
    const duration = input.duration ?? Math.max(0.01, sourceOut - sourceIn);
    if (duration <= 0) throw new Error("clip duration must be > 0");
    const clip: Clip = {
      id: newId(),
      assetId: asset.id,
      name: input.name ?? asset.name,
      start: Math.max(0, input.start),
      duration,
      in: sourceIn,
      out: sourceIn + duration,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
      keyframes: [],
      effects: [],
    };
    this.commit(`clip.add "${clip.name}"`, () => {
      track.clips.push(clip);
    });
    return clip;
  }

  /** Razor tool: split a clip at an absolute timeline time. */
  splitClip(clipId: ID, at: number, trackId?: ID): [Clip, Clip] {
    const { track, clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const local = at - clip.start;
    if (local <= 0.01 || local >= clip.duration - 0.01) {
      throw new Error(`split time must be inside the clip (got ${at})`);
    }
    const left: Clip = structuredClone(clip);
    const right: Clip = structuredClone(clip);
    left.id = newId();
    right.id = newId();
    left.duration = local;
    left.out = clip.in + local;
    right.start = clip.start + local;
    right.duration = clip.duration - local;
    right.in = clip.in + local;
    right.out = clip.out;
    // keep keyframes proportional on both halves
    left.keyframes = clip.keyframes.filter((k) => k.time <= local).map((k) => ({ ...k }));
    right.keyframes = clip.keyframes
      .filter((k) => k.time > local)
      .map((k) => ({ ...k, time: k.time - local }));
    this.commit(`clip.split "${clip.name}" @${at}s`, () => {
      const index = track.clips.findIndex((c) => c.id === clip.id);
      track.clips.splice(index, 1, left, right);
    });
    return [left, right];
  }

  /** Trim a clip edge: edge="start" moves the in-point, edge="end" moves the out-point. */
  trimClip(clipId: ID, edge: "start" | "end", time: number, trackId?: ID): Clip {
    const { track, clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const before = structuredClone(clip);
    if (edge === "start") {
      const delta = time - clip.start;
      const newDuration = clip.duration - delta;
      if (newDuration <= 0.01) throw new Error("trim would make clip duration <= 0");
      if (clip.in + delta < 0) throw new Error("trim exceeds source in-point");
      clip.start = time;
      clip.duration = newDuration;
      clip.in += delta;
    } else {
      const newDuration = time - clip.start;
      if (newDuration <= 0.01) throw new Error("trim would make clip duration <= 0");
      clip.duration = newDuration;
      clip.out = clip.in + newDuration;
    }
    this.commit(`clip.trim "${clip.name}" ${edge}`, () => {
      void before;
    });
    return clip;
  }

  moveClip(clipId: ID, newStart: number, toTrackId?: ID, fromTrackId?: ID): Clip {
    const { track: fromTrack, clip, index } = fromTrackId
      ? this.findClip(fromTrackId, clipId)
      : this.findClipAnywhere(clipId);
    const toTrack = toTrackId ? this.findTrack(toTrackId) : fromTrack;
    if (fromTrack.locked || toTrack.locked) throw new Error("track is locked");
    if (toTrack.kind !== fromTrack.kind && toTrack.clips.length > 0 && fromTrack.kind !== toTrack.kind) {
      // allow cross-kind only to empty tracks (e.g. moving audio to an empty video track is a user error)
      throw new Error(`cannot move ${fromTrack.kind} clip to ${toTrack.kind} track`);
    }
    const target = Math.max(0, newStart);
    this.commit(`clip.move "${clip.name}" → ${target}s`, () => {
      fromTrack.clips.splice(index, 1);
      clip.start = target;
      toTrack.clips.push(clip);
    });
    return clip;
  }

  deleteClip(clipId: ID, trackId?: ID): void {
    const { track, clip, index } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    this.commit(`clip.delete "${clip.name}"`, () => {
      track.clips.splice(index, 1);
    });
  }

  /** Delete clip and close the gap on its track (ripple). */
  rippleDeleteClip(clipId: ID, trackId?: ID): void {
    const { track, clip, index } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const gap = clip.duration;
    this.commit(`clip.rippleDelete "${clip.name}"`, () => {
      track.clips.splice(index, 1);
      for (const c of track.clips) {
        if (c.start >= clip.start + gap - 0.0001) {
          c.start = Math.max(0, c.start - gap);
        }
      }
    });
  }

  updateClip(clipId: ID, patch: Partial<Pick<Clip, "assetId" | "name" | "start" | "duration" | "in" | "out" | "keyframes">> & {
    transform?: Partial<Clip["transform"]>;
  }, trackId?: ID): Clip {
    const { track, clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    this.commit(`clip.update "${clip.name}"`, () => {
      if (patch.assetId != null) clip.assetId = patch.assetId;
      if (patch.name != null) clip.name = patch.name;
      if (patch.start != null) clip.start = Math.max(0, patch.start);
      if (patch.duration != null) {
        if (patch.duration <= 0) throw new Error("duration must be > 0");
        clip.duration = patch.duration;
        clip.out = clip.in + patch.duration;
      }
      if (patch.in != null) clip.in = Math.max(0, patch.in);
      if (patch.out != null) clip.out = patch.out;
      if (patch.transform) Object.assign(clip.transform, patch.transform);
      if (Array.isArray(patch.keyframes)) {
        clip.keyframes = patch.keyframes.map((k) => ({ ...k })).sort((a, b) => a.time - b.time);
      }
    });
    return clip;
  }

  // ---- keyframes / effects ----

  addKeyframes(clipId: ID, keyframes: Keyframe[], trackId?: ID): Clip {
    const { track, clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    this.commit(`clip.keyframes "${clip.name}" (+${keyframes.length})`, () => {
      for (const kf of keyframes) {
        const existing = clip.keyframes.findIndex(
          (k) => k.property === kf.property && Math.abs(k.time - kf.time) < 0.0001,
        );
        if (existing >= 0) clip.keyframes[existing] = { ...kf };
        else clip.keyframes.push({ ...kf });
      }
      clip.keyframes.sort((a, b) => a.time - b.time);
    });
    return clip;
  }

  applyAnimationPreset(clipId: ID, presetId: string, trackId?: ID): Clip {
    const preset = ANIMATION_PRESETS[presetId];
    if (!preset) throw new Error(`unknown animation preset: ${presetId}`);
    const { clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    const keyframes = preset.build(clip);
    this.addKeyframes(clipId, keyframes, trackId);
    return clip;
  }

  addEffect(clipId: ID, type: string, params: Record<string, unknown> = {}, trackId?: ID): EffectInstance {
    const { track, clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const effect: EffectInstance = { id: newId(), type, params };
    this.commit(`effect.add "${type}" on "${clip.name}"`, () => {
      clip.effects.push(effect);
    });
    return effect;
  }

  removeEffect(clipId: ID, effectId: ID, trackId?: ID): void {
    const { track, clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const index = clip.effects.findIndex((e) => e.id === effectId);
    if (index < 0) throw new Error(`effect not found: ${effectId}`);
    this.commit(`effect.remove on "${clip.name}"`, () => {
      clip.effects.splice(index, 1);
    });
  }

  // ---- captions ----

  addCaption(input: { text: string; start: number; end: number; style?: Record<string, unknown> }): Caption {
    if (input.end <= input.start) throw new Error("caption end must be after start");
    const caption: Caption = {
      id: newId(),
      text: input.text,
      start: input.start,
      end: input.end,
      ...(input.style ? { style: input.style } : {}),
    };
    this.commit(`caption.add "${caption.text.slice(0, 24)}"`, () => {
      this.activeSequence().captions.push(caption);
      this.activeSequence().captions.sort((a, b) => a.start - b.start);
    });
    return caption;
  }

  addCaptionsFromSegments(segments: Array<{ text: string; start: number; end: number }>): Caption[] {
    this.commit(`captions.generate (${segments.length})`, () => {
      const seq = this.activeSequence();
      for (const s of segments) {
        seq.captions.push({ id: newId(), text: s.text, start: s.start, end: s.end });
      }
      seq.captions.sort((a, b) => a.start - b.start);
    });
    return this.activeSequence().captions;
  }

  updateCaption(captionId: ID, patch: Partial<Pick<Caption, "text" | "start" | "end" | "style">>): Caption {
    const seq = this.activeSequence();
    const caption = seq.captions.find((c) => c.id === captionId);
    if (!caption) throw new Error(`caption not found: ${captionId}`);
    this.commit(`caption.update "${caption.text.slice(0, 24)}"`, () => {
      Object.assign(caption, patch);
    });
    return caption;
  }

  removeCaption(captionId: ID): void {
    const seq = this.activeSequence();
    const index = seq.captions.findIndex((c) => c.id === captionId);
    if (index < 0) throw new Error(`caption not found: ${captionId}`);
    this.commit("caption.remove", () => {
      seq.captions.splice(index, 1);
    });
  }

  // ---- F1: plná editace (roll / slip / slide) ----

  /**
   * Roll edit: posune střih mezi tímto klipem a sousedem vpravo.
   * Kladné delta prodlužuje tento klip na úkor souseda.
   */
  rollClip(clipId: ID, delta: number, trackId?: ID): { left: Clip; right: Clip } {
    const { track, clip: left } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const end = clipEnd(left);
    const right = track.clips.find((c) => Math.abs(c.start - end) < 0.02);
    if (!right) throw new Error("roll requires an adjacent clip on the right (no gap)");
    const maxRight = right.duration - 0.01;
    const maxLeft = -(left.duration - 0.01);
    if (delta > maxRight) throw new Error(`roll delta exceeds right neighbor duration (max ${maxRight.toFixed(2)}s)`);
    if (delta < maxLeft) throw new Error(`roll delta exceeds clip duration (min ${maxLeft.toFixed(2)}s)`);
    this.commit(`clip.roll "${left.name}" ${delta > 0 ? "+" : ""}${delta.toFixed(2)}s`, () => {
      left.duration += delta;
      left.out = left.in + left.duration;
      right.start += delta;
      right.duration -= delta;
      right.in += delta;
    });
    return { left, right };
  }

  /** Slip edit: shifts clip media in/out points without moving timeline position. */
  slipClip(clipId: ID, delta: number, trackId?: ID): Clip {
    const { track, clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const newIn = clip.in + delta;
    const newOut = clip.out + delta;
    if (newIn < 0) throw new Error("slip would go before media start (in < 0)");
    const asset = this.project.assets.find((a) => a.id === clip.assetId);
    if (asset?.duration != null && newOut > asset.duration + 0.01) {
      throw new Error(`slip would exceed media end (out > ${asset.duration.toFixed(2)}s)`);
    }
    this.commit(`clip.slip "${clip.name}" ${delta > 0 ? "+" : ""}${delta.toFixed(2)}s`, () => {
      clip.in = newIn;
      clip.out = newOut;
    });
    return clip;
  }

  /**
   * Slide edit: posune klip po timeline a upraví sousedy, aby nevznikla mezera.
   * Předchozí klip se natáhne/zkrátí, následující klip se ořízne zepředu.
   */
  slideClip(clipId: ID, delta: number, trackId?: ID): Clip {
    const { track, clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const oldStart = clip.start;
    const oldEnd = clipEnd(clip);
    const newStart = Math.max(0, oldStart + delta);
    const realDelta = newStart - oldStart;
    const prev = track.clips.find((c) => Math.abs(clipEnd(c) - oldStart) < 0.02);
    const next = track.clips.find((c) => Math.abs(c.start - oldEnd) < 0.02);
    if (prev && newStart - prev.start < 0.01) throw new Error("slide: předchozí klip by zmizel");
    if (next && next.duration - realDelta < 0.01) {
      throw new Error("slide: následující klip by neměl dost délky");
    }
    if (next && next.in + realDelta < 0) {
      throw new Error("slide: následující klip by přetáhl začátek zdroje");
    }
    this.commit(`clip.slide "${clip.name}" ${realDelta > 0 ? "+" : ""}${realDelta.toFixed(2)}s`, () => {
      clip.start = newStart;
      if (prev) {
        prev.duration = newStart - prev.start;
        prev.out = prev.in + prev.duration;
      }
      if (next) {
        next.start = newStart + clip.duration;
        next.in += realDelta;
        next.duration -= realDelta;
        next.out = next.in + next.duration;
      }
    });
    return clip;
  }

  /** Aktualizace parametrů efektu (např. barevné korekce). */
  updateEffect(clipId: ID, effectId: ID, params: Record<string, unknown>, trackId?: ID): EffectInstance {
    const { track, clip } = trackId ? this.findClip(trackId, clipId) : this.findClipAnywhere(clipId);
    if (track.locked) throw new Error(`track is locked: ${track.name}`);
    const effect = clip.effects.find((e) => e.id === effectId);
    if (!effect) throw new Error(`effect not found: ${effectId}`);
    this.commit(`effect.update "${effect.type}" on "${clip.name}"`, () => {
      Object.assign(effect.params, params);
    });
    return effect;
  }

  /** Aktualizace metadat assetu (např. výsledek probe, proxyPath) — bez undo záznamu. */
  updateAsset(assetId: ID, patch: Partial<Omit<Asset, "id" | "createdAt">>): Asset {
    const asset = this.findAsset(assetId);
    Object.assign(asset, patch);
    this.project.updatedAt = now();
    this.emit({ type: "change", label: `asset.update "${asset.name}"` });
    return asset;
  }

  // ---- jobs (render / generation — gen stuby do F4, render je reálný od F1) ----

  createJob(type: JobType, input: Record<string, unknown>): Job {
    const job: Job = {
      id: newId(),
      type,
      status: "queued",
      progress: 0,
      input,
      createdAt: now(),
      updatedAt: now(),
    };
    this.project.jobs.push(job);
    this.emit({ type: "job", job: { ...job } });
    return job;
  }

  updateJob(jobId: ID, patch: { status?: JobStatus; progress?: number; output?: Record<string, unknown>; error?: string }): Job {
    const job = this.project.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    Object.assign(job, patch);
    job.updatedAt = now();
    this.emit({ type: "job", job: { ...job } });
    return job;
  }

  getJob(jobId: ID): Job {
    const job = this.project.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    return job;
  }
}
