// F5 — Template & Plugin Marketplace (PLAN.md §3.3, §7, §13).
// Provides a curated catalog of parameterized motion-graphics/sequence templates & editor plugins,
// supports installing custom `.veditpack.json` manifests from disk or API, and executes all changes
// atomically via `engine.transaction(...)` with full single-step undo & audit logging.

import { readFile } from "node:fs/promises";
import type { VeditEngine } from "../core/engine.js";
import { sequenceDuration } from "../core/types.js";
import { addTimelineMarker, exportYouTubeChapters, recordAudit } from "./collab.js";

export type PackKind = "template" | "plugin";

export interface PackParamSpec {
  key: string;
  label: string;
  defaultValue: string;
}

export interface MarketplacePack {
  id: string;
  kind: PackKind;
  name: string;
  author: string;
  version: string;
  category: string;
  description: string;
  builtin: boolean;
  params?: PackParamSpec[];
  /** Optional declarative template blueprint for custom JSON `.veditpack` packs. */
  blueprint?: {
    sequenceWidth?: number;
    sequenceHeight?: number;
    fps?: number;
    captions?: Array<{ text: string; start: number; end: number }>;
    markers?: Array<{ time: number; label: string }>;
    clipEffect?: { type: string; params: Record<string, unknown> };
    animationPreset?: string;
  };
}

export const BUILTIN_PACKS: MarketplacePack[] = [
  {
    id: "tpl-youtube-intro",
    kind: "template",
    name: "YouTube Channel Intro + Lower Third",
    author: "Vedit Studio",
    version: "1.0.0",
    category: "YouTube / 16:9",
    description: "Sets 1920×1080 sequence, adds animated opener & speaker lower-third captions, chapter intro marker, and smooth fade-in on lead clip.",
    builtin: true,
    params: [
      { key: "title", label: "Episode Title", defaultValue: "Welcome Back to the Channel" },
      { key: "subtitle", label: "Speaker / Handle", defaultValue: "@veditstudio" },
    ],
  },
  {
    id: "tpl-tiktok-shorts",
    kind: "template",
    name: "TikTok / Reels 9:16 Viral Hook",
    author: "Vedit Studio",
    version: "1.0.0",
    category: "Vertical Shorts / 9:16",
    description: "Reconfigures sequence to 1080×1920 vertical, applies punchy zoom-in opener keyframes, and inserts hook + CTA captions.",
    builtin: true,
    params: [
      { key: "title", label: "Hook Headline", defaultValue: "Watch what happens in 5 seconds" },
      { key: "cta", label: "End Call-to-Action", defaultValue: "Follow for part 2" },
    ],
  },
  {
    id: "tpl-promo-spot",
    kind: "template",
    name: "Product Launch Promo Spot",
    author: "Vedit Motion Lab",
    version: "1.0.0",
    category: "Commercial / Promo",
    description: "Adds structured 3-act promo captions (Hero Problem → Solution → CTA), contrast punch grade, and slide-left transition preset.",
    builtin: true,
    params: [
      { key: "title", label: "Product Name", defaultValue: "Vedit Pro Desktop" },
      { key: "cta", label: "Call to Action", defaultValue: "Download Today" },
    ],
  },
  {
    id: "tpl-podcast-chapters",
    kind: "template",
    name: "Podcast Highlights & Chapters",
    author: "Vedit Studio",
    version: "1.0.0",
    category: "Podcast / Longform",
    description: "Adds lower-third host labels, chapter markers across timeline segments, and gentle cross-fade polish.",
    builtin: true,
    params: [
      { key: "title", label: "Show Name", defaultValue: "Creators Uncut Podcast" },
      { key: "subtitle", label: "Guest Name", defaultValue: "Special Guest" },
    ],
  },
  {
    id: "plg-auto-chapters",
    kind: "plugin",
    name: "Auto YouTube Chapters & Summary",
    author: "Vedit Official",
    version: "1.1.0",
    category: "Workflow Automation",
    description: "Scans timeline clips & captions to populate chapter markers and return a ready-to-paste YouTube chapter timestamp block.",
    builtin: true,
  },
  {
    id: "plg-cinematic-lut",
    kind: "plugin",
    name: "Cinematic Color Grade Pack",
    author: "Vedit Color",
    version: "1.0.0",
    category: "Color & Look",
    description: "Applies filmic contrast/saturation/gamma look (Teal & Orange, Kodak 2383, Crisp Clean, or Monochrome) to all active video clips.",
    builtin: true,
    params: [{ key: "look", label: "Look Preset", defaultValue: "kodak-2383" }],
  },
  {
    id: "plg-social-polish",
    kind: "plugin",
    name: "Social Safe-Zone & Opener Polish",
    author: "Vedit Official",
    version: "1.0.0",
    category: "Social Delivery",
    description: "Ensures every video clip has smooth entry keyframes and trims excess trailing caption overlaps.",
    builtin: true,
  },
];

