// AI titulky a voiceover (F2, PLAN.md §3.2) — workflow nad speech enginem.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VeditEngine } from "../core/engine.js";
import type { Asset, Caption, Clip } from "../core/types.js";
import { extractPeaks, probeMedia, run, ffmpegPath } from "../core/media.js";
import { speechCapabilities, transcribe, ttsScript, type CaptionSegment } from "./speech.js";

export interface VoiceoverInput {
  script: string;
  voice?: string;
  rate?: number;
  gap?: number;
  /** čas na timeline, kde voiceover začne */
  start?: number;
  trackId?: string;
  /** přidat i titulky (výchozí ano) */
  captions?: boolean;
}

export interface VoiceoverResult {
  asset: Asset;
  clip: Clip;
  captions: Caption[];
  duration: number;
  engine: string;
}

/**
 * Vygeneruje voiceover ze skriptu: TTS audio + klip na timeline + titulky
 * s přesným časováním. Vše jako jedna transakce (jedno undo).
 */
export async function generateVoiceover(
  engine: VeditEngine,
  input: VoiceoverInput,
  opts: { mediaDir: string },
): Promise<VoiceoverResult> {
  const caps = await speechCapabilities();
  if (!caps.tts.available) {
    throw new Error("TTS engine není k dispozici (nainstaluj python/requirements.txt do .venv-ai)");
  }
  const scriptTts = await ttsScript(input.script, {
    voice: input.voice ?? "cs",
    rate: input.rate,
    gap: input.gap,
  });

  await mkdir(opts.mediaDir, { recursive: true });
  const fileName = `voiceover_${Date.now().toString(36)}.wav`;
  const filePath = join(opts.mediaDir, fileName);
  await writeFile(filePath, scriptTts.wav);

  const probe = await probeMedia(filePath);
  const start = Math.max(0, input.start ?? 0);

  return engine.transaction("ai.voiceover", () => {
    const seq = engine.activeSequence();
    let trackId = input.trackId;
    if (!trackId) {
      const track = seq.tracks.find((t) => t.kind === "audio");
      trackId = track ? track.id : engine.addTrack("audio", "A1").id;
    }
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

export interface TranscribeResult {
  captions: Caption[];
  text: string;
  engine: string;
}

/**
 * Přepis řeči z média → titulky (Whisper-class pipeline).
 * Nejdřív se audio převede na 16 kHz mono WAV, pak běží ASR.
 */
export async function transcribeToCaptions(
  engine: VeditEngine,
  assetId: string,
  opts: { language?: string; maxWords?: number } = {},
): Promise<TranscribeResult> {
  const caps = await speechCapabilities();
  const external = Boolean(process.env.VEDIT_ASR_CMD);
  if (!caps.asr.available && !external) {
    throw new Error("ASR engine není k dispozici (pocketsphinx nebo VEDIT_ASR_CMD)");
  }
  const asset = engine.findAsset(assetId);
  const workDir = await mkdtemp(join(tmpdir(), "vedit-asr-"));
  const wavPath = join(workDir, "audio16k.wav");
  // převod na 16 kHz mono (vstup pro ASR)
  await run(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error",
    "-i", asset.path,
    "-map", "a:0",
    "-ac", "1", "-ar", "16000",
    "-f", "wav", wavPath, "-y",
  ]);

  const result = await transcribe(wavPath, { language: opts.language, maxWords: opts.maxWords });
  const captions = engine.addCaptionsFromSegments(result.segments);
  return { captions, text: result.text, engine: result.engine };
}

/** Odhad úrovně signálu (0..1) pro UI indikaci — reálné peaks. */
export async function audioPeaks(assetPath: string, samples = 200): Promise<number[]> {
  return extractPeaks(assetPath, samples);
}
