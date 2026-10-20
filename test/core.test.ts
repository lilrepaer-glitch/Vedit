import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VeditEngine } from "../src/core/engine.js";
import {
  captionsToSrt,
  loadProject,
  saveProject,
  sequenceDuration,
  type Project,
} from "../src/core/index.js";

function setup() {
  const engine = new VeditEngine(VeditEngine.createProject("Test"));
  const v1 = engine.addTrack("video", "V1");
  const a1 = engine.addTrack("audio", "A1");
  const video = engine.addAsset({
    name: "clip.mp4",
    kind: "video",
    path: "/tmp/clip.mp4",
    duration: 30,
    width: 1920,
    height: 1080,
    fps: 30,
  });
  const audio = engine.addAsset({ name: "hudba.mp3", kind: "audio", path: "/tmp/hudba.mp3", duration: 60 });
  return { engine, v1, a1, video, audio };
}

describe("VeditEngine — základní operace", () => {
  it("vytvoří projekt se sekvencí", () => {
    const { engine } = setup();
    expect(engine.project.format).toBe("vedit-project");
    expect(engine.project.sequences).toHaveLength(1);
    expect(engine.activeSequence().fps).toBe(30);
  });

  it("přidá klip a počítá délku sekvence", () => {
    const { engine, v1, video } = setup();
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 5, duration: 8, in: 2, out: 10 });
    expect(clip.start).toBe(5);
    expect(clip.duration).toBe(8);
    expect(clip.out).toBe(10);
    expect(sequenceDuration(engine.activeSequence())).toBe(13);
  });

  it("razor (split) rozdělí klip na dva", () => {
    const { engine, v1, video } = setup();
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 10, in: 0, out: 10 });
    const [left, right] = engine.splitClip(clip.id, 4);
    expect(left.duration).toBeCloseTo(4);
    expect(right.start).toBeCloseTo(4);
    expect(right.duration).toBeCloseTo(6);
    expect(right.in).toBeCloseTo(4);
    expect(engine.findTrack(v1.id).clips).toHaveLength(2);
  });

  it("split mimo klip selže", () => {
    const { engine, v1, video } = setup();
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 10 });
    expect(() => engine.splitClip(clip.id, 11)).toThrow(/inside the clip/);
  });

  it("trim posune hranu klipu", () => {
    const { engine, v1, video } = setup();
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 10, in: 0, out: 10 });
    engine.trimClip(clip.id, "start", 3);
    expect(clip.start).toBe(3);
    expect(clip.duration).toBeCloseTo(7);
    expect(clip.in).toBeCloseTo(3);
    engine.trimClip(clip.id, "end", 8);
    expect(clip.duration).toBeCloseTo(5);
  });

  it("move přesune klip na jiný čas i stopu", () => {
    const { engine, v1, a1, video, audio } = setup();
    const vClip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 5 });
    engine.moveClip(vClip.id, 12, undefined, v1.id);
    expect(vClip.start).toBe(12);
    // audio klip na audio stopu
    const aClip = engine.addClip({ trackId: a1.id, assetId: audio.id, start: 0, duration: 5 });
    engine.moveClip(aClip.id, 20);
    expect(aClip.start).toBe(20);
  });

  it("ripple delete zavře mezeru", () => {
    const { engine, v1, video } = setup();
    const c1 = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 4, in: 0, out: 4 });
    const c2 = engine.addClip({ trackId: v1.id, assetId: video.id, start: 4, duration: 4, in: 4, out: 8 });
    const c3 = engine.addClip({ trackId: v1.id, assetId: video.id, start: 8, duration: 4, in: 8, out: 12 });
    engine.rippleDeleteClip(c2.id, v1.id);
    expect(engine.findTrack(v1.id).clips).toHaveLength(2);
    expect(c3.start).toBeCloseTo(4);
    expect(c1.start).toBe(0);
  });

  it("undo/redo vrací stav", () => {
    const { engine, v1, video } = setup();
    const base = engine.undoLabels.length;
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 5 });
    engine.splitClip(clip.id, 2);
    expect(engine.findTrack(v1.id).clips).toHaveLength(2);
    expect(engine.undo()).toBe(true); // split
    expect(engine.findTrack(v1.id).clips).toHaveLength(1);
    expect(engine.undo()).toBe(true); // addClip
    expect(engine.findTrack(v1.id).clips).toHaveLength(0);
    expect(engine.redo()).toBe(true);
    expect(engine.findTrack(v1.id).clips).toHaveLength(1);
    expect(engine.redo()).toBe(true);
    expect(engine.findTrack(v1.id).clips).toHaveLength(2);
    expect(engine.undoLabels.length - base).toBe(2);
  });

  it("klip na zamčené stopě nelze měnit", () => {
    const { engine, v1, video } = setup();
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 5 });
    const track = engine.findTrack(v1.id);
    track.locked = true;
    expect(() => engine.deleteClip(clip.id, v1.id)).toThrow(/locked/);
    track.locked = false;
    engine.deleteClip(clip.id, v1.id);
    expect(engine.findTrack(v1.id).clips).toHaveLength(0);
  });

  it("roll posune střih mezi sousedními klipy", () => {
    const { engine, v1, video } = setup();
    const left = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 4, in: 0, out: 4 });
    const right = engine.addClip({ trackId: v1.id, assetId: video.id, start: 4, duration: 4, in: 4, out: 8 });
    engine.rollClip(left.id, 1);
    expect(left.duration).toBeCloseTo(5);
    expect(right.start).toBeCloseTo(5);
    expect(right.duration).toBeCloseTo(3);
    expect(right.in).toBeCloseTo(5);
    expect(() => engine.rollClip(left.id, 10)).toThrow(/překračuje/);
    // bez souseda vpravo to nejde
    const solo = engine.addClip({ trackId: v1.id, assetId: video.id, start: 20, duration: 2 });
    expect(() => engine.rollClip(solo.id, 1)).toThrow(/sousední/);
  });

  it("slip posune obsah bez pohybu na timeline", () => {
    const { engine, v1, video } = setup();
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 2, duration: 4, in: 5, out: 9 });
    engine.slipClip(clip.id, 1.5);
    expect(clip.in).toBeCloseTo(6.5);
    expect(clip.out).toBeCloseTo(10.5);
    expect(clip.start).toBe(2);
    expect(clip.duration).toBe(4);
    expect(() => engine.slipClip(clip.id, -10)).toThrow(/začátek/);
    expect(() => engine.slipClip(clip.id, 25)).toThrow(/konec/);
  });

  it("slide posune klip a upraví sousedy", () => {
    const { engine, v1, video } = setup();
    const prev = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 3, in: 0, out: 3 });
    const mid = engine.addClip({ trackId: v1.id, assetId: video.id, start: 3, duration: 2, in: 3, out: 5 });
    const next = engine.addClip({ trackId: v1.id, assetId: video.id, start: 5, duration: 3, in: 5, out: 8 });
    engine.slideClip(mid.id, 1);
    expect(mid.start).toBeCloseTo(4);
    expect(prev.duration).toBeCloseTo(4);
    expect(next.start).toBeCloseTo(6);
    expect(next.in).toBeCloseTo(6);
    expect(next.duration).toBeCloseTo(2);
  });
});

