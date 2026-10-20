// Vedit core data model (PLAN.md §6 Datový model)

export type ID = string;

export type AssetKind = "video" | "audio" | "image" | "generated";

export interface AssetSource {
  provider?: string;
  model?: string;
  prompt?: string;
  simulated?: boolean;
}

export interface Asset {
  id: ID;
  name: string;
  kind: AssetKind;
  path: string;
  /** seconds; undefined when unknown (e.g. no media probe yet) */
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  sizeBytes?: number;
  source?: AssetSource;
  createdAt: string;
}

export interface Keyframe {
  /** clip-local time in seconds (0 = clip start) */
  time: number;
  property: string;
  value: number | string;
  easing?: string;
}

export interface EffectInstance {
  id: ID;
  type: string;
  params: Record<string, unknown>;
}

export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
}

export interface Clip {
  id: ID;
  assetId: ID;
  name: string;
  /** position on timeline, seconds */
  start: number;
  /** visible duration on timeline, seconds */
  duration: number;
  /** offset into source media, seconds */
  in: number;
  /** end offset into source media, seconds */
  out: number;
  transform: Transform;
  keyframes: Keyframe[];
  effects: EffectInstance[];
}

export type TrackKind = "video" | "audio" | "text" | "graphics";

export interface Track {
  id: ID;
  name: string;
  kind: TrackKind;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  clips: Clip[];
}

export interface Caption {
  id: ID;
  text: string;
  start: number;
  end: number;
  style?: Record<string, unknown>;
}

export interface Sequence {
  id: ID;
  name: string;
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
  captions: Caption[];
}

export type JobType =
  | "render"
  | "gen.video"
  | "gen.image"
  | "gen.music"
  | "gen.sfx"
  | "gen.voice"
  | "captions"
  | "other";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: ID;
  type: JobType;
  status: JobStatus;
  progress: number;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  format: "vedit-project";
  formatVersion: 1;
  id: ID;
  name: string;
  createdAt: string;
  updatedAt: string;
  assets: Asset[];
  sequences: Sequence[];
  activeSequenceId: ID;
  jobs: Job[];
}

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration;
}

export function sequenceDuration(seq: Sequence): number {
  let max = 0;
  for (const track of seq.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clipEnd(clip));
    }
  }
  return max;
}
