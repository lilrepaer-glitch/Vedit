import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VeditEngine } from "../src/core/engine.js";
import {
  speechCapabilities,
  splitScript,
  transcribe,
  ttsScript,
  ttsSynthesize,
} from "../src/ai/speech.js";
import { generateVoiceover, transcribeToCaptions } from "../src/ai/voiceover.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vedit-speech-"));
});

describe("splitScript (čistá utilita)", () => {
  it("dělí věty a dlouhé řádky", () => {
    expect(splitScript("Ahoj světe. To je test!")).toEqual(["Ahoj světe.", "To je test!"]);
    expect(splitScript("řádek jeden\nřádek dva")).toEqual(["řádek jeden", "řádek dva"]);
    const long = `${"slovo ".repeat(30)}. Konec.`;
    const parts = splitScript(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.at(-1)).toBe("Konec.");
  });
});

describe("F2 speech engine", () => {
  it("capabilities najde TTS i ASR", async () => {
    const caps = await speechCapabilities(true);
    expect(caps.tts.available).toBe(true);
    expect(caps.tts.engine).toBe("espeak-ng");
    expect(caps.asr.available).toBe(true);
    expect(caps.asr.engine).toBe("pocketsphinx");
  }, 60000);

  it("TTS vygeneruje reálný WAV (cs i en)", async () => {
    const cs = await ttsSynthesize("Ahoj světe, toto je Vedit.", { voice: "cs" });
    expect(cs.wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(cs.duration).toBeGreaterThan(0.5);
    expect(cs.duration).toBeLessThan(10);
    expect(cs.sampleRate).toBeGreaterThan(8000);

    const en = await ttsSynthesize("Hello world from Vedit.", { voice: "en" });
    expect(en.duration).toBeGreaterThan(0.3);
    expect(en.wav.subarray(0, 4).toString()).toBe("RIFF");
  }, 60000);

  it("ttsScript vytvoří voiceover s přesným časováním frází", async () => {
    const script = "První věta titulku.\nDruhá věta pokračuje.\nTřetí věta uzavírá.";
    const result = await ttsScript(script, { voice: "cs", gap: 0.3 });
    expect(result.phrases).toHaveLength(3);
    // monotónní časování, odpovídá celkové délce
    for (let i = 1; i < result.phrases.length; i++) {
      expect(result.phrases[i]!.start).toBeGreaterThanOrEqual(result.phrases[i - 1]!.end - 0.01);
    }
    expect(result.totalDuration).toBeGreaterThan(1);
    expect(result.phrases.at(-1)!.end).toBeLessThanOrEqual(result.totalDuration + 0.05);
    expect(result.wav.subarray(0, 4).toString()).toBe("RIFF");
  }, 60000);

  it("transcribe přepíše TTS řeč (en) na segmenty s časy", async () => {
    const tts = await ttsSynthesize("Hello world this is a caption test", { voice: "en" });
    const wavPath = join(dir, "asr_in.wav");
    await writeFile(wavPath, tts.wav);
    const result = await transcribe(wavPath, { language: "en" });
    expect(result.engine).toBe("pocketsphinx");
    expect(Array.isArray(result.segments)).toBe(true);
    for (const seg of result.segments) {
      expect(seg.start).toBeGreaterThanOrEqual(0);
      expect(seg.end).toBeGreaterThan(seg.start - 0.01);
      expect(seg.end).toBeLessThanOrEqual(tts.duration + 1);
    }
  }, 120000);

  it("generateVoiceover přidá asset + klip + titulky jako jedno undo", async () => {
    const engine = new VeditEngine(VeditEngine.createProject("VO test"));
    const result = await generateVoiceover(
      engine,
      { script: "Ahoj. Tohle je voiceover test.", voice: "cs", start: 1 },
      { mediaDir: dir },
    );
    expect(result.asset.kind).toBe("audio");
    expect(result.asset.source?.simulated).toBe(false);
    expect(result.clip.start).toBe(1);
    expect(result.captions.length).toBe(2);
    expect(result.captions[0]!.start).toBeGreaterThanOrEqual(1);
    // jediné undo vrátí vše
    expect(engine.undo()).toBe(true);
    expect(engine.project.assets.filter((a) => a.kind === "audio")).toHaveLength(0);
    expect(engine.activeSequence().captions).toHaveLength(0);
    expect(engine.undo()).toBe(false);
  }, 60000);

  it("transcribeToCaptions vloží titulky do projektu", async () => {
    const engine = new VeditEngine(VeditEngine.createProject("ASR test"));
    const tts = await ttsSynthesize("Hello world", { voice: "en" });
    const wavPath = join(dir, "asr_asset.wav");
    await writeFile(wavPath, tts.wav);
    const asset = engine.addAsset({
      name: "asr_asset.wav",
      kind: "audio",
      path: wavPath,
      duration: tts.duration,
      hasAudio: true,
    });
    const result = await transcribeToCaptions(engine, asset.id, { language: "en" });
    expect(result.engine).toBe("pocketsphinx");
    expect(result.captions).toBeInstanceOf(Array);
    // i když ASR nic nerozpozná, pole musí existovat a projekt zůstává konzistentní
    expect(engine.activeSequence().captions).toHaveLength(result.captions.length);
  }, 120000);
});
