// Universal Multi-Provider API Settings & Protocol Engine for Vedit Studio (v0.8.0).
// Supports OpenAI, Google Gemini, Anthropic Claude, OpenRouter, Groq, DeepSeek,
// NVIDIA NIM, xAI Grok, Ollama, LM Studio, and any custom OpenAI-compatible proxy —
// with automatic API key prefix detection, URL sanitization, native Anthropic `/v1/messages`
// support, and reasoning-model (`o1`/`o3`/`o4`/`gpt-5`) parameter compatibility.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ApiPresetInfo {
  id: string;
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  suggestedModels: string[];
}

export const API_PROVIDER_PRESETS: ApiPresetInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    suggestedModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"],
  },
  {
    id: "gemini",
    label: "Google Gemini (AI Studio)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresKey: true,
    suggestedModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true,
    suggestedModels: ["claude-sonnet-4-20250514", "claude-3-5-haiku-latest", "claude-3-7-sonnet-latest"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    suggestedModels: [
      "openai/gpt-4o-mini",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.3-70b-instruct",
    ],
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    suggestedModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen-qwq-32b"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    requiresKey: true,
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    requiresKey: true,
    suggestedModels: [
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.3-nemotron-super-49b-v1",
      "deepseek-ai/deepseek-v3.1",
    ],
  },
  {
    id: "xai",
    label: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    requiresKey: true,
    suggestedModels: ["grok-2-latest", "grok-3-mini-beta"],
  },
  {
    id: "ollama",
    label: "Ollama (Local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    requiresKey: false,
    suggestedModels: ["llama3.2", "qwen2.5:14b", "deepseek-r1:8b", "mistral"],
  },
  {
    id: "lmstudio",
    label: "LM Studio (Local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    requiresKey: false,
    suggestedModels: ["local-model"],
  },
  {
    id: "custom",
    label: "Custom Endpoint",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    suggestedModels: [],
  },
];

export interface StoredApiConfig {
  providerPreset: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
  temperature?: number;
  providerKeys?: Record<string, string>;
  updatedAt?: string;
}

export interface PublicApiConfig {
  providerPreset: string;
  baseUrl: string;
  hasApiKey: boolean;
  maskedApiKey: string;
  model: string;
  visionModel: string;
  temperature: number;
  configuredProviderKeys: string[];
  updatedAt?: string;
  presets: ApiPresetInfo[];
}

const DEFAULT_CONFIG: StoredApiConfig = {
  providerPreset: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  visionModel: "gpt-4o-mini",
  temperature: 0.2,
  providerKeys: {},
};

let runtimeConfig: StoredApiConfig = { ...DEFAULT_CONFIG };
let activeSettingsPath: string | null = null;

export function sanitizeApiKey(raw?: string): string {
  if (!raw) return "";
  return raw
    .replace(/[\u200B-\u200D\uFEFF\u00A0\r\n\t]/g, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .replace(/^[A-Z0-9_]*API_KEY\s*=\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/\s+/g, "");
}

export function detectPresetFromKey(apiKey: string): ApiPresetInfo | null {
  const k = sanitizeApiKey(apiKey);
  if (!k) return null;
  if (k.startsWith("sk-or-")) return API_PROVIDER_PRESETS.find((p) => p.id === "openrouter") ?? null;
  if (k.startsWith("sk-ant-")) return API_PROVIDER_PRESETS.find((p) => p.id === "anthropic") ?? null;
  if (k.startsWith("AIza")) return API_PROVIDER_PRESETS.find((p) => p.id === "gemini") ?? null;
  if (k.startsWith("gsk_")) return API_PROVIDER_PRESETS.find((p) => p.id === "groq") ?? null;
  if (k.startsWith("nvapi-")) return API_PROVIDER_PRESETS.find((p) => p.id === "nvidia") ?? null;
  if (k.startsWith("xai-")) return API_PROVIDER_PRESETS.find((p) => p.id === "xai") ?? null;
  return null;
}

export function maskSecret(secret: string): string {
  const clean = sanitizeApiKey(secret);
  if (!clean) return "";
  if (clean.length <= 8) return `${clean.slice(0, 2)}••••••`;
  return `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
}

export function normalizeBaseUrl(raw: string): string {
  let u = (raw || "").trim().replace(/\s+/g, "").replace(/\/+$/, "");
  if (!u) return "https://api.openai.com/v1";
  if (!/^https?:\/\//i.test(u)) {
    const isPrivate = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u);
    u = `${isPrivate ? "http" : "https"}://${u}`;
  }
  u = u.replace(/\/(chat\/completions|messages|completions|models)$/i, "");
  if (/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)[^/]+$/i.test(u)) {
    return `${u}/v1`;
  }
  if (!u) return "https://api.openai.com/v1";
  // Strip accidentally pasted terminal paths
  u = u.replace(/\/(chat\/completions|messages|completions|models)$/i, "");
  if (/^https?:\/\/generativelanguage\.googleapis\.com(\/v1beta)?$/i.test(u)) {
    return "https://generativelanguage.googleapis.com/v1beta/openai";
  }
  if (/^https?:\/\/(api\.openai\.com|api\.deepseek\.com|api\.anthropic\.com|api\.mistral\.ai|api\.x\.ai|api\.together\.xyz)$/i.test(u)) {
    return `${u}/v1`;
  }
  if (/^https?:\/\/api\.groq\.com$/i.test(u)) {
    return "https://api.groq.com/openai/v1";
  }
  if (/^https?:\/\/openrouter\.ai(\/api)?$/i.test(u)) {
    return "https://openrouter.ai/api/v1";
  }
  return u;
}

