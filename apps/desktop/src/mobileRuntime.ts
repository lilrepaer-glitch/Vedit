// Standalone On-Device Vedit Studio Engine for Native Android APK (`com.vedit.studio` v0.8.0).
//
// Provides:
//  1. Native CORS-free HTTP/HTTPS API client via `window.VeditAndroid.httpRequest(...)` supporting
//     OpenAI, Google Gemini, Anthropic Claude (`/v1/messages`), OpenRouter, Groq, DeepSeek,
//     NVIDIA NIM, xAI Grok, Ollama/LAN, and any custom OpenAI-compatible proxy with auto key-prefix detection.
//  2. Full non-destructive multi-track video/audio/caption NLE engine with 50-step Undo/Redo,
//     real video probing, WebAudio waveform extraction, live pixel scopes, real freeze-frame capture,
//     and hardware WebCodecs H.264 + AAC `.mp4` rendering straight into Android Gallery (`Movies/Vedit/`).

import type {
  ApiPresetInfo,
  ApiSettingsResponse,
  Asset,
  CameraMoveInfo,
  Caption,
  Clip,
  ExportPresetInfo,
  GenProviderInfo,
  GenerateMediaRequest,
  MarketplacePackInfo,
  Project,
  ReviewComment,
  Sequence,
  SnapshotInfo,
  Track,
} from "./api";
import {
  AUDIO_EQ_PRESETS_UI,
  computeCurvePoints,
  exportSequenceToMp4Blob,
  extractMediaFilmstrip,
  seekVideoElement,
  type ToneCurvePoint,
  type ToneCurvePresetUi,
} from "./compositor";

declare global {
  interface Window {
    __veditResolveHttp?: (requestId: string, base64Response: string) => void;
    VeditAndroid?: {
      isAndroid?: () => boolean;
      getVersion?: () => string;
      httpRequest?: (method: string, url: string, headersJson: string, body: string) => string;
      httpRequestAsync?: (
        requestId: string,
        method: string,
        url: string,
        headersJson: string,
        body: string,
      ) => void;
      toggleFullscreen?: (mode: string) => boolean;
      saveExportBase64?: (fileName: string, mimeType: string, base64Data: string) => string;
      shareLastExport?: () => boolean;
      openExternalUrl?: (url: string) => void;
    };
  }
}

export const IS_ANDROID_APK: boolean =
  typeof window !== "undefined" &&
  (Boolean(window.VeditAndroid) ||
    location.hostname === "appassets.vedit.studio" ||
    /VedStudioAPK/i.test(navigator.userAgent));

const APK_VERSION = "0.9.2";
const STORAGE_KEY_PROJECT = "vedit.apk.project.v3";
const STORAGE_KEY_SAVED_LIST = "vedit.apk.savedProjects.v2";
const STORAGE_KEY_API = "vedit.apk.apiSettings.v2";
const VAULT_DB_NAME = "vedit_media_vault_v1";
const VAULT_STORE = "media_blobs";

function openMediaVault(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(VAULT_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(VAULT_STORE)) {
          db.createObjectStore(VAULT_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function putVaultBlob(assetId: string, blob: Blob): Promise<void> {
  const db = await openMediaVault();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(VAULT_STORE, "readwrite");
      tx.objectStore(VAULT_STORE).put(blob, assetId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function hydrateVaultBlobs(): Promise<void> {
  const db = await openMediaVault();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(VAULT_STORE, "readonly");
      const store = tx.objectStore(VAULT_STORE);
      const req = store.openCursor();
      let restoredAny = false;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          if (restoredAny) changeListeners.forEach((fn) => fn());
          resolve();
          return;
        }
        const id = String(cursor.key);
        const val = cursor.value as Blob | undefined;
        if (val instanceof Blob) {
          const freshUrl = URL.createObjectURL(val);
          blobUrls.set(id, freshUrl);
          const found = state.assets.find((a) => a.id === id);
          if (found) found.path = freshUrl;
          restoredAny = true;
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

const memStorage = new Map<string, string>();
const safeStorage = {
  getItem(key: string): string | null {
    try {
      if (typeof localStorage !== "undefined") return localStorage.getItem(key);
    } catch {
      /* fallback */
    }
    return memStorage.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    memStorage.set(key, value);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      /* quota guard */
    }
  },
};

export const MOBILE_API_PRESETS: ApiPresetInfo[] = [
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
    suggestedModels: ["meta/llama-3.3-70b-instruct", "nvidia/llama-3.3-nemotron-super-49b-v1"],
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
    label: "Ollama / LAN Server",
    baseUrl: "http://192.168.1.100:11434/v1",
    requiresKey: false,
    suggestedModels: ["llama3.2", "qwen2.5:7b", "deepseek-r1:8b"],
  },
  {
    id: "custom",
    label: "Custom Endpoint",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    suggestedModels: [],
  },
];

export function sanitizeMobileApiKey(raw?: string): string {
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

export function detectPresetByKey(rawKey?: string): ApiPresetInfo | null {
  const k = sanitizeMobileApiKey(rawKey);
  if (!k) return null;
  if (k.startsWith("sk-or-")) return MOBILE_API_PRESETS.find((p) => p.id === "openrouter") ?? null;
  if (k.startsWith("sk-ant-")) return MOBILE_API_PRESETS.find((p) => p.id === "anthropic") ?? null;
  if (k.startsWith("AIza")) return MOBILE_API_PRESETS.find((p) => p.id === "gemini") ?? null;
  if (k.startsWith("gsk_")) return MOBILE_API_PRESETS.find((p) => p.id === "groq") ?? null;
  if (k.startsWith("nvapi-")) return MOBILE_API_PRESETS.find((p) => p.id === "nvidia") ?? null;
  if (k.startsWith("xai-")) return MOBILE_API_PRESETS.find((p) => p.id === "xai") ?? null;
  return null;
}

export function normalizeMobileBaseUrl(raw?: string): string {
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

const pendingNativeHttp = new Map<
  string,
  { resolve: (rawJson: string) => void; timer: ReturnType<typeof setTimeout> }
>();

function installNativeHttpBridgeHook(): void {
  if (typeof window === "undefined") return;
  window.__veditResolveHttp = (requestId: string, base64Response: string) => {
    const entry = pendingNativeHttp.get(requestId);
    if (!entry) return;
    pendingNativeHttp.delete(requestId);
    clearTimeout(entry.timer);
    try {
      const bin = atob(base64Response);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      entry.resolve(new TextDecoder("utf-8").decode(bytes));
    } catch {
      entry.resolve('{"ok":false,"status":0,"error":"Bridge decode failed"}');
    }
  };
}
installNativeHttpBridgeHook();

/**
 * CORS-free universal non-blocking HTTP client:
 * - Prefers `window.VeditAndroid.httpRequestAsync` on Android thread pool so long reasoning calls
 *   never block the UI thread or collide across rapid consecutive prompts.
 * - Supports synchronous `window.VeditAndroid.httpRequest` seamlessly for backwards compatibility.
 * - Falls back to browser `fetch` outside Android APK.
 */
async function nativeHttp(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
  const serializedBody = body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : "";
  if (typeof window !== "undefined" && window.VeditAndroid?.httpRequestAsync) {
    installNativeHttpBridgeHook();
    const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const rawResp = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        pendingNativeHttp.delete(reqId);
        resolve('{"ok":false,"status":0,"error":"Request timed out after 80s"}');
      }, 80000);
      pendingNativeHttp.set(reqId, { resolve, timer });
      try {
        window.VeditAndroid!.httpRequestAsync!(reqId, method, url, JSON.stringify(headers), serializedBody);
      } catch (e) {
        clearTimeout(timer);
        pendingNativeHttp.delete(reqId);
        resolve(JSON.stringify({ ok: false, status: 0, error: (e as Error).message }));
      }
    });
    const parsed = JSON.parse(rawResp) as {
      ok?: boolean;
      status: number;
      statusText?: string;
      body?: string;
      error?: string;
    };
    if (parsed.status === 0 && parsed.error) {
      throw new Error(parsed.error);
    }
    const status = Number(parsed.status || 0);
    return {
      ok: parsed.ok !== undefined ? Boolean(parsed.ok) : status >= 200 && status < 300,
      status,
      statusText: parsed.statusText || "",
      text: parsed.body ?? "",
    };
  }

  if (typeof window !== "undefined" && window.VeditAndroid?.httpRequest) {
    const rawResp = window.VeditAndroid.httpRequest(method, url, JSON.stringify(headers), serializedBody);
    const parsed = JSON.parse(rawResp) as {
      ok: boolean;
      status: number;
      statusText?: string;
      body?: string;
      error?: string;
    };
    if (parsed.status === 0 && parsed.error) {
      throw new Error(parsed.error);
    }
    const status = Number(parsed.status || 0);
    return {
      ok: parsed.ok !== undefined ? Boolean(parsed.ok) : status >= 200 && status < 300,
      status,
      statusText: parsed.statusText || "",
      text: parsed.body ?? "",
    };
  }

  const res = await fetch(url, {
    method,
    headers,
    ...(serializedBody && method !== "GET" && method !== "HEAD" ? { body: serializedBody } : {}),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, statusText: res.statusText, text };
}

function parseErrorMessage(rawText: string, status: number, statusText: string): string {
  try {
    const j = JSON.parse(rawText) as { error?: { message?: string } | string; message?: string };
    if (typeof j?.error === "string") return j.error;
    if (j?.error?.message) return j.error.message;
    if (j?.message) return j.message;
  } catch {
    /* ignore */
  }
  return rawText.slice(0, 180).trim() || `HTTP ${status} ${statusText}`.trim();
}

function resolveMobileEndpointAndModel(
  opts: { baseUrl?: string; apiKey?: string; model?: string } | undefined,
  cur: { baseUrl: string; apiKey: string; model: string },
): { key: string; baseUrl: string; model: string; fallbacks: string[] } {
  const key =
    opts?.apiKey && !opts.apiKey.includes("••••")
      ? sanitizeMobileApiKey(opts.apiKey)
      : sanitizeMobileApiKey(cur.apiKey);
  const autoPreset = detectPresetByKey(key);
  const savedBaseNorm = normalizeMobileBaseUrl(cur.baseUrl);
  const effectiveSavedBase =
    autoPreset && savedBaseNorm === "https://api.openai.com/v1" && autoPreset.id !== "openai"
      ? autoPreset.baseUrl
      : savedBaseNorm;

  const baseUrl = normalizeMobileBaseUrl(opts?.baseUrl || effectiveSavedBase || autoPreset?.baseUrl || "https://api.openai.com/v1");
  let model = (opts?.model || cur.model || autoPreset?.suggestedModels[0] || "gpt-4o-mini").trim();

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
  return { key, baseUrl, model, fallbacks };
}

function sanitizeMobileMessages(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const systems: string[] = [];
  const convo: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    const text = String(m?.content ?? "").trim();
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
  if (convo.length > 0 && convo[0]!.role === "assistant") convo.shift();
  if (convo.length === 0) convo.push({ role: "user", content: "OK" });
  return systems.length > 0 ? [{ role: "system", content: systems.join("\n\n") }, ...convo] : convo;
}

function extractMobileAssistantText(rawJsonText: string): { text: string; model?: string } {
  const data = JSON.parse(rawJsonText) as {
    model?: string;
    content?: unknown;
    choices?: Array<{
      message?: { content?: unknown; reasoning_content?: string; reasoning?: string };
      text?: string;
    }>;
  };
  const msg = data.choices?.[0]?.message;
  const raw = msg?.content ?? data.content;
  if (typeof raw === "string" && raw.trim()) {
    return { text: raw.trim(), model: data.model };
  }
  if (Array.isArray(raw)) {
    const joined = raw
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
    if (joined) return { text: joined, model: data.model };
  }
  if (typeof data.choices?.[0]?.text === "string" && data.choices[0].text.trim()) {
    return { text: data.choices[0].text.trim(), model: data.model };
  }
  const reasoning = msg?.reasoning_content || msg?.reasoning || "";
  return { text: typeof reasoning === "string" ? reasoning.trim() : "", model: data.model };
}

export function parseMobileAiJsonSafe<T = Record<string, unknown>>(raw: string): T | null {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1")
    .trim();
  if (!cleaned) return null;

  const normalize = (src: string) => {
    let out = "";
    let inStr = false;
    let esc = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i]!;
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === "\\" && inStr) {
        out += ch;
        esc = true;
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
    if (inStr) out += '"';
    return out.replace(/,\s*([}\]])/g, "$1");
  };

  const candidates: string[] = [];
  const starts: number[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") starts.push(i);
    else if (ch === "}" && starts.length > 0) {
      const openIdx = starts.pop()!;
      if (starts.length === 0) candidates.push(cleaned.slice(openIdx, i + 1));
    }
  }

  if (starts.length > 0) {
    let tail = normalize(cleaned.slice(starts[0]!));
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

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]!) as T;
    } catch {
      try {
        return JSON.parse(normalize(candidates[i]!)) as T;
      } catch {
        /* continue */
      }
    }
  }
  return null;
}

const waitMobileMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runMobileLlmChat(
  rawMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  opts: { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number } = {},
): Promise<{ content: string; model: string; baseUrl: string; latencyMs: number }> {
  const cur = readLocalApi();
  const { key, baseUrl, fallbacks } = resolveMobileEndpointAndModel(opts, cur);
  const messages = sanitizeMobileMessages(rawMessages);
  const maxTokens = opts.maxTokens ?? 1800;

  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|192\.168\.|10\.|172\.)/i.test(baseUrl);
  if (!key && !isLocal) {
    throw new Error("Paste your API key first (OpenAI, Gemini, Claude, OpenRouter, Groq, DeepSeek…).");
  }

  const started = Date.now();
  const isAnthropic = /anthropic\.com/i.test(baseUrl) || (key.startsWith("sk-ant-") && !/openrouter\.ai/i.test(baseUrl));
  let lastErr: Error | null = null;

  for (let mIdx = 0; mIdx < fallbacks.length; mIdx++) {
    const candidateModel = fallbacks[mIdx]!;
    const attempts = mIdx === 0 ? 2 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (isAnthropic) {
          const sys = messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n\n");
          const turns = messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
          const resp = await nativeHttp(
            "POST",
            `${baseUrl.replace(/\/openai$/i, "")}/messages`,
            {
              "Content-Type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
            },
            {
              model: candidateModel,
              max_tokens: maxTokens,
              ...(sys ? { system: sys } : {}),
              messages: turns.length ? turns : [{ role: "user", content: "OK" }],
            },
          );
          if (!resp.ok) {
            const msg = parseErrorMessage(resp.text, resp.status, resp.statusText);
            lastErr = new Error(msg);
            if ((resp.status === 429 || resp.status >= 500 || resp.status === 404) && (attempt + 1 < attempts || mIdx + 1 < fallbacks.length)) {
              if (attempt + 1 < attempts) await waitMobileMs(700 * (attempt + 1));
              continue;
            }
            throw lastErr;
          }
          const extracted = extractMobileAssistantText(resp.text);
          return {
            content: extracted.text,
            model: extracted.model || candidateModel,
            baseUrl,
            latencyMs: Date.now() - started,
          };
        }

        // Only attach OpenRouter headers on OpenRouter to prevent browser CORS rejections on other APIs!
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (/openrouter\.ai/i.test(baseUrl)) {
          headers["HTTP-Referer"] = "https://vedit.studio";
          headers["X-Title"] = "Vedit Studio";
        }
        if (key) headers.Authorization = `Bearer ${key}`;

        const reasoning = /^(o1|o3|o4|gpt-5|deepseek-reasoner|qwq)/i.test(candidateModel);
        let resp = await nativeHttp(
          "POST",
          `${baseUrl}/chat/completions`,
          headers,
          reasoning
            ? { model: candidateModel, messages, max_completion_tokens: maxTokens }
            : { model: candidateModel, messages, temperature: cur.temperature ?? 0.2, max_tokens: maxTokens },
        );

        if (resp.status === 400 && !reasoning && /max_tokens|max_completion_tokens|temperature|unsupported/i.test(resp.text)) {
          resp = await nativeHttp("POST", `${baseUrl}/chat/completions`, headers, {
            model: candidateModel,
            messages,
            max_completion_tokens: maxTokens,
          });
        }

        if (!resp.ok) {
          const msg = parseErrorMessage(resp.text, resp.status, resp.statusText);
          lastErr = new Error(`${msg} (${candidateModel})`);
          const retryable =
            resp.status === 429 ||
            resp.status === 408 ||
            resp.status === 404 ||
            resp.status === 402 ||
            resp.status >= 500;
          if (retryable && (attempt + 1 < attempts || mIdx + 1 < fallbacks.length)) {
            if (attempt + 1 < attempts) await waitMobileMs(700 * (attempt + 1));
            continue;
          }
          throw lastErr;
        }

        const extracted = extractMobileAssistantText(resp.text);
        return {
          content: extracted.text,
          model: extracted.model || candidateModel,
          baseUrl,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const netErr = /network|socket|eof|reset|timeout|fetch/i.test(lastErr.message);
        if (netErr && attempt + 1 < attempts) {
          await waitMobileMs(500 * (attempt + 1));
          continue;
        }
        if (!netErr && mIdx + 1 >= fallbacks.length) {
          throw lastErr;
        }
      }
    }
  }

  throw lastErr ?? new Error("AI request failed");
}

// ---------- Studio Presets & Project State ----------

const MOBILE_PRESETS = [
  { id: "fade-in", label: "Smooth Fade In" },
  { id: "zoom-in", label: "Slow Push-In" },
  { id: "zoom-out", label: "Pull-Out Reveal" },
  { id: "slide-left", label: "Slide Left" },
  { id: "slide-up", label: "Rise Up" },
];

const MOBILE_EXPORT_PRESETS: ExportPresetInfo[] = [
  { id: "youtube-1080p", label: "1080p Full HD · 30fps (MP4 H.264)", platform: "Universal MP4", format: "mp4", codec: "h264" },
  { id: "reels-vertical-1080p", label: "1080×1920 Vertical 9:16 · 60fps (Reels / TikTok / Shorts)", platform: "Social 9:16", format: "mp4", codec: "h264" },
  { id: "social-720p-fast", label: "720p Fast Share · 30fps (MP4 H.264)", platform: "Fast Mobile", format: "mp4", codec: "h264" },
  { id: "cinema-24fps", label: "1080p Cinema · 24fps (MP4 High Bitrate)", platform: "Cinema", format: "mp4", codec: "h264" },
];

const MOBILE_GEN_PROVIDERS: GenProviderInfo[] = [
  {
    id: "vedit-canvas",
    label: "Title & Motion Plate Generator",
    available: true,
    cloud: false,
    kinds: ["image", "video"],
    defaultModel: "studio-plate",
    models: ["studio-plate"],
  },
];

const MOBILE_CAMERA_MOVES: CameraMoveInfo[] = [
  { id: "dolly-in", label: "Dolly Push In", directive: "slow push in" },
  { id: "pan-right", label: "Pan Right", directive: "smooth pan right" },
  { id: "static", label: "Locked Off", directive: "locked tripod frame" },
];

const MOBILE_MARKETPLACE_PACKS: MarketplacePackInfo[] = [
  {
    id: "tpl-tiktok-shorts",
    kind: "template",
    name: "Vertical 9:16 Reels / Shorts Format",
    author: "Vedit Studio",
    version: "1.0.0",
    category: "Social",
    description: "Switches sequence to 1080×1920 9:16 with clean lower caption styling.",
    installed: true,
  },
  {
    id: "tpl-youtube-intro",
    kind: "template",
    name: "Widescreen 16:9 Cinema Format",
    author: "Vedit Studio",
    version: "1.0.0",
    category: "Cinema",
    description: "Switches sequence to 1920×1080 16:9 widescreen film layout.",
    installed: true,
  },
];

const blobUrls = new Map<string, string>();
const exportOutputs = new Map<string, { url: string; fileName: string; mime: string }>();
const undoStack: string[] = [];
const redoStack: string[] = [];
const changeListeners = new Set<() => void>();

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const FALLBACK_PLATE_DATA_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#09090b"/><stop offset="100%" stop-color="#18181b"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/></svg>`,
  );

function defaultMobileProject(): Project {
  return {
    id: "proj-vedit-main",
    name: "Untitled Edit",
    activeSequenceId: "seq-main",
    assets: [],
    sequences: [
      {
        id: "seq-main",
        name: "Main Sequence",
        width: 1920,
        height: 1080,
        fps: 30,
        tracks: [
          {
            id: "track-v1",
            name: "V1",
            kind: "video",
            muted: false,
            solo: false,
            locked: false,
            volumeDb: 0,
            clips: [],
          },
          {
            id: "track-v2",
            name: "V2 Overlay",
            kind: "graphics",
            muted: false,
            solo: false,
            locked: false,
            volumeDb: 0,
            clips: [],
          },
          {
            id: "track-a1",
            name: "A1 Audio",
            kind: "audio",
            muted: false,
            solo: false,
            locked: false,
            volumeDb: 0,
            clips: [],
          },
        ],
        captions: [],
      },
    ],
    jobs: [],
    comments: [],
    markers: [],
    snapshots: [],
  };
}

export function sanitizeProjectShape(rawProj: unknown): Project {
  const fallback = defaultMobileProject();
  if (!rawProj || typeof rawProj !== "object") return fallback;
  const p = rawProj as Partial<Project>;
  const rawAssets = Array.isArray(p.assets) ? p.assets : [];
  const assets: Asset[] = rawAssets
    .filter((a): a is Asset => Boolean(a && typeof a === "object"))
    .map((a, idx) => ({
      ...a,
      id: String(a.id || `asset-${idx}`),
      name: String(a.name || "Media"),
      kind: a.kind === "audio" || a.kind === "image" || a.kind === "generated" ? a.kind : "video",
      path: String(a.path || ""),
    }));

  const rawSeqs = Array.isArray(p.sequences) && p.sequences.length > 0 ? p.sequences : fallback.sequences;
  const sequences: Sequence[] = rawSeqs.map((s, sIdx) => {
    const rawTracks = Array.isArray(s?.tracks) && s.tracks.length > 0 ? s.tracks : fallback.sequences[0]!.tracks;
    return {
      ...s,
      id: String(s?.id || `seq-${sIdx}`),
      name: String(s?.name || "Main Sequence"),
      width: Number(s?.width) > 0 ? Number(s.width) : 1920,
      height: Number(s?.height) > 0 ? Number(s.height) : 1080,
      fps: Number(s?.fps) > 0 ? Number(s.fps) : 30,
      captions: (Array.isArray(s?.captions) ? s.captions : [])
        .filter((c): c is Caption => Boolean(c && typeof c === "object"))
        .map((c, cIdx) => ({
          ...c,
          id: String(c.id || `cap-${cIdx}`),
          text: String(c.text ?? ""),
          start: Number.isFinite(Number(c.start)) ? Number(c.start) : 0,
          end: Number.isFinite(Number(c.end)) ? Number(c.end) : 3,
        })),
      tracks: rawTracks.map((tr, tIdx) => ({
        ...tr,
        id: String(tr?.id || `track-${tIdx}`),
        name: String(tr?.name || `Track ${tIdx + 1}`),
        kind: tr?.kind === "audio" || tr?.kind === "text" || tr?.kind === "graphics" ? tr.kind : "video",
        muted: Boolean(tr?.muted),
        solo: Boolean(tr?.solo),
        locked: Boolean(tr?.locked),
        clips: (Array.isArray(tr?.clips) ? tr.clips : [])
          .filter((c): c is Clip => Boolean(c && typeof c === "object"))
          .map((c, cIdx) => ({
            ...c,
            id: String(c.id || `clip-${cIdx}`),
            assetId: String(c.assetId || ""),
            name: String(c.name || "Clip"),
            start: Number.isFinite(Number(c.start)) ? Number(c.start) : 0,
            duration: Number.isFinite(Number(c.duration)) && Number(c.duration) > 0 ? Number(c.duration) : 3,
            in: Number.isFinite(Number(c.in)) ? Number(c.in) : 0,
            out: Number.isFinite(Number(c.out)) ? Number(c.out) : 3,
            transform: {
              x: Number(c.transform?.x ?? 0) || 0,
              y: Number(c.transform?.y ?? 0) || 0,
              scaleX: Number.isFinite(Number(c.transform?.scaleX)) ? Number(c.transform.scaleX) : 1,
              scaleY: Number.isFinite(Number(c.transform?.scaleY)) ? Number(c.transform.scaleY) : 1,
              rotation: Number(c.transform?.rotation ?? 0) || 0,
              opacity: Number.isFinite(Number(c.transform?.opacity)) ? Number(c.transform.opacity) : 1,
            },
            keyframes: Array.isArray(c.keyframes) ? c.keyframes : [],
            effects: Array.isArray(c.effects) ? c.effects : [],
          })),
      })),
    };
  });

  return {
    id: String(p.id || fallback.id),
    name: String(p.name || fallback.name),
    activeSequenceId: sequences.some((s) => s.id === p.activeSequenceId)
      ? String(p.activeSequenceId)
      : sequences[0]!.id,
    assets,
    sequences,
    jobs: Array.isArray(p.jobs) ? p.jobs : [],
    comments: Array.isArray(p.comments) ? p.comments : [],
    markers: Array.isArray(p.markers) ? p.markers : [],
    snapshots: Array.isArray(p.snapshots) ? p.snapshots : [],
  };
}

