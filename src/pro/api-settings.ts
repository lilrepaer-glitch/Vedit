// Universal Multi-Provider Resilient AI Protocol Engine for Vedit Studio (v0.9.1 / F12).
// Supports OpenAI, Google Gemini, Anthropic Claude, OpenRouter (including `:free`), Groq,
// DeepSeek, NVIDIA NIM, xAI Grok, Ollama, LM Studio, and any custom OpenAI-compatible proxy —
// with strict saved-model priority, automatic cross-provider mismatch recovery, multi-attempt
// backoff + model failover on 429/503, balanced JSON extraction, and message alternation guarantees.

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
    suggestedModels: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"],
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
      "openrouter/free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemini-2.5-flash",
      "anthropic/claude-sonnet-4",
      "deepseek/deepseek-chat",
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
  return /anthropic\.com/i.test(baseUrl) || (sanitizeApiKey(apiKey).startsWith("sk-ant-") && !/openrouter\.ai/i.test(baseUrl));
}

/**
 * Resolves the target Base URL and Model while strictly respecting user-configured values first,
 * and automatically healing cross-provider model leftover mismatches (e.g., `gpt-4o-mini` sent to Gemini/Groq).
 */
export function resolveEndpointAndModel(
  opts: { baseUrl?: string; apiKey?: string; model?: string } | undefined,
  saved: { baseUrl: string; apiKey: string; model: string },
): { apiKey: string; baseUrl: string; model: string; fallbacks: string[] } {
  const apiKey =
    opts?.apiKey && !opts.apiKey.includes("••••")
      ? sanitizeApiKey(opts.apiKey)
      : sanitizeApiKey(saved.apiKey);
  const autoPreset = detectPresetFromKey(apiKey);

  // If saved.baseUrl is still untouched OpenAI default while the key unmistakably belongs to Gemini/Groq/OpenRouter/Anthropic/NVIDIA/xAI, route to that provider
  const savedBaseNorm = normalizeBaseUrl(saved.baseUrl);
  const effectiveSavedBase =
    autoPreset && savedBaseNorm === "https://api.openai.com/v1" && autoPreset.id !== "openai"
      ? autoPreset.baseUrl
      : savedBaseNorm;

  const baseUrl = normalizeBaseUrl(opts?.baseUrl || effectiveSavedBase || autoPreset?.baseUrl || "https://api.openai.com/v1");
  let model = (opts?.model || saved.model || autoPreset?.suggestedModels[0] || "gpt-4o-mini").trim();

  // Heal cross-provider model leftovers without touching valid user models (e.g. OpenRouter `:free` models!)
  if (/api\.openai\.com/i.test(baseUrl) && model.startsWith("openai/")) {
    model = model.slice("openai/".length);
  } else if (/generativelanguage\.googleapis\.com/i.test(baseUrl)) {
    model = model.replace(/^models\//, "").replace(/^google\//, "");
    if (!/^(gemini|gemma|learnlm)/i.test(model)) model = "gemini-2.5-flash";
  } else if (/api\.anthropic\.com/i.test(baseUrl)) {
    model = model.replace(/^anthropic\//, "");
    if (!/^claude/i.test(model)) model = "claude-sonnet-4-20250514";
  } else if (/api\.groq\.com/i.test(baseUrl)) {
    if (/^(gpt-|claude-|gemini-)/i.test(model)) model = "llama-3.3-70b-versatile";
  } else if (/api\.deepseek\.com/i.test(baseUrl)) {
    model = model.replace(/^deepseek\//, "");
    if (!/^deepseek/i.test(model)) model = "deepseek-chat";
  } else if (/api\.x\.ai/i.test(baseUrl)) {
    if (!/^grok/i.test(model)) model = "grok-2-latest";
  }

  // Build resilient same-provider fallback chain in case primary model is rate-limited (429) or overloaded (503)
  const fallbacks: string[] = [model];
  const pushUnique = (m: string) => {
    if (m && !fallbacks.includes(m)) fallbacks.push(m);
  };
  if (/generativelanguage\.googleapis\.com/i.test(baseUrl)) {
    pushUnique("gemini-2.5-flash");
    pushUnique("gemini-2.0-flash");
  } else if (/api\.groq\.com/i.test(baseUrl)) {
    pushUnique("llama-3.3-70b-versatile");
    pushUnique("llama-3.1-8b-instant");
  } else if (/openrouter\.ai/i.test(baseUrl) && (model.endsWith(":free") || model === "openrouter/free")) {
    pushUnique("openrouter/free");
    pushUnique("meta-llama/llama-3.3-70b-instruct:free");
    pushUnique("google/gemma-3-27b-it:free");
  } else if (/api\.openai\.com/i.test(baseUrl)) {
    pushUnique("gpt-4o-mini");
  } else if (/api\.anthropic\.com/i.test(baseUrl)) {
    pushUnique("claude-3-5-haiku-latest");
  } else if (/api\.deepseek\.com/i.test(baseUrl)) {
    pushUnique("deepseek-chat");
  }

  return { apiKey, baseUrl, model, fallbacks };
}

/**
 * Ensures strictly valid chat message arrays across strict providers (Anthropic, Gemini, Mistral, OpenAI):
 * merges consecutive same-role turns and strips empty messages so multi-turn chats NEVER fail with HTTP 400.
 */
export function sanitizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const systems: string[] = [];
  const convo: ChatMessage[] = [];
  for (const m of messages) {
    const text = typeof m?.content === "string" ? m.content.trim() : String(m?.content ?? "").trim();
    if (!text) continue;
    if (m.role === "system") {
      systems.push(text);
      continue;
    }
    const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
    const prev = convo[convo.length - 1];
    if (prev && prev.role === role) {
      prev.content = `${prev.content}\n\n${text}`;
    } else {
      convo.push({ role, content: text });
    }
  }
  if (convo.length > 0 && convo[0]!.role === "assistant") {
    convo.shift();
  }
  if (convo.length === 0) {
    convo.push({ role: "user", content: "OK" });
  }
  return systems.length > 0 ? [{ role: "system", content: systems.join("\n\n") }, ...convo] : convo;
}

function parseRawSseOrJsonText(rawText: string): { text: string; model?: string } {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("data:") || /\ndata:\s*\{/.test(trimmed)) {
    let content = "";
    let reasoning = "";
    let model: string | undefined;
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      try {
        const ev = JSON.parse(p) as {
          model?: string;
          delta?: { text?: string };
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
        };
        if (!model && ev.model) model = ev.model;
        if (ev.delta?.text) content += ev.delta.text;
        const d = ev.choices?.[0]?.delta;
        if (d?.content) content += d.content;
        if (d?.reasoning_content) reasoning += d.reasoning_content;
        else if (d?.reasoning) reasoning += d.reasoning;
      } catch {
        /* ignore partial SSE frame */
      }
    }
    return { text: (content || reasoning).trim(), model };
  }
  const data = JSON.parse(trimmed) as { model?: string };
  return { text: extractAssistantContent(data), model: data.model };
}
export function extractAssistantContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const root = payload as {
    content?: unknown;
    choices?: Array<{
      message?: { content?: unknown; reasoning_content?: string; reasoning?: string };
      text?: string;
    }>;
  };
  const msg = root.choices?.[0]?.message;
  const rawContent = msg?.content ?? root.content;
  if (typeof rawContent === "string" && rawContent.trim()) {
    return rawContent.trim();
  }
  if (Array.isArray(rawContent)) {
    const joined = rawContent
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: string };
          if (p.type === "thinking") return "";
          return typeof p.text === "string" ? p.text : "";
        }
        return "";
      })
      .join("")
      .trim();
    if (joined) return joined;
  }
  if (typeof root.choices?.[0]?.text === "string" && root.choices[0].text.trim()) {
    return root.choices[0].text.trim();
  }
  const reasoningFallback = msg?.reasoning_content || msg?.reasoning || "";
  return typeof reasoningFallback === "string" ? reasoningFallback.trim() : "";
}