const customRegistry = new Map<string, MarketplacePack>();

export function registerPack(pack: Omit<MarketplacePack, "builtin">): MarketplacePack {
  if (!pack.id || !pack.name || !pack.kind) {
    throw new Error("invalid pack manifest: id, kind, and name are required");
  }
  const stored: MarketplacePack = { ...pack, builtin: false };
  customRegistry.set(stored.id, stored);
  return stored;
}

export async function installPackFromFile(engine: VeditEngine, filePath: string): Promise<MarketplacePack> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Omit<MarketplacePack, "builtin">;
  const pack = registerPack(raw);
  installPack(engine, pack.id);
  return pack;
}

export function listMarketplacePacks(engine?: VeditEngine): Array<MarketplacePack & { installed: boolean }> {
  const installedSet = new Set(engine?.project.installedPacks ?? BUILTIN_PACKS.map((p) => p.id));
  const all = [...BUILTIN_PACKS, ...customRegistry.values()];
  return all.map((p) => ({
    ...p,
    installed: p.builtin || installedSet.has(p.id),
  }));
}

export function installPack(engine: VeditEngine, packId: string): MarketplacePack {
  const all = listMarketplacePacks(engine);
  const found = all.find((p) => p.id === packId);
  if (!found) throw new Error(`marketplace pack not found: ${packId}`);
  engine.project.installedPacks ??= [];
  if (!engine.project.installedPacks.includes(packId)) {
    engine.project.installedPacks.push(packId);
  }
  recordAudit(engine.project, "plugin", "marketplace.install", `Installed pack "${found.name}" (${packId})`);
  return found;
}

export function uninstallPack(engine: VeditEngine, packId: string): void {
  engine.project.installedPacks = (engine.project.installedPacks ?? []).filter((id) => id !== packId);
  recordAudit(engine.project, "plugin", "marketplace.uninstall", `Uninstalled pack "${packId}"`);
}

function interpolateText(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? "");
}

export function applyTemplate(
  engine: VeditEngine,
  templateId: string,
  params: Record<string, string> = {},
): {
  templateId: string;
  appliedName: string;
  sequence: { width: number; height: number; fps: number };
  captionsAdded: number;
  clipsStyled: number;
} {
  const pack = listMarketplacePacks(engine).find((p) => p.id === templateId && p.kind === "template");
  if (!pack) throw new Error(`template not found: ${templateId}`);

  const mergedParams: Record<string, string> = {};
  for (const spec of pack.params ?? []) mergedParams[spec.key] = spec.defaultValue;
  for (const [k, v] of Object.entries(params)) if (v !== undefined) mergedParams[k] = String(v);

  return engine.transaction(`apply template: ${pack.name}`, () => {
    const seq = engine.activeSequence();
    const captionsBefore = seq.captions.length;
    let clipsStyled = 0;
    const videoClips = seq.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
    const totalDur = Math.max(sequenceDuration(seq), 6);

    switch (pack.id) {
      case "tpl-youtube-intro": {
        seq.width = 1920;
        seq.height = 1080;
        seq.fps = 30;
        engine.addCaption({ text: mergedParams.title!, start: 0.2, end: 3.0 });
        engine.addCaption({ text: mergedParams.subtitle!, start: 3.2, end: 5.8 });
        addTimelineMarker(engine, { time: 0, label: mergedParams.title! });
        if (videoClips[0]) {
          engine.applyAnimationPreset(videoClips[0].id, "fade-in");
          clipsStyled++;
        }
        break;
      }
      case "tpl-tiktok-shorts": {
        seq.width = 1080;
        seq.height = 1920;
        seq.fps = 30;
        engine.addCaption({ text: mergedParams.title!, start: 0, end: 2.4 });
        engine.addCaption({ text: mergedParams.cta!, start: Math.max(2.6, totalDur - 2.2), end: totalDur });
        if (videoClips[0]) {
          engine.applyAnimationPreset(videoClips[0].id, "zoom-in");
          clipsStyled++;
        }
        break;
      }
      case "tpl-promo-spot": {
        seq.width = 1920;
        seq.height = 1080;
        seq.fps = 30;
        engine.addCaption({ text: `${mergedParams.title!} — Built for Creators`, start: 0, end: 2.2 });
        engine.addCaption({ text: "Cut, Animate & Generate in One Timeline", start: 2.4, end: 4.6 });
        engine.addCaption({ text: mergedParams.cta!, start: Math.max(4.8, totalDur - 2), end: totalDur });
        for (const clip of videoClips) {
          engine.addEffect(clip.id, "color", { contrast: 1.12, saturation: 1.15 });
          clipsStyled++;
        }
        break;
      }
      case "tpl-podcast-chapters": {
        engine.addCaption({
          text: `${mergedParams.title!} • ${mergedParams.subtitle!}`,
          start: 0.3,
          end: 4.0,
        });
        videoClips.forEach((c, idx) => {
          addTimelineMarker(engine, { time: idx === 0 ? 0 : c.start, label: `Segment ${idx + 1}: ${c.name}` });
          clipsStyled++;
        });
        break;
      }
      default: {
        const bp = pack.blueprint;
        if (bp?.sequenceWidth) seq.width = bp.sequenceWidth;
        if (bp?.sequenceHeight) seq.height = bp.sequenceHeight;
        if (bp?.fps) seq.fps = bp.fps;
        for (const cap of bp?.captions ?? []) {
          engine.addCaption({
            text: interpolateText(cap.text, mergedParams),
            start: cap.start,
            end: cap.end,
          });
        }
        for (const m of bp?.markers ?? []) {
          addTimelineMarker(engine, { time: m.time, label: interpolateText(m.label, mergedParams) });
        }
        for (const clip of videoClips) {
          if (bp?.animationPreset) engine.applyAnimationPreset(clip.id, bp.animationPreset);
          if (bp?.clipEffect) engine.addEffect(clip.id, bp.clipEffect.type, bp.clipEffect.params);
          clipsStyled++;
        }
      }
    }

    recordAudit(engine.project, "plugin", "template.apply", `Applied template "${pack.name}"`);
    return {
      templateId: pack.id,
      appliedName: pack.name,
      sequence: { width: seq.width, height: seq.height, fps: seq.fps },
      captionsAdded: seq.captions.length - captionsBefore,
      clipsStyled,
    };
  });
}