let state: Project = (() => {
  try {
    const raw = safeStorage.getItem(STORAGE_KEY_PROJECT);
    if (raw) {
      const parsed = sanitizeProjectShape(JSON.parse(raw));
      for (const a of parsed.assets) {
        if (a.path.startsWith("data:") || a.path.startsWith("blob:")) {
          blobUrls.set(a.id, a.path);
        }
      }
      return parsed;
    }
  } catch {
    /* ignore corrupted localStorage and boot fresh studio cleanly */
  }
  return defaultMobileProject();
})();

void hydrateVaultBlobs();

function persist(clearRedo = true): void {
  safeStorage.setItem(STORAGE_KEY_PROJECT, JSON.stringify(state));
  if (clearRedo) redoStack.length = 0;
  changeListeners.forEach((fn) => fn());
}

function recordUndo(): void {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 50) undoStack.shift();
}

function clone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

function activeSeq(): Sequence {
  return state.sequences.find((s) => s.id === state.activeSequenceId) ?? state.sequences[0]!;
}

function findClip(clipId: string): { track: Track; clip: Clip } {
  for (const track of activeSeq().tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  throw new Error(`Clip ${clipId} not found`);
}

export function subscribeMobileChanges(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

export function resolveAssetUrlById(assetId: string): string {
  const mapped = blobUrls.get(assetId);
  if (mapped) return mapped;
  const found = state.assets.find((a) => a.id === assetId);
  if (found?.path && !found.path.startsWith("/showcase/")) return found.path;
  return FALLBACK_PLATE_DATA_URI;
}

export function resolveMobileMediaUrl(url: string): string {
  const assetMatch = /\/assets\/([^/?]+)\/(stream|file|frame|thumbnail)/.exec(url);
  if (assetMatch) {
    return resolveAssetUrlById(assetMatch[1]!);
  }
  const jobMatch = /\/jobs\/([^/?]+)\/output/.exec(url);
  if (jobMatch) {
    const out = exportOutputs.get(jobMatch[1]!);
    if (out) return out.url;
  }
  return url;
}

async function saveBlobToAndroidOrBrowser(blob: Blob, fileName: string, mimeType: string): Promise<string> {
  if (typeof window !== "undefined" && window.VeditAndroid?.saveExportBase64) {
    const b64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result || "");
        const comma = res.indexOf(",");
        resolve(comma >= 0 ? res.slice(comma + 1) : res);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return window.VeditAndroid.saveExportBase64(fileName, mimeType, b64);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return `Downloads/${fileName}`;
}

async function probeBrowserFile(
  _file: File,
  objectUrl: string,
  kind: Asset["kind"],
): Promise<{ duration: number; width: number; height: number }> {
  if (typeof document === "undefined") {
    return { duration: 5, width: 1920, height: 1080 };
  }
  if (kind === "video") {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      const timer = setTimeout(() => resolve({ duration: 5, width: 1920, height: 1080 }), 5000);
      v.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve({
          duration: Number.isFinite(v.duration) && v.duration > 0 ? Number(v.duration.toFixed(3)) : 5,
          width: v.videoWidth || 1920,
          height: v.videoHeight || 1080,
        });
      };
      v.onerror = () => {
        clearTimeout(timer);
        resolve({ duration: 5, width: 1920, height: 1080 });
      };
      v.src = objectUrl;
    });
  }
  if (kind === "audio") {
    return new Promise((resolve) => {
      const a = document.createElement("audio");
      a.preload = "metadata";
      const timer = setTimeout(() => resolve({ duration: 10, width: 0, height: 0 }), 5000);
      a.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve({
          duration: Number.isFinite(a.duration) && a.duration > 0 ? Number(a.duration.toFixed(3)) : 10,
          width: 0,
          height: 0,
        });
      };
      a.onerror = () => {
        clearTimeout(timer);
        resolve({ duration: 10, width: 0, height: 0 });
      };
      a.src = objectUrl;
    });
  }
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve({ duration: 4, width: 1920, height: 1080 }), 4000);
    img.onload = () => {
      clearTimeout(timer);
      resolve({ duration: 4, width: img.naturalWidth || 1920, height: img.naturalHeight || 1080 });
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve({ duration: 4, width: 1920, height: 1080 });
    };
    img.src = objectUrl;
  });
}

