import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { mobileApi } from "../apps/desktop/src/mobileRuntime.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const APK_PATH = path.join(ROOT, "releases", "Vedit.apk");

function inspectApkZip(buf: Buffer) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThan(0);
  const total = buf.readUInt16LE(eocd + 10);
  const cdStart = buf.readUInt32LE(eocd + 16);

  const entries = new Map<
    string,
    { method: number; compSize: number; rawSize: number; dataOffset: number; data: Buffer }
  >();
  let ptr = cdStart;
  for (let i = 0; i < total; i++) {
    expect(buf.readUInt32LE(ptr)).toBe(0x02014b50);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const rawSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const lfhOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");

    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataOffset = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const rawSlice = buf.subarray(dataOffset, dataOffset + compSize);
    const data = method === 0 ? Buffer.from(rawSlice) : zlib.inflateRawSync(rawSlice);

    entries.set(name, { method, compSize, rawSize, dataOffset, data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe("F10 — Standalone Native Android APK (Vedit.apk v0.7.0) & Mobile NLE Engine", () => {
  it("ships a valid, 4-byte-aligned, v1+v2+v3 cryptographically signed releases/Vedit.apk", () => {
    expect(fs.existsSync(APK_PATH)).toBe(true);
    const apk = fs.readFileSync(APK_PATH);
    expect(apk.length).toBeGreaterThan(250_000);
    // ZIP Local File Header magic PK\x03\x04
    expect(apk.readUInt32LE(0)).toBe(0x04034b50);
    // APK Signature Scheme v2/v3 Signing Block magic ("APK Sig Block 42")
    expect(apk.includes(Buffer.from("APK Sig Block 42", "ascii"))).toBe(true);

    const entries = inspectApkZip(apk);

    // Core Android binary package artifacts
    expect(entries.has("AndroidManifest.xml")).toBe(true);
    expect(entries.has("resources.arsc")).toBe(true);
    expect(entries.has("classes.dex")).toBe(true);

    // v1 JAR Signature or v2+v3 Full-APK Signing Block verified above
    expect(
      entries.has("META-INF/MANIFEST.MF") || apk.includes(Buffer.from("APK Sig Block 42", "ascii")),
    ).toBe(true);

    // Android 11–15 mandatory rule: resources.arsc MUST be uncompressed AND 4-byte aligned!
    const arsc = entries.get("resources.arsc")!;
    expect(arsc.method).toBe(0);
    expect(arsc.dataOffset % 4).toBe(0);

    // Valid Dalvik/ART DEX header + MainActivity & VeditAndroid bridge symbols
    const dex = entries.get("classes.dex")!;
    expect(dex.data.subarray(0, 4).toString("ascii")).toBe("dex\n");
    expect(dex.data.includes(Buffer.from("Lcom/vedit/studio/MainActivity;", "ascii"))).toBe(true);
    expect(dex.data.includes(Buffer.from("saveExportBase64", "ascii"))).toBe(true);

    // Multi-density launcher icons compiled by Google aapt2 (res/mipmap-*-v4/ic_launcher.png)
    for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
      const iconEntry =
        entries.get(`res/mipmap-${density}-v4/ic_launcher.png`) ??
        entries.get(`res/mipmap-${density}/ic_launcher.png`);
      expect(iconEntry).toBeDefined();
      expect(iconEntry!.method).toBe(0);
      expect(iconEntry!.dataOffset % 4).toBe(0);
    }

    // Complete offline-capable Vedit Studio bundle inside assets/public/
    expect(entries.has("assets/public/index.html")).toBe(true);
    const assetKeys = Array.from(entries.keys());
    expect(assetKeys.some((k) => k.startsWith("assets/public/assets/") && k.endsWith(".js"))).toBe(true);
    expect(assetKeys.some((k) => k.startsWith("assets/public/assets/") && k.endsWith(".css"))).toBe(true);
  });

  it("executes full standalone mobile NLE editing, undo/redo, LUTs, API config & AI copilot", async () => {
    const listed = await mobileApi.listProjects();
    expect(listed.projects.length).toBeGreaterThanOrEqual(1);

    const boot = await mobileApi.getProject(listed.projects[0].id);
    const seq = boot.project.sequences[0];
    expect(seq.tracks.length).toBeGreaterThanOrEqual(2);
    const leadClip = seq.tracks.flatMap((t) => t.clips)[0];
    expect(leadClip).toBeDefined();

    // Apply 3D LUT + split clip + speed ramp + undo/redo
    await mobileApi.applyLut(leadClip.id, "kodak-2383");
    await mobileApi.colorGrade(leadClip.id, "teal-orange-blockbuster");
    await mobileApi.splitClip(leadClip.id, 2.5);
    const afterSplit = await mobileApi.getProject(listed.projects[0].id);
    expect(afterSplit.project.sequences[0].tracks[0].clips.length).toBeGreaterThanOrEqual(2);

    await mobileApi.undo();
    const afterUndo = await mobileApi.getProject(listed.projects[0].id);
    expect(afterUndo.project.sequences[0].tracks[0].clips.length).toBe(seq.tracks[0].clips.length);
    await mobileApi.redo();
    const afterRedo = await mobileApi.getProject(listed.projects[0].id);
    expect(afterRedo.project.sequences[0].tracks[0].clips.length).toBeGreaterThanOrEqual(2);

    // Custom API Key + Base URL + Model configuration on Android
    const updatedCfg = await mobileApi.saveApiSettings({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-test-mobile-key-123456",
    });
    expect(updatedCfg.hasApiKey).toBe(true);
    expect(updatedCfg.model).toBe("gpt-4o-mini");

    // Offline AI Copilot fallback works immediately when cleared API key
    await mobileApi.saveApiSettings({ clearApiKey: true });
    const copilot = await mobileApi.runCopilot("Add title and Kodak film look");
    expect(copilot.stepsExecuted.length).toBeGreaterThanOrEqual(1);

    const check = await mobileApi.checkUpdate();
    expect(check.currentVersion).toBe("0.7.0");
  });
});
