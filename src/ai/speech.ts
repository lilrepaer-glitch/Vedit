// Speech engine bridge (PLAN.md §3.2, F2) — TTS + ASR přes Python sidecar.
// TTS: espeak-ng (cs/en/…), ASR: pocketsphinx (en) + externí příkazy (Whisper apod.)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SIDECAR = resolve(MODULE_DIR, "..", "..", "python", "speech_tool.py");

export interface CaptionSegment {
  text: string;
  start: number;
  end: number;
}

export interface TtsResult {
  wav: Buffer;
  sampleRate: number;
  duration: number;
}

export interface ScriptTtsResult {
  wav: Buffer;
  phrases: CaptionSegment[];
  sampleRate: number;
  totalDuration: number;
  voice: string;
}

export interface SpeechCapabilities {
  tts: { engine: string; available: boolean };
  asr: { engine: string; available: boolean };
  voices: string[];
}

/** Python interpret se speech závislostmi (venv, VEDIT_PYTHON, nebo systémový). */
export function pythonBin(): string {
  if (process.env.VEDIT_PYTHON) return process.env.VEDIT_PYTHON;
  const venvWin = resolve(process.cwd(), ".venv-ai/Scripts/python.exe");
  if (existsSync(venvWin)) return venvWin;
  const venvUnix = resolve(process.cwd(), ".venv-ai/bin/python");
  if (existsSync(venvUnix)) return venvUnix;
  return process.platform === "win32" ? "python" : "python3";
}

function runPython(args: string[], timeoutMs = 15000): Promise<string> {
  if (!existsSync(SIDECAR)) {
    return Promise.reject(new Error(`speech_tool.py not found at ${SIDECAR}`));
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonBin(), [SIDECAR, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`speech_tool ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(new Error(`speech_tool ${args[0]} selhal (${code}): ${err.trim().split("\n").slice(-2).join(" | ")}`));
    });
  });
}

let cachedCaps: SpeechCapabilities | null = null;

/** Zjistí dostupné enginy (cache). */
export async function speechCapabilities(force = false): Promise<SpeechCapabilities> {
  if (cachedCaps && !force) return cachedCaps;
  try {
    const raw = await runPython(["probe"], 2500);
    const probe = JSON.parse(raw) as { espeak: boolean; pocketsphinx: boolean };
    cachedCaps = {
      tts: { engine: probe.espeak ? "espeak-ng" : "none", available: probe.espeak },
      asr: { engine: probe.pocketsphinx ? "pocketsphinx" : "none", available: probe.pocketsphinx },
      voices: ["cs", "en", "sk", "de", "fr", "es", "it", "pl", "ru"],
    };
  } catch {
    cachedCaps = {
      tts: { engine: "none", available: false },
      asr: { engine: "none", available: false },
      voices: [],
    };
  }
  return cachedCaps;
}

/** Syntéza jednoho textu → WAV. */
export async function ttsSynthesize(
  text: string,
  opts: { voice?: string; rate?: number; pitch?: number } = {},
): Promise<TtsResult> {
  const dir = await mkdtemp(join(tmpdir(), "vedit-tts-"));
  const out = join(dir, "tts.wav");
  try {
    const raw = await runPython([
      "tts",
      "--text", text,
      "--voice", opts.voice ?? "cs",
      "--rate", String(opts.rate ?? 175),
      "--pitch", String(opts.pitch ?? 50),
      "--out", out,
    ]);
    const meta = JSON.parse(raw.trim().split("\n").pop()!) as { sampleRate: number; duration: number };
    const wav = await readFile(out);
    return { wav, sampleRate: meta.sampleRate, duration: meta.duration };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Skript → voiceover WAV + přesné časování frází pro titulky.
 * Každá fráze se syntetizuje zvlášť, takže časy odpovídají stopě na vteřiny.
 */
export async function ttsScript(
  script: string,
  opts: { voice?: string; rate?: number; pitch?: number; gap?: number } = {},
): Promise<ScriptTtsResult> {
  const dir = await mkdtemp(join(tmpdir(), "vedit-tts-script-"));
  try {
    const scriptFile = join(dir, "script.txt");
    await writeFile(scriptFile, script, "utf8");
    const raw = await runPython([
      "tts-script",
      "--script-file", scriptFile,
      "--voice", opts.voice ?? "cs",
      "--rate", String(opts.rate ?? 175),
      "--pitch", String(opts.pitch ?? 50),
      "--gap", String(opts.gap ?? 0.35),
      "--outdir", dir,
    ]);
    const meta = JSON.parse(raw.trim().split("\n").pop()!) as {
      phrases: CaptionSegment[];
      wav: string;
      sampleRate: number;
      totalDuration: number;
      voice: string;
    };
    const wav = await readFile(meta.wav);
    return {
      wav,
      phrases: meta.phrases,
      sampleRate: meta.sampleRate,
      totalDuration: meta.totalDuration,
      voice: meta.voice,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Přepis řeči → segmenty titulků.
 * 1) VEDIT_ASR_CMD (externí Whisper atd.) — pokud je nastaveno
 * 2) pocketsphinx (en) přes sidecar
 */
export async function transcribe(
  audioPath: string,
  opts: { language?: string; maxWords?: number } = {},
): Promise<{ segments: CaptionSegment[]; text: string; engine: string }> {
  if (process.env.VEDIT_ASR_CMD) {
    const raw = await new Promise<string>((res, rej) => {
      const child = spawn(process.env.VEDIT_ASR_CMD!, [audioPath], { shell: true, windowsHide: true });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.on("error", rej);
      child.on("close", (code) => (code === 0 ? res(out) : rej(new Error(`VEDIT_ASR_CMD selhal (${code})`))));
    });
    const parsed = JSON.parse(raw) as { segments: CaptionSegment[]; text?: string };
    return { segments: parsed.segments, text: parsed.text ?? "", engine: "external" };
  }
  const raw = await runPython([
    "asr",
    "--audio", audioPath,
    "--language", opts.language ?? "en",
    "--max-words", String(opts.maxWords ?? 8),
  ]);
  const parsed = JSON.parse(raw.trim().split("\n").pop()!) as {
    segments: CaptionSegment[];
    text: string;
    engine: string;
  };
  return { segments: parsed.segments, text: parsed.text, engine: parsed.engine };
}

/** Rozdělí skript na fráze (věty; dlouhé na čárkách) — čistá utilita. */
export function splitScript(script: string, maxLen = 100): string[] {
  const phrases: string[] = [];
  for (const line of script.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/(?<=[.!?…])\s+/);
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      if (p.length <= maxLen) {
        phrases.push(p);
      } else {
        let buf = "";
        for (const chunk of p.split(/(?<=[,;:])\s+/)) {
          if (buf && buf.length + chunk.length + 1 > maxLen) {
            phrases.push(buf);
            buf = chunk;
          } else {
            buf = buf ? `${buf} ${chunk}` : chunk;
          }
        }
        if (buf) phrases.push(buf);
      }
    }
  }
  return phrases;
}