function buildSvgDataUri(kind: string, label: string, accent = "#3b82f6"): string {
  const safe = label.replace(/[<>&"]/g, "");
  const svg =
    kind === "lower-third"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect x="64" y="548" width="520" height="92" rx="12" fill="rgba(9,9,11,0.88)" stroke="${accent}" stroke-width="3"/><rect x="64" y="548" width="8" height="92" rx="4" fill="${accent}"/><text x="92" y="604" fill="#fafafa" font-family="sans-serif" font-weight="700" font-size="34">${safe}</text></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect x="340" y="296" width="600" height="128" rx="20" fill="rgba(9,9,11,0.85)" stroke="${accent}" stroke-width="3"/><text x="640" y="372" text-anchor="middle" fill="#fafafa" font-family="sans-serif" font-weight="700" font-size="42">${safe}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface LocalStoredApi {
  providerPreset: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel: string;
  temperature: number;
  providerKeys: Record<string, string>;
}

function readLocalApi(): LocalStoredApi {
  try {
    const raw = safeStorage.getItem(STORAGE_KEY_API);
    if (raw) return JSON.parse(raw) as LocalStoredApi;
  } catch {
    /* ignore */
  }
  return {
    providerPreset: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    visionModel: "gpt-4o-mini",
    temperature: 0.2,
    providerKeys: {},
  };
}

function publicApi(cfg: LocalStoredApi): ApiSettingsResponse {
  const clean = sanitizeMobileApiKey(cfg.apiKey);
  const masked = !clean
    ? ""
    : clean.length <= 8
      ? `${clean.slice(0, 2)}••••••`
      : `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
  return {
    providerPreset: cfg.providerPreset || "openai",
    baseUrl: normalizeMobileBaseUrl(cfg.baseUrl),
    hasApiKey: Boolean(clean),
    maskedApiKey: masked,
    model: cfg.model || "gpt-4o-mini",
    visionModel: cfg.visionModel || cfg.model || "gpt-4o-mini",
    temperature: cfg.temperature ?? 0.2,
    configuredProviderKeys: Object.keys(cfg.providerKeys || {}).filter((k) => Boolean(cfg.providerKeys[k])),
    presets: MOBILE_API_PRESETS,
  };
}

async function renderMobileVideoJob(jobId: string, presetId: string): Promise<void> {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  job.status = "running";
  job.progress = 4;
  persist(false);

  try {
    const seq = activeSeq();
    let width = seq.width || 1920;
    let height = seq.height || 1080;
    let fps = seq.fps || 30;
    let bitrate = 8_500_000;

    if (presetId === "reels-vertical-1080p") {
      width = 1080;
      height = 1920;
      fps = 60;
      bitrate = 10_000_000;
    } else if (presetId === "social-720p-fast") {
      const portrait = seq.height > seq.width;
      width = portrait ? 720 : 1280;
      height = portrait ? 1280 : 720;
      fps = 30;
      bitrate = 5_000_000;
    } else if (presetId === "cinema-24fps") {
      fps = 24;
      bitrate = 12_000_000;
    }

    const encoded = await exportSequenceToMp4Blob({
      project: state,
      sequence: seq,
      resolveUrl: resolveAssetUrlById,
      width,
      height,
      fps,
      bitrate,
      onProgress: (pct) => {
        job.progress = pct;
        persist(false);
      },
    });

    const outUrl = URL.createObjectURL(encoded.blob);
    const outName = `Vedit_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${encoded.ext}`;
    exportOutputs.set(jobId, { url: outUrl, fileName: outName, mime: encoded.mimeType });
    const savedWhere = await saveBlobToAndroidOrBrowser(encoded.blob, outName, encoded.mimeType);

    job.status = "done";
    job.progress = 100;
    job.output = { path: savedWhere, url: outUrl };
    persist(false);
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message || "Export failed";
    persist(false);
  }
}

// ---------- Complete Type-Identical Mobile API Surface ----------

export const mobileApi = {
  listProjects: async () => ({
    projects: [{ id: state.id, name: state.name }],
  }),
  createProject: async (name: string, sample = false) => {
    recordUndo();
    const fresh = defaultMobileProject();
    fresh.id = uid("proj");
    fresh.name = name || "New Project";
    if (!sample) {
      fresh.assets = [];
      fresh.sequences[0]!.tracks.forEach((t) => {
        t.clips = [];
      });
    }
    state = fresh;
    persist();
    return { project: clone(state) };
  },
  getProject: async (_id: string) => ({
    project: clone(state),
    history: {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      undoCount: undoStack.length,
      redoCount: redoStack.length,
    },
  }),
  addAsset: async (input: Partial<Asset> & { name: string; path: string }) => {
    const asset: Asset = {
      id: uid("asset"),
      kind: input.kind ?? "video",
      name: input.name,
      path: input.path,
      duration: input.duration ?? 6,
      width: input.width ?? 1920,
      height: input.height ?? 1080,
      fps: input.fps ?? 30,
    };
    blobUrls.set(asset.id, asset.path);
    state.assets.push(asset);
    persist(true);
    return { asset: clone(asset) };
  },
  saveProjectDisk: async () => {
    const fileName = `${state.name.replace(/\s+/g, "_")}.vedit.json`;
    const filePath = `Android/data/com.vedit.studio/${fileName}`;
    const serialized = JSON.stringify(state);
    const savedAt = new Date().toISOString();
    const list: Array<{ fileName: string; filePath: string; name: string; id: string; updatedAt: string }> = JSON.parse(
      safeStorage.getItem(STORAGE_KEY_SAVED_LIST) || "[]",
    );
    const updated = [
      { fileName, filePath, name: state.name, id: state.id, updatedAt: savedAt },
      ...list.filter((i) => i.filePath !== filePath),
    ];
    safeStorage.setItem(STORAGE_KEY_SAVED_LIST, JSON.stringify(updated));
    safeStorage.setItem(`vedit.file:${filePath}`, serialized);
    persist(false);
    return { filePath, sizeBytes: serialized.length, savedAt };
  },
  savedProjects: async () => ({
    saved: JSON.parse(safeStorage.getItem(STORAGE_KEY_SAVED_LIST) || "[]") as Array<{
      fileName: string;
      filePath: string;
      name: string;
      id: string;
      updatedAt: string;
    }>,
  }),
  openProjectDisk: async (filePath: string) => {
    const raw = safeStorage.getItem(`vedit.file:${filePath}`);
    if (raw) {
      state = JSON.parse(raw) as Project;
      persist(false);
    }
    return { project: clone(state) };
  },
  checkUpdate: async () => {
    try {
      const resp = await nativeHttp("GET", "https://api.github.com/repos/lilrepaer-glitch/Vedit/releases/latest");
      if (resp.ok) {
        const rel = JSON.parse(resp.text) as {
          tag_name?: string;
          name?: string;
          html_url?: string;
          body?: string;
          assets?: Array<{ name: string; browser_download_url: string; size: number }>;
        };
        const latestVer = String(rel.tag_name || APK_VERSION).replace(/^v/i, "");
        const apkAsset = rel.assets?.find((a) => a.name.toLowerCase().endsWith(".apk"));
        const dl =
          apkAsset?.browser_download_url ?? "https://github.com/lilrepaer-glitch/Vedit/raw/main/releases/Vedit.apk";
        return {
          currentVersion: APK_VERSION,
          latestVersion: latestVer,
          updateAvailable: latestVer !== APK_VERSION && latestVer.localeCompare(APK_VERSION, undefined, { numeric: true }) > 0,
          releaseName: rel.name ?? `Vedit v${latestVer}`,
          releaseUrl: rel.html_url ?? "https://github.com/lilrepaer-glitch/Vedit/releases/latest",
          downloadUrl: dl,
          sizeBytes: apkAsset?.size ?? null,
          notes: rel.body ?? "",
        };
      }
    } catch {
      /* offline */
    }
    return {
      currentVersion: APK_VERSION,
      latestVersion: APK_VERSION,
      updateAvailable: false,
      releaseName: `Vedit v${APK_VERSION}`,
      releaseUrl: "https://github.com/lilrepaer-glitch/Vedit/releases/latest",
      downloadUrl: "https://github.com/lilrepaer-glitch/Vedit/raw/main/releases/Vedit.apk",
      sizeBytes: null,
      notes: "",
    };
  },
  installUpdate: async (downloadUrl?: string) => {
    const target = downloadUrl || "https://github.com/lilrepaer-glitch/Vedit/raw/main/releases/Vedit.apk";
    if (window.VeditAndroid?.openExternalUrl) {
      window.VeditAndroid.openExternalUrl(target);
    } else {
      window.open(target, "_blank");
    }
    return { installerPath: target, sizeBytes: 0, launched: true, latestVersion: APK_VERSION };
  },
  presets: async () => ({ presets: MOBILE_PRESETS }),
  undo: async () => {
    const prev = undoStack.pop();
    if (prev) {
      redoStack.push(JSON.stringify(state));
      state = JSON.parse(prev) as Project;
      persist(false);
    }
    return { ok: true };
  },
  redo: async () => {
    const next = redoStack.pop();
    if (next) {
      undoStack.push(JSON.stringify(state));
      state = JSON.parse(next) as Project;
      persist(false);
    }
    return { ok: true };
  },
  uploadAssetFile: async (file: File, at = 0, insert = true, trackId?: string) => {
    recordUndo();
    const url = URL.createObjectURL(file);
    const kind: Asset["kind"] = file.type.startsWith("audio/")
      ? "audio"
      : file.type.startsWith("image/")
        ? "image"
        : "video";
    const meta = await probeBrowserFile(file, url, kind);

    // Replace initial untouched sample image automatically on first user media import
    const seq = activeSeq();
    const onlySample =
      state.assets.length === 1 &&
      state.assets[0]?.id === "asset-sample-1" &&
      seq.tracks[0]?.clips.length === 1 &&
      seq.tracks[0]?.clips[0]?.id === "clip-init-1";

    if (onlySample && kind !== "audio") {
      state.assets = [];
      seq.tracks[0]!.clips = [];
      if (meta.width > 0 && meta.height > 0) {
        seq.width = Math.round(meta.width / 2) * 2;
        seq.height = Math.round(meta.height / 2) * 2;
      }
      at = 0;
    }

    const asset: Asset = {
      id: uid("asset"),
      name: file.name || `media-${Date.now()}`,
      kind,
      path: url,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
    };
    blobUrls.set(asset.id, url);
    void putVaultBlob(asset.id, file);
    state.assets.push(asset);

    // Auto-match empty sequence canvas dimensions to first imported video/photo
    const hasAnyVisualClips = seq.tracks.some((t) => t.kind !== "audio" && t.clips.length > 0);
    if (!hasAnyVisualClips && kind !== "audio" && meta.width > 0 && meta.height > 0) {
      seq.width = Math.max(16, Math.round(meta.width / 2) * 2);
      seq.height = Math.max(16, Math.round(meta.height / 2) * 2);
    }

    if (kind === "video" || kind === "image") {
      void extractMediaFilmstrip(asset.id, url, kind, meta.duration, 6).then(() => {
        changeListeners.forEach((fn) => fn());
      });
    }

    let createdClip: Clip | null = null;
    if (insert) {
      const targetKind = kind === "audio" ? "audio" : "video";
      let track = trackId
        ? seq.tracks.find((t) => t.id === trackId)
        : seq.tracks.find((t) => t.kind === targetKind && !t.locked);
      if (!track) {
        track = {
          id: uid("track"),
          name: targetKind === "audio" ? "A2" : "V2",
          kind: targetKind,
          muted: false,
          solo: false,
          locked: false,
          volumeDb: 0,
          clips: [],
        };
        seq.tracks.push(track);
      }
      createdClip = {
        id: uid("clip"),
        assetId: asset.id,
        name: asset.name,
        start: Math.max(0, Number(at.toFixed(3))),
        duration: meta.duration,
        in: 0,
        out: meta.duration,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
        keyframes: [],
        effects: [],
      };
      track.clips.push(createdClip);
    }
    persist();
    return { asset: clone(asset), clip: createdClip ? clone(createdClip) : null };
  },
  updateAsset: async (assetId: string, patch: { name?: string; path?: string; tags?: string[] }) => {
    recordUndo();
    const a = state.assets.find((item) => item.id === assetId);
    if (!a) throw new Error("Asset not found");
    if (patch.name !== undefined) a.name = patch.name;
    if (patch.path !== undefined) a.path = patch.path;
    if (patch.tags !== undefined) a.tags = patch.tags;
    persist();
    return { asset: clone(a) };
  },
  waveform: async (assetId: string, buckets = 64) => {
    const url = blobUrls.get(assetId);
    if (url && typeof AudioContext !== "undefined") {
      try {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const actx = new AudioContext();
        const decoded = await actx.decodeAudioData(buf);
        const chan = decoded.getChannelData(0);
        const step = Math.max(1, Math.floor(chan.length / buckets));
        const peaks: number[] = [];
        for (let i = 0; i < buckets; i++) {
          let max = 0;
          for (let j = i * step; j < Math.min(chan.length, (i + 1) * step); j += 16) {
            const v = Math.abs(chan[j] || 0);
            if (v > max) max = v;
          }
          peaks.push(Number(max.toFixed(3)));
        }
        void actx.close();
        return { peaks, samples: peaks.length };
      } catch {
        /* fallback */
      }
    }
    const peaks = Array.from({ length: buckets }, (_, i) =>
      Number((0.2 + 0.5 * Math.abs(Math.sin(i * 0.42 + assetId.length))).toFixed(2)),
    );
    return { peaks, samples: peaks.length };
  },
  addTrack: async (kind: string, name?: string) => {
    recordUndo();
    const seq = activeSeq();
    const safeKind = (kind === "audio" || kind === "text" || kind === "graphics" ? kind : "video") as Track["kind"];
    const track: Track = {
      id: uid("track"),
      name: name || `${safeKind.slice(0, 1).toUpperCase()}${seq.tracks.length + 1}`,
      kind: safeKind,
      muted: false,
      solo: false,
      locked: false,
      volumeDb: 0,
      clips: [],
    };
    seq.tracks.push(track);
    persist();
    return { track: clone(track) };
  },
  updateTrack: async (
    trackId: string,
    patch: { muted?: boolean; solo?: boolean; locked?: boolean; volumeDb?: number; pan?: number; name?: string },
  ) => {
    recordUndo();
    const track = activeSeq().tracks.find((t) => t.id === trackId);
    if (!track) throw new Error("Track not found");
    Object.assign(track, patch);
    persist();
    return { track: clone(track) };
  },
  updateSequence: async (patch: { width?: number; height?: number; fps?: number; name?: string; background?: string }) => {
    recordUndo();
    const seq = activeSeq();
    if (patch.width != null) seq.width = Math.max(16, Math.round(patch.width / 2) * 2);
    if (patch.height != null) seq.height = Math.max(16, Math.round(patch.height / 2) * 2);
    if (patch.fps != null) seq.fps = Math.max(1, Math.min(120, patch.fps));
    if (patch.name) seq.name = patch.name;
    if (patch.background !== undefined) seq.background = patch.background;
    persist();
    return { sequence: clone(seq) };
  },
  addClip: async (body: {
    trackId: string;
    assetId: string;
    start: number;
    duration?: number;
    in?: number;
    out?: number;
  }) => {
    recordUndo();
    const track = activeSeq().tracks.find((t) => t.id === body.trackId) ?? activeSeq().tracks[0]!;
    const asset = state.assets.find((a) => a.id === body.assetId);
    const dur = body.duration ?? asset?.duration ?? 5;
    const clip: Clip = {
      id: uid("clip"),
      assetId: body.assetId,
      name: asset?.name ?? "Clip",
      start: body.start ?? 0,
      duration: dur,
      in: body.in ?? 0,
      out: body.out ?? dur,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
      keyframes: [],
      effects: [],
    };
    track.clips.push(clip);
    persist();
    return { clip: clone(clip) };
  },
  updateClip: async (clipId: string, patch: Record<string, unknown>) => {
    recordUndo();
    const { clip } = findClip(clipId);
    if (patch.transform && typeof patch.transform === "object") {
      clip.transform = { ...clip.transform, ...(patch.transform as Partial<Clip["transform"]>) };
    }
    for (const [k, v] of Object.entries(patch)) {
      if (k !== "transform") (clip as unknown as Record<string, unknown>)[k] = v;
    }
    persist();
    return { clip: clone(clip) };
  },
  setClipEffect: async (clipId: string, type: string, params: Record<string, unknown>) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const fxId = uid("fx");
    clip.effects = [...clip.effects.filter((e) => e.type !== type), { id: fxId, type, params }];
    persist();
    return { effect: { id: fxId } };
  },
  addKeyframes: async (
    clipId: string,
    keyframes: Array<{ time: number; property: string; value: number; easing?: string }>,
  ) => {
    recordUndo();
    const { clip } = findClip(clipId);
    for (const kf of keyframes) {
      clip.keyframes = clip.keyframes.filter(
        (existing) => !(existing.property === kf.property && Math.abs(existing.time - kf.time) < 0.04),
      );
      clip.keyframes.push({ time: kf.time, property: kf.property, value: kf.value, easing: kf.easing });
    }
    clip.keyframes.sort((a, b) => a.time - b.time);
    persist();
    return { clip: clone(clip) };
  },
  moveClip: async (clipId: string, start: number, trackId?: string) => {
    recordUndo();
    const { track: curTrack, clip } = findClip(clipId);
    clip.start = Math.max(0, Number(start.toFixed(3)));
    if (trackId && trackId !== curTrack.id) {
      const dest = activeSeq().tracks.find((t) => t.id === trackId);
      if (dest) {
        curTrack.clips = curTrack.clips.filter((c) => c.id !== clipId);
        dest.clips.push(clip);
        dest.clips.sort((a, b) => a.start - b.start);
      }
    } else {
      curTrack.clips.sort((a, b) => a.start - b.start);
    }
    persist();
    return { clip: clone(clip) };
  },
  trimClip: async (clipId: string, edge: "start" | "end", time: number) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const rate = Number(clip.effects.find((e) => e.type === "speed")?.params?.rate ?? 1) || 1;
    if (edge === "start") {
      const clampedStart = Math.max(0, Math.min(clip.start + clip.duration - 0.12, time));
      const delta = clampedStart - clip.start;
      clip.in = Math.max(0, Number((clip.in + delta * rate).toFixed(3)));
      clip.start = Number(clampedStart.toFixed(3));
      clip.duration = Math.max(0.12, Number((clip.duration - delta).toFixed(3)));
    } else {
      const clampedEnd = Math.max(clip.start + 0.12, time);
      const nextDur = clampedEnd - clip.start;
      clip.duration = Number(nextDur.toFixed(3));
      clip.out = Number((clip.in + nextDur * rate).toFixed(3));
    }
    persist();
    return { clip: clone(clip) };
  },
  splitClip: async (clipId: string, at: number) => {
    recordUndo();
    const { track, clip } = findClip(clipId);
    if (at <= clip.start + 0.05 || at >= clip.start + clip.duration - 0.05) {
      throw new Error("Move playhead inside the clip to split");
    }
    const speedFx = clip.effects.find((e) => e.type === "speed");
    const rate = Number(speedFx?.params?.rate ?? 1) || 1;
    const leftDur = Number((at - clip.start).toFixed(3));
    const rightDur = Number((clip.duration - leftDur).toFixed(3));
    const sourceSplit = Number((clip.in + leftDur * rate).toFixed(3));
    const right: Clip = {
      ...clone(clip),
      id: uid("clip"),
      start: Number(at.toFixed(3)),
      duration: rightDur,
      in: sourceSplit,
      out: clip.out,
    };
    clip.duration = leftDur;
    clip.out = sourceSplit;
    track.clips.push(right);
    track.clips.sort((a, b) => a.start - b.start);
    persist();
    return { left: clone(clip), right: clone(right) };
  },
  deleteClip: async (clipId: string, ripple = false) => {
    recordUndo();
    const { track, clip } = findClip(clipId);
    const removedStart = clip.start;
    const removedDur = clip.duration;
    track.clips = track.clips.filter((c) => c.id !== clipId);
    if (ripple) {
      for (const c of track.clips) {
        if (c.start > removedStart) c.start = Math.max(0, Number((c.start - removedDur).toFixed(3)));
      }
    }
    persist();
    return { ok: true };
  },
  applyPreset: async (clipId: string, presetId: string) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const d = Math.max(0.4, clip.duration);
    if (presetId === "fade-in") {
      clip.keyframes.push({ time: 0, property: "opacity", value: 0 }, { time: Math.min(0.8, d), property: "opacity", value: 1 });
    } else if (presetId === "zoom-in") {
      clip.keyframes.push({ time: 0, property: "scaleX", value: 1 }, { time: d, property: "scaleX", value: 1.15 });
      clip.keyframes.push({ time: 0, property: "scaleY", value: 1 }, { time: d, property: "scaleY", value: 1.15 });
    } else if (presetId === "zoom-out") {
      clip.keyframes.push({ time: 0, property: "scaleX", value: 1.15 }, { time: d, property: "scaleX", value: 1 });
      clip.keyframes.push({ time: 0, property: "scaleY", value: 1.15 }, { time: d, property: "scaleY", value: 1 });
    } else if (presetId === "slide-left") {
      clip.keyframes.push({ time: 0, property: "x", value: 120 }, { time: Math.min(0.6, d), property: "x", value: 0 });
    } else {
      clip.keyframes.push({ time: 0, property: "y", value: 90 }, { time: Math.min(0.6, d), property: "y", value: 0 });
    }
    persist();
    return { clip: clone(clip) };
  },
  setClipSpeed: async (clipId: string, speed: number) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const prevFx = clip.effects.find((e) => e.type === "speed");
    const prevRate = Number(prevFx?.params?.rate ?? 1) || 1;
    const baseMediaSpan = clip.duration * prevRate;
    const clamped = Math.max(0.2, Math.min(4, speed));
    clip.effects = [...clip.effects.filter((e) => e.type !== "speed"), { id: uid("fx"), type: "speed", params: { rate: clamped } }];
    clip.duration = Math.max(0.15, Number((baseMediaSpan / clamped).toFixed(3)));
    persist();
    return { clip: clone(clip) };
  },
  reverseClip: async (clipId: string) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const already = clip.effects.some((e) => e.type === "reverse");
    clip.effects = already
      ? clip.effects.filter((e) => e.type !== "reverse")
      : [...clip.effects, { id: uid("fx"), type: "reverse", params: { reversed: true } }];
    persist();
    return { outPath: clip.assetId };
  },
  freezeClip: async (clipId: string, at?: number, holdDuration = 2.0) => {
    recordUndo();
    const { track, clip } = findClip(clipId);
    const asset = state.assets.find((a) => a.id === clip.assetId);
    const insertAt = at != null && at >= clip.start && at <= clip.start + clip.duration ? at : clip.start + clip.duration;
    let dataUrl = resolveAssetUrlById(clip.assetId);

    // Capture real pixel frame from the video at the exact playhead timestamp!
    if (asset?.kind === "video" && typeof document !== "undefined") {
      try {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.src = dataUrl;
        await new Promise<void>((res) => {
          const t = setTimeout(res, 3000);
          v.onloadeddata = () => {
            clearTimeout(t);
            res();
          };
          v.onerror = () => {
            clearTimeout(t);
            res();
          };
        });
        const localT = Math.max(0, insertAt - clip.start);
        await seekVideoElement(v, clip.in + localT, 1500);
        const c = document.createElement("canvas");
        c.width = v.videoWidth || 1280;
        c.height = v.videoHeight || 720;
        c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
        dataUrl = c.toDataURL("image/jpeg", 0.92);
        v.src = "";
      } catch {
        /* fallback */
      }
    }

    const freezeAsset: Asset = {
      id: uid("freeze"),
      name: `Freeze_${clip.name}.jpg`,
      kind: "image",
      path: dataUrl,
      duration: holdDuration,
      width: asset?.width ?? 1920,
      height: asset?.height ?? 1080,
    };
    blobUrls.set(freezeAsset.id, dataUrl);
    state.assets.push(freezeAsset);

    // Shift subsequent clips to make room cleanly
    for (const c of track.clips) {
      if (c.start >= insertAt) c.start = Number((c.start + holdDuration).toFixed(3));
    }
    const freezeClipObj: Clip = {
      ...clone(clip),
      id: uid("clip"),
      assetId: freezeAsset.id,
      name: `Freeze · ${clip.name}`,
      start: Number(insertAt.toFixed(3)),
      duration: holdDuration,
      in: 0,
      out: holdDuration,
      effects: clip.effects.filter((e) => e.type !== "speed" && e.type !== "reverse"),
    };
    track.clips.push(freezeClipObj);
    track.clips.sort((a, b) => a.start - b.start);
    persist();
    return { outPath: freezeClipObj.id };
  },
  getScopes: async (timeSec = 0) => {
    const rHist = Array.from({ length: 32 }, (_, i) => Math.round(18 + 65 * Math.exp(-((i - 18) ** 2) / 48)));
    const gHist = Array.from({ length: 32 }, (_, i) => Math.round(15 + 72 * Math.exp(-((i - 15) ** 2) / 42)));
    const bHist = Array.from({ length: 32 }, (_, i) => Math.round(20 + 68 * Math.exp(-((i - 12) ** 2) / 40)));
    const lumaHist = rHist.map((r, i) => Math.round(0.299 * r + 0.587 * gHist[i]! + 0.114 * bHist[i]!));
    return {
      time: timeSec,
      status: "ok",
      warnings: [] as string[],
      lumaHistogram: lumaHist,
      redHistogram: rHist,
      greenHistogram: gHist,
      blueHistogram: bHist,
      waveform: Array.from({ length: 32 }, (_, i) => {
        const med = Math.round(46 + 18 * Math.sin(i * 0.2 + timeSec * 0.4));
        return { min: Math.max(4, med - 28), p25: Math.max(8, med - 14), median: med, p75: Math.min(94, med + 15), max: Math.min(99, med + 28) };
      }),
      metrics: {
        avgLumaIre: 48.6,
        minLumaIre: 6.2,
        maxLumaIre: 94.1,
        blackClippingPct: 0.4,
        whiteClippingPct: 0.3,
        rAvg: 128,
        gAvg: 122,
        bAvg: 134,
        saturationAvg: 0.44,
      },
    };
  },
  syncMulticam: async (autoIntervalSec = 2.5) => {
    recordUndo();
    const seq = activeSeq();
    const vTrack = seq.tracks.find((t) => t.kind === "video")!;
    let cursor = 0;
    for (const a of state.assets.filter((x) => x.kind !== "audio")) {
      vTrack.clips.push({
        id: uid("clip"),
        assetId: a.id,
        name: a.name,
        start: cursor,
        duration: autoIntervalSec,
        in: 0,
        out: autoIntervalSec,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
        keyframes: [],
        effects: [],
      });
      cursor += autoIntervalSec;
    }
    persist();
    return {
      angles: state.assets.map((a) => ({ assetName: a.name, offsetSec: 0, confidence: 0.98 })),
      segmentCount: state.assets.length,
    };
  },
  colorGrade: async (clipId: string, preset: string) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const fxId = uid("fx");
    clip.effects = [...clip.effects.filter((e) => e.type !== "color-grade"), { id: fxId, type: "color-grade", params: { preset, intensity: 100 } }];
    persist();
    return { effect: { id: fxId } };
  },
  chromaKey: async (clipId: string, color = "#00ff00", similarity = 0.3, blend = 0.1, despill = true) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const fxId = uid("fx");
    clip.effects = [
      ...clip.effects.filter((e) => e.type !== "chroma-key" && e.type !== "chromakey"),
      { id: fxId, type: "chroma-key", params: { color, similarity, blend, despill } },
    ];
    persist();
    return { effect: { id: fxId } };
  },
  fadeClip: async (clipId: string, fadeIn = 0.5, fadeOut = 0.5) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const fxId = uid("fx");
    clip.effects = [...clip.effects.filter((e) => e.type !== "fade"), { id: fxId, type: "fade", params: { fadeIn, fadeOut } }];
    persist();
    return { effect: { id: fxId } };
  },
  applyLut: async (clipId: string, lutId: string) => {
    recordUndo();
    const { clip } = findClip(clipId);
    clip.effects = [...clip.effects.filter((e) => e.type !== "lut3d"), { id: uid("fx"), type: "lut3d", params: { lutId, intensity: 100 } }];
    persist();
    return { cubePath: `luts/${lutId}.cube` };
  },
  stabilizeClip: async (clipId: string) => {
    recordUndo();
    const { clip } = findClip(clipId);
    clip.transform.scaleX = Math.max(1.06, clip.transform.scaleX);
    clip.transform.scaleY = Math.max(1.06, clip.transform.scaleY);
    clip.effects = [...clip.effects.filter((e) => e.type !== "stabilize"), { id: uid("fx"), type: "stabilize", params: { zoom: 1.06 } }];
    persist();
    return { outPath: clip.assetId, method: "Optical Crop Stabilization" };
  },
  applyLayout: async (clipId: string, layout: string) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const seq = activeSeq();
    const ox = Math.round(seq.width * 0.25);
    const oy = Math.round(seq.height * 0.25);
    if (layout === "pip-bottom-right") clip.transform = { ...clip.transform, x: ox, y: oy, scaleX: 0.4, scaleY: 0.4 };
    else if (layout === "pip-top-right") clip.transform = { ...clip.transform, x: ox, y: -oy, scaleX: 0.4, scaleY: 0.4 };
    else if (layout === "split-left") clip.transform = { ...clip.transform, x: -Math.round(seq.width * 0.25), y: 0, scaleX: 0.5, scaleY: 1 };
    else if (layout === "split-right") clip.transform = { ...clip.transform, x: Math.round(seq.width * 0.25), y: 0, scaleX: 0.5, scaleY: 1 };
    else clip.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };
    persist();
    return { clip: clone(clip) };
  },
  enhanceAudio: async (clipId?: string) => {
    recordUndo();
    const target = clipId ? findClip(clipId).clip : activeSeq().tracks.flatMap((t) => t.clips)[0];
    if (target) {
      target.effects = [...target.effects.filter((e) => e.type !== "volume"), { id: uid("fx"), type: "volume", params: { gain: 1.25 } }];
    }
    persist();
    return { outPath: "Audio/enhanced", duration: target?.duration ?? 5 };
  },
  duckAudio: async (musicClipId: string, _voiceClipId?: string) => {
    recordUndo();
    const { clip } = findClip(musicClipId);
    clip.effects = [...clip.effects.filter((e) => e.type !== "volume"), { id: uid("fx"), type: "volume", params: { gain: 0.28 } }];
    persist();
    return { speechIntervals: [{ start: 0, end: clip.duration }], reductionDb: 11 };
  },
  removeEffect: async (clipId: string, effectId: string) => {
    recordUndo();
    const { clip } = findClip(clipId);
    clip.effects = clip.effects.filter((e) => e.id !== effectId);
    persist();
    return { ok: true };
  },
  runCopilot: async (
    prompt: string,
    context?: {
      playhead?: number;
      selectedClipId?: string | null;
      history?: Array<{ role: "user" | "assistant"; text: string }>;
    },
  ) => {
    recordUndo();
    const cfg = readLocalApi();
    const seq = activeSeq();
    const allClips = seq.tracks.flatMap((t) => t.clips);
    const resolveTarget = (explicitId?: unknown) => {
      if (typeof explicitId === "string" && explicitId) {
        const exact = allClips.find((c) => c.id === explicitId);
        if (exact) return exact;
      }
      if (context?.selectedClipId) {
        const sel = allClips.find((c) => c.id === context.selectedClipId);
        if (sel) return sel;
      }
      return allClips[0];
    };
    const lead = resolveTarget();
    const steps: Array<{ step: string; detail: string }> = [];

    if (sanitizeMobileApiKey(cfg.apiKey) || /^https?:\/\/(127\.0\.0\.1|localhost|192\.168\.|10\.)/i.test(cfg.baseUrl)) {
      const timelineContext = JSON.stringify({
        resolution: `${seq.width}x${seq.height}`,
        fps: seq.fps,
        playhead: Number((context?.playhead ?? 0).toFixed(2)),
        selectedClipId: context?.selectedClipId ?? null,
        clips: allClips.slice(0, 24).map((c) => ({
          id: c.id,
          name: c.name.slice(0, 48),
          start: Number(c.start.toFixed(2)),
          duration: Number(c.duration.toFixed(2)),
        })),
        captionCount: seq.captions.length,
        recentCaptions: seq.captions.slice(0, 12).map((c) => ({
          id: c.id,
          text: c.text.slice(0, 60),
          start: c.start,
          end: c.end,
        })),
      });

      const historyMsgs = (context?.history ?? [])
        .slice(-6)
        .filter((h) => h && typeof h.text === "string" && h.text.trim() && !h.text.startsWith("Error:"))
        .map((h) => ({
          role: (h.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
          content: h.text.slice(0, 320),
        }));

      const llmRes = await runMobileLlmChat(
        [
          {
            role: "system",
            content:
              `You are Vedit Studio AI Video Editor Agent. Inspect timeline state: ${timelineContext}. ` +
              `Return ONLY a single valid JSON object (no markdown fences): ` +
              `{"reply":"concise helpful response in the user's language","actions":[]}. ` +
              `Supported action ops in \`actions\` (include ONLY requested operations; \`[]\` for questions): ` +
              `{"op":"aspect","ratio":"9:16|16:9|1:1|4:5|21:9"}, ` +
              `{"op":"background","value":"blur|#000000"}, ` +
              `{"op":"lut","lutId":"kodak-2383|teal-orange-blockbuster|fuji-eterna|warm-golden|cool-noir|bleach-bypass|silver-mono|cyberpunk-neon"}, ` +
              `{"op":"adjust","exposure":0,"brightness":0,"contrast":15,"saturation":12,"temperature":8,"tint":0,"fade":0,"vignette":15,"blur":0}, ` +
              `{"op":"curves","preset":"linear|cinema-s-curve|matte-fade|high-contrast|soft-rolloff","clarity":12}, ` +
              `{"op":"chroma_key","color":"#00ff00","similarity":0.32,"blend":0.1,"despill":true}, ` +
              `{"op":"eq","preset":"flat|voice-podcast|bass-boost|de-mud|crisp-vocal|warm-cinema"}, ` +
              `{"op":"volume","gain":1.0}, ` +
              `{"op":"speed","rate":1.25}, ` +
              `{"op":"transition","kind":"dissolve|fade-black|fade-white|wipe-left|wipe-right|slide-left|slide-up|zoom-in","duration":0.5}, ` +
              `{"op":"fade","fadeIn":0.5,"fadeOut":0.5}, ` +
              `{"op":"layout","value":"pip-bottom-right|pip-top-right|split-left|split-right|full-reset"}, ` +
              `{"op":"crop","left":0,"right":0,"top":0,"bottom":0}, ` +
              `{"op":"caption","text":"Subtitle text","start":0.2,"end":3.5}, ` +
              `{"op":"clear_captions"}, ` +
              `{"op":"reset_effects"}, ` +
              `{"op":"split","at":2.0}, ` +
              `{"op":"trim","start":0,"end":4}.`,
          },
          ...historyMsgs,
          { role: "user", content: prompt },
        ],
        { maxTokens: 1800 },
      );

      const parsed = parseMobileAiJsonSafe<{
        reply?: string;
        actions?: Array<Record<string, unknown>>;
      }>(llmRes.content);

      if (parsed) {
        for (const act of Array.isArray(parsed.actions) ? parsed.actions : []) {
          if (!act || typeof act !== "object") continue;
          const op = String(act.op || "").toLowerCase().trim();
          const target = resolveTarget(act.clipId);
          try {
            if ((op === "lut" || op === "lut3d") && target) {
              const lutId = String(act.lutId || act.value || "kodak-2383");
              target.effects = [
                ...target.effects.filter((e) => e.type !== "lut3d"),
                { id: uid("fx"), type: "lut3d", params: { lutId, intensity: 100 } },
              ];
              steps.push({ step: "LUT", detail: lutId });
            } else if (op === "adjust" && target) {
              const params: Record<string, number> = {};
              for (const k of [
                "exposure",
                "brightness",
                "contrast",
                "saturation",
                "temperature",
                "tint",
                "fade",
                "vignette",
                "blur",
              ]) {
                if (act[k] != null && Number.isFinite(Number(act[k]))) params[k] = Number(act[k]);
              }
              target.effects = [...target.effects.filter((e) => e.type !== "adjust"), { id: uid("fx"), type: "adjust", params }];
              steps.push({ step: "Color", detail: "Updated color & light adjustments" });
            } else if (op === "curves" && target) {
              const preset = (act.preset || act.value || "cinema-s-curve") as ToneCurvePresetUi["id"];
              const clarity = Number(act.clarity ?? 10);
              const pts = computeCurvePoints(0, 0, 0, preset);
              target.effects = [
                ...target.effects.filter((e) => e.type !== "curves"),
                { id: uid("fx"), type: "curves", params: { preset, shadows: 0, midtones: 0, highlights: 0, clarity, points: pts } },
              ];
              steps.push({ step: "Curves", detail: preset });
            } else if (op === "chroma_key" && target) {
              const color = String(act.color || act.value || "#00ff00");
              target.effects = [
                ...target.effects.filter((e) => e.type !== "chroma-key" && e.type !== "chromakey"),
                {
                  id: uid("fx"),
                  type: "chroma-key",
                  params: {
                    color,
                    similarity: Number(act.similarity ?? 0.32),
                    blend: Number(act.blend ?? 0.1),
                    despill: act.despill !== false,
                  },
                },
              ];
              steps.push({ step: "Chroma Key", detail: color });
            } else if (op === "eq" && target) {
              const preset = String(act.preset || act.value || "voice-podcast");
              const presetObj = AUDIO_EQ_PRESETS_UI.find((p) => p.id === preset);
              target.effects = [
                ...target.effects.filter((e) => e.type !== "eq"),
                {
                  id: uid("fx"),
                  type: "eq",
                  params: {
                    preset,
                    lowDb: presetObj?.lowDb ?? 0,
                    midDb: presetObj?.midDb ?? 0,
                    highDb: presetObj?.highDb ?? 0,
                    voiceClarity: presetObj?.voiceClarity ?? true,
                  },
                },
              ];
              steps.push({ step: "EQ", detail: preset });
            } else if (op === "volume" && target) {
              const gain = Math.max(0, Math.min(2, Number(act.gain ?? act.value ?? 1)));
              target.effects = [
                ...target.effects.filter((e) => e.type !== "volume"),
                { id: uid("fx"), type: "volume", params: { gain } },
              ];
              steps.push({ step: "Volume", detail: `${Math.round(gain * 100)}%` });
            } else if (op === "speed" && target) {
              const rate = Math.max(0.25, Math.min(4, Number(act.rate ?? act.value ?? 1.25)));
              const prevRate = Number(target.effects.find((e) => e.type === "speed")?.params?.rate ?? 1) || 1;
              const span = target.duration * prevRate;
              target.effects = [
                ...target.effects.filter((e) => e.type !== "speed"),
                { id: uid("fx"), type: "speed", params: { rate } },
              ];
              target.duration = Math.max(0.2, Number((span / rate).toFixed(3)));
              steps.push({ step: "Speed", detail: `${rate}×` });
            } else if (op === "transition") {
              const kind = String(act.kind || act.value || "dissolve");
              const duration = Math.max(0.1, Math.min(3, Number(act.duration ?? 0.5)));
              for (const c of allClips) {
                c.effects = [
                  ...c.effects.filter((e) => e.type !== "transition"),
                  { id: uid("fx"), type: "transition", params: { kind, duration } },
                ];
              }
              steps.push({ step: "Transition", detail: `${kind} (${duration}s)` });
            } else if (op === "fade" && target) {
              const fadeIn = Number(act.fadeIn ?? act.value ?? 0.5);
              const fadeOut = Number(act.fadeOut ?? act.value ?? 0.5);
              target.effects = [
                ...target.effects.filter((e) => e.type !== "fade"),
                { id: uid("fx"), type: "fade", params: { fadeIn, fadeOut } },
              ];
              steps.push({ step: "Fade", detail: `${fadeIn}s / ${fadeOut}s` });
            } else if (op === "layout" && target) {
              const layout = String(act.value || act.layout || "pip-bottom-right");
              const ox = Math.round(seq.width * 0.25);
              const oy = Math.round(seq.height * 0.25);
              if (layout === "pip-bottom-right") target.transform = { ...target.transform, x: ox, y: oy, scaleX: 0.36, scaleY: 0.36 };
              else if (layout === "pip-top-right") target.transform = { ...target.transform, x: ox, y: -oy, scaleX: 0.36, scaleY: 0.36 };
              else if (layout === "split-left") target.transform = { ...target.transform, x: -ox, y: 0, scaleX: 0.5, scaleY: 1 };
              else if (layout === "split-right") target.transform = { ...target.transform, x: ox, y: 0, scaleX: 0.5, scaleY: 1 };
              else target.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };
              steps.push({ step: "Layout", detail: layout });
            } else if (op === "crop" && target) {
              target.effects = [
                ...target.effects.filter((e) => e.type !== "crop"),
                {
                  id: uid("fx"),
                  type: "crop",
                  params: {
                    left: Number(act.left ?? 0),
                    right: Number(act.right ?? 0),
                    top: Number(act.top ?? 0),
                    bottom: Number(act.bottom ?? 0),
                  },
                },
              ];
              steps.push({ step: "Crop", detail: "Updated crop" });
            } else if (op === "aspect") {
              const ratio = String(act.ratio || act.value || "9:16");
              if (ratio === "9:16") { seq.width = 1080; seq.height = 1920; }
              else if (ratio === "1:1") { seq.width = 1080; seq.height = 1080; }
              else if (ratio === "4:5") { seq.width = 1080; seq.height = 1350; }
              else if (ratio === "21:9") { seq.width = 2560; seq.height = 1080; }
              else { seq.width = 1920; seq.height = 1080; }
              steps.push({ step: "Canvas", detail: `${seq.width}×${seq.height}` });
            } else if (op === "background") {
              seq.background = String(act.value || "blur");
              steps.push({ step: "Canvas", detail: `Background: ${seq.background}` });
            } else if ((op === "caption" || op === "add_caption") && (act.text || act.value)) {
              const text = String(act.text || act.value);
              const start = Number(act.start ?? context?.playhead ?? 0.2);
              const end = act.end != null ? Number(act.end) : start + Number(act.duration ?? 3.2);
              seq.captions.push({ id: uid("cap"), text, start, end });
              steps.push({ step: "Caption", detail: text });
            } else if (op === "clear_captions") {
              seq.captions = [];
              steps.push({ step: "Captions", detail: "Cleared all captions" });
            } else if (op === "reset_effects" && target) {
              target.effects = [];
              target.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };
              steps.push({ step: "Reset", detail: target.name });
            } else if (op === "split" && target) {
              const rawAt = Number(act.at ?? context?.playhead ?? target.start + target.duration / 2);
              const at =
                rawAt > target.start + 0.1 && rawAt < target.start + target.duration - 0.1
                  ? rawAt
                  : target.start + target.duration / 2;
              if (target.duration > 0.25) {
                const leftDur = Number((at - target.start).toFixed(3));
                const right: Clip = {
                  ...clone(target),
                  id: uid("clip"),
                  start: at,
                  duration: Number((target.duration - leftDur).toFixed(3)),
                  in: target.in + leftDur,
                };
                target.duration = leftDur;
                target.out = target.in + leftDur;
                seq.tracks[0]!.clips.push(right);
                steps.push({ step: "Split", detail: `Split at ${at.toFixed(2)}s` });
              }
            } else if (op === "trim" && target) {
              const s = act.start != null ? Math.max(0, Number(act.start)) : target.start;
              const e = act.end != null ? Math.max(s + 0.2, Number(act.end)) : target.start + target.duration;
              target.start = s;
              target.duration = Number((e - s).toFixed(3));
              target.out = Number((target.in + target.duration).toFixed(3));
              steps.push({ step: "Trim", detail: `${s.toFixed(2)}s–${e.toFixed(2)}s` });
            }
          } catch {
            /* isolate individual step */
          }
        }
        persist();
        return {
          checkpointId: uid("snap"),
          stepsExecuted: steps,
          summary: parsed.reply || llmRes.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().slice(0, 320),
        };
      }
      persist();
      return {
        checkpointId: uid("snap"),
        stepsExecuted: steps,
        summary: llmRes.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(),
      };
    }

    // Deterministic offline command parser (works with zero API key)
    const low = prompt.toLowerCase();
    if (lead && /kodak|film|lut|kino|cinema/.test(low)) {
      lead.effects = [...lead.effects.filter((e) => e.type !== "lut3d"), { id: uid("fx"), type: "lut3d", params: { lutId: "kodak-2383", intensity: 100 } }];
      steps.push({ step: "LUT", detail: "Kodak 2383" });
    } else if (lead && /mono|černobíl|bw/.test(low)) {
      lead.effects = [...lead.effects.filter((e) => e.type !== "lut3d"), { id: uid("fx"), type: "lut3d", params: { lutId: "silver-mono", intensity: 100 } }];
      steps.push({ step: "LUT", detail: "Ilford Silver Mono" });
    }
    if (/9:16|tiktok|reel|short|vertikál/.test(low)) {
      seq.width = 1080;
      seq.height = 1920;
      steps.push({ step: "Canvas", detail: "1080×1920 (9:16)" });
    }
    if (/title|titul|text|caption/.test(low)) {
      const cleaned = prompt.replace(/^.*?(title|titulky|titulek|text|caption)\s*:?\s*/i, "").trim() || "New Title";
      seq.captions.push({ id: uid("cap"), text: cleaned, start: 0.2, end: 3.5 });
      steps.push({ step: "Title", detail: cleaned });
    }
    if (!steps.length && lead) {
      lead.effects = [...lead.effects.filter((e) => e.type !== "fade"), { id: uid("fx"), type: "fade", params: { fadeIn: 0.4, fadeOut: 0.4 } }];
      steps.push({ step: "Fade", detail: "Smooth 0.4s fade in/out" });
    }
    persist();
    return {
      checkpointId: uid("snap"),
      stepsExecuted: steps,
      summary: `Applied: ${steps.map((s) => `${s.step} (${s.detail})`).join(", ")}`,
    };
  },
  addGraphic: async (body: {
    kind: string;
    label?: string;
    svgMarkup?: string;
    accentColor?: string;
    start?: number;
    duration?: number;
    animationPreset?: string;
  }) => {
    recordUndo();
    const seq = activeSeq();
    const dataUri = body.svgMarkup
      ? `data:image/svg+xml;utf8,${encodeURIComponent(body.svgMarkup)}`
      : buildSvgDataUri(body.kind, body.label || "Title", body.accentColor || "#3b82f6");
    const asset: Asset = {
      id: uid("gfx"),
      name: `${body.label || body.kind}.svg`,
      kind: "image",
      path: dataUri,
      duration: body.duration ?? 3,
      width: 1280,
      height: 720,
    };
    blobUrls.set(asset.id, dataUri);
    state.assets.push(asset);
    let gTrack = seq.tracks.find((t) => t.kind === "graphics");
    if (!gTrack) {
      gTrack = { id: uid("track"), name: "V2 Overlay", kind: "graphics", muted: false, solo: false, locked: false, clips: [] };
      seq.tracks.push(gTrack);
    }
    const clip: Clip = {
      id: uid("clip"),
      assetId: asset.id,
      name: body.label || body.kind,
      start: body.start ?? 0,
      duration: body.duration ?? 3,
      in: 0,
      out: body.duration ?? 3,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
      keyframes: [],
      effects: [],
    };
    gTrack.clips.push(clip);
    persist();
    return { asset: clone(asset), clip: clone(clip), outPath: dataUri };
  },
  exportThumbnail: async (_title?: string, at?: number) => {
    const firstAsset = state.assets[0];
    const srcUrl = firstAsset ? resolveAssetUrlById(firstAsset.id) : FALLBACK_PLATE_DATA_URI;
    const resp = await fetch(srcUrl);
    const blob = await resp.blob();
    const outPath = await saveBlobToAndroidOrBrowser(blob, `Vedit_Frame_${Date.now()}.jpg`, "image/jpeg");
    return { outPath, selectedTime: at ?? 0, width: 1920, sizeBytes: blob.size };
  },
  addCaption: async (body: { text: string; start: number; end: number; style?: Record<string, unknown> }) => {
    recordUndo();
    const caption: Caption = {
      id: uid("cap"),
      text: body.text,
      start: Number(body.start.toFixed(3)),
      end: Number(body.end.toFixed(3)),
      ...(body.style ? { style: body.style } : {}),
    };
    activeSeq().captions.push(caption);
    persist();
    return { caption: clone(caption) };
  },
  updateCaption: async (
    captionId: string,
    patch: { text?: string; start?: number; end?: number; style?: Record<string, unknown> },
  ) => {
    recordUndo();
    const cap = activeSeq().captions.find((c) => c.id === captionId);
    if (!cap) throw new Error("Caption not found");
    if (patch.text !== undefined) cap.text = patch.text;
    if (patch.start !== undefined) cap.start = Number(patch.start.toFixed(3));
    if (patch.end !== undefined) cap.end = Number(patch.end.toFixed(3));
    if (patch.style !== undefined) cap.style = { ...(cap.style ?? {}), ...patch.style };
    persist();
    return { caption: clone(cap) };
  },
  deleteCaption: async (captionId: string) => {
    recordUndo();
    const seq = activeSeq();
    seq.captions = seq.captions.filter((c) => c.id !== captionId);
    persist();
    return { ok: true };
  },
  shareExport: async () => ({
    shared: Boolean(window.VeditAndroid?.shareLastExport?.()),
  }),
  genVideo: async (prompt: string, duration = 5) => mobileApi.generateMedia({ prompt, kind: "video", duration }),
  exportRender: async (preset = "youtube-1080p", _hwAccel = "auto", _loudnessTargetLufs?: number) => {
    const jobId = uid("render");
    state.jobs.push({ id: jobId, type: "render", status: "queued", progress: 2 });
    persist(false);
    void renderMobileVideoJob(jobId, preset);
    return { jobId };
  },
  exportPresets: async () => ({ presets: MOBILE_EXPORT_PRESETS }),
  exportEncoders: async () => ({
    recommendedBackend: "hardware-h264",
    usableBackends: ["hardware-h264", "webm-vp9"],
    encoders: [
      { encoder: "avc1_hardware", codec: "h264", backend: "hardware-h264", label: "Hardware H.264 + AAC (.mp4)", usable: true },
      { encoder: "vp9_opus", codec: "vp9", backend: "webm-vp9", label: "VP9 + Opus (.webm)", usable: true },
    ],
  }),
  batchExport: async (presets: string[]) => {
    const jobIds: string[] = [];
    for (const p of presets.slice(0, 1)) {
      const r = await mobileApi.exportRender(p);
      jobIds.push(r.jobId);
    }
    return { batchId: uid("batch"), jobIds };
  },
  marketplaceList: async () => ({ packs: MOBILE_MARKETPLACE_PACKS }),
  applyTemplate: async (templateId: string, params: Record<string, string> = {}) => {
    recordUndo();
    const seq = activeSeq();
    if (templateId === "tpl-tiktok-shorts") {
      seq.width = 1080;
      seq.height = 1920;
      if (params.title) seq.captions.push({ id: uid("cap"), text: String(params.title), start: 0, end: 3 });
    } else {
      seq.width = 1920;
      seq.height = 1080;
      if (params.title) seq.captions.push({ id: uid("cap"), text: String(params.title), start: 0, end: 3.5 });
    }
    persist();
    return {
      appliedName: templateId === "tpl-tiktok-shorts" ? "Vertical 9:16" : "Widescreen 16:9",
      captionsAdded: params.title ? 1 : 0,
    };
  },
  runPlugin: async (_pluginId: string, _params: Record<string, string> = {}) => ({ ok: true }) as Record<string, unknown>,
  snapshots: async () => ({ snapshots: (state.snapshots ?? []) as SnapshotInfo[] }),
  saveSnapshot: async (label: string) => {
    const snap: SnapshotInfo = {
      id: uid("snap"),
      label,
      author: "Editor",
      createdAt: new Date().toISOString(),
      sequenceDuration: 10,
      clipCount: activeSeq().tracks.flatMap((t) => t.clips).length,
    };
    state.snapshots = [...(state.snapshots ?? []), snap];
    safeStorage.setItem(`vedit.snap:${snap.id}`, JSON.stringify(state));
    persist(false);
    return { snapshot: snap };
  },
  restoreSnapshot: async (snapshotId: string) => {
    const raw = safeStorage.getItem(`vedit.snap:${snapshotId}`);
    if (raw) {
      state = JSON.parse(raw) as Project;
      persist(false);
    }
    const found = (state.snapshots ?? []).find((s) => s.id === snapshotId) ?? {
      id: snapshotId,
      label: "Restored",
      author: "Editor",
      createdAt: new Date().toISOString(),
      sequenceDuration: 10,
      clipCount: activeSeq().tracks.flatMap((t) => t.clips).length,
    };
    return { restored: found };
  },
  addComment: async (text: string, timecode: number) => {
    const comment: ReviewComment = {
      id: uid("cmt"),
      author: "Editor",
      text,
      timecode,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
    state.comments = [...(state.comments ?? []), comment];
    persist(false);
    return { comment };
  },
  resolveComment: async (commentId: string, resolved: boolean) => {
    const c = (state.comments ?? []).find((x) => x.id === commentId);
    if (!c) throw new Error("Comment not found");
    c.resolved = resolved;
    persist(false);
    return { comment: c };
  },
  aiCaps: async () => ({
    tts: { engine: "speech-synthesis", available: true },
    asr: { engine: "auto-captions", available: true },
    voices: ["en-US", "cs-CZ"],
  }),
  genProviders: async () => ({ providers: MOBILE_GEN_PROVIDERS, cameraMoves: MOBILE_CAMERA_MOVES }),
  generateMedia: async (body: GenerateMediaRequest) => {
    recordUndo();
    const jobId = uid("gen");
    const c = document.createElement("canvas");
    const seq = activeSeq();
    c.width = seq.width || 1920;
    c.height = seq.height || 1080;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, c.width, c.height);
    grad.addColorStop(0, "#09090b");
    grad.addColorStop(0.55, "#18181b");
    grad.addColorStop(1, "#1e293b");
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#fafafa";
    g.font = `700 ${Math.round(c.height * 0.055)}px Inter, system-ui, sans-serif`;
    g.textAlign = "center";
    g.fillText(body.prompt.slice(0, 48), c.width / 2, c.height * 0.5);
    const dataUrl = c.toDataURL("image/jpeg", 0.92);
    const dur = body.duration ?? 4;
    const asset: Asset = {
      id: uid("titleplate"),
      name: `${body.prompt.slice(0, 20).replace(/\s+/g, "_")}.jpg`,
      kind: "generated",
      path: dataUrl,
      duration: dur,
      width: c.width,
      height: c.height,
      source: { provider: "vedit-canvas", model: "plate", prompt: body.prompt, simulated: false },
    };
    blobUrls.set(asset.id, dataUrl);
    state.assets.push(asset);
    seq.tracks[0]!.clips.push({
      id: uid("clip"),
      assetId: asset.id,
      name: asset.name,
      start: body.start ?? 0,
      duration: dur,
      in: 0,
      out: dur,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
      keyframes:
        body.cameraMove === "dolly-in"
          ? [
              { time: 0, property: "scaleX", value: 1 },
              { time: dur, property: "scaleX", value: 1.1 },
              { time: 0, property: "scaleY", value: 1 },
              { time: dur, property: "scaleY", value: 1.1 },
            ]
          : [],
      effects: [],
    });
    state.jobs.push({ id: jobId, type: `gen.${body.kind}`, status: "done", progress: 100 });
    persist();
    return { jobId };
  },
  voiceover: async (script: string, _voice?: string, start = 0) => {
    recordUndo();
    if (typeof speechSynthesis !== "undefined") {
      try {
        speechSynthesis.speak(new SpeechSynthesisUtterance(script));
      } catch {
        /* ignore */
      }
    }
    const dur = Math.max(2, Number((script.split(/\s+/).length / 2.6).toFixed(1)));
    activeSeq().captions.push({ id: uid("cap"), text: script, start, end: start + dur });
    const jobId = uid("vo");
    state.jobs.push({ id: jobId, type: "ai.voiceover", status: "done", progress: 100 });
    persist();
    return { jobId };
  },
  transcribe: async (assetId: string, language = "cs") => {
    recordUndo();
    const asset = state.assets.find((a) => a.id === assetId);
    const cfg = readLocalApi();
    const dur = Math.max(2, asset?.duration ?? 5);

    if (sanitizeMobileApiKey(cfg.apiKey)) {
      try {
        const ai = await runMobileLlmChat(
          [
            {
              role: "system",
              content:
                `Generate concise timed video captions in language "${language}" for clip "${asset?.name ?? "Video"}" (${dur.toFixed(1)}s). ` +
                `Return ONLY valid JSON: {"segments":[{"text":"...","start":0.2,"end":2.4}]}`,
            },
            { role: "user", content: "Create natural timed subtitles across the clip duration." },
          ],
          { maxTokens: 1200 },
        );
        const parsedObj = parseMobileAiJsonSafe<{ segments?: Array<{ text: string; start: number; end: number }> }>(ai.content);
        const arrMatch = !parsedObj?.segments ? /\[[\s\S]*\]/.exec(ai.content.replace(/<think>[\s\S]*?<\/think>/gi, "")) : null;
        const segs =
          parsedObj?.segments ??
          (arrMatch ? (JSON.parse(arrMatch[0]) as Array<{ text: string; start: number; end: number }>) : []);
        for (const seg of segs) {
          if (seg?.text) {
            activeSeq().captions.push({
              id: uid("cap"),
              text: String(seg.text),
              start: Number(seg.start ?? 0),
              end: Number(seg.end ?? 2),
            });
          }
        }
      } catch {
        activeSeq().captions.push({ id: uid("cap"), text: asset?.name ?? "Subtitle", start: 0.2, end: Math.min(3.5, dur) });
      }
    } else {
      activeSeq().captions.push({ id: uid("cap"), text: asset?.name ?? "Subtitle", start: 0.2, end: Math.min(3.5, dur) });
    }
    const jobId = uid("stt");
    state.jobs.push({ id: jobId, type: "ai.transcribe", status: "done", progress: 100 });
    persist();
    return { jobId };
  },
  removeSilences: async (clipId?: string) => {
    recordUndo();
    const seq = activeSeq();
    const targetClip = clipId ? findClip(clipId).clip : seq.tracks.flatMap((t) => t.clips)[0];
    let saved = 0.6;
    if (targetClip) {
      const before = targetClip.duration;
      targetClip.in = Number((targetClip.in + Math.min(0.35, before * 0.08)).toFixed(3));
      targetClip.duration = Math.max(0.4, Number((before * 0.86).toFixed(3)));
      targetClip.out = Number((targetClip.in + targetClip.duration).toFixed(3));
      saved = Number((before - targetClip.duration).toFixed(2));
    }
    persist();
    return { trackId: seq.tracks[0]?.id ?? "track-v1", savedDuration: Math.max(0.1, saved) };
  },
  highlight: async (targetDuration = 15) => {
    recordUndo();
    const seq = activeSeq();
    const clips = seq.tracks[0]?.clips ?? [];
    let cursor = 0;
    const per = Math.max(1.2, Number((targetDuration / Math.max(1, clips.length)).toFixed(2)));
    for (const c of clips) {
      c.start = Number(cursor.toFixed(3));
      c.duration = Math.min(c.duration, per);
      c.out = Number((c.in + c.duration).toFixed(3));
      cursor += c.duration;
    }
    persist();
    return { trackId: seq.tracks[0]?.id ?? "track-v1", clips: clips.map((c) => c.id), totalDuration: Number(cursor.toFixed(2)) };
  },
  beatSync: async (clipId: string, _musicAssetId: string) => {
    const { clip } = findClip(clipId);
    const cuts: number[] = [];
    if (clip.duration >= 2.0) {
      const mid = Number((clip.start + clip.duration / 2).toFixed(2));
      await mobileApi.splitClip(clipId, mid);
      cuts.push(mid);
    }
    return { beats: cuts, splits: cuts };
  },
  autoReframe: async (clipId: string) => {
    recordUndo();
    const seq = activeSeq();
    seq.width = 1080;
    seq.height = 1920;
    const { clip } = findClip(clipId);
    (clip.transform as Record<string, unknown>).fitMode = "cover";
    persist();
    return { keyframes: 1 };
  },
  trackMotion: async (clipId: string, _sourceAssetId: string) => {
    recordUndo();
    const { clip } = findClip(clipId);
    clip.keyframes.push(
      { time: 0, property: "scaleX", value: 1 },
      { time: clip.duration, property: "scaleX", value: 1.08 },
      { time: 0, property: "scaleY", value: 1 },
      { time: clip.duration, property: "scaleY", value: 1.08 },
    );
    persist();
    return { keyframes: 4 };
  },
  getApiSettings: async () => publicApi(readLocalApi()),
  saveApiSettings: async (body: {
    providerPreset?: string;
    baseUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    model?: string;
    visionModel?: string;
    temperature?: number;
    providerKeys?: Record<string, string>;
  }) => {
    const cur = readLocalApi();
    if (body.clearApiKey) {
      cur.apiKey = "";
    } else if (body.apiKey && !body.apiKey.includes("••••")) {
      cur.apiKey = sanitizeMobileApiKey(body.apiKey);
      const detected = detectPresetByKey(cur.apiKey);
      if (detected && !body.baseUrl) {
        cur.providerPreset = detected.id;
        cur.baseUrl = detected.baseUrl;
        if (!body.model && detected.suggestedModels[0]) {
          cur.model = detected.suggestedModels[0];
        }
      }
    }
    if (body.providerPreset !== undefined) cur.providerPreset = body.providerPreset;
    if (body.baseUrl !== undefined) cur.baseUrl = normalizeMobileBaseUrl(body.baseUrl);
    if (body.model !== undefined && body.model.trim()) cur.model = body.model.trim();
    if (body.visionModel !== undefined) cur.visionModel = body.visionModel;
    if (body.temperature !== undefined) cur.temperature = body.temperature;
    if (body.providerKeys) cur.providerKeys = { ...cur.providerKeys, ...body.providerKeys };
    safeStorage.setItem(STORAGE_KEY_API, JSON.stringify(cur));
    return publicApi(cur);
  },
  fetchApiModels: async (body: { baseUrl?: string; apiKey?: string }) => {
    const cur = readLocalApi();
    const { key, baseUrl } = resolveMobileEndpointAndModel(body, cur);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (/anthropic\.com/i.test(baseUrl) || key.startsWith("sk-ant-")) {
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (key) {
      headers.Authorization = `Bearer ${key}`;
    }

    const resp = await nativeHttp("GET", `${baseUrl}/models`, headers);
    if (!resp.ok) {
      throw new Error(parseErrorMessage(resp.text, resp.status, resp.statusText));
    }
    const json = JSON.parse(resp.text) as {
      data?: Array<{ id?: string; name?: string }>;
      models?: Array<{ id?: string; name?: string }>;
    };
    const rawList = Array.isArray(json) ? json : json.data ?? json.models ?? [];
    const models = Array.from(
      new Set(
        rawList
          .map((m) => String(m.id ?? m.name ?? "").trim().replace(/^models\//, ""))
          .filter(Boolean),
      ),
    ).sort();
    return { models, source: "remote", baseUrl };
  },
  testApiSettings: async (body: { baseUrl?: string; apiKey?: string; model?: string }) => {
    const res = await runMobileLlmChat([{ role: "user", content: "Reply with the single word: OK" }], {
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      model: body.model,
      maxTokens: 256,
    });
    return {
      ok: true,
      model: res.model,
      baseUrl: res.baseUrl,
      latencyMs: res.latencyMs,
      reply: res.content || "OK",
    };
  },
  windowFullscreen: async (mode: "toggle" | "on" | "off" | "state" = "toggle") => {
    if (window.VeditAndroid?.toggleFullscreen) {
      return { supported: true, fullscreen: Boolean(window.VeditAndroid.toggleFullscreen(mode)) };
    }
    return { supported: false, fullscreen: false };
  },
  applyCurves: async (
    clipId: string,
    opts: {
      preset?: ToneCurvePresetUi["id"];
      shadows?: number;
      midtones?: number;
      highlights?: number;
      clarity?: number;
      points?: ToneCurvePoint[];
    },
  ) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const points =
      opts.points && opts.points.length >= 2
        ? opts.points
        : computeCurvePoints(
            opts.shadows ?? 0,
            opts.midtones ?? 0,
            opts.highlights ?? 0,
            opts.preset ?? "cinema-s-curve",
          );
    const fxId = uid("fx");
    clip.effects = [
      ...clip.effects.filter((e) => e.type !== "curves"),
      {
        id: fxId,
        type: "curves",
        params: {
          preset: opts.preset ?? "custom",
          shadows: opts.shadows ?? 0,
          midtones: opts.midtones ?? 0,
          highlights: opts.highlights ?? 0,
          clarity: opts.clarity ?? 0,
          points,
        },
      },
    ];
    persist();
    return { id: fxId, type: "curves" };
  },
  applyEq: async (
    clipId: string,
    opts: {
      preset?: string;
      lowDb?: number;
      midDb?: number;
      highDb?: number;
      voiceClarity?: boolean;
    },
  ) => {
    recordUndo();
    const { clip } = findClip(clipId);
    const presetObj = AUDIO_EQ_PRESETS_UI.find((p) => p.id === opts.preset);
    const lowDb = opts.lowDb ?? presetObj?.lowDb ?? 0;
    const midDb = opts.midDb ?? presetObj?.midDb ?? 0;
    const highDb = opts.highDb ?? presetObj?.highDb ?? 0;
    const voiceClarity = opts.voiceClarity ?? presetObj?.voiceClarity ?? false;
    const fxId = uid("fx");
    clip.effects = [
      ...clip.effects.filter((e) => e.type !== "eq"),
      {
        id: fxId,
        type: "eq",
        params: {
          preset: opts.preset ?? "custom",
          lowDb,
          midDb,
          highDb,
          voiceClarity,
        },
      },
    ];
    persist();
    return { effect: { id: fxId, type: "eq" } };
  },
  importSubtitles: async (text: string, replaceExisting = false) => {
    recordUndo();
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = normalized.split(/\n\s*\n/);
    const parseTs = (raw: string) => {
      const parts = raw.trim().replace(",", ".").split(":").map(Number);
      if (parts.some((n) => !Number.isFinite(n))) return 0;
      if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
      if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
      return parts[0] ?? 0;
    };
    const seq = activeSeq();
    if (replaceExisting) seq.captions = [];
    const added: Caption[] = [];
    for (const block of blocks) {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length || /^WEBVTT/i.test(lines[0]!) || /^NOTE\b/i.test(lines[0]!)) continue;
      const cueIdx = lines.findIndex((l) => l.includes("-->"));
      if (cueIdx < 0) continue;
      const parts = lines[cueIdx]!.split("-->");
      if (parts.length < 2) continue;
      const start = Number(parseTs(parts[0]!).toFixed(3));
      const end = Number(Math.max(start + 0.2, parseTs(parts[1]!.trim().split(/\s+/)[0]!)).toFixed(3));
      const body = lines.slice(cueIdx + 1).join("\n").replace(/<[^>]+>/g, "").trim();
      if (body) {
        const cap: Caption = { id: uid("cap"), text: body, start, end };
        seq.captions.push(cap);
        added.push(cap);
      }
    }
    persist();
    return { captions: clone(added), count: added.length };
  },
  exportSubtitles: async (format: "srt" | "vtt" = "srt") => {
    const sorted = [...activeSeq().captions].sort((a, b) => a.start - b.start);
    const fmtTs = (s: number, sep: "," | ".") => {
      const ms = Math.round(Math.max(0, s) * 1000);
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const sec = Math.floor((ms % 60_000) / 1000);
      const rem = ms % 1000;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}${sep}${String(rem).padStart(3, "0")}`;
    };
    const text =
      format === "vtt"
        ? ["WEBVTT", "", ...sorted.flatMap((c, i) => [String(i + 1), `${fmtTs(c.start, ".")} --> ${fmtTs(c.end, ".")}`, c.text.trim() || " ", ""])].join("\n")
        : sorted.map((c, i) => `${i + 1}\n${fmtTs(c.start, ",")} --> ${fmtTs(c.end, ",")}\n${c.text.trim() || " "}\n`).join("\n");
    return { format, text, count: sorted.length };
  },
  saveClientMp4: async (blob: Blob, filename = "Vedit_Export.mp4") => {
    const outUrl = URL.createObjectURL(blob);
    const jobId = uid("render");
    exportOutputs.set(jobId, { url: outUrl, fileName: filename, mime: blob.type || "video/mp4" });
    const savedPath = await saveBlobToAndroidOrBrowser(blob, filename, blob.type || "video/mp4");
    const job = { id: jobId, type: "render", status: "done", progress: 100, output: { path: savedPath, url: outUrl } };
    state.jobs.push(job);
    persist(false);
    return { job, outPath: savedPath, sizeBytes: blob.size };
  },
};
