import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { VeditEngine } from "../src/core/engine.js";
import {
  extractAssistantContent,
  parseAiJsonSafe,
  resolveEndpointAndModel,
  sanitizeChatMessages,
  saveApiSettings,
} from "../src/pro/api-settings.js";
import { runStudioCopilot } from "../src/ai/orchestrator.js";
import { mobileApi, parseMobileAiJsonSafe } from "../apps/desktop/src/mobileRuntime.js";

describe("F12 — Bulletproof Multi-Turn AI Engine Reliability (v0.9.1): Zero Errors Across Repeated Real-World AI Usage", () => {
  let mockServer: Server;
  let mockBaseUrl: string;
  let requestCounter = 0;
  const receivedModels: string[] = [];
  const receivedHeaders: Array<Record<string, string | string[] | undefined>> = [];

  beforeAll(async () => {
    mockServer = createServer((req, res) => {
      let rawBody = "";
      req.on("data", (c: Buffer) => {
        rawBody += c.toString("utf8");
      });
      req.on("end", () => {
        requestCounter += 1;
        receivedHeaders.push(req.headers);
        const body = rawBody ? (JSON.parse(rawBody) as { model?: string; messages?: Array<{ role: string; content: string }> }) : {};
        receivedModels.push(String(body.model ?? ""));

        // Verify strict role alternation on EVERY SINGLE CALL!
        const nonSystem = (body.messages ?? []).filter((m) => m.role !== "system");
        for (let i = 1; i < nonSystem.length; i++) {
          if (nonSystem[i]!.role === nonSystem[i - 1]!.role) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Roles must strictly alternate between user and assistant!" } }));
            return;
          }
        }

        // Chaos Monkey simulation across consecutive real-world AI uses:
        // Call #2 simulates transient 429 rate-limit -> should automatically recover on retry without error!
        if (requestCounter === 2) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Rate limit exceeded, retry shortly" } }));
          return;
        }
        // Call #4 returns DeepSeek `<think>{internal braces}</think>` + markdown fence + raw newline inside string!
        if (requestCounter === 4) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              model: body.model,
              choices: [
                {
                  message: {
                    content:
                      '<think>Analyzing {timeline} & user intent...</think>\n```json\n{"reply":"Upravil jsem barvy i S-křivku\\npodle požadavku.","actions":[{"op":"curves","preset":"cinema-s-curve","clarity":14},{"op":"eq","preset":"voice-podcast"},]}\n```',
                  },
                },
              ],
            }),
          );
          return;
        }
        // Call #6 returns truncated mid-JSON output (`finish_reason: "length"`)!
        if (requestCounter === 6) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              model: body.model,
              choices: [
                {
                  finish_reason: "length",
                  message: {
                    content: '{"reply":"Přepnuto na 9:16 Reels a přidán titulek","actions":[{"op":"aspect","ratio":"9:16"},{"op":"add_caption","text":"Ahoj světe","start":0.2,"duration":2.5}',
                  },
                },
              ],
            }),
          );
          return;
        }
        // Call #8 returns multimodal content array parts (`[{ type: "thinking" }, { type: "text" }]`)!
        if (requestCounter === 8) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              model: body.model,
              choices: [
                {
                  message: {
                    content: [
                      { type: "thinking", text: "Let me check {clip}..." },
                      {
                        type: "text",
                        text: '{"reply":"Hotovo, klíčování zeleného plátna aktivní.","actions":[{"op":"chroma_key","color":"#00ff00","similarity":0.34}]}',
                      },
                    ],
                  },
                },
              ],
            }),
          );
          return;
        }
        // Call #10 returns plain conversational Czech prose (zero JSON at all — user asked a question)!
        if (requestCounter === 10) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              model: body.model,
              choices: [
                {
                  message: {
                    content: "Pro rozdělení klipu na pozici přehrávače stiskni klávesu S nebo klikni na Split.",
                  },
                },
              ],
            }),
          );
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: body.model,
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply: `Krok #${requestCounter} dokončen úspěšně.`,
                    actions: [{ op: "adjust", contrast: 12, saturation: 8 }],
                  }),
                },
              },
            ],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (mockServer.address() as AddressInfo).port;
    mockBaseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  afterAll(async () => {
    await saveApiSettings({ clearApiKey: true, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it("never clobbers user-saved custom models (`:free` OpenRouter, custom Gemini/Groq models) on subsequent AI uses", () => {
    const openRouterResolved = resolveEndpointAndModel(undefined, {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-v1-abc123456789",
      model: "google/gemma-3-27b-it:free",
    });
    expect(openRouterResolved.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(openRouterResolved.model).toBe("google/gemma-3-27b-it:free");
    expect(openRouterResolved.fallbacks[0]).toBe("google/gemma-3-27b-it:free");

    // Heals leftover `gpt-4o-mini` if user pasted a Gemini key against default OpenAI URL
    const healedGemini = resolveEndpointAndModel(undefined, {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "AIzaSyTestKey123456789",
      model: "gpt-4o-mini",
    });
    expect(healedGemini.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(healedGemini.model).toBe("gemini-2.5-flash");

    // Strictly sanitizes consecutive user/user messages so Anthropic & Gemini never reject multi-turn history
    const sanitized = sanitizeChatMessages([
      { role: "system", content: "Sys A" },
      { role: "user", content: "First prompt" },
      { role: "user", content: "Second prompt after cancelled turn" },
      { role: "assistant", content: "Reply 1" },
      { role: "assistant", content: "Reply 2" },
      { role: "user", content: "Third prompt" },
    ]);
    expect(sanitized.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("survives 10 consecutive Desktop AI Copilot turns through 429 rate limits, <think> tags, truncated JSON, array content & prose", async () => {
    await saveApiSettings({
      providerPreset: "custom",
      baseUrl: mockBaseUrl,
      apiKey: "sk-or-v1-custom-free-user-key",
      model: "deepseek/deepseek-r1:free",
    });

    const engine = new VeditEngine(VeditEngine.createProject("AI Stress Test"));
    const tr = engine.addTrack("video", "V1");
    const asset = engine.addAsset({ name: "clip.mp4", kind: "video", path: "/tmp/nonexistent.mp4", duration: 6 });
    const clip = engine.addClip({ trackId: tr.id, assetId: asset.id, start: 0, duration: 6 });

    const history: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (let turn = 1; turn <= 10; turn++) {
      const prompt = `Turn ${turn}: uprav video prosím`;
      const res = await runStudioCopilot(engine, prompt, {
        playhead: 1.5,
        selectedClipId: clip.id,
        history,
      });
      expect(res.summary.length).toBeGreaterThan(0);
      history.push({ role: "user", text: prompt });
      history.push({ role: "assistant", text: res.summary });
    }

    // Every single call preserved the user's exact selected model (`deepseek/deepseek-r1:free`) AND clean headers!
    expect(receivedModels.every((m) => m === "deepseek/deepseek-r1:free")).toBe(true);
    expect(receivedHeaders.every((h) => h["http-referer"] === undefined)).toBe(true);

    // Verify F12 effects & captions actually landed on the clip/sequence across those turns
    expect(clip.effects.some((e) => e.type === "curves")).toBe(true);
    expect(clip.effects.some((e) => e.type === "eq")).toBe(true);
    expect(clip.effects.some((e) => e.type === "chroma-key")).toBe(true);
    expect(engine.activeSequence().captions.some((c) => c.text === "Ahoj světe")).toBe(true);
  });

  it("executes non-blocking Android async thread-pool bridge (`httpRequestAsync`) with full UTF-8 Czech diacritics across repeated calls", async () => {
    (globalThis as Record<string, unknown>).window = {
      ...(globalThis.window ?? {}),
      VeditAndroid: {
        httpRequestAsync(reqId: string, _method: string, _url: string, _headers: string, body: string) {
          const parsedBody = JSON.parse(body || "{}") as { model?: string };
          setTimeout(() => {
            const payload = JSON.stringify({
              ok: true,
              status: 200,
              body: JSON.stringify({
                model: parsedBody.model,
                choices: [
                  {
                    message: {
                      content:
                        '<think>{check}</think>{"reply":"Hotovo! Přidány české titulky s diakritikou: Příliš žluťoučký kůň úpěl ďábelské ódy.","actions":[{"op":"curves","preset":"cinema-s-curve"},{"op":"caption","text":"Příliš žluťoučký kůň","start":0.4,"end":3.2}]}',
                    },
                  },
                ],
              }),
            });
            const b64 = Buffer.from(payload, "utf8").toString("base64");
            const win = globalThis.window as { __veditResolveHttp?: (id: string, data: string) => void };
            win.__veditResolveHttp?.(reqId, b64);
          }, 5);
        },
      },
    };
    await mobileApi.saveApiSettings({
      providerPreset: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-v1-mobiletest",
      model: "meta-llama/llama-3.3-70b-instruct:free",
    });

    for (let i = 0; i < 5; i++) {
      const mobRes = await mobileApi.runCopilot(`Mobilní úprava #${i + 1}: přidej české titulky a křivku`);
      expect(mobRes.summary).toContain("Příliš žluťoučký kůň");
    }

    expect(extractAssistantContent({ choices: [{ message: { content: null, reasoning_content: " fallback " } }] })).toBe("fallback");
    expect(parseAiJsonSafe("plain conversational answer without json")).toBeNull();
    expect(parseMobileAiJsonSafe("plain conversational answer without json")).toBeNull();
  });
});