describe("animace, titulky, export", () => {
  it("aplikuje animační preset jako keyframy", () => {
    const { engine, v1, video } = setup();
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 3 });
    engine.applyAnimationPreset(clip.id, "fade-in");
    expect(clip.keyframes.length).toBeGreaterThan(0);
    expect(clip.keyframes[0]!.property).toBe("opacity");
    // opětovná aplikace stejného presetu přepíše stejné keyframy
    engine.applyAnimationPreset(clip.id, "fade-in");
    const opacityKeys = clip.keyframes.filter((k) => k.property === "opacity");
    expect(opacityKeys).toHaveLength(2);
  });

  it("neznámý preset selže", () => {
    const { engine, v1, video } = setup();
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 3 });
    expect(() => engine.applyAnimationPreset(clip.id, "neexistuje")).toThrow(/unknown animation preset/);
  });

  it("titulky: add, from-text, update, SRT export", () => {
    const { engine } = setup();
    engine.addCaption({ text: "Ahoj světe", start: 1, end: 2.5 });
    engine.addCaptionsFromSegments([
      { text: "druhý", start: 3, end: 4 },
      { text: "třetí", start: 5, end: 6 },
    ]);
    const captions = engine.activeSequence().captions;
    expect(captions).toHaveLength(3);
    engine.updateCaption(captions[0]!.id, { text: "Ahoj!" });
    expect(captions[0]!.text).toBe("Ahoj!");
    const srt = captionsToSrt(captions);
    expect(srt).toContain("00:00:01,000 --> 00:00:02,500");
    expect(srt).toContain("Ahoj!");
  });

  it("efekty: add/remove", () => {
    const { engine, v1, video } = setup();
    const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 3 });
    const effect = engine.addEffect(clip.id, "blur", { radius: 4 });
    expect(clip.effects).toHaveLength(1);
    engine.removeEffect(clip.id, effect.id);
    expect(clip.effects).toHaveLength(0);
  });
});

describe("persistence (.vedit JSON)", () => {
  it("uloží a načte projekt beze ztráty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vedit-test-"));
    const file = join(dir, "projekt.vedit");
    try {
      const { engine, v1, video } = setup();
      const clip = engine.addClip({ trackId: v1.id, assetId: video.id, start: 0, duration: 6 });
      engine.applyAnimationPreset(clip.id, "slide-in-left");
      engine.addCaption({ text: "test", start: 0, end: 1 });
      await saveProject(engine.project, file);
      const loaded = (await loadProject(file)) as Project;
      expect(loaded.name).toBe("Test");
      expect(loaded.sequences[0]!.tracks[0]!.clips[0]!.keyframes.length).toBeGreaterThan(0);
      expect(loaded.sequences[0]!.captions).toHaveLength(1);
      const reEngine = new VeditEngine(loaded);
      expect(reEngine.timeline().duration).toBeCloseTo(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
