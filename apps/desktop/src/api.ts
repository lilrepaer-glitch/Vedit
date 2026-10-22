// Client for the Vedit REST & WebSocket API (PLAN.md §5).

export interface Clip {
  id: string;
  assetId: string;
  name: string;
  start: number;
  duration: number;
  in: number;
  out: number;
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number; opacity: number };
  keyframes: Array<{ time: number; property: string; value: number | string; easing?: string }>;
  effects: Array<{ id: string; type: string; params: Record<string, unknown> }>;
}

export interface Track {
  id: string;
  name: string;
  kind: "video" | "audio" | "text" | "graphics";
  muted: boolean;
  solo: boolean;
  locked: boolean;
  volumeDb?: number;
  pan?: number;
  clips: Clip[];
}

export interface Asset {
  id: string;
  name: string;
  kind: "video" | "audio" | "image" | "generated";
  path: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  tags?: string[];
  source?: {
    provider?: string;
    model?: string;
    prompt?: string;
    directedPrompt?: string;
    cameraMove?: string;
    seed?: number;
    continuityFrom?: string;
    simulated?: boolean;
  };
}

export interface Caption {
  id: string;
  text: string;
  start: number;
  end: number;
}

export interface ReviewComment {
  id: string;
  author: string;
  text: string;
  timecode: number;
  resolved: boolean;
  createdAt: string;
}

export interface TimelineMarker {
  id: string;
  time: string | number;
  label: string;
  color?: string;
}

export interface SnapshotInfo {
  id: string;
  label: string;
  author?: string;
  createdAt: string;
  sequenceDuration: number;
  clipCount: number;
}

export interface MarketplacePackInfo {
  id: string;
  kind: "template" | "plugin";
  name: string;
  author: string;
  version: string;
  category: string;
  description: string;
  installed: boolean;
}

export interface ExportPresetInfo {
  id: string;
  label: string;
  platform: string;
  format: "mp4" | "mov" | "webm" | "gif";
  codec: "h264" | "h265" | "prores" | "vp9" | "gif";
}

export interface Project {
  id: string;
  name: string;
  assets: Asset[];
  sequences: Array<{
    id: string;
    name: string;
    width: number;
    height: number;
    fps: number;
    tracks: Track[];
    captions: Caption[];
  }>;
  activeSequenceId: string;
  jobs: Array<{ id: string; type: string; status: string; progress: number; error?: string; output?: Record<string, unknown> }>;
  comments?: ReviewComment[];
  markers?: TimelineMarker[];
  snapshots?: SnapshotInfo[];
}

export interface GenProviderInfo {
  id: string;
  label: string;
  available: boolean;
  cloud: boolean;
  reason?: string;
  kinds: Array<"video" | "image" | "music" | "sfx" | "voice">;
  defaultModel: string;
  models: string[];
}

export interface ApiPresetInfo {
  id: string;
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  suggestedModels: string[];
}

