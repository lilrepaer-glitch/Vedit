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
import { callChatCompletion, getRuntimeApiConfig, isLlmEndpointConfigured } from "../pro/api-settings.js";

export interface CopilotStepResult {
  step: string;
  detail: string;
}

export interface CopilotRunResult {
  prompt: string;
  checkpointId: string;
  stepsExecuted: CopilotStepResult[];
  summary: string;
  modelUsed?: string;
  assistantReply?: string;
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

  // If the user configured a live Custom API Key / Local LLM endpoint in API Settings, let their chosen model plan & explain edits first!
  let modelUsed: string | undefined;
  let assistantReply: string | undefined;
  if (isLlmEndpointConfigured()) {
    try {
      const cfg = getRuntimeApiConfig();
      const seq = engine.activeSequence();
      const timelineSummary = seq.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        clips: t.clips.map((c) => ({ id: c.id, name: c.name, start: c.start, duration: c.duration })),
      }));
      const llm = await callChatCompletion(
        [
          {
            role: "system",
            content:
              'You are Vedit Studio AI Video Editor Copilot. Given the timeline JSON and user request (in any language including Czech or English), return ONLY valid JSON of the shape {"reply":"short helpful message","actions":[{"op":"lut3d|color_grade|speed|fade|chroma_key|reverse|freeze|layout|enhance_audio|duck_music|remove_silences|highlight|add_caption|add_graphic|apply_template","clipId":"optional","value":"optional string or number","text":"optional text","start":0,"duration":3}]}. Valid lut3d values: kodak-2383, teal-orange-blockbuster, fuji-eterna-soft, bleach-bypass, cyberpunk-neon. Valid color_grade values: cinematic-contrast, warm-golden, cool-noir, vivid-social, neutral. Valid layout values: pip-bottom-right, pip-top-right, split-left, split-right, full-reset.',
          },
          {
            role: "user",
            content: `Timeline: ${JSON.stringify(timelineSummary)}\nUser request: ${cleanPrompt}`,
          },
        ],
        { timeoutMs: 22000, maxTokens: 700 },
      );
      modelUsed = llm.model || cfg.model;
      const jsonMatch = /\{[\s\S]*\}/.exec(llm.content);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          reply?: string;
          actions?: Array<Record<string, unknown>>;
        };
        assistantReply = parsed.reply;
        for (const act of parsed.actions ?? []) {
          const op = String(act.op ?? "");
          const targetClip =
            (typeof act.clipId === "string"
              ? seq.tracks.flatMap((t) => t.clips).find((c) => c.id === act.clipId)
              : undefined) ?? getLeadVideoClip();
          if (op === "lut3d" && targetClip) {
            const lutId = (String(act.value || "kodak-2383") as Parameters<typeof applyCubeLut>[2]["lutId"]);
            await applyCubeLut(engine, targetClip.id, { lutId, outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined });
            steps.push({ step: "cinema.lut3d", detail: `Applied ${lutId} 3D LUT via ${modelUsed}` });
          } else if (op === "color_grade" && targetClip) {
            const preset = String(act.value || "cinematic-contrast") as Parameters<typeof applyColorGrade>[2]["preset"];
            applyColorGrade(engine, targetClip.id, { preset });
            steps.push({ step: "color.grade", detail: `Applied color grade "${preset}"` });
          } else if (op === "speed" && targetClip) {
            const rate = Math.max(0.1, Math.min(8, Number(act.value || 1.5)));
            setClipSpeed(engine, targetClip.id, rate);
            steps.push({ step: "clip.set_speed", detail: `Set "${targetClip.name}" speed to ${rate}×` });
          } else if (op === "fade" && targetClip) {
            const dur = Math.max(0.1, Number(act.value || 0.5));
            applyFadeTransition(engine, targetClip.id, { fadeIn: dur, fadeOut: dur });
            steps.push({ step: "transition.fade", detail: `Added ${dur}s fade in/out` });
          } else if (op === "chroma_key" && targetClip) {
            const color = String(act.value || "#00ff00");
            applyChromaKey(engine, targetClip.id, { color });
            steps.push({ step: "effect.chroma_key", detail: `Applied chroma key (${color})` });
          } else if (op === "reverse" && targetClip) {
            await reverseClip(engine, targetClip.id, { outDir: opts.dataDir ? `${opts.dataDir}/reversed` : undefined });
            steps.push({ step: "cinema.reverse", detail: `Reversed "${targetClip.name}"` });
          } else if (op === "freeze" && targetClip) {
            await freezeFrameClip(engine, targetClip.id, { outDir: opts.dataDir ? `${opts.dataDir}/freeze` : undefined });
            steps.push({ step: "cinema.freeze", detail: `Inserted freeze frame on "${targetClip.name}"` });
          } else if (op === "layout" && targetClip) {
            const layout = String(act.value || "pip-bottom-right") as Parameters<typeof applyLayoutPreset>[2];
            applyLayoutPreset(engine, targetClip.id, layout);
            steps.push({ step: "cinema.layout", detail: `Applied layout "${layout}"` });
          } else if (op === "enhance_audio" && targetClip) {
            await enhanceAudio(engine, {
              clipId: targetClip.id,
              outDir: opts.dataDir ? `${opts.dataDir}/audio` : undefined,
            });
            steps.push({ step: "audio.enhance", detail: `Enhanced voice DSP on "${targetClip.name}"` });
          } else if (op === "duck_music") {
            const music = getMusicClip() ?? targetClip;
            if (music) {
              await duckMusicUnderVoice(engine, {
                musicClipId: music.id,
                outDir: opts.dataDir ? `${opts.dataDir}/audio` : undefined,
              });
              steps.push({ step: "audio.duck", detail: `Auto-ducked music track "${music.name}"` });
            }
          } else if (op === "remove_silences") {
            const res = await removeSilences(engine, {});
            steps.push({ step: "edit.remove_silences", detail: `Removed ${res.savedDuration.toFixed(2)}s silence` });
          } else if (op === "highlight") {
            const res = await buildHighlight(engine, { targetDuration: Number(act.duration || act.value || 15) });
            steps.push({ step: "edit.highlight", detail: `Built ${res.totalDuration.toFixed(1)}s highlight reel` });
          } else if (op === "add_caption") {
            const text = String(act.text || act.value || "Title");
            const start = Math.max(0, Number(act.start || 0));
            const duration = Math.max(0.5, Number(act.duration || 3));
            engine.addCaption({ text, start, end: start + duration });
            steps.push({ step: "caption.add", detail: `Added caption "${text}" (${start}s–${start + duration}s)` });
          } else if (op === "add_graphic") {
            const label = String(act.text || act.value || "Vedit Studio");
            await addGraphicOverlay(engine, {
              kind: "lower-third-card",
              label,
              start: Number(act.start || 0),
              duration: 3,
              outDir: opts.dataDir ? `${opts.dataDir}/graphics` : undefined,
            });
            steps.push({ step: "graphics.overlay", detail: `Added lower-third "${label}"` });
          } else if (op === "apply_template") {
            const r = applyTemplate(engine, String(act.value || "tpl-youtube-intro"), {});
            steps.push({ step: "marketplace.apply_template", detail: `Applied ${r.appliedName}` });
          }
        }
        if (steps.length > 0 || assistantReply) {
          recordAudit(engine.project, "api", `${modelUsed}: ${cleanPrompt}`, "AI Copilot");
          return {
            prompt: cleanPrompt,
            checkpointId: snap.id,
            stepsExecuted: steps,
            summary: assistantReply
              ? `[${modelUsed}] ${assistantReply}`
              : `[${modelUsed}] Executed ${steps.length} step(s): ${steps.map((s) => s.detail).join(" • ")}`,
            modelUsed,
            assistantReply,
          };
        }
      }
    } catch {
      // Gracefully fall back to built-in offline studio parser below if remote API is unreachable
    }
  }

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
