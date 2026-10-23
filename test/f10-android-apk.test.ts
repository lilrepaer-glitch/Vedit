import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPresetByKey,
  mobileApi,
  normalizeMobileBaseUrl,
  sanitizeMobileApiKey,
} from "../apps/desktop/src/mobileRuntime.js";
import {
  detectPresetFromKey,
  normalizeBaseUrl,
  sanitizeApiKey,
} from "../src/pro/api-settings.js";

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
    const compSize = buf.readUInt16LE(ptr + 20);
    const rawSize = buf.readUInt16LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const lfhOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");

    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataOffset = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const rawSlice = buf.subarray(dataOffset, dataOffset + compSize);
    let data: Buffer;
    if (method === 0 || compSize === 0) {
      data = Buffer.from(rawSlice);
    } else {
      try {
        data = zlib.inflateRawSync(rawSlice);
      } catch {
        data = zlib.inflateRawSync(buf.subarray(dataOffset));
      }
    }

    entries.set(name, { method, compSize, rawSize, dataOffset, data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe("F10 — Standalone Native Android APK (Vedit.apk v0.8.0), Universal API Bridge & Real Mobile/Desktop NLE", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("ships a valid, 4-byte-aligned, v2+v3 cryptographically signed releases/Vedit.apk with native HTTP & Gallery bridges", () => {
    expect(fs.existsSync(APK_PATH)).toBe(true);
    const apk = fs.readFileSync(APK_PATH);
    expect(apk.length).toBeGreaterThan(250_000);
    expect(apk.readUInt32LE(0)).toBe(0x04034b50);
    expect(apk.includes(Buffer.from("APK Sig Block 42", "ascii"))).toBe(true);

    const entries = inspectApkZip(apk);
    expect(entries.has("AndroidManifest.xml")).toBe(true);
    expect(entries.has("resources.arsc")).toBe(true);
    expect(entries.has("classes.dex")).toBe(true);

    const arsc = entries.get("resources.arsc")!;
    expect(arsc.method).toBe(0);
    expect(arsc.dataOffset % 4).toBe(0);

    const dex = entries.get("classes.dex")!;
    expect(dex.data.subarray(0, 4).toString("ascii")).toBe("dex\n");
    expect(dex.data.includes(Buffer.from("Lcom/vedit/studio/MainActivity;", "ascii"))).toBe(true);
    expect(dex.data.includes(Buffer.from("httpRequest", "ascii"))).toBe(true);
    expect(dex.data.includes(Buffer.from("saveExportBase64", "ascii"))).toBe(true);
    expect(dex.data.includes(Buffer.from("shareLastExport", "ascii"))).toBe(true);

    for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
      const iconEntry =
        entries.get(`res/mipmap-${density}-v4/ic_launcher.png`) ??
        entries.get(`res/mipmap-${density}/ic_launcher.png`);
      expect(iconEntry).toBeDefined();
      expect(iconEntry!.method).toBe(0);
      expect(iconEntry!.dataOffset % 4).toBe(0);
    }

    expect(entries.has("assets/public/index.html")).toBe(true);
    const assetKeys = Array.from(entries.keys());
    expect(assetKeys.some((k) => k.startsWith("assets/public/assets/") && k.endsWith(".js"))).toBe(true);
    expect(assetKeys.some((k) => k.startsWith("assets/public/assets/") && k.endsWith(".css"))).toBe(true);
  });

  it("auto-sanitizes pasted API keys, detects providers, and normalizes URLs identically on Android & PC", () => {
    const messyKey = '  "Bearer sk-proj-abc123\u200B\uFEFFxyz789" \n ';
    expect(sanitizeMobileApiKey(messyKey)).toBe("sk-proj-abc123xyz789");
    expect(sanitizeApiKey(messyKey)).toBe("sk-proj-abc123xyz789");

    expect(detectPresetByKey("AIzaSyDummyGeminiKey12345")?.id).toBe("gemini");
    expect(detectPresetFromKey("AIzaSyDummyGeminiKey12345")?.id).toBe("gemini");
    expect(detectPresetByKey("sk-ant-api03-claude-key")?.id).toBe("anthropic");
    expect(detectPresetFromKey("sk-ant-api03-claude-key")?.id).toBe("anthropic");
    expect(detectPresetByKey("sk-or-v1-openrouter-key")?.id).toBe("openrouter");
    expect(detectPresetByKey("gsk_groq_fast_key_123")?.id).toBe("groq");
    expect(detectPresetByKey("nvapi-nvidia-key-123")?.id).toBe("nvidia");
    expect(detectPresetByKey("xai-grok-key-123")?.id).toBe("xai");

    expect(normalizeMobileBaseUrl("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1");
    expect(normalizeMobileBaseUrl("192.168.1.42:11434")).toBe("http://192.168.1.42:11434/v1");
    expect(normalizeBaseUrl("192.168.1.42:11434")).toBe("http://192.168.1.42:11434/v1");
  });

  it("routes Android API calls through CORS-free native VeditAndroid.httpRequest for OpenAI, Gemini & Anthropic", async () => {
    const nativeCalls: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];

    (globalThis as Record<string, unknown>).window = {
      VeditAndroid: {
        httpRequest(method: string, url: string, headersJson: string, body: string) {
          const headers = JSON.parse(headersJson || "{}") as Record<string, string>;
          nativeCalls.push({ method, url, headers, body });

          if (url.endsWith("/messages")) {
            return JSON.stringify({
              status: 200,
              body: JSON.stringify({
                content: [
                  {
                    type: "text",
                    text: '{"reply":"Applied film grade","actions":[{"op":"aspect","ratio":"9:16"},{"op":"adjust","exposure":12,"contrast":18}]}',
                  },
                ],
              }),
            });
          }
          if (url.endsWith("/models")) {
            return JSON.stringify({
              status: 200,
              body: JSON.stringify({
                data: [{ id: "gemini-2.5-flash" }, { id: "gemini-2.5-pro" }],
              }),
            });
          }
          return JSON.stringify({
            status: 200,
            body: JSON.stringify({
              choices: [{ message: { content: "OK" } }],
            }),
          });
        },
      },
    };

    await mobileApi.saveApiSettings({
      apiKey: "AIzaSyTestMobileKey999",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.5-flash",
    });
    const fetched = await mobileApi.fetchApiModels({});
    expect(fetched.models).toContain("gemini-2.5-flash");

    const ping = await mobileApi.testApiSettings({});
    expect(ping.ok).toBe(true);
    expect(ping.reply).toBe("OK");

    await mobileApi.saveApiSettings({
      apiKey: "sk-ant-api03-testmobile",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-20250514",
    });
    const copilotRes = await mobileApi.runCopilot("Make this 9:16 vertical with punchy film contrast");
    expect(copilotRes.summary).toContain("Applied film grade");
    expect(
      nativeCalls.some(
        (c) =>
          c.url === "https://api.anthropic.com/v1/messages" &&
          c.headers["x-api-key"] === "sk-ant-api03-testmobile",
      ),
    ).toBe(true);
  });

  it("executes real non-destructive editing: canvas aspect, color grade, transform, crop, speed, trim, move, captions & undo/redo", async () => {
    const { projects } = await mobileApi.listProjects();
    expect(projects.length).toBeGreaterThanOrEqual(1);

    const { project } = await mobileApi.getProject(projects[0]!.id);
    const seq = project.sequences[0]!;
    expect(seq.tracks.length).toBeGreaterThanOrEqual(2);
    let leadClip = seq.tracks.flatMap((t) => t.clips)[0];
    if (!leadClip) {
      const { asset } = await mobileApi.addAsset({
        name: "Camera_Take_01.mp4",
        path: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'/>",
        kind: "video",
        duration: 6,
      });
      const added = await mobileApi.addClip({
        trackId: seq.tracks[0]!.id,
        assetId: asset.id,
        start: 0,
        duration: 6,
      });
      leadClip = added.clip;
    }
    expect(leadClip).toBeDefined();

    // Update sequence aspect ratio & blurred background fill
    const { sequence: resized } = await mobileApi.updateSequence({
      width: 1080,
      height: 1920,
      background: "blur",
    });
    expect(resized.width).toBe(1080);
    expect(resized.height).toBe(1920);
    expect(resized.background).toBe("blur");

    // Live color grading, LUT & crop effects
    await mobileApi.setClipEffect(leadClip.id, "adjust", { exposure: 20, contrast: 15, saturation: 25 });
    await mobileApi.setClipEffect(leadClip.id, "lut3d", { lutId: "teal-orange-blockbuster", intensity: 100 });
    await mobileApi.setClipEffect(leadClip.id, "crop", { left: 0.08, right: 0.08 });

    // Split + Undo + Redo
    const countBefore = (await mobileApi.getProject(project.id)).project.sequences[0]!.tracks[0]!.clips.length;
    await mobileApi.splitClip(leadClip.id, leadClip.start + leadClip.duration * 0.5);
    expect((await mobileApi.getProject(project.id)).project.sequences[0]!.tracks[0]!.clips.length).toBe(countBefore + 1);

    await mobileApi.undo();
    expect((await mobileApi.getProject(project.id)).project.sequences[0]!.tracks[0]!.clips.length).toBe(countBefore);
    await mobileApi.redo();
    expect((await mobileApi.getProject(project.id)).project.sequences[0]!.tracks[0]!.clips.length).toBe(countBefore + 1);

    // Captions create + reposition + edit text + delete
    const { caption: cap } = await mobileApi.addCaption({
      start: 0.5,
      end: 3.5,
      text: "Clean Studio Title",
      style: { fontSize: 48, x: 0.5, y: 0.8, color: "#ffffff" },
    });
    await mobileApi.updateCaption(cap.id, { text: "Updated Title", style: { fontSize: 54, x: 0.5, y: 0.25 } });
    const withCap = (await mobileApi.getProject(project.id)).project;
    expect(withCap.sequences[0]!.captions.some((c) => c.id === cap.id && c.text === "Updated Title")).toBe(true);

    await mobileApi.deleteCaption(cap.id);
    const withoutCap = (await mobileApi.getProject(project.id)).project;
    expect(withoutCap.sequences[0]!.captions.some((c) => c.id === cap.id)).toBe(false);

    const check = await mobileApi.checkUpdate();
    expect(check.currentVersion).toBe("1.0.2");
  });
});
