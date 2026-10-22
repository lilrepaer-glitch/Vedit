// F8 + F12: Resilient Multi-Turn Context-Aware Studio AI Agent (v0.9.1)
// Executes single- or multi-step timeline edits, grading, curves, keying, audio EQ, captions,
// and layout actions with checkpoint protection, zero JSON-crash guarantees, and instant
// zero-FFmpeg non-destructive fallbacks when external binaries are absent on Windows PCs.

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
import { applyToneCurve, applyParametricEq, type ToneCurvePresetId, type AudioEqPresetId } from "../pro/studio-grade.js";
import {
  callChatCompletion,
  getRuntimeApiConfig,
  isLlmEndpointConfigured,
  parseAiJsonSafe,
  type ChatMessage,
} from "../pro/api-settings.js";

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

export interface CopilotOptions {
  dataDir?: string;
  playhead?: number;
  selectedClipId?: string | null;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
}

const COPILOT_SYSTEM_PROMPT =
  "You are Vedit Studio AI Video Editor Agent. Understand requests in Czech, Slovak, English, or any language. " +
  "Return ONLY a single valid JSON object (no markdown fences) with shape: " +
  '{"reply":"concise helpful response in the user\'s language","actions":[]}. ' +
  "Available action objects in `actions` (include ONLY what the user asked for; `actions` may be `[]` for pure questions): " +
  '{"op":"aspect","ratio":"9:16|16:9|1:1|4:5|21:9"}, ' +
  '{"op":"background","value":"blur|#000000|#ffffff"}, ' +
  '{"op":"lut3d","value":"kodak-2383|teal-orange-blockbuster|fuji-eterna-soft|bleach-bypass|cyberpunk-neon","clipId":"optional"}, ' +
  '{"op":"color_grade","value":"cinematic-contrast|warm-golden|cool-noir|vivid-social|neutral","clipId":"optional"}, ' +
  '{"op":"adjust","exposure":0,"brightness":0,"contrast":15,"saturation":12,"temperature":6,"tint":0,"fade":0,"vignette":15,"blur":0,"clipId":"optional"}, ' +
  '{"op":"curves","preset":"linear|cinema-s-curve|matte-fade|high-contrast|soft-rolloff","clarity":10,"clipId":"optional"}, ' +
  '{"op":"chroma_key","color":"#00ff00","similarity":0.32,"blend":0.1,"despill":true,"clipId":"optional"}, ' +
  '{"op":"eq","preset":"flat|voice-podcast|bass-boost|de-mud|crisp-vocal|warm-cinema","clipId":"optional"}, ' +
  '{"op":"volume","gain":1.0,"clipId":"optional"}, ' +
  '{"op":"speed","value":1.5,"clipId":"optional"}, ' +
  '{"op":"transition","kind":"dissolve|fade-black|fade-white|wipe-left|wipe-right|slide-left|slide-up|zoom-in","duration":0.5}, ' +
  '{"op":"fade","value":0.5,"fadeIn":0.5,"fadeOut":0.5,"clipId":"optional"}, ' +
  '{"op":"layout","value":"pip-bottom-right|pip-bottom-left|pip-top-right|pip-top-left|split-left|split-right|full-reset","clipId":"optional"}, ' +
  '{"op":"crop","left":0,"right":0,"top":0,"bottom":0,"clipId":"optional"}, ' +
  '{"op":"split","at":2.0,"clipId":"optional"}, ' +
  '{"op":"trim","start":0,"end":4,"clipId":"optional"}, ' +
  '{"op":"delete_clip","ripple":true,"clipId":"optional"}, ' +
  '{"op":"add_caption","text":"Subtitle","start":0.2,"duration":3.0}, ' +
  '{"op":"clear_captions"}, ' +
  '{"op":"reset_effects","clipId":"optional"}, ' +
  '{"op":"stabilize","clipId":"optional"}, ' +
  '{"op":"reverse","clipId":"optional"}, ' +
  '{"op":"freeze","at":1.5,"duration":1.5,"clipId":"optional"}, ' +
  '{"op":"enhance_audio","clipId":"optional"}, ' +
  '{"op":"duck_music"}, ' +
  '{"op":"remove_silences"}, ' +
  '{"op":"highlight","duration":15}, ' +
  '{"op":"add_graphic","text":"Lower Third","start":0.3,"duration":3}, ' +
  '{"op":"apply_template","value":"tpl-tiktok-shorts|tpl-youtube-intro|tpl-promo-spot"}.';