/** Repairs unescaped literal control characters inside JSON strings & trailing commas. */
function normalizeLooseJsonCandidate(src: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr) {
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") continue;
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
    }
    out += ch;
  }
  // Close dangling open string/brackets if truncated by token limit
  if (inStr) out += '"';
  return out.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Crash-proof balanced JSON extractor for LLM outputs:
 * - Strips `<think>...</think>` reasoning blocks and markdown code fences first
 * - Finds balanced `{ ... }` objects from the end so `{...}` inside explanations never corrupts parsing
 * - Auto-repairs raw newlines inside JSON strings, trailing commas, and truncated closing brackets
 * - Never throws under any input!
 */
export function parseAiJsonSafe<T = Record<string, unknown>>(raw: string): T | null {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1")
    .trim();

  if (!cleaned) return null;

  // Collect all balanced `{ ... }` spans
  const candidates: string[] = [];
  const starts: number[] = [];
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") {
      starts.push(i);
    } else if (ch === "}" && starts.length > 0) {
      const openIdx = starts.pop()!;
      if (starts.length === 0) {
        candidates.push(cleaned.slice(openIdx, i + 1));
      }
    }
  }

  // If truncated mid-object (`starts.length > 0`), build a bracket-closed repair candidate too!
  if (starts.length > 0) {
    let tail = normalizeLooseJsonCandidate(cleaned.slice(starts[0]!));
    // Re-count open `{` and `[` outside strings and close them cleanly
    const stack: string[] = [];
    let sIn = false;
    let sEsc = false;
    for (let i = 0; i < tail.length; i++) {
      const c = tail[i]!;
      if (sEsc) {
        sEsc = false;
        continue;
      }
      if (c === "\\" && sIn) {
        sEsc = true;
        continue;
      }
      if (c === '"') {
        sIn = !sIn;
        continue;
      }
      if (sIn) continue;
      if (c === "{") stack.push("}");
      else if (c === "[") stack.push("]");
      else if ((c === "}" || c === "]") && stack.length > 0) stack.pop();
    }
    tail = tail.replace(/,\s*$/, "") + stack.reverse().join("");
    candidates.push(tail);
  }

  // Try parsing from the last complete top-level `{...}` backwards
  for (let i = candidates.length - 1; i >= 0; i--) {
    const cand = candidates[i]!;
    try {
      return JSON.parse(cand) as T;
    } catch {
      try {
        return JSON.parse(normalizeLooseJsonCandidate(cand)) as T;
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
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
  const { apiKey: rawKey, baseUrl } = resolveEndpointAndModel(override, runtimeConfig);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (isAnthropicEndpoint(baseUrl, rawKey)) {
    if (rawKey) headers["x-api-key"] = rawKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (rawKey) {
    headers.Authorization = `Bearer ${rawKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 16000);
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

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callChatCompletion(
  rawMessages: ChatMessage[],
  opts: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    fastReasoning?: boolean;
  } = {},
): Promise<{ content: string; model: string; latencyMs: number }> {
  const { apiKey: rawKey, baseUrl, fallbacks } = resolveEndpointAndModel(opts, runtimeConfig);
  const messages = sanitizeChatMessages(rawMessages);
  const maxTokens = opts.maxTokens ?? 4096;

  const started = Date.now();
  let lastError: Error | null = null;

  for (let modelIdx = 0; modelIdx < fallbacks.length; modelIdx++) {
    const candidateModel = fallbacks[modelIdx]!;
    const maxAttempts = modelIdx === 0 ? 2 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const perChunkTimeout = opts.timeoutMs ?? 180000;
      let timer = setTimeout(() => controller.abort(), perChunkTimeout);
      try {
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
              model: candidateModel,
              max_tokens: maxTokens,
              ...(systemText ? { system: systemText } : {}),
              messages: userTurns.length ? userTurns : [{ role: "user", content: "OK" }],
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const rawErr = await res.text().catch(() => "");
            if ((res.status === 429 || res.status >= 500 || res.status === 404) && (attempt + 1 < maxAttempts || modelIdx + 1 < fallbacks.length)) {
              lastError = new Error(`Anthropic HTTP ${res.status}: ${rawErr.slice(0, 160)}`);
              if (attempt + 1 < maxAttempts) await sleepMs(750 * (attempt + 1));
              continue;
            }
            let detail = `HTTP ${res.status}`;
            try {
              const j = JSON.parse(rawErr) as { error?: { message?: string } };
              detail = j?.error?.message || detail;
            } catch {
              if (rawErr.trim()) detail = rawErr.slice(0, 180);
            }
            throw new Error(`Anthropic API error: ${detail}`);
          }
          const data = (await res.json()) as { model?: string; content?: Array<{ text?: string }> };
          return {
            content: extractAssistantContent(data),
            model: data.model || candidateModel,
            latencyMs: Date.now() - started,
          };
        }

        // OpenAI-compatible `/chat/completions` — ONLY attach OpenRouter headers for openrouter.ai!
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        const isOpenRouter = /openrouter\.ai/i.test(baseUrl);
        const isGemini = /generativelanguage\.googleapis\.com/i.test(baseUrl);
        if (isOpenRouter) {
          headers["HTTP-Referer"] = "https://vedit.studio";
          headers["X-Title"] = "Vedit Studio";
        }
        if (rawKey) headers.Authorization = `Bearer ${rawKey}`;

        const isReasoningModel = /^(o1|o3|o4|gpt-5|deepseek-reasoner|qwq)/i.test(candidateModel);
        const wantLowReasoning = opts.fastReasoning !== false;
        const buildPayload = (compatMode: boolean) => {
          if (compatMode) {
            return {
              model: candidateModel,
              messages,
              max_completion_tokens: maxTokens,
            };
          }
          const base: Record<string, unknown> = isReasoningModel
            ? {
                model: candidateModel,
                messages,
                max_completion_tokens: maxTokens,
                stream: true,
              }
            : {
                model: candidateModel,
                messages,
                temperature: opts.temperature ?? runtimeConfig.temperature ?? 0.2,
                max_tokens: maxTokens,
                stream: true,
              };
          if (wantLowReasoning) {
            if (isOpenRouter) {
              base.reasoning = { effort: "low" };
            } else if (isGemini || isReasoningModel) {
              base.reasoning_effort = "low";
            }
          }
          return base;
        };

        let res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(buildPayload(false)),
          signal: controller.signal,
        });

        if (res.status === 400) {
          const errPreview = await res.clone().text().catch(() => "");
          if (/max_tokens|max_completion_tokens|temperature|reasoning|thinking|stream|unknown|unsupported/i.test(errPreview)) {
            res = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers,
              body: JSON.stringify(buildPayload(true)),
              signal: controller.signal,
            });
          }
        }

        if (!res.ok) {
          const rawErr = await res.text().catch(() => "");
          const retryable =
            res.status === 429 ||
            res.status === 408 ||
            res.status === 404 ||
            res.status === 402 ||
            res.status >= 500;
          let detail = `HTTP ${res.status} ${res.statusText}`;
          try {
            const errBody = JSON.parse(rawErr) as { error?: { message?: string } | string; message?: string };
            if (typeof errBody?.error === "string") detail = errBody.error;
            else if (errBody?.error?.message) detail = errBody.error.message;
            else if (errBody?.message) detail = errBody.message;
          } catch {
            if (rawErr.trim()) detail = rawErr.slice(0, 180);
          }
          lastError = new Error(`${detail} (${candidateModel})`);
          if (retryable && (attempt + 1 < maxAttempts || modelIdx + 1 < fallbacks.length)) {
            if (attempt + 1 < maxAttempts) await sleepMs(750 * (attempt + 1));
            continue;
          }
          throw lastError;
        }

        let rawBodyText = "";
        if (res.body) {
          const reader = res.body.getReader();
          const dec = new TextDecoder("utf-8");
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(), perChunkTimeout);
            rawBodyText += dec.decode(value, { stream: true });
          }
          rawBodyText += dec.decode();
        } else {
          rawBodyText = await res.text();
        }
        const parsedOut = parseRawSseOrJsonText(rawBodyText);
        return {
          content: parsedOut.text,
          model: parsedOut.model || candidateModel,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isNetErr = /fetch|network|socket|econnreset|etimedout|abort/i.test(lastError.message);
        if (isNetErr && attempt + 1 < maxAttempts) {
          await sleepMs(600 * (attempt + 1));
          continue;
        }
        if (!isNetErr && modelIdx + 1 >= fallbacks.length) {
          throw lastError;
        }
      } finally {
        clearTimeout(timer);
      }
    }
  }

  throw lastError ?? new Error("AI request failed");
}

export async function testApiConnection(override?: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<{ ok: boolean; model: string; baseUrl: string; latencyMs: number; reply: string }> {
  const { apiKey: rawKey, baseUrl, model } = resolveEndpointAndModel(override, runtimeConfig);
  const result = await callChatCompletion([{ role: "user", content: "Reply with the single word: OK" }], {
    baseUrl,
    apiKey: rawKey,
    model,
    maxTokens: 256,
    timeoutMs: 25000,
  });
  return {
    ok: true,
    model: result.model,
    baseUrl,
    latencyMs: result.latencyMs,
    reply: result.content || "OK",
  };
}