export interface ApiSettingsResponse {
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

export interface CameraMoveInfo {
  id: string;
  label: string;
  directive: string;
}

const env = (import.meta as { env?: Record<string, string> }).env;

/**
 * Resolve API & WebSocket origin cleanly across all desktop and dev environments:
 * - When navigated directly onto the local Vedit Engine (`http://127.0.0.1:<port>/`), use same-origin relative URLs (`""`)
 *   so dynamic port fallback (when Windows WinNAT/Hyper-V excludes 47000) works automatically with zero CORS!
 * - When still on initial Tauri custom scheme (`tauri://localhost` / `http(s)://tauri.localhost`), talk to `http://127.0.0.1:47000`.
 * - In Vite dev mode (`localhost:5173`), use relative URLs proxied by Vite.
 */
const servedDirectlyByEngine =
  typeof window !== "undefined" &&
  (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
  location.port !== "5173";

const isDesktop =
  typeof window !== "undefined" &&
  !servedDirectlyByEngine &&
  (location.protocol === "tauri:" ||
    location.hostname === "tauri.localhost" ||
    location.hostname.endsWith(".localhost"));
const API_ORIGIN = env?.VITE_API_BASE ?? (isDesktop ? "http://127.0.0.1:47000" : "");

import {
  IS_ANDROID_APK,
  mobileApi,
  resolveMobileMediaUrl,
  subscribeMobileChanges,
} from "./mobileRuntime";

const API_TOKEN = env?.VITE_API_TOKEN ?? "dev";

export function apiUrl(path: string): string {
  return `${API_ORIGIN}/api/v1${path}`;
}

export function withToken(url: string): string {
  if (IS_ANDROID_APK) return resolveMobileMediaUrl(url);
  const abs = url.startsWith("/") ? `${API_ORIGIN}${url}` : url;
  return `${abs}${abs.includes("?") ? "&" : "?"}token=${encodeURIComponent(API_TOKEN)}`;
}

async function req<T>(method: string, path: string, body?: unknown, timeoutMs = 60000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${API_TOKEN}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* text */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface GenerateMediaRequest {
  kind: "video" | "image" | "music" | "sfx" | "voice";
  prompt: string;
  provider?: string;
  model?: string;
  duration?: number;
  cameraMove?: string;
  continuityFromClipId?: string;
  insertToTimeline?: boolean;
  start?: number;
}

const rawApi = {
  listProjects: () => req<{ projects: Array<{ id: string; name: string }> }>("GET", "/projects"),
  getProject: (id: string) => req<{ project: Project }>("GET", `/projects/${id}`),
  createProject: (name: string, sample = true) => req<{ project: Project }>("POST", "/projects", { name, sample }),
  addAsset: (input: Partial<Asset> & { name: string; path: string }) =>
    req<{ asset: Asset }>("POST", `/projects/${currentId}/assets`, input),
  addTrack: (kind: string, name?: string) =>
    req<{ track: Track }>("POST", `/projects/${currentId}/tracks`, { kind, name }),
  updateTrack: (
    trackId: string,
    patch: { muted?: boolean; solo?: boolean; locked?: boolean; volumeDb?: number; pan?: number; name?: string },
  ) => req<{ track: Track }>(`PATCH`, `/projects/${currentId}/tracks/${trackId}`, patch),
  waveform: (assetId: string, samples = 96) =>
    req<{ peaks: number[]; samples: number }>("GET", `/projects/${currentId}/assets/${assetId}/waveform?samples=${samples}`),
  addGraphic: (input: {
    kind: string;
    label?: string;
    svgMarkup?: string;
    accentColor?: string;
    start?: number;
    duration?: number;
    animationPreset?: string;
  }) => req<{ asset: Asset; clip: Clip; outPath: string }>("POST", `/projects/${currentId}/graphics`, input),
  exportThumbnail: (title?: string, at?: number) =>
    req<{ outPath: string; selectedTime: number; width: number; sizeBytes: number }>(
      "POST",
      `/projects/${currentId}/thumbnail`,
      { ...(title ? { title } : {}), ...(at != null ? { at } : {}) },
    ),
  updateAsset: (assetId: string, patch: { name?: string; path?: string; tags?: string[] }) =>
    req<{ asset: Asset }>(`PATCH`, `/projects/${currentId}/assets/${assetId}`, patch),
  runCopilot: (prompt: string) =>
    req<{ summary: string; checkpointId: string; stepsExecuted: Array<{ step: string; detail: string }> }>(
      "POST",
      `/projects/${currentId}/copilot`,
      { prompt },
    ),
  applyLut: (clipId: string, lutId: string) =>
    req<{ cubePath: string }>(`POST`, `/projects/${currentId}/clips/${clipId}/lut`, { lutId }),
  stabilizeClip: (clipId: string) =>
    req<{ outPath: string; method: string }>(`POST`, `/projects/${currentId}/clips/${clipId}/stabilize`, {}),
  applyLayout: (clipId: string, layout: string) =>
    req<{ clip: Clip }>(`POST`, `/projects/${currentId}/clips/${clipId}/layout`, { layout }),
  getScopes: (time: number) =>
    req<{
      time: number;
      status: string;
      warnings: string[];
      lumaHistogram: number[];
      redHistogram: number[];
      greenHistogram: number[];
      blueHistogram: number[];
      waveform: Array<{ min: number; p25: number; median: number; p75: number; max: number }>;
      metrics: {
        avgLumaIre: number;
        minLumaIre: number;
        maxLumaIre: number;
        blackClippingPct: number;
        whiteClippingPct: number;
        rAvg: number;
        gAvg: number;
        bAvg: number;
        saturationAvg: number;
      };
    }>(`GET`, `/projects/${currentId}/scopes?time=${encodeURIComponent(time.toFixed(3))}`),
  reverseClip: (clipId: string) =>
    req<{ outPath: string }>(`POST`, `/projects/${currentId}/clips/${clipId}/reverse`, {}),
  freezeClip: (clipId: string, at?: number, holdDuration = 1.5) =>
    req<{ outPath: string }>(`POST`, `/projects/${currentId}/clips/${clipId}/freeze`, {
      ...(at != null ? { at } : {}),
      holdDuration,
    }),
  syncMulticam: (autoIntervalSec = 2.5) =>
    req<{ referenceAssetId: string; angles: Array<{ assetName: string; offsetSec: number; confidence: number }> }>(
      `POST`,
      `/projects/${currentId}/multicam/sync`,
      {},
    ).then(async (syncRes) => {
      const cutRes = await req<{ segmentCount: number }>(`POST`, `/projects/${currentId}/multicam/cuts`, {
        autoIntervalSec,
      });
      return { angles: syncRes.angles, segmentCount: cutRes.segmentCount };
    }),
  addClip: (input: { trackId: string; assetId: string; start: number; duration?: number; in?: number; out?: number }) =>
    req<{ clip: Clip }>("POST", `/projects/${currentId}/clips`, input),
  splitClip: (clipId: string, at: number) =>
    req<{ left: Clip; right: Clip }>("POST", `/projects/${currentId}/clips/${clipId}/split`, { at }),
  deleteClip: (clipId: string, ripple = false) =>
    req<{ ok: boolean }>("DELETE", `/projects/${currentId}/clips/${clipId}${ripple ? "?ripple=1" : ""}`),
  updateClip: (clipId: string, patch: Record<string, unknown>) =>
    req<{ clip: Clip }>("PATCH", `/projects/${currentId}/clips/${clipId}`, patch),
  applyPreset: (clipId: string, preset: string) =>
    req<{ clip: Clip }>("POST", `/projects/${currentId}/clips/${clipId}/animation`, { preset }),
  addCaption: (input: { text: string; start: number; end: number }) =>
    req<{ caption: Caption }>("POST", `/projects/${currentId}/captions`, input),
  undo: () => req<{ ok: boolean }>("POST", `/projects/${currentId}/undo`),
  redo: () => req<{ ok: boolean }>("POST", `/projects/${currentId}/redo`),
  genProviders: () => req<{ providers: GenProviderInfo[]; cameraMoves: CameraMoveInfo[] }>("GET", "/gen/providers"),
  generateMedia: (input: GenerateMediaRequest) =>
    req<{ jobId: string; assetId?: string; clipId?: string }>(
      "POST",
      `/projects/${currentId}/gen/${input.kind}`,
      { ...input, real: true },
    ),
  genVideo: (prompt: string, duration = 5) =>
    req<{ jobId: string; assetId?: string }>("POST", `/projects/${currentId}/gen/video`, {
      prompt,
      duration,
      real: true,
    }),
  exportRender: (preset?: string, hwAccel = "auto", loudnessLufs?: number) =>
    req<{ jobId: string }>("POST", `/projects/${currentId}/export`, {
      ...(preset ? { preset } : { format: "mp4" }),
      hwAccel,
      ...(loudnessLufs != null ? { loudnessLufs } : {}),
    }),
  exportPresets: () => req<{ presets: ExportPresetInfo[] }>("GET", "/export/presets"),
  exportEncoders: () =>
    req<{
      recommendedBackend: string;
      usableBackends: string[];
      encoders: Array<{ encoder: string; codec: string; backend: string; label: string; usable: boolean }>;
    }>("GET", "/export/encoders"),
  batchExport: (presets: string[]) =>
    req<{ batchId: string; jobIds: string[] }>("POST", `/projects/${currentId}/export/batch`, { presets }),
  saveProjectDisk: () =>
    req<{ filePath: string; sizeBytes: number; savedAt: string }>("POST", `/projects/${currentId}/save`, {}),
  savedProjects: () =>
    req<{ saved: Array<{ fileName: string; filePath: string; name: string; id: string; updatedAt: string }> }>(
      "GET",
      "/projects-saved",
    ),
  openProjectDisk: (filePath: string) =>
    req<{ project: Project }>("POST", "/projects/open", { filePath }),
  checkUpdate: () =>
    req<{
      currentVersion: string;
      latestVersion: string;
      updateAvailable: boolean;
      releaseName: string;
      releaseUrl: string;
      downloadUrl: string | null;
      sizeBytes: number | null;
      notes: string;
    }>("GET", "/updater/check"),
  installUpdate: (downloadUrl?: string) =>
    req<{ installerPath: string; sizeBytes: number; launched: boolean; latestVersion: string }>(
      "POST",
      "/updater/install",
      { ...(downloadUrl ? { downloadUrl } : {}) },
      300000,
    ),
  uploadAssetFile: async (
    file: File,
    at?: number,
    insert = true,
    trackId?: string,
  ): Promise<{ asset: Asset; clip: Clip | null }> => {
    const qs = new URLSearchParams({
      name: file.name,
      insert: String(insert),
      ...(at != null ? { at: String(at) } : {}),
      ...(trackId ? { trackId } : {}),
    });
    // Pass `file` Blob directly as streaming body with `application/octet-stream`
    // so multi-GB 4K/8K videos stream straight to disk without `ArrayBuffer` memory limits!
    const res = await fetch(apiUrl(`/projects/${currentId}/assets/upload?${qs.toString()}`), {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${API_TOKEN}`,
      },
      body: file,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return res.json() as Promise<{ asset: Asset; clip: Clip | null }>;
  },
  removeEffect: (clipId: string, effectId: string) =>
    req<{ ok: boolean }>("DELETE", `/projects/${currentId}/clips/${clipId}/effects/${effectId}`),
  colorGrade: (clipId: string, preset: string) =>
    req<{ effect: { id: string } }>(`POST`, `/projects/${currentId}/clips/${clipId}/color-grade`, { preset }),
  chromaKey: (clipId: string, color = "#00ff00", similarity = 0.28) =>
    req<{ effect: { id: string } }>(`POST`, `/projects/${currentId}/clips/${clipId}/chroma-key`, {
      color,
      similarity,
      despill: true,
    }),
  setClipSpeed: (clipId: string, speed: number) =>
    req<{ clip: Clip }>(`POST`, `/projects/${currentId}/clips/${clipId}/speed`, { speed }),
  fadeClip: (clipId: string, fadeIn = 0.5, fadeOut = 0.5) =>
    req<{ effect: { id: string } }>(`POST`, `/projects/${currentId}/clips/${clipId}/fade`, { fadeIn, fadeOut }),
  enhanceAudio: (clipId?: string) =>
    req<{ outPath: string; duration: number }>(`POST`, `/projects/${currentId}/audio/enhance`, {
      ...(clipId ? { clipId } : {}),
    }),
  duckAudio: (musicClipId: string, voiceClipId?: string) =>
    req<{ speechIntervals: Array<{ start: number; end: number }>; reductionDb: number }>(
      `POST`,
      `/projects/${currentId}/audio/duck`,
      { musicClipId, ...(voiceClipId ? { voiceClipId } : {}) },
    ),
  marketplaceList: () => req<{ packs: MarketplacePackInfo[] }>("GET", `/marketplace?projectId=${currentId}`),
  applyTemplate: (templateId: string, params: Record<string, string> = {}) =>
    req<{ appliedName: string; captionsAdded: number }>(
      "POST",
      `/projects/${currentId}/marketplace/apply-template`,
      { templateId, params },
    ),
  runPlugin: (pluginId: string, params: Record<string, string> = {}) =>
    req<Record<string, unknown>>("POST", `/projects/${currentId}/marketplace/run-plugin`, { pluginId, params }),
  saveSnapshot: (label: string) =>
    req<{ snapshot: SnapshotInfo }>("POST", `/projects/${currentId}/snapshots`, { label, author: "Desktop Editor" }),
  restoreSnapshot: (snapshotId: string) =>
    req<{ restored: SnapshotInfo }>(`POST`, `/projects/${currentId}/snapshots/${snapshotId}/restore`),
  addComment: (text: string, timecode: number) =>
    req<{ comment: ReviewComment }>("POST", `/projects/${currentId}/comments`, { text, timecode }),
  resolveComment: (commentId: string, resolved: boolean) =>
    req<{ comment: ReviewComment }>(`PATCH`, `/projects/${currentId}/comments/${commentId}`, { resolved }),
  presets: () => req<{ presets: Array<{ id: string; label: string }> }>("GET", "/animation/presets"),
  aiCaps: () =>
    req<{ tts: { engine: string; available: boolean }; asr: { engine: string; available: boolean }; voices: string[] }>(
      "GET",
      "/ai/capabilities",
    ),
  voiceover: (script: string, voice: string, start = 0) =>
    req<{ jobId: string }>("POST", `/projects/${currentId}/voiceover`, { script, voice, start }),
  transcribe: (assetId: string, language = "en") =>
    req<{ jobId: string }>("POST", `/projects/${currentId}/assets/${assetId}/transcribe`, { language }),
  removeSilences: (clipId?: string) =>
    req<{ trackId: string; savedDuration: number }>(
      "POST",
      `/projects/${currentId}/edit/remove-silences`,
      clipId ? { clipId } : {},
    ),
  highlight: (targetDuration = 15) =>
    req<{ trackId: string; totalDuration: number; clips: unknown[] }>("POST", `/projects/${currentId}/edit/highlight`, {
      targetDuration,
    }),
  beatSync: (clipId: string, musicAssetId: string) =>
    req<{ beats: number[]; splits: unknown[] }>(`POST`, `/projects/${currentId}/clips/${clipId}/beat-sync`, {
      musicAssetId,
    }),
  autoReframe: (clipId: string) =>
    req<{ keyframes: number }>("POST", `/projects/${currentId}/clips/${clipId}/auto-reframe`, {}),
  trackMotion: (clipId: string, sourceAssetId: string) =>
    req<{ keyframes: number }>("POST", `/projects/${currentId}/clips/${clipId}/track-motion`, { sourceAssetId }),
  getApiSettings: () => req<ApiSettingsResponse>("GET", "/settings/api"),
  saveApiSettings: (body: {
    providerPreset?: string;
    baseUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    model?: string;
    visionModel?: string;
    temperature?: number;
    providerKeys?: Record<string, string>;
  }) => req<ApiSettingsResponse>("PUT", "/settings/api", body),
  fetchApiModels: (body: { baseUrl?: string; apiKey?: string }) =>
    req<{ models: string[]; source: string; baseUrl: string }>("POST", "/settings/api/models", body),
  testApiSettings: (body: { baseUrl?: string; apiKey?: string; model?: string }) =>
    req<{ ok: boolean; model: string; baseUrl: string; latencyMs: number; reply: string }>(
      "POST",
      "/settings/api/test",
      body,
    ),
  windowFullscreen: (mode: "toggle" | "on" | "off" | "state" = "toggle") =>
    req<{ supported: boolean; fullscreen: boolean }>("POST", "/window/fullscreen", { mode }),
};

export const api: typeof rawApi = IS_ANDROID_APK ? mobileApi : rawApi;

export let currentId = "";

export function setCurrentId(id: string): void {
  currentId = id;
}

export function connectWs(onChange: () => void): () => void {
  if (IS_ANDROID_APK) return subscribeMobileChanges(onChange);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = isDesktop ? "ws://127.0.0.1:47000/ws" : `${proto}://${location.host}/ws`;
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  const triggerCoalesced = () => {
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      onChange();
    }, 90);
  };

  const open = () => {
    if (closed) return;
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        triggerCoalesced();
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.type === "hello" || msg.type === "change" || msg.type === "job") triggerCoalesced();
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (!closed) {
          timer = setTimeout(() => {
            onChange();
            open();
          }, 1000);
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      if (!closed) timer = setTimeout(open, 1000);
    }
  };

  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
