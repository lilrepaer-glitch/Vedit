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
  format: "mp4" | "mov" | "webm";
  codec: "h264" | "h265" | "prores" | "vp9";
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

export interface CameraMoveInfo {
  id: string;
  label: string;
  directive: string;
}

const env = (import.meta as { env?: Record<string, string> }).env;

/**
 * In desktop Tauri webview (http://tauri.localhost or tauri://localhost), sidecar runs at 127.0.0.1:47000;
 * in browser dev mode Vite proxies /api and /ws.
 */
const isDesktop = location.protocol === "tauri:" || location.hostname === "tauri.localhost";
const API_ORIGIN = env?.VITE_API_BASE ?? (isDesktop ? "http://127.0.0.1:47000" : "");

const API_TOKEN = env?.VITE_API_TOKEN ?? "dev";

export function apiUrl(path: string): string {
  return `${API_ORIGIN}/api/v1${path}`;
}

export function withToken(url: string): string {
  const abs = url.startsWith("/") ? `${API_ORIGIN}${url}` : url;
  return `${abs}${abs.includes("?") ? "&" : "?"}token=${encodeURIComponent(API_TOKEN)}`;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

export const api = {
  listProjects: () => req<{ projects: Array<{ id: string; name: string }> }>("GET", "/projects"),
  getProject: (id: string) => req<{ project: Project }>("GET", `/projects/${id}`),
  createProject: (name: string, sample = true) => req<{ project: Project }>("POST", "/projects", { name, sample }),
  addAsset: (input: Partial<Asset> & { name: string; path: string }) =>
    req<{ asset: Asset }>("POST", `/projects/${currentId}/assets`, input),
  addTrack: (kind: string, name?: string) =>
    req<{ track: Track }>("POST", `/projects/${currentId}/tracks`, { kind, name }),
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
  exportRender: (preset?: string) =>
    req<{ jobId: string }>("POST", `/projects/${currentId}/export`, preset ? { preset } : { format: "mp4" }),
  exportPresets: () => req<{ presets: ExportPresetInfo[] }>("GET", "/export/presets"),
  batchExport: (presets: string[]) =>
    req<{ batchId: string; jobIds: string[] }>("POST", `/projects/${currentId}/export/batch`, { presets }),
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
};

export let currentId = "";

export function setCurrentId(id: string): void {
  currentId = id;
}

export function connectWs(onChange: () => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = isDesktop ? "ws://127.0.0.1:47000/ws" : `${proto}://${location.host}/ws`;
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (closed) return;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.type === "change" || msg.type === "job") onChange();
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