function isAnthropicEndpoint(baseUrl: string, apiKey: string): boolean {
  return /anthropic\.com/i.test(baseUrl) || sanitizeApiKey(apiKey).startsWith("sk-ant-");
}

function applyEnvKeys(cfg: StoredApiConfig): void {
  const cleanKey = sanitizeApiKey(cfg.apiKey);
  if (cleanKey) {
    process.env.OPENAI_API_KEY = cleanKey;
    if (cleanKey.startsWith("AIza")) process.env.GOOGLE_API_KEY = cleanKey;
  }
  if (cfg.baseUrl.trim()) {
    process.env.OPENAI_BASE_URL = normalizeBaseUrl(cfg.baseUrl);
  }
  for (const [k, v] of Object.entries(cfg.providerKeys ?? {})) {
    if (typeof v === "string" && sanitizeApiKey(v)) {
      process.env[k] = sanitizeApiKey(v);
    }
  }
}

export function toPublicApiConfig(cfg: StoredApiConfig = runtimeConfig): PublicApiConfig {
  return {
    providerPreset: cfg.providerPreset || "custom",
    baseUrl: normalizeBaseUrl(cfg.baseUrl),
    hasApiKey: Boolean(sanitizeApiKey(cfg.apiKey)),
    maskedApiKey: maskSecret(cfg.apiKey),
    model: cfg.model || "gpt-4o-mini",
    visionModel: cfg.visionModel || cfg.model || "gpt-4o-mini",
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0.2,
    configuredProviderKeys: Object.entries(cfg.providerKeys ?? {})
      .filter(([, v]) => Boolean(sanitizeApiKey(v)))
      .map(([k]) => k),
    updatedAt: cfg.updatedAt,
    presets: API_PROVIDER_PRESETS,
  };
}

export function getRuntimeApiConfig(): StoredApiConfig {
  return { ...runtimeConfig, providerKeys: { ...(runtimeConfig.providerKeys ?? {}) } };
}

export function isLlmEndpointConfigured(cfg: StoredApiConfig = runtimeConfig): boolean {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|192\.168\.|10\.|172\.)/i.test(base);
  return Boolean(cfg.model.trim() && (sanitizeApiKey(cfg.apiKey) || isLocal));
}

export async function initApiSettings(dataDir: string): Promise<PublicApiConfig> {
  activeSettingsPath = join(dataDir, "settings", "api-config.json");
  try {
    const raw = await readFile(activeSettingsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredApiConfig>;
    runtimeConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      apiKey: sanitizeApiKey(parsed.apiKey),
      baseUrl: normalizeBaseUrl(parsed.baseUrl ?? DEFAULT_CONFIG.baseUrl),
      providerKeys: { ...(parsed.providerKeys ?? {}) },
    };
    applyEnvKeys(runtimeConfig);
  } catch {
    applyEnvKeys(runtimeConfig);
  }
  return toPublicApiConfig(runtimeConfig);
}

