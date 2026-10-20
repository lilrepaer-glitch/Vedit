// Klient pro Vedit REST API (PLAN.md §5) — běží přes Vite proxy na /api.

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
  source?: { provider?: string; model?: string; prompt?: string; simulated?: boolean };
}

export interface Caption {
  id: string;
  text: string;
  start: number;
  end: number;
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
  jobs: Array<{ id: string; type: string; status: string; progress: number; output?: Record<string, unknown> }>;
}

const API_TOKEN = (import.meta as { env?: Record<string, string> }).env?.VITE_API_TOKEN ?? "dev";

/** Přidá ?token= pro <img>/download odkazy (API akceptuje header i query). */
export function withToken(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(API_TOKEN)}`;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
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

export const api = {
  listProjects: () => req<{ projects: Array<{ id: string; name: string }> }>("GET", "/projects"),
  getProject: (id: string) => req<{ project: Project }>("GET", `/projects/${id}`),
  createProject: (name: string) => req<{ project: Project }>("POST", "/projects", { name }),
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
  genVideo: (prompt: string, duration = 5) =>
    req<{ jobId: string; assetId?: string }>("POST", `/projects/${currentId}/gen/video`, { prompt, duration }),
  exportRender: () => req<{ jobId: string }>("POST", `/projects/${currentId}/export`, { format: "mp4" }),
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
};

export let currentId = "";

export function setCurrentId(id: string): void {
  currentId = id;
}

export function connectWs(onChange: () => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === "change" || msg.type === "job") onChange();
  };
  ws.onclose = () => {
    // reconnect for dev convenience
    setTimeout(onChange, 1000);
  };
  return () => ws.close();
}
