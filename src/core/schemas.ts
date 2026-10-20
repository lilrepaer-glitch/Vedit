// Zod schemas for the .vedit project format (open JSON format, PLAN.md §6)

import { z } from "zod";
import type { Project } from "./types.js";

const id = z.string().min(1);

export const assetSourceSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  simulated: z.boolean().optional(),
});

export const assetSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(["video", "audio", "image", "generated"]),
  path: z.string(),
  duration: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  sizeBytes: z.number().nonnegative().optional(),
  source: assetSourceSchema.optional(),
  createdAt: z.string(),
});

export const keyframeSchema = z.object({
  time: z.number().nonnegative(),
  property: z.string(),
  value: z.union([z.number(), z.string()]),
  easing: z.string().optional(),
});

export const effectSchema = z.object({
  id,
  type: z.string(),
  params: z.record(z.unknown()),
});

export const transformSchema = z.object({
  x: z.number(),
  y: z.number(),
  scaleX: z.number(),
  scaleY: z.number(),
  rotation: z.number(),
  opacity: z.number(),
});

export const clipSchema = z.object({
  id,
  assetId: id,
  name: z.string(),
  start: z.number().nonnegative(),
  duration: z.number().positive(),
  in: z.number().nonnegative(),
  out: z.number(),
  transform: transformSchema,
  keyframes: z.array(keyframeSchema),
  effects: z.array(effectSchema),
});

export const trackSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(["video", "audio", "text", "graphics"]),
  muted: z.boolean(),
  solo: z.boolean(),
  locked: z.boolean(),
  clips: z.array(clipSchema),
});

export const captionSchema = z.object({
  id,
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number(),
  style: z.record(z.unknown()).optional(),
});

export const sequenceSchema = z.object({
  id,
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  tracks: z.array(trackSchema),
  captions: z.array(captionSchema),
});

export const jobSchema = z.object({
  id,
  type: z.enum([
    "render",
    "gen.video",
    "gen.image",
    "gen.music",
    "gen.sfx",
    "gen.voice",
    "captions",
    "other",
  ]),
  status: z.enum(["queued", "running", "done", "failed"]),
  progress: z.number().min(0).max(100),
  input: z.record(z.unknown()),
  output: z.record(z.unknown()).optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const projectSchema = z.object({
  format: z.literal("vedit-project"),
  formatVersion: z.literal(1),
  id,
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  assets: z.array(assetSchema),
  sequences: z.array(sequenceSchema).min(1),
  activeSequenceId: id,
  jobs: z.array(jobSchema),
});

export function parseProject(data: unknown): Project {
  return projectSchema.parse(data) as Project;
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}