export async function saveApiSettings(
  patch: Partial<{
    providerPreset: string;
    baseUrl: string;
    apiKey: string;
    clearApiKey: boolean;
    model: string;
    visionModel: string;
    temperature: number;
    providerKeys: Record<string, string>;
  }>,
  dataDir?: string,
): Promise<PublicApiConfig> {
  if (dataDir && !activeSettingsPath) {
    activeSettingsPath = join(dataDir, "settings", "api-config.json");
  }
  const next: StoredApiConfig = {
    ...runtimeConfig,
    providerKeys: { ...(runtimeConfig.providerKeys ?? {}) },
  };

  if (patch.clearApiKey) {
    next.apiKey = "";
  } else if (typeof patch.apiKey === "string" && patch.apiKey.trim() && !patch.apiKey.includes("••••")) {
    next.apiKey = sanitizeApiKey(patch.apiKey);
    const detected = detectPresetFromKey(next.apiKey);
    if (detected && !patch.baseUrl) {
      next.providerPreset = detected.id;
      next.baseUrl = detected.baseUrl;
      if (!patch.model && detected.suggestedModels[0]) {
        next.model = detected.suggestedModels[0];
      }
    }
  }

  if (patch.providerPreset !== undefined) next.providerPreset = String(patch.providerPreset);
  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(String(patch.baseUrl));
  if (patch.model !== undefined && String(patch.model).trim()) {
    next.model = String(patch.model).trim();
  }
  if (patch.visionModel !== undefined) {
    next.visionModel = String(patch.visionModel).trim() || next.model;
  }
  if (typeof patch.temperature === "number" && Number.isFinite(patch.temperature)) {
    next.temperature = Math.max(0, Math.min(2, patch.temperature));
  }
  if (patch.providerKeys && typeof patch.providerKeys === "object") {
    for (const [k, v] of Object.entries(patch.providerKeys)) {
      if (typeof v === "string") {
        const clean = sanitizeApiKey(v);
        if (!clean) delete next.providerKeys![k];
        else if (!v.includes("••••")) next.providerKeys![k] = clean;
      }
    }
  }
  next.updatedAt = new Date().toISOString();
  runtimeConfig = next;
  applyEnvKeys(runtimeConfig);

  if (activeSettingsPath) {
    await mkdir(dirname(activeSettingsPath), { recursive: true });
    await writeFile(activeSettingsPath, JSON.stringify(runtimeConfig, null, 2), { mode: 0o600 });
  }
  return toPublicApiConfig(runtimeConfig);
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function fetchRemoteModels(override?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<{ models: string[]; source: "remote" | "preset"; baseUrl: string }> {
  const rawKey =
    override?.apiKey && !override.apiKey.includes("••••")
      ? sanitizeApiKey(override.apiKey)
      : sanitizeApiKey(runtimeConfig.apiKey);
  const autoPreset = detectPresetFromKey(rawKey);
  const baseUrl = normalizeBaseUrl(override?.baseUrl || autoPreset?.baseUrl || runtimeConfig.baseUrl);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (isAnthropicEndpoint(baseUrl, rawKey)) {
    if (rawKey) headers["x-api-key"] = rawKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (rawKey) {
    headers.Authorization = `Bearer ${rawKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14000);
  try {
    const res = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
    if (!res.ok) {
      let msg = `HTTP ${res.status} ${res.statusText}`;
      try {
        const errJson = (await res.json()) as { error?: { message?: string } | string };
        msg = typeof errJson?.error === "string" ? errJson.error : errJson?.error?.message || msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const payload = (await res.json()) as
      | { data?: Array<{ id?: string; name?: string }>; models?: Array<{ name?: string; id?: string }> }
      | Array<{ id?: string; name?: string }>;
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : [];
    const ids = Array.from(
      new Set(
        list
          .map((m) =>
            String(m.id ?? m.name ?? "")
              .trim()
              .replace(/^models\//, ""),
          )
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));
    return { models: ids, source: "remote", baseUrl };
  } finally {
    clearTimeout(timer);
  }
}

export async function callChatCompletion(
  messages: ChatMessage[],
  opts: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  } = {},
): Promise<{ content: string; model: string; latencyMs: number }> {
  const rawKey =
    opts.apiKey && !opts.apiKey.includes("••••")
      ? sanitizeApiKey(opts.apiKey)
      : sanitizeApiKey(runtimeConfig.apiKey);
  const autoPreset = detectPresetFromKey(rawKey);
  const baseUrl = normalizeBaseUrl(opts.baseUrl || autoPreset?.baseUrl || runtimeConfig.baseUrl);
  let model = (opts.model || autoPreset?.suggestedModels[0] || runtimeConfig.model || "gpt-4o-mini").trim();

  // Strip OpenRouter `openai/` prefix when talking directly to api.openai.com
  if (/api\.openai\.com/i.test(baseUrl) && model.startsWith("openai/")) {
    model = model.slice("openai/".length);
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 35000);

  try {
    // Native Anthropic `/v1/messages` support
    if (isAnthropicEndpoint(baseUrl, rawKey)) {
      const systemText = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const userTurns = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      const anthropicBase = baseUrl.replace(/\/openai$/i, "");
      const res = await fetch(`${anthropicBase}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": rawKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 1024,
          ...(systemText ? { system: systemText } : {}),
          messages: userTurns.length ? userTurns : [{ role: "user", content: "Hello" }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          detail = j?.error?.message || detail;
        } catch {
          /* ignore */
        }
        throw new Error(`Anthropic API error: ${detail}`);
      }
      const data = (await res.json()) as { model?: string; content?: Array<{ text?: string }> };
      return {
        content: (data.content ?? []).map((c) => c.text ?? "").join("").trim(),
        model: data.model || model,
        latencyMs: Date.now() - started,
      };
    }

    // Standard OpenAI-compatible `/chat/completions` with automatic reasoning-model retry
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "HTTP-Referer": "https://vedit.studio",
      "X-Title": "Vedit Studio",
    };
    if (rawKey) headers.Authorization = `Bearer ${rawKey}`;

    const isReasoningModel = /^(o1|o3|o4|gpt-5)/i.test(model);
    const buildPayload = (compatMode: boolean) =>
      compatMode || isReasoningModel
        ? {
            model,
            messages,
            max_completion_tokens: opts.maxTokens ?? 1024,
          }
        : {
            model,
            messages,
            temperature: opts.temperature ?? runtimeConfig.temperature ?? 0.2,
            max_tokens: opts.maxTokens ?? 1024,
          };

    let res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildPayload(false)),
      signal: controller.signal,
    });

    if (res.status === 400 && !isReasoningModel) {
      const errPreview = await res.clone().text().catch(() => "");
      if (/max_tokens|max_completion_tokens|temperature/i.test(errPreview)) {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(buildPayload(true)),
          signal: controller.signal,
        });
      }
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status} ${res.statusText}`;
      try {
        const errBody = (await res.json()) as { error?: { message?: string } | string };
        if (typeof errBody?.error === "string") detail = errBody.error;
        else if (errBody?.error?.message) detail = errBody.error.message;
      } catch {
        /* ignore */
      }
      throw new Error(`${detail} (${baseUrl})`);
    }

    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    return {
      content,
      model: data.model || model,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function testApiConnection(override?: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<{ ok: boolean; model: string; baseUrl: string; latencyMs: number; reply: string }> {
  const rawKey =
    override?.apiKey && !override.apiKey.includes("••••")
      ? sanitizeApiKey(override.apiKey)
      : sanitizeApiKey(runtimeConfig.apiKey);
  const autoPreset = detectPresetFromKey(rawKey);
  const baseUrl = normalizeBaseUrl(override?.baseUrl || autoPreset?.baseUrl || runtimeConfig.baseUrl);
  const result = await callChatCompletion(
    [{ role: "user", content: "Reply with: OK" }],
    {
      baseUrl,
      apiKey: rawKey,
      model: override?.model,
      maxTokens: 32,
      timeoutMs: 20000,
    },
  );
  return {
    ok: true,
    model: result.model,
    baseUrl,
    latencyMs: result.latencyMs,
    reply: result.content || "Connected",
  };
}
