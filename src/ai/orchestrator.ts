// F8: Built-in AI Orchestrator / Studio Copilot (PLAN.md §6 "AI orkestrátor (plánování úkolů)")
// Converts natural-language production prompts into safe, checkpoint-backed multi-step Vedit operations.

import type { VeditEngine } from "../core/engine.js";
import { removeSilences, buildHighlight } from "../ai/edit.js";
import { saveSnapshot, recordAudit } from "../ext/collab.js";
import { applyTemplate } from "../ext/marketplace.js";
import { applyChromaKey, applyColorGrade, applyFadeTransition, setClipSpeed } from "../pro/fx.js";
import { duckMusicUnderVoice, enhanceAudio } from "../pro/audio.js";
import { applyCubeLut, applyLayoutPreset, freezeFrameClip, reverseClip, stabilizeClip } from "../pro/cinema.js";
import { addGraphicOverlay } from "../pro/graphics.js";
import { generateProjectThumbnail } from "../pro/capture.js";
import { applyMulticamCuts, syncMulticamClips } from "../pro/multicam.js";
import { analyzeFrameScopes } from "../pro/scopes.js";

export interface CopilotStepResult {
  step: string;
  detail: string;
}

export interface CopilotRunResult {
  prompt: string;
  checkpointId: string;
  stepsExecuted: CopilotStepResult[];
  summary: string;
}

/**
 * Executes a natural-language studio workflow with automatic safety checkpointing.
 * Works 100% offline with built-in multi-intent parsing across all F0–F8 engines.
 */