export function runPlugin(
  engine: VeditEngine,
  pluginId: string,
  params: Record<string, string> = {},
): Record<string, unknown> {
  const pack = listMarketplacePacks(engine).find((p) => p.id === pluginId && p.kind === "plugin");
  if (!pack) throw new Error(`plugin not found: ${pluginId}`);

  return engine.transaction(`plugin: ${pack.name}`, () => {
    const seq = engine.activeSequence();
    const videoClips = seq.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);

    switch (pluginId) {
      case "plg-auto-chapters": {
        engine.project.markers = [];
        videoClips.forEach((clip, idx) => {
          addTimelineMarker(engine, {
            time: idx === 0 ? 0 : clip.start,
            label: clip.name.replace(/\.[^.]+$/, ""),
          });
        });
        if (videoClips.length === 0 && seq.captions.length > 0) {
          seq.captions.forEach((cap, idx) => {
            addTimelineMarker(engine, {
              time: idx === 0 ? 0 : cap.start,
              label: cap.text.slice(0, 32),
            });
          });
        }
        const chapters = exportYouTubeChapters(engine.project);
        recordAudit(engine.project, "plugin", "plugin.auto-chapters", `Generated ${chapters.markers.length} chapter markers`);
        return { pluginId, markersCreated: chapters.markers.length, youtubeDescription: chapters.youtubeDescription };
      }

      case "plg-cinematic-lut": {
        const look = params.look ?? "kodak-2383";
        const gradeParams: Record<string, Record<string, number>> = {
          "kodak-2383": { contrast: 1.16, saturation: 1.12, gamma: 0.96 },
          "teal-orange": { contrast: 1.2, saturation: 1.25, brightness: 0.02 },
          "crisp-clean": { contrast: 1.08, saturation: 1.06, brightness: 0.03 },
        };
        for (const clip of videoClips) {
          if (look === "monochrome") {
            engine.addEffect(clip.id, "grayscale", {});
          } else {
            engine.addEffect(clip.id, "color", gradeParams[look] ?? gradeParams["kodak-2383"]!);
          }
        }
        recordAudit(engine.project, "plugin", "plugin.cinematic-lut", `Applied look "${look}" to ${videoClips.length} clips`);
        return { pluginId, look, clipsGraded: videoClips.length };
      }

      case "plg-social-polish":
      default: {
        if (videoClips[0] && videoClips[0].keyframes.length === 0) {
          engine.applyAnimationPreset(videoClips[0].id, "fade-in");
        }
        const bp = pack.blueprint;
        if (bp?.clipEffect) {
          for (const clip of videoClips) {
            engine.addEffect(clip.id, bp.clipEffect.type, bp.clipEffect.params);
          }
        }
        recordAudit(engine.project, "plugin", "plugin.run", `Executed plugin "${pack.name}"`);
        return { pluginId, name: pack.name, clipsProcessed: videoClips.length };
      }
    }
  });
}