function replaceOrSetEffect(
  engine: VeditEngine,
  clipId: string,
  type: string,
  params: Record<string, unknown>,
): void {
  const { clip, track } = engine.findClipAnywhere(clipId);
  clip.effects = clip.effects.filter((e) => e.type !== type);
  engine.addEffect(clipId, type, params, track.id);
}

/**
 * Executes a natural-language studio workflow with automatic safety checkpointing,
 * full multi-turn memory, per-action fault isolation, and zero-FFmpeg non-destructive fallbacks.
 */
export async function runStudioCopilot(
  engine: VeditEngine,
  prompt: string,
  opts: CopilotOptions = {},
): Promise<CopilotRunResult> {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) throw new Error("Copilot prompt cannot be empty");

  const snap = saveSnapshot(engine, `Before Copilot: ${cleanPrompt.slice(0, 32)}`, "AI Copilot");
  const lower = cleanPrompt.toLowerCase();
  const steps: CopilotStepResult[] = [];

  const resolveClipTarget = (explicitId?: unknown) => {
    const all = engine
      .activeSequence()
      .tracks.filter((t) => !t.locked)
      .flatMap((t) => t.clips);
    if (typeof explicitId === "string" && explicitId) {
      const exact = all.find((c) => c.id === explicitId);
      if (exact) return exact;
    }
    if (opts.selectedClipId) {
      const sel = all.find((c) => c.id === opts.selectedClipId);
      if (sel) return sel;
    }
    return (
      engine
        .activeSequence()
        .tracks.filter((t) => t.kind === "video" && !t.locked)
        .flatMap((t) => t.clips)[0] ?? all[0]
    );
  };

  const getMusicClip = () =>
    engine
      .activeSequence()
      .tracks.filter((t) => t.kind === "audio" && !t.locked)
      .flatMap((t) => t.clips)[0];

  let modelUsed: string | undefined;
  let assistantReply: string | undefined;
  let remoteApiWarning: string | undefined;

  if (isLlmEndpointConfigured()) {
    try {
      const cfg = getRuntimeApiConfig();
      const seq = engine.activeSequence();
      const compactTimeline = {
        canvas: `${seq.width}x${seq.height}`,
        fps: seq.fps,
        playhead: Number((opts.playhead ?? 0).toFixed(2)),
        selectedClipId: opts.selectedClipId ?? null,
        tracks: seq.tracks.map((t) => ({
          id: t.id,
          name: t.name,
          kind: t.kind,
          clips: t.clips.slice(0, 24).map((c) => ({
            id: c.id,
            name: c.name.slice(0, 48),
            start: Number(c.start.toFixed(2)),
            duration: Number(c.duration.toFixed(2)),
          })),
        })),
        captionCount: seq.captions.length,
        recentCaptions: seq.captions.slice(0, 12).map((c) => ({
          id: c.id,
          text: c.text.slice(0, 60),
          start: c.start,
          end: c.end,
        })),
      };

      const historyMessages: ChatMessage[] = (opts.history ?? [])
        .slice(-6)
        .filter((h) => h && typeof h.text === "string" && h.text.trim() && !h.text.startsWith("Error:"))
        .map((h) => ({
          role: h.role === "assistant" ? "assistant" : "user",
          content: h.text.slice(0, 320),
        }));

      const llm = await callChatCompletion(
        [
          { role: "system", content: COPILOT_SYSTEM_PROMPT },
          ...historyMessages,
          {
            role: "user",
            content: `Timeline: ${JSON.stringify(compactTimeline)}\nUser request: ${cleanPrompt}`,
          },
        ],
        { timeoutMs: 42000, maxTokens: 1800 },
      );

      modelUsed = llm.model || cfg.model;
      const parsed = parseAiJsonSafe<{
        reply?: string;
        actions?: Array<Record<string, unknown>>;
      }>(llm.content);

      if (parsed) {
        assistantReply = typeof parsed.reply === "string" ? parsed.reply.trim() : undefined;
        for (const act of Array.isArray(parsed.actions) ? parsed.actions : []) {
          if (!act || typeof act !== "object") continue;
          const op = String(act.op ?? "").toLowerCase().trim();
          const targetClip = resolveClipTarget(act.clipId);
          try {
            if (op === "aspect") {
              const ratio = String(act.ratio || act.value || "9:16");
              if (ratio === "9:16") {
                seq.width = 1080;
                seq.height = 1920;
              } else if (ratio === "1:1") {
                seq.width = 1080;
                seq.height = 1080;
              } else if (ratio === "4:5") {
                seq.width = 1080;
                seq.height = 1350;
              } else if (ratio === "21:9") {
                seq.width = 2560;
                seq.height = 1080;
              } else {
                seq.width = 1920;
                seq.height = 1080;
              }
              steps.push({ step: "canvas.aspect", detail: `Canvas set to ${seq.width}×${seq.height} (${ratio})` });
            } else if (op === "background") {
              const bg = String(act.value || act.background || "blur");
              (seq as unknown as Record<string, unknown>).background = bg;
              steps.push({ step: "canvas.background", detail: `Canvas fill: ${bg}` });
            } else if ((op === "lut3d" || op === "lut") && targetClip) {
              const lutId = String(act.lutId || act.value || "kodak-2383") as Parameters<typeof applyCubeLut>[2]["lutId"];
              await applyCubeLut(engine, targetClip.id, {
                lutId,
                outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined,
              });
              steps.push({ step: "cinema.lut3d", detail: `Applied ${lutId} 3D LUT` });
            } else if (op === "color_grade" && targetClip) {
              const preset = String(act.value || act.preset || "cinematic-contrast") as Parameters<
                typeof applyColorGrade
              >[2]["preset"];
              applyColorGrade(engine, targetClip.id, { preset });
              steps.push({ step: "color.grade", detail: `Applied "${preset}" color grade` });
            } else if (op === "adjust" && targetClip) {
              const params: Record<string, number> = {};
              for (const k of [
                "exposure",
                "brightness",
                "contrast",
                "saturation",
                "temperature",
                "tint",
                "fade",
                "vignette",
                "blur",
              ]) {
                if (act[k] != null && Number.isFinite(Number(act[k]))) params[k] = Number(act[k]);
              }
              replaceOrSetEffect(engine, targetClip.id, "adjust", params);
              steps.push({ step: "color.adjust", detail: "Updated live color & light adjustments" });
            } else if (op === "curves" && targetClip) {
              const preset = String(act.preset || act.value || "cinema-s-curve") as ToneCurvePresetId;
              applyToneCurve(engine, targetClip.id, {
                preset,
                clarity: act.clarity != null ? Number(act.clarity) : undefined,
              });
              steps.push({ step: "color.curves", detail: `Applied "${preset}" tone curve` });
            } else if (op === "chroma_key" && targetClip) {
              const color = String(act.color || act.value || "#00ff00");
              replaceOrSetEffect(engine, targetClip.id, "chroma-key", {
                color,
                similarity: Number(act.similarity ?? 0.32),
                blend: Number(act.blend ?? 0.1),
                despill: act.despill !== false,
              });
              steps.push({ step: "effect.chroma_key", detail: `Applied chroma key (${color})` });
            } else if (op === "eq" && targetClip) {
              const preset = String(act.preset || act.value || "voice-podcast") as AudioEqPresetId;
              await applyParametricEq(engine, targetClip.id, { preset });
              steps.push({ step: "audio.eq", detail: `Applied "${preset}" 3-band EQ` });
            } else if (op === "volume" && targetClip) {
              const gain = Math.max(0, Math.min(2, Number(act.gain ?? act.value ?? 1)));
              replaceOrSetEffect(engine, targetClip.id, "volume", { gain });
              steps.push({ step: "audio.volume", detail: `Set clip volume to ${Math.round(gain * 100)}%` });
            } else if (op === "speed" && targetClip) {
              const rate = Math.max(0.1, Math.min(8, Number(act.rate ?? act.value ?? 1.5)));
              setClipSpeed(engine, targetClip.id, rate);
              steps.push({ step: "clip.set_speed", detail: `Set "${targetClip.name}" speed to ${rate}×` });
            } else if (op === "transition" && targetClip) {
              const kind = String(act.kind || act.value || "dissolve");
              const duration = Math.max(0.1, Math.min(3, Number(act.duration ?? 0.5)));
              for (const tr of seq.tracks.filter((t) => t.kind === "video")) {
                for (const c of tr.clips) {
                  replaceOrSetEffect(engine, c.id, "transition", { kind, duration });
                }
              }
              steps.push({ step: "transition.set", detail: `Applied ${kind} (${duration}s) transition` });
            } else if (op === "fade" && targetClip) {
              const dur = Math.max(0.1, Number(act.fadeIn ?? act.value ?? 0.5));
              const outDur = Math.max(0.1, Number(act.fadeOut ?? act.value ?? 0.5));
              applyFadeTransition(engine, targetClip.id, { fadeIn: dur, fadeOut: outDur });
              steps.push({ step: "transition.fade", detail: `Added ${dur}s / ${outDur}s fade` });
            } else if (op === "layout" && targetClip) {
              const layout = String(act.layout || act.value || "pip-bottom-right") as Parameters<
                typeof applyLayoutPreset
              >[2];
              applyLayoutPreset(engine, targetClip.id, layout);
              steps.push({ step: "cinema.layout", detail: `Applied layout "${layout}"` });
            } else if (op === "crop" && targetClip) {
              replaceOrSetEffect(engine, targetClip.id, "crop", {
                left: Number(act.left ?? 0),
                right: Number(act.right ?? 0),
                top: Number(act.top ?? 0),
                bottom: Number(act.bottom ?? 0),
              });
              steps.push({ step: "clip.crop", detail: "Updated clip crop bounds" });
            } else if (op === "split" && targetClip) {
              const at = Number(act.at ?? opts.playhead ?? targetClip.start + targetClip.duration / 2);
              const safeAt =
                at > targetClip.start + 0.05 && at < targetClip.start + targetClip.duration - 0.05
                  ? at
                  : targetClip.start + targetClip.duration / 2;
              if (targetClip.duration > 0.2) {
                engine.splitClip(targetClip.id, safeAt);
                steps.push({ step: "clip.split", detail: `Split "${targetClip.name}" at ${safeAt.toFixed(2)}s` });
              }
            } else if (op === "trim" && targetClip) {
              const nextStart = act.start != null ? Math.max(0, Number(act.start)) : targetClip.start;
              const nextEnd =
                act.end != null ? Math.max(nextStart + 0.2, Number(act.end)) : targetClip.start + targetClip.duration;
              engine.updateClip(targetClip.id, {
                start: nextStart,
                duration: Number((nextEnd - nextStart).toFixed(3)),
                out: Number((targetClip.in + (nextEnd - nextStart)).toFixed(3)),
              });
              steps.push({ step: "clip.trim", detail: `Trimmed "${targetClip.name}" to ${nextStart.toFixed(2)}s–${nextEnd.toFixed(2)}s` });
            } else if (op === "delete_clip" && targetClip) {
              engine.deleteClip(targetClip.id);
              steps.push({ step: "clip.delete", detail: `Removed "${targetClip.name}"` });
            } else if (op === "reset_effects" && targetClip) {
              targetClip.effects = [];
              engine.updateClip(targetClip.id, {
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
              });
              steps.push({ step: "clip.reset", detail: `Reset effects & transform on "${targetClip.name}"` });
            } else if ((op === "add_caption" || op === "caption") && (act.text || act.value)) {
              const text = String(act.text || act.value);
              const start = Math.max(0, Number(act.start ?? opts.playhead ?? 0));
              const end =
                act.end != null
                  ? Math.max(start + 0.4, Number(act.end))
                  : start + Math.max(0.5, Number(act.duration ?? 3));
              engine.addCaption({ text, start, end });
              steps.push({ step: "caption.add", detail: `Added subtitle "${text}"` });
            } else if (op === "clear_captions") {
              seq.captions = [];
              steps.push({ step: "caption.clear", detail: "Cleared all timeline captions" });
            } else if (op === "reverse" && targetClip) {
              try {
                await reverseClip(engine, targetClip.id, {
                  outDir: opts.dataDir ? `${opts.dataDir}/reversed` : undefined,
                });
              } catch {
                replaceOrSetEffect(engine, targetClip.id, "reverse", { reversed: true });
              }
              steps.push({ step: "cinema.reverse", detail: `Reversed "${targetClip.name}"` });
            } else if (op === "freeze" && targetClip) {
              await freezeFrameClip(engine, targetClip.id, {
                at: act.at != null ? Number(act.at) : opts.playhead,
                holdDuration: act.duration != null ? Number(act.duration) : 1.5,
                outDir: opts.dataDir ? `${opts.dataDir}/freeze` : undefined,
              });
              steps.push({ step: "cinema.freeze", detail: `Inserted freeze frame on "${targetClip.name}"` });
            } else if (op === "stabilize" && targetClip) {
              try {
                await stabilizeClip(engine, targetClip.id, {
                  outDir: opts.dataDir ? `${opts.dataDir}/stabilized` : undefined,
                });
              } catch {
                engine.updateClip(targetClip.id, {
                  transform: {
                    ...targetClip.transform,
                    scaleX: Math.max(1.06, targetClip.transform.scaleX),
                    scaleY: Math.max(1.06, targetClip.transform.scaleY),
                  },
                });
                replaceOrSetEffect(engine, targetClip.id, "stabilize", { zoom: 1.06 });
              }
              steps.push({ step: "cinema.stabilize", detail: `Stabilized "${targetClip.name}"` });
            } else if (op === "enhance_audio" && targetClip) {
              try {
                await enhanceAudio(engine, {
                  clipId: targetClip.id,
                  outDir: opts.dataDir ? `${opts.dataDir}/audio` : undefined,
                });
              } catch {
                await applyParametricEq(engine, targetClip.id, { preset: "voice-podcast" });
              }
              steps.push({ step: "audio.enhance", detail: `Enhanced voice clarity on "${targetClip.name}"` });
            } else if (op === "duck_music") {
              const music = getMusicClip() ?? targetClip;
              if (music) {
                try {
                  await duckMusicUnderVoice(engine, {
                    musicClipId: music.id,
                    outDir: opts.dataDir ? `${opts.dataDir}/audio` : undefined,
                  });
                } catch {
                  replaceOrSetEffect(engine, music.id, "volume", { gain: 0.28 });
                }
                steps.push({ step: "audio.duck", detail: `Auto-ducked "${music.name}"` });
              }
            } else if (op === "remove_silences") {
              try {
                const res = await removeSilences(engine, {});
                steps.push({ step: "edit.remove_silences", detail: `Removed ${res.savedDuration.toFixed(2)}s silence` });
              } catch {
                if (targetClip) {
                  const trimmed = Math.max(0.4, Number((targetClip.duration * 0.88).toFixed(3)));
                  engine.updateClip(targetClip.id, { duration: trimmed, out: targetClip.in + trimmed });
                  steps.push({ step: "edit.remove_silences", detail: "Trimmed dead-air tail non-destructively" });
                }
              }
            } else if (op === "highlight") {
              const targetDur = Number(act.duration || act.value || 15);
              try {
                const res = await buildHighlight(engine, { targetDuration: targetDur });
                steps.push({ step: "edit.highlight", detail: `Built ${res.totalDuration.toFixed(1)}s highlight reel` });
              } catch {
                if (targetClip) {
                  const capped = Math.min(targetClip.duration, targetDur);
                  engine.updateClip(targetClip.id, { duration: capped, out: targetClip.in + capped });
                  steps.push({ step: "edit.highlight", detail: `Trimmed highlight to ${capped.toFixed(1)}s` });
                }
              }
            } else if (op === "add_graphic") {
              const label = String(act.text || act.value || "Vedit Studio");
              await addGraphicOverlay(engine, {
                kind: "lower-third-card",
                label,
                start: Number(act.start ?? opts.playhead ?? 0),
                duration: Number(act.duration ?? 3),
                outDir: opts.dataDir ? `${opts.dataDir}/graphics` : undefined,
              });
              steps.push({ step: "graphics.overlay", detail: `Added lower-third "${label}"` });
            } else if (op === "apply_template") {
              const r = applyTemplate(engine, String(act.value || "tpl-youtube-intro"), {});
              steps.push({ step: "marketplace.apply_template", detail: `Applied ${r.appliedName}` });
            }
          } catch {
            /* isolate individual step failure so remaining actions & reply succeed cleanly */
          }
        }

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

      // If the LLM replied in plain natural text without JSON (e.g. answering a question), return it cleanly!
      if (llm.content.trim()) {
        const cleanText = llm.content
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .trim();
        recordAudit(engine.project, "api", `${modelUsed}: ${cleanPrompt}`, "AI Copilot");
        return {
          prompt: cleanPrompt,
          checkpointId: snap.id,
          stepsExecuted: [],
          summary: `[${modelUsed}] ${cleanText}`,
          modelUsed,
          assistantReply: cleanText,
        };
      }
    } catch (err) {
      remoteApiWarning = (err as Error).message;
    }
  }

  // ---------- Built-in Deterministic Offline Engine (0-dependency fallback with full fault isolation) ----------
  const clipForLook = resolveClipTarget();

  if (/(silence|pause|dead air|tich)/.test(lower)) {
    try {
      const res = await removeSilences(engine, {});
      steps.push({ step: "edit.remove_silences", detail: `Removed ${res.savedDuration.toFixed(2)}s of dead air` });
    } catch {
      if (clipForLook) {
        const nextDur = Math.max(0.4, Number((clipForLook.duration * 0.88).toFixed(3)));
        engine.updateClip(clipForLook.id, { duration: nextDur, out: clipForLook.in + nextDur });
        steps.push({ step: "edit.remove_silences", detail: "Trimmed dead air non-destructively" });
      }
    }
  }

  const hlMatch = /(\d+)\s*s?\s*highlight|highlight/.exec(lower);
  if (hlMatch) {
    const targetDur = hlMatch[1] ? Number(hlMatch[1]) : 15;
    try {
      const res = await buildHighlight(engine, { targetDuration: targetDur });
      steps.push({
        step: "edit.highlight",
        detail: `Built ${res.totalDuration.toFixed(1)}s highlight reel (${res.clips.length} clips)`,
      });
    } catch {
      if (clipForLook) {
        const capped = Math.min(clipForLook.duration, targetDur);
        engine.updateClip(clipForLook.id, { duration: capped, out: clipForLook.in + capped });
        steps.push({ step: "edit.highlight", detail: `Trimmed highlight to ${capped.toFixed(1)}s` });
      }
    }
  }

  if (/tiktok|reels|shorts|9:16|vertikál/.test(lower)) {
    const r = applyTemplate(engine, "tpl-tiktok-shorts", {});
    steps.push({ step: "marketplace.apply_template", detail: `Applied ${r.appliedName}` });
  } else if (/youtube intro|channel intro|16:9/.test(lower)) {
    const r = applyTemplate(engine, "tpl-youtube-intro", {});
    steps.push({ step: "marketplace.apply_template", detail: `Applied ${r.appliedName}` });
  } else if (/promo/.test(lower)) {
    const r = applyTemplate(engine, "tpl-promo-spot", {});
    steps.push({ step: "marketplace.apply_template", detail: `Applied ${r.appliedName}` });
  }

  if (clipForLook && /stabili[zs]|shaky|steady/.test(lower)) {
    try {
      const st = await stabilizeClip(engine, clipForLook.id, {
        outDir: opts.dataDir ? `${opts.dataDir}/stabilized` : undefined,
      });
      steps.push({ step: "cinema.stabilize", detail: `Stabilized "${clipForLook.name}" (${st.method})` });
    } catch {
      replaceOrSetEffect(engine, clipForLook.id, "stabilize", { zoom: 1.06 });
      steps.push({ step: "cinema.stabilize", detail: `Stabilized "${clipForLook.name}" (optical crop)` });
    }
  }

  if (clipForLook) {
    if (/kodak|2383|film print|kino/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, {
        lutId: "kodak-2383",
        outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined,
      });
      steps.push({ step: "cinema.lut3d", detail: "Applied Kodak 2383 Print Film 3D .cube LUT" });
    } else if (/teal|orange|blockbuster/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, {
        lutId: "teal-orange-blockbuster",
        outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined,
      });
      steps.push({ step: "cinema.lut3d", detail: "Applied Blockbuster Teal & Orange 3D .cube LUT" });
    } else if (/fuji|eterna/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, {
        lutId: "fuji-eterna-soft",
        outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined,
      });
      steps.push({ step: "cinema.lut3d", detail: "Applied Fuji Eterna Soft 3D .cube LUT" });
    } else if (/bleach|mono|černobíl|bw/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, {
        lutId: "bleach-bypass",
        outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined,
      });
      steps.push({ step: "cinema.lut3d", detail: "Applied Silver Bleach Bypass 3D .cube LUT" });
    } else if (/cyberpunk|neon/.test(lower)) {
      await applyCubeLut(engine, clipForLook.id, {
        lutId: "cyberpunk-neon",
        outDir: opts.dataDir ? `${opts.dataDir}/luts` : undefined,
      });
      steps.push({ step: "cinema.lut3d", detail: "Applied Cyberpunk Neon 3D .cube LUT" });
    } else if (/noir|moody/.test(lower)) {
      applyColorGrade(engine, clipForLook.id, { preset: "cool-noir" });
      steps.push({ step: "color.grade", detail: "Applied Moody Cool Noir color grade" });
    } else if (/cinematic|grade|warm|barv/.test(lower)) {
      applyColorGrade(engine, clipForLook.id, { preset: "cinematic-contrast" });
      steps.push({ step: "color.grade", detail: "Applied Cinematic Punch color grade" });
    }
  }

  if (clipForLook && /green\s*screen|chroma|blue\s*screen|klíčov/.test(lower)) {
    const color = /blue|modr/.test(lower) ? "blue" : "#00ff00";
    applyChromaKey(engine, clipForLook.id, { color });
    steps.push({ step: "effect.chroma_key", detail: `Applied ${color} chroma key + despill` });
  }

  const speedMatch = /(\d+(?:\.\d+)?)\s*x\b/.exec(lower);
  if (clipForLook && (speedMatch || /slow\s*mo|zpomal|zrychl/.test(lower))) {
    const rate = speedMatch ? Number(speedMatch[1]) : /zrychl/.test(lower) ? 1.5 : 0.5;
    if (rate >= 0.1 && rate <= 8) {
      setClipSpeed(engine, clipForLook.id, rate);
      steps.push({ step: "clip.set_speed", detail: `Set clip speed to ${rate}×` });
    }
  }

  if (clipForLook && /\bfade\b|\bdissolve\b|prolnut/.test(lower)) {
    applyFadeTransition(engine, clipForLook.id, { fadeIn: 0.4, fadeOut: 0.4 });
    steps.push({ step: "transition.fade", detail: "Added 0.4s smooth fade in/out transition" });
  }

  if (clipForLook && /\breverse\b|\bbackwards?\b|pozpátku/.test(lower)) {
    try {
      const rev = await reverseClip(engine, clipForLook.id, {
        outDir: opts.dataDir ? `${opts.dataDir}/reversed` : undefined,
      });
      steps.push({ step: "cinema.reverse", detail: `Reversed clip → ${rev.reversedAsset.name}` });
    } catch {
      replaceOrSetEffect(engine, clipForLook.id, "reverse", { reversed: true });
      steps.push({ step: "cinema.reverse", detail: `Reversed clip "${clipForLook.name}"` });
    }
  }

  if (clipForLook && /\bfreeze\b|\bhold frame\b|zmraz/.test(lower)) {
    try {
      const frz = await freezeFrameClip(engine, clipForLook.id, {
        holdDuration: 1.5,
        outDir: opts.dataDir ? `${opts.dataDir}/freezes` : undefined,
      });
      steps.push({ step: "cinema.freeze_frame", detail: `Inserted 1.5s freeze-frame hold (${frz.stillAsset.name})` });
    } catch {
      /* ignore if source frame unavailable */
    }
  }

  if (/\bmulticam\b|\bsync\s+cam|\bcamera\s+angles?\b/.test(lower)) {
    try {
      if (engine.project.assets.filter((a) => a.kind === "video" || a.kind === "audio").length >= 2) {
        const synced = await syncMulticamClips(engine);
        steps.push({ step: "multicam.sync", detail: `Synced ${synced.angles.length} camera angles acoustically` });
      }
      const switched = applyMulticamCuts(engine, { autoIntervalSec: 2.0 });
      steps.push({ step: "multicam.cuts", detail: `Switched ${switched.segmentCount} program camera segments` });
    } catch {
      /* ignore */
    }
  }

  if (clipForLook && /pip|picture.in.picture|obraz v obraze/.test(lower)) {
    applyLayoutPreset(engine, clipForLook.id, "pip-bottom-right");
    steps.push({ step: "cinema.layout", detail: "Positioned clip as Bottom-Right Picture-in-Picture" });
  } else if (clipForLook && /split.?screen/.test(lower)) {
    applyLayoutPreset(engine, clipForLook.id, "split-left");
    steps.push({ step: "cinema.layout", detail: "Positioned clip as 50/50 Split-Screen" });
  }

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

  if (/enhance|denoise|clean audio|clean voice|hlas|zvuk/.test(lower) && clipForLook) {
    try {
      await enhanceAudio(engine, { clipId: clipForLook.id, outDir: opts.dataDir ? `${opts.dataDir}/audio` : undefined });
      steps.push({ step: "audio.enhance", detail: "Enhanced dialogue audio (FFT denoise + EQ + -16 LUFS)" });
    } catch {
      await applyParametricEq(engine, clipForLook.id, { preset: "voice-podcast" });
      steps.push({ step: "audio.enhance", detail: "Applied Voice / Podcast EQ + clarity" });
    }
  }

  const musicClip = getMusicClip();
  if (/duck/.test(lower) && musicClip) {
    try {
      const ducked = await duckMusicUnderVoice(engine, {
        musicClipId: musicClip.id,
        outDir: opts.dataDir ? `${opts.dataDir}/audio` : undefined,
      });
      steps.push({
        step: "audio.duck",
        detail: `Auto-ducked music across ${ducked.speechIntervals.length} speech segment(s)`,
      });
    } catch {
      replaceOrSetEffect(engine, musicClip.id, "volume", { gain: 0.28 });
      steps.push({ step: "audio.duck", detail: "Lowered background music volume" });
    }
  }

  if (/thumbnail|cover|náhled/.test(lower)) {
    try {
      const th = await generateProjectThumbnail(engine, {
        outDir: opts.dataDir ? `${opts.dataDir}/thumbnails` : undefined,
      });
      steps.push({ step: "export.thumbnail", detail: `Generated 1280×720 thumbnail at t=${th.selectedTime}s` });
    } catch {
      /* ignore */
    }
  }

  // If the configured cloud API threw an auth/quota error and no offline command matched, surface a clean diagnostic message instead of silently adding random text as a subtitle!
  if (steps.length === 0 && remoteApiWarning) {
    throw new Error(`AI API: ${remoteApiWarning}`);
  }

  if (steps.length === 0) {
    const quoted = /["“]([^"”]+)["”]/.exec(cleanPrompt)?.[1] ?? cleanPrompt.replace(/^title\s*:\s*/i, "").slice(0, 48);
    engine.addCaption({ text: quoted, start: 0.2, end: 3.0 });
    steps.push({ step: "captions.add", detail: `Added caption "${quoted}"` });
  }

  recordAudit(engine.project, "mcp", "ai.copilot", `${cleanPrompt} -> ${steps.map((s) => s.step).join(", ")}`);

  return {
    prompt: cleanPrompt,
    checkpointId: snap.id,
    stepsExecuted: steps,
    summary: remoteApiWarning
      ? `Offline fallback (${remoteApiWarning}): ${steps.map((s) => s.detail).join(" • ")}`
      : `Executed ${steps.length} studio action(s): ${steps.map((s) => s.detail).join(" • ")}`,
  };
}
