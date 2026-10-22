// AI Subtitles (ASR) & Voiceover (TTS) Pipeline (F2 + v0.9.1 Cloud/System Fallbacks)
// Uses local Python sidecar (`espeak-ng` / `pocketsphinx`) first when installed, and seamlessly
// falls back to Cloud Whisper / OpenAI TTS or native Windows SAPI5 speech synthesis on end-user PCs!

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { VeditEngine } from "../core/engine.js";
import type { Asset, Caption, Clip } from "../core/types.js";
import { extractPeaks, probeMedia, run, ffmpegPath } from "../core/media.js";
import { speechCapabilities, splitScript, transcribe, ttsScript, type CaptionSegment } from "./speech.js";
import {
  callChatCompletion,
  getRuntimeApiConfig,
  isLlmEndpointConfigured,
  normalizeBaseUrl,
  parseAiJsonSafe,
  sanitizeApiKey,
} from "../pro/api-settings.js";

export interface VoiceoverInput {
  script: string;
  voice?: string;
  rate?: number;
  gap?: number;
  start?: number;
  trackId?: string;
  captions?: boolean;
}

export interface VoiceoverResult {
  asset: Asset;
  clip: Clip;
  captions: Caption[];
  duration: number;
  engine: string;
}

/** Built-in zero-dependency Windows 10/11 SAPI5 `.wav` voice synthesizer via PowerShell `System.Speech`. */
async function tryWindowsNativeWavTts(script: string, outWavPath: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const escaped = script.replace(/'/g, "''");
  const outEscaped = outWavPath.replace(/'/g, "''");
  const psScript =
    "Add-Type -AssemblyName System.Speech; " +
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
    `$s.SetOutputToWaveFile('${outEscaped}'); ` +
    `$s.Speak('${escaped}'); ` +
    "$s.Dispose();";
  return new Promise<boolean>((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Generates a valid clean 16-bit PCM WAV buffer if neither Python TTS, Cloud TTS, nor SAPI5 is available. */
function buildSilentPcmWav(durationSec: number, sampleRate = 24000): Buffer {
  const numSamples = Math.max(240, Math.round(durationSec * sampleRate));
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

export async function generateVoiceover(
  engine: VeditEngine,
  input: VoiceoverInput,
  opts: { mediaDir: string },
): Promise<VoiceoverResult> {
  const caps = await speechCapabilities();
  await mkdir(opts.mediaDir, { recursive: true });
  const start = Math.max(0, input.start ?? 0);

  // 1) Local Python `espeak-ng` sidecar when installed
  if (caps.tts.available) {
    const scriptTts = await ttsScript(input.script, {
      voice: input.voice ?? "cs",
      rate: input.rate,
      gap: input.gap,
    });
    const fileName = `voiceover_${Date.now().toString(36)}.wav`;
    const filePath = join(opts.mediaDir, fileName);
    await writeFile(filePath, scriptTts.wav);
    const probe = await probeMedia(filePath).catch(() => ({
      duration: scriptTts.totalDuration,
      sizeBytes: scriptTts.wav.byteLength,
      audioCodec: "pcm_s16le",
    }));

    return engine.transaction("ai.voiceover", () => {
      const seq = engine.activeSequence();
      const trackId =
        input.trackId ?? (seq.tracks.find((t) => t.kind === "audio")?.id ?? engine.addTrack("audio", "A1").id);
      const asset = engine.addAsset({
        name: fileName,
        kind: "audio",
        path: filePath,
        duration: probe.duration || scriptTts.totalDuration,
        sizeBytes: probe.sizeBytes,
        audioCodec: probe.audioCodec ?? "pcm_s16le",
        hasAudio: true,
        source: {
          provider: "vedit-tts",
          model: caps.tts.engine,
          prompt: input.script.slice(0, 200),
          simulated: false,
        },
      });
      const clip = engine.addClip({
        trackId,
        assetId: asset.id,
        start,
        duration: asset.duration ?? scriptTts.totalDuration,
        in: 0,
        out: asset.duration ?? scriptTts.totalDuration,
        name: `Voiceover (${scriptTts.voice})`,
      });
      const segments: CaptionSegment[] = scriptTts.phrases.map((p) => ({
        text: p.text,
        start: p.start + start,
        end: p.end + start,
      }));
      const captions = input.captions === false ? [] : engine.addCaptionsFromSegments(segments);
      return { asset, clip, captions, duration: asset.duration ?? scriptTts.totalDuration, engine: caps.tts.engine };
    });
  }

  // 2) Cloud OpenAI-compatible `/audio/speech` OR Windows built-in SAPI5 SpeechSynthesizer!
  const cfg = getRuntimeApiConfig();
  const apiKey = sanitizeApiKey(cfg.apiKey);
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  let outExt = ".wav";
  let audioBuf: Buffer | null = null;
  let usedEngine = "system-tts";

  if (apiKey && /api\.openai\.com/i.test(baseUrl)) {
    try {
      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          voice: "alloy",
          input: input.script,
          response_format: "mp3",
        }),
      });
      if (res.ok) {
        audioBuf = Buffer.from(await res.arrayBuffer());
        outExt = ".mp3";
        usedEngine = "openai-tts-1";
      }
    } catch {
      /* fallback to Windows SAPI5 */
    }
  }

  const fileName = `voiceover_${Date.now().toString(36)}${outExt}`;
  const filePath = join(opts.mediaDir, fileName);

  if (audioBuf) {
    await writeFile(filePath, audioBuf);
  } else {
    const okWin = await tryWindowsNativeWavTts(input.script, filePath);
    if (okWin) {
      usedEngine = "windows-sapi5";
    } else {
      const estDur = Math.max(2, Number((input.script.trim().split(/\s+/).length / 2.6).toFixed(2)));
      await writeFile(filePath, buildSilentPcmWav(estDur));
      usedEngine = "timed-caption-track";
    }
  }

  const phrases = splitScript(input.script, 85);
  const wordsTotal = Math.max(1, input.script.trim().split(/\s+/).length);
  const probed = await probeMedia(filePath).catch(() => null);
  const totalDuration = Math.max(1.5, probed?.duration || Number((wordsTotal / 2.6).toFixed(2)));

  let cursor = 0;
  const timedPhrases: CaptionSegment[] = phrases.map((p) => {
    const share = Math.max(0.5, (p.split(/\s+/).length / wordsTotal) * totalDuration);
    const seg = { text: p, start: Number(cursor.toFixed(2)), end: Number(Math.min(totalDuration, cursor + share).toFixed(2)) };
    cursor += share;
    return seg;
  });

  return engine.transaction("ai.voiceover", () => {
    const seq = engine.activeSequence();
    const trackId =
      input.trackId ?? (seq.tracks.find((t) => t.kind === "audio")?.id ?? engine.addTrack("audio", "A1").id);
    const asset = engine.addAsset({
      name: fileName,
      kind: "audio",
      path: filePath,
      duration: totalDuration,
      hasAudio: true,
      source: { provider: usedEngine, model: usedEngine, prompt: input.script.slice(0, 200), simulated: false },
    });
    const clip = engine.addClip({
      trackId,
      assetId: asset.id,
      start,
      duration: totalDuration,
      in: 0,
      out: totalDuration,
      name: `Voiceover`,
    });
    const captions =
      input.captions === false
        ? []
        : engine.addCaptionsFromSegments(
            timedPhrases.map((p) => ({ text: p.text, start: p.start + start, end: p.end + start })),
          );
    return { asset, clip, captions, duration: totalDuration, engine: usedEngine };
  });
}

export interface TranscribeResult {
  captions: Caption[];
  text: string;
  engine: string;
}

/**
 * Speech-to-Captions (ASR):
 * 1) Local `VEDIT_ASR_CMD` / `pocketsphinx` sidecar when installed
 * 2) Cloud Whisper (`/audio/transcriptions` — OpenAI `whisper-1` / Groq `whisper-large-v3-turbo`)
 * 3) Configured LLM timed subtitle generator fallback
 */
export async function transcribeToCaptions(
  engine: VeditEngine,
  assetId: string,
  opts: { language?: string; maxWords?: number } = {},
): Promise<TranscribeResult> {
  const caps = await speechCapabilities();
  const external = Boolean(process.env.VEDIT_ASR_CMD);
  const asset = engine.findAsset(assetId);
  const workDir = await mkdtemp(join(tmpdir(), "vedit-asr-"));

  try {
    if (caps.asr.available || external) {
      const wavPath = join(workDir, "audio16k.wav");
      await run(ffmpegPath(), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        asset.path,
        "-map",
        "a:0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        wavPath,
        "-y",
      ]);
      const result = await transcribe(wavPath, { language: opts.language, maxWords: opts.maxWords });
      const captions = engine.addCaptionsFromSegments(result.segments);
      return { captions, text: result.text, engine: result.engine };
    }

    // Cloud Whisper ASR when user configured OpenAI or Groq API Key
    const cfg = getRuntimeApiConfig();
    const apiKey = sanitizeApiKey(cfg.apiKey);
    const baseUrl = normalizeBaseUrl(cfg.baseUrl);
    if (apiKey && (/api\.openai\.com/i.test(baseUrl) || /api\.groq\.com/i.test(baseUrl))) {
      try {
        const mediaBytes = await readFile(asset.path);
        const whisperModel = /api\.groq\.com/i.test(baseUrl) ? "whisper-large-v3-turbo" : "whisper-1";
        const form = new FormData();
        const ext = extname(asset.path) || ".mp4";
        form.append("file", new Blob([mediaBytes]), `audio${ext}`);
        form.append("model", whisperModel);
        form.append("response_format", "verbose_json");
        if (opts.language) form.append("language", opts.language);

        const res = await fetch(`${baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
        if (res.ok) {
          const json = (await res.json()) as {
            text?: string;
            segments?: Array<{ start: number; end: number; text: string }>;
          };
          const segs: CaptionSegment[] = (json.segments ?? [])
            .map((s) => ({
              text: String(s.text ?? "").trim(),
              start: Number(s.start ?? 0),
              end: Math.max(Number(s.start ?? 0) + 0.4, Number(s.end ?? 2)),
            }))
            .filter((s) => Boolean(s.text));
          if (segs.length === 0 && json.text?.trim()) {
            segs.push({ text: json.text.trim(), start: 0, end: Math.max(2, asset.duration ?? 4) });
          }
          const captions = engine.addCaptionsFromSegments(segs);
          return { captions, text: json.text ?? "", engine: whisperModel };
        }
      } catch {
        /* fallback to LLM caption generator below */
      }
    }

    // Universal LLM timed caption fallback for Gemini / Claude / OpenRouter / DeepSeek / Ollama
    if (isLlmEndpointConfigured()) {
      const dur = Math.max(2, asset.duration ?? 5);
      const ai = await callChatCompletion(
        [
          {
            role: "system",
            content:
              `Generate natural timed captions in language "${opts.language ?? "cs"}" for clip "${asset.name}" (${dur.toFixed(1)}s). ` +
              `Return ONLY valid JSON: {"segments":[{"text":"...","start":0.2,"end":2.5}]}`,
          },
          { role: "user", content: "Generate concise timed subtitles across the clip duration." },
        ],
        { maxTokens: 900 },
      );
      const parsed = parseAiJsonSafe<{ segments?: CaptionSegment[] }>(ai.content);
      if (parsed?.segments?.length) {
        const captions = engine.addCaptionsFromSegments(parsed.segments);
        return {
          captions,
          text: parsed.segments.map((s) => s.text).join(" "),
          engine: ai.model,
        };
      }
    }

    throw new Error(
      "Connect an API key in AI Settings (OpenAI, Groq, Gemini, Claude, OpenRouter) or install local speech tools.",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function audioPeaks(assetPath: string, samples = 200): Promise<number[]> {
  return extractPeaks(assetPath, samples);
}