export async function runStudioCopilot(
  engine: VeditEngine,
  prompt: string,
  opts: { dataDir?: string } = {},
): Promise<CopilotRunResult> {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) throw new Error("Copilot prompt cannot be empty");

  const snap = saveSnapshot(engine, `Before Copilot: ${cleanPrompt.slice(0, 32)}`, "AI Copilot");
  const lower = cleanPrompt.toLowerCase();
  const steps: CopilotStepResult[] = [];

  const getLeadVideoClip = () =>
    engine
      .activeSequence()
      .tracks.filter((t) => t.kind === "video" && !t.locked)
      .flatMap((t) => t.clips)[0];

  const getMusicClip = () =>
    engine
      .activeSequence()
      .tracks.filter((t) => t.kind === "audio" && !t.locked)
      .flatMap((t) => t.clips)[0];

  // 1. Silence removal
  if (/(silence|pause|dead air|tich)/.test(lower)) {
    const res = await removeSilences(engine, {});
    steps.push({ step: "edit.remove_silences", detail: `Removed ${res.savedDuration.toFixed(2)}s of dead air` });
  }

  // 2. Highlight reel
  const hlMatch = /(\d+)\s*s?\s*highlight|highlight/.exec(lower);
  if (hlMatch) {
    const targetDur = hlMatch[1] ? Number(hlMatch[1]) : 15;
    const res = await buildHighlight(engine, { targetDuration: targetDur });
    steps.push({ step: "edit.highlight", detail: `Built ${res.totalDuration.toFixed(1)}s highlight reel (${res.clips.length} clips)` });
  }

  // 3. Marketplace templates (TikTok / YouTube / Promo)
  if (/tiktok|reels|shorts|9:16/.test(lower)) {
    const r = applyTemplate(engine, "tpl-tiktok-shorts", {});
    steps.push({ step: "marketplace.apply_template", detail: `Applied ${r.appliedName}` });
  } else if (/youtube intro|channel intro/.test(lower)) {
    const r = applyTemplate(engine, "tpl-youtube-intro", {});
    steps.push({ step: "marketplace.apply_template", detail: `Applied ${r.appliedName}` });
  } else if (/promo/.test(lower)) {
    const r = applyTemplate(engine, "tpl-promo-spot", {});
    steps.push({ step: "marketplace.apply_template", detail: `Applied ${r.appliedName}` });
  }

  // 4. Stabilization
  const lead = getLeadVideoClip();
  if (lead && /stabili[zs]|shaky|steady/.test(lower)) {
    const st = await stabilizeClip(engine, lead.id, { outDir: opts.dataDir ? `${opts.dataDir}/stabilized` : undefined });
    steps.push({ step: "cinema.stabilize", detail: `Stabilized "${lead.name}" (${st.method})` });
  }

  // 5. 3D Cinema LUTs & Color Looks
  const clipForLook = getLeadVideoClip();
  if (clipForLook) {
    if (/kodak|2383|film print/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, { lutId: "kodak-2383", outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined });
      steps.push({ step: "cinema.lut3d", detail: "Applied Kodak 2383 Print Film 3D .cube LUT" });
    } else if (/teal|orange|blockbuster/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, {
        lutId: "teal-orange-blockbuster",
        outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined,
      });
      steps.push({ step: "cinema.lut3d", detail: "Applied Blockbuster Teal & Orange 3D .cube LUT" });
    } else if (/fuji|eterna/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, { lutId: "fuji-eterna-soft", outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined });
      steps.push({ step: "cinema.lut3d", detail: "Applied Fuji Eterna Soft 3D .cube LUT" });
    } else if (/bleach/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, { lutId: "bleach-bypass", outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined });
      steps.push({ step: "cinema.lut3d", detail: "Applied Silver Bleach Bypass 3D .cube LUT" });
    } else if (/cyberpunk|neon/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, { lutId: "cyberpunk-neon", outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined });
      steps.push({ step: "cinema.lut3d", detail: "Applied Cyberpunk Neon 3D .cube LUT" });
    } else if (/noir|moody/.test(lower)) {
      applyColorGrade(engine, clipForLook.id, { preset: "cool-noir" });
      steps.push({ step: "color.grade", detail: "Applied Moody Cool Noir color grade" });
    } else if (/cinematic|grade|warm/.test(lower)) {
      applyColorGrade(engine, clipForLook.id, { preset: "cinematic-contrast" });
      steps.push({ step: "color.grade", detail: "Applied Cinematic Punch color grade" });
    }
  }

  // 6. Chroma key
  if (clipForLook && /green\s*screen|chroma|blue\s*screen/.test(lower)) {
    const color = /blue/.test(lower) ? "blue" : "#00ff00";
    applyChromaKey(engine, clipForLook.id, { color });
    steps.push({ step: "effect.chroma_key", detail: `Applied ${color} chroma key + despill` });
  }

  // 7. Speed changes (e.g. "2x", "1.5x", "0.5x", "slow motion")
  const speedMatch = /(\d+(?:\.\d+)?)\s*x\b/.exec(lower);
  if (clipForLook && (speedMatch || /slow\s*mo/.test(lower))) {
    const rate = speedMatch ? Number(speedMatch[1]) : 0.5;
    if (rate >= 0.1 && rate <= 8) {
      setClipSpeed(engine, clipForLook.id, rate);
      steps.push({ step: "clip.set_speed", detail: `Set clip speed to ${rate}×` });
    }
  }

  // 7b. Smooth fade in / fade out transition
  if (clipForLook && /\bfade\b|\bdissolve\b/.test(lower)) {
    applyFadeTransition(engine, clipForLook.id, { fadeIn: 0.4, fadeOut: 0.4 });
    steps.push({ step: "transition.fade", detail: "Added 0.4s smooth fade in/out transition" });
  }

  // 7c. Reverse playback & Freeze-frame hold (F9)
  if (clipForLook && /\breverse\b|\bbackwards?\b/.test(lower)) {
    const rev = await reverseClip(engine, clipForLook.id, {
      outDir: opts.dataDir ? `${opts.dataDir}/reversed` : undefined,
    });
    steps.push({ step: "cinema.reverse", detail: `Reversed clip → ${rev.reversedAsset.name}` });
  }
  if (clipForLook && /\bfreeze\b|\bhold frame\b/.test(lower)) {
    const frz = await freezeFrameClip(engine, clipForLook.id, {
      holdDuration: 1.5,
      outDir: opts.dataDir ? `${opts.dataDir}/freezes` : undefined,
    });
    steps.push({ step: "cinema.freeze_frame", detail: `Inserted 1.5s freeze-frame hold (${frz.stillAsset.name})` });
  }

  // 7d. Multicam sync & angle switching (F9)
  if (/\bmulticam\b|\bsync\s+cam|\bcamera\s+angles?\b/.test(lower)) {
    if (engine.project.assets.filter((a) => a.kind === "video" || a.kind === "audio").length >= 2) {
      const synced = await syncMulticamClips(engine);
      steps.push({ step: "multicam.sync", detail: `Synced ${synced.angles.length} camera angles acoustically` });
    }
    const switched = applyMulticamCuts(engine, { autoIntervalSec: 2.0 });
    steps.push({ step: "multicam.cuts", detail: `Switched ${switched.segmentCount} program camera segments` });
  }

  // 8. Picture-in-Picture / Split layout
  if (clipForLook && /pip|picture.in.picture/.test(lower)) {
    applyLayoutPreset(engine, clipForLook.id, "pip-bottom-right");
    steps.push({ step: "cinema.layout", detail: "Positioned clip as Bottom-Right Picture-in-Picture" });
  } else if (clipForLook && /split.?screen/.test(lower)) {
    applyLayoutPreset(engine, clipForLook.id, "split-left");
    steps.push({ step: "cinema.layout", detail: "Positioned clip as 50/50 Split-Screen" });
  }

  // 9. Lower third / Callout overlay
  if (/lower.?third|callout|arrow|badge/.test(lower)) {
    const quoted = /["“]([^"”]+)["”]/.exec(cleanPrompt)?.[1];
    const kind = /arrow/.test(lower) ? "callout-arrow" : /badge/.test(lower) ? "pill-badge" : "lower-third-card";
    await addGraphicOverlay(engine, {
      kind,
      label: quoted,
      start: 0.3,
      duration: 3,
      animationPreset: "fade-in",
      outDir: opts.dataDir ? `${opts.dataDir}/graphics` : undefined,
    });
    steps.push({ step: "graphics.add_overlay", detail: `Added ${kind}${quoted ? ` ("${quoted}")` : ""}` });
  }

  // 10. Voice enhance & Auto-ducking
  if (/enhance|denoise|clean audio|clean voice/.test(lower) && clipForLook) {
    await enhanceAudio(engine, { clipId: clipForLook.id, outDir: opts.dataDir ? `${opts.dataDir}/audio` : undefined });
    steps.push({ step: "audio.enhance", detail: "Enhanced dialogue audio (FFT denoise + EQ + -16 LUFS)" });
  }
  const musicClip = getMusicClip();
  if (/duck/.test(lower) && musicClip) {
    const ducked = await duckMusicUnderVoice(engine, {
      musicClipId: musicClip.id,
      outDir: opts.dataDir ? `${opts.dataDir}/audio` : undefined,
    });
    steps.push({ step: "audio.duck", detail: `Auto-ducked music across ${ducked.speechIntervals.length} speech segment(s)` });
  }

  // 11. Thumbnail generation
  if (/thumbnail|cover/.test(lower)) {
    const th = await generateProjectThumbnail(engine, { outDir: opts.dataDir ? `${opts.dataDir}/thumbnails` : undefined });
    steps.push({ step: "export.thumbnail", detail: `Generated 1280×720 thumbnail at t=${th.selectedTime}s` });
  }

  // Fallback caption if user simply asked to add text / title or generic polish
  if (steps.length === 0) {
    const quoted = /["“]([^"”]+)["”]/.exec(cleanPrompt)?.[1] ?? cleanPrompt.slice(0, 48);
    engine.addCaption({ text: quoted, start: 0.2, end: 3.0 });
    steps.push({ step: "captions.add", detail: `Added caption "${quoted}"` });
  }

  recordAudit(engine.project, "mcp", "ai.copilot", `${cleanPrompt} -> ${steps.map((s) => s.step).join(", ")}`);

  return {
    prompt: cleanPrompt,
    checkpointId: snap.id,
    stepsExecuted: steps,
    summary: `Executed ${steps.length} studio action(s): ${steps.map((s) => s.detail).join(" • ")}`,
  };
}
