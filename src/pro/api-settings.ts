// Persistent Custom API Key, Base URL & Model Configuration for Vedit Desktop (v0.6.0).
// Allows users to connect ANY OpenAI-compatible API endpoint (OpenAI, OpenRouter, DeepSeek,
// NVIDIA NIM, Groq, Together, Ollama, LM Studio, vLLM, or custom enterprise proxy) plus
// optional media generation provider keys — stored safely in `<VEDIT_DATA>/settings/api-config.json`.

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
    label: "OpenAI Official",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    suggestedModels: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "o4-mini"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (All Cloud Models)",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    suggestedModels: [
      "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat",
      "qwen/qwen-2.5-72b-instruct",
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek API",
    baseUrl: "https://api.deepseek.com/v1",
    requiresKey: true,
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM API",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    requiresKey: true,
    suggestedModels: [
      "nvidia/llama-3.3-nemotron-super-49b-v1",
      "meta/llama-3.3-70b-instruct",
      "deepseek-ai/deepseek-v3.1",
    ],
  },
  {
    id: "groq",
    label: "Groq Ultra-Fast LPU",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    suggestedModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen-qwq-32b"],
  },
  {
    id: "ollama",
    label: "Ollama (Local PC — No Key Needed)",
    baseUrl: "http://127.0.0.1:11434/v1",
    requiresKey: false,
    suggestedModels: ["llama3.2", "qwen2.5:14b", "deepseek-r1:8b", "mistral"],
  },
  {
    id: "lmstudio",
    label: "LM Studio (Local PC Server)",
    baseUrl: "http://127.0.0.1:1234/v1",
    requiresKey: false,
    suggestedModels: ["local-model"],
  },
  {
    id: "custom",
    label: "Custom OpenAI-Compatible URL",
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
  model: "gpt-4.1-mini",
  visionModel: "gpt-4.1-mini",
  temperature: 0.2,
  providerKeys: {},
};

let runtimeConfig: StoredApiConfig = { ...DEFAULT_CONFIG };
let activeSettingsPath: string | null = null;

export function maskSecret(secret: string): string {
  const clean = secret.trim();
  if (!clean) return "";
  if (clean.length <= 8) return `${clean.slice(0, 2)}••••••`;
  return `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "https://api.openai.com/v1";
  return trimmed;
}

function applyEnvKeys(cfg: StoredApiConfig): void {
  if (cfg.apiKey.trim()) {
    process.env.OPENAI_API_KEY = cfg.apiKey.trim();
  }
  if (cfg.baseUrl.trim()) {
    process.env.OPENAI_BASE_URL = normalizeBaseUrl(cfg.baseUrl);
  }
  for (const [k, v] of Object.entries(cfg.providerKeys ?? {})) {
    if (typeof v === "string" && v.trim()) {
      process.env[k] = v.trim();
    }
  }
}

export function toPublicApiConfig(cfg: StoredApiConfig = runtimeConfig): PublicApiConfig {
  return {
    providerPreset: cfg.providerPreset || "custom",
    baseUrl: normalizeBaseUrl(cfg.baseUrl),
    hasApiKey: Boolean(cfg.apiKey.trim()),
    maskedApiKey: maskSecret(cfg.apiKey),
    model: cfg.model || "gpt-4.1-mini",
    visionModel: cfg.visionModel || cfg.model || "gpt-4.1-mini",
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0.2,
    configuredProviderKeys: Object.entries(cfg.providerKeys ?? {})
      .filter(([, v]) => Boolean(v?.trim()))
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
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(base);
  return Boolean(cfg.model.trim() && (cfg.apiKey.trim() || isLocal));
}

export async function initApiSettings(dataDir: string): Promise<PublicApiConfig> {
  activeSettingsPath = join(dataDir, "settings", "api-config.json");
  try {
    const raw = await readFile(activeSettingsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredApiConfig>;
    runtimeConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
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
  if (patch.providerPreset !== undefined) next.providerPreset = String(patch.providerPreset);
  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(String(patch.baseUrl));
  if (patch.clearApiKey) {
    next.apiKey = "";
  } else if (typeof patch.apiKey === "string" && patch.apiKey.trim() && !patch.apiKey.includes("••••")) {
    next.apiKey = patch.apiKey.trim();
  }
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
        if (!v.trim()) delete next.providerKeys![k];
        else if (!v.includes("••••")) next.providerKeys![k] = v.trim();
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
  const baseUrl = normalizeBaseUrl(override?.baseUrl || runtimeConfig.baseUrl);
  const rawKey =
    override?.apiKey && !override.apiKey.includes("••••") ? override.apiKey.trim() : runtimeConfig.apiKey.trim();

  const headers: Record<string, string> = { Accept: "application/json" };
  if (rawKey) headers.Authorization = `Bearer ${rawKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const payload = (await res.json()) as { data?: Array<{ id?: string; name?: string }> } | Array<{ id?: string }>;
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    const ids = Array.from(
      new Set(
        list
          .map((m) => String((m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? "").trim())
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
  const baseUrl = normalizeBaseUrl(opts.baseUrl || runtimeConfig.baseUrl);
  const rawKey =
    opts.apiKey && !opts.apiKey.includes("••••") ? opts.apiKey.trim() : runtimeConfig.apiKey.trim();
  const model = (opts.model || runtimeConfig.model || "gpt-4.1-mini").trim();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://vedit.studio",
    "X-Title": "Vedit Studio Desktop",
  };
  if (rawKey) headers.Authorization = `Bearer ${rawKey}`;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? runtimeConfig.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1024,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } | string };
      if (typeof errBody?.error === "string") detail = errBody.error;
      else if (errBody?.error?.message) detail = errBody.error.message;
    } catch {
      /* ignore parse error */
    }
    throw new Error(`API error (${baseUrl}): ${detail}`);
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
}

export async function testApiConnection(override?: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<{ ok: boolean; model: string; baseUrl: string; latencyMs: number; reply: string }> {
  const baseUrl = normalizeBaseUrl(override?.baseUrl || runtimeConfig.baseUrl);
  const result = await callChatCompletion(
    [
      { role: "system", content: "You are Vedit Studio's AI engine check. Reply concisely in under 8 words." },
      { role: "user", content: "Confirm connection status." },
    ],
    {
      baseUrl,
      apiKey: override?.apiKey,
      model: override?.model,
      maxTokens: 32,
      timeoutMs: 15000,
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
