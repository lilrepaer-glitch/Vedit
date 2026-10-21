import { useEffect, useRef, useState } from "react";
import type {
  Asset,
  CameraMoveInfo,
  Caption,
  Clip,
  GenProviderInfo,
  GenerateMediaRequest,
  MarketplacePackInfo,
  Project,
  Track,
} from "./api";
import { api, apiUrl, withToken } from "./api";

export function fmt(t: number): string {
  return `${t.toFixed(2)}s`;
}

// ---------- MediaPool (F6: Drag & Drop + File Picker + Quick Timeline Insert) ----------

export function MediaPool({
  project,
  projectId,
  playhead,
  onImported,
  onQuickAdd,
}: {
  project: Project;
  projectId: string;
  playhead: number;
  onImported: (msg?: string) => void;
  onQuickAdd: (asset: Asset) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [recMode, setRecMode] = useState<"screen" | "camera" | "mic" | null>(null);
  const [recSec, setRecSec] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stopRecording = () => {
    recorderRef.current?.stop();
  };

  const startRecording = async (mode: "screen" | "camera" | "mic") => {
    try {
      const stream =
        mode === "screen"
          ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
          : mode === "camera"
            ? await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
            : await navigator.mediaDevices.getUserMedia({ audio: true });

      chunksRef.current = [];
      const mime = mode === "mic" ? "audio/webm" : "video/webm";
      const rec = new MediaRecorder(stream, MediaRecorder.isTypeSupported(mime) ? { mimeType: mime } : undefined);
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) clearInterval(timerRef.current);
        setRecMode(null);
        setUploading(true);
        try {
          const ext = mode === "mic" ? "webm" : "webm";
          const blob = new Blob(chunksRef.current, { type: mime });
          const file = new File([blob], `${mode}-recording-${Date.now()}.${ext}`, { type: mime });
          await api.uploadAssetFile(file, playhead, true);
          onImported(`Recorded ${mode} clip added onto timeline`);
        } catch (err) {
          alert(`Recording upload failed: ${(err as Error).message}`);
        } finally {
          setUploading(false);
        }
      };
      recorderRef.current = rec;
      setRecMode(mode);
      setRecSec(0);
      timerRef.current = window.setInterval(() => setRecSec((s) => s + 0.2), 200);
      rec.start(250);
    } catch (err) {
      alert(`Capture unavailable: ${(err as Error).message}`);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      let cursor = playhead;
      for (const file of Array.from(files)) {
        const res = await api.uploadAssetFile(file, cursor, true);
        cursor += res.asset.duration ?? 5;
      }
      onImported(`Imported ${files.length} file${files.length > 1 ? "s" : ""} onto timeline`);
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="panel">
      <h2>Media Pool</h2>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `1px dashed ${dragging ? "#4f8cff" : "#3a4256"}`,
          background: dragging ? "rgba(79, 140, 255, 0.12)" : "rgba(255,255,255,0.03)",
          borderRadius: 6,
          padding: "10px 8px",
          textAlign: "center",
          cursor: "pointer",
          marginBottom: 8,
          fontSize: 12,
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          style={{ display: "none" }}
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <strong>{uploading ? "⏳ Importing & probing media…" : "📂 Drop Video / Audio / Image Files"}</strong>
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          or click to browse files on your PC (auto-added to timeline)
        </div>
      </div>

      {/* F7: Built-in Studio Recorder (Screen / Webcam / Voice Mic) */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        {recMode ? (
          <button
            type="button"
            onClick={stopRecording}
            style={{ width: "100%", background: "#b91c1c", color: "#fff", fontWeight: 700 }}
          >
            ⏹ Stop {recMode.toUpperCase()} Recording ({recSec.toFixed(1)}s)
          </button>
        ) : (
          <>
            <button type="button" disabled={uploading} onClick={() => void startRecording("screen")} title="Record Windows screen + audio">
              🖥 Record Screen
            </button>
            <button type="button" disabled={uploading} onClick={() => void startRecording("camera")} title="Record webcam + mic">
              📷 Camera
            </button>
            <button type="button" disabled={uploading} onClick={() => void startRecording("mic")} title="Record voice microphone">
              🎙 Mic
            </button>
          </>
        )}
      </div>

      <input
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="🔍 Filter media by name or #tag…"
        style={{ width: "100%", marginBottom: 6 }}
      />

      <ul className="asset-list">
        {project.assets
          .filter((a) => {
            const q = searchQuery.trim().toLowerCase().replace(/^#/, "");
            if (!q) return true;
            return (
              a.name.toLowerCase().includes(q) ||
              (a.tags ?? []).some((t) => t.toLowerCase().includes(q))
            );
          })
          .map((a) => (
            <li key={a.id} className="asset" style={{ flexWrap: "wrap", gap: 4 }}>
              <span className={`badge badge-${a.kind}`}>{a.kind}</span>
              <span
                className="asset-name"
                title={
                  a.source?.prompt
                    ? `${a.name} — ${a.source.provider ?? "gen"}/${a.source.model ?? ""}: "${a.source.prompt}"`
                    : a.path
                }
              >
                {a.name}
              </span>
              {(a.tags ?? []).map((tg) => (
                <span key={tg} className="badge badge-stub" style={{ fontSize: 10 }}>
                  #{tg}
                </span>
              ))}
              <span className="muted">{a.duration != null ? fmt(a.duration) : "—"}</span>
              {a.source?.model && (
                <span className="badge badge-stub" title={a.source.directedPrompt ?? a.source.prompt}>
                  {a.source.simulated ? "offline" : a.source.provider ?? "AI"}
                </span>
              )}
              <button
                type="button"
                title="Add searchable tag"
                style={{ padding: "1px 5px", fontSize: 10 }}
                onClick={async () => {
                  const tag = window.prompt(`Add tag for "${a.name}" (e.g. b-roll, hero, intro):`);
                  if (!tag?.trim()) return;
                  const next = Array.from(new Set([...(a.tags ?? []), tag.trim()]));
                  await api.updateAsset(a.id, { tags: next });
                  onImported(`Tagged "${a.name}" #${tag.trim()}`);
                }}
              >
                #Tag
              </button>
              <button
                type="button"
                title="Insert onto timeline at playhead"
                style={{ padding: "1px 6px", fontSize: 11 }}
                onClick={() => onQuickAdd(a)}
              >
                + Add
              </button>
            </li>
          ))}
      </ul>
      <details style={{ marginTop: 6 }}>
        <summary className="muted" style={{ cursor: "pointer", fontSize: 11 }}>
          Import by local disk path
        </summary>
        <ImportForm projectId={projectId} onImported={() => onImported("Media linked")} />
      </details>
    </section>
  );
}

function ImportForm({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  return (
    <form
      className="import-form"
      style={{ marginTop: 6 }}
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        const body = {
          name: String(data.get("name") || "medium.mp4"),
          kind: String(data.get("kind") || "video"),
          path: String(data.get("path") || "/media/medium.mp4"),
          duration: Number(data.get("duration") || 10),
        };
        const res = await fetch(apiUrl(`/projects/${projectId}/assets`), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer dev" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          form.reset();
          onImported();
        } else {
          alert((await res.json()).error ?? "import failed");
        }
      }}
    >
      <input name="name" placeholder="name.mp4" required />
      <input name="path" placeholder="C:\\Videos\\clip.mp4" required />
      <select name="kind" defaultValue="video">
        <option value="video">video</option>
        <option value="audio">audio</option>
        <option value="image">image</option>
      </select>
      <input name="duration" type="number" placeholder="duration (s)" defaultValue={10} min={0} step={0.1} />
      <button type="submit">+ Link Path</button>
    </form>
  );
}

// ---------- Preview (F6: Real-Time Streaming Video + Audio Playback, Transport Bar, Live FX & Captions, Fullscreen) ----------

export function Preview({
  project,
  clip,
  playhead,
  playing,
  shuttleRate,
  frameUrl,
  onTogglePlay,
  onSeek,
}: {
  project: Project;
  clip: Clip | null;
  playhead: number;
  playing: boolean;
  shuttleRate: number;
  frameUrl: string | null;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
}) {
  const seq = project.sequences.find((s) => s.id === project.activeSequenceId)!;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const activeAsset = clip ? project.assets.find((a) => a.id === clip.assetId) ?? null : null;
  const streamSrc =
    clip && activeAsset && activeAsset.kind !== "image"
      ? withToken(`/api/v1/projects/${project.id}/assets/${clip.assetId}/stream`)
      : null;

  // Find active background audio clip on audio tracks at current playhead
  const activeAudioClip =
    seq.tracks
      .filter((t) => t.kind === "audio" && !t.muted)
      .flatMap((t) => t.clips)
      .find((c) => playhead >= c.start && playhead < c.start + c.duration) ?? null;
  const audioStreamSrc = activeAudioClip
    ? withToken(`/api/v1/projects/${project.id}/assets/${activeAudioClip.assetId}/stream`)
    : null;

  const clipSpeedEff = Number(clip?.effects.find((e) => e.type === "speed")?.params?.rate ?? 1) || 1;

  // Keep HTML5 <video> element synced with playhead & playing state
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !clip || !streamSrc) return;
    const mediaTime = Math.max(0, clip.in + (playhead - clip.start) * clipSpeedEff);
    if (!playing) {
      v.pause();
      if (Number.isFinite(mediaTime) && Math.abs(v.currentTime - mediaTime) > 0.08) {
        try {
          v.currentTime = mediaTime;
        } catch {
          /* metadata still loading */
        }
      }
    } else {
      v.playbackRate = Math.max(0.25, Math.min(4, Math.abs(shuttleRate) * clipSpeedEff));
      if (Math.abs(v.currentTime - mediaTime) > 0.35) {
        try {
          v.currentTime = mediaTime;
        } catch {
          /* ignore */
        }
      }
      void v.play().catch(() => undefined);
    }
  }, [playing, playhead, clip, streamSrc, shuttleRate, clipSpeedEff]);

  // Keep HTML5 background <audio> synced during real-time playback
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !activeAudioClip || !audioStreamSrc) return;
    const audioTime = Math.max(0, activeAudioClip.in + (playhead - activeAudioClip.start));
    if (!playing) {
      a.pause();
    } else {
      a.playbackRate = Math.max(0.25, Math.min(4, Math.abs(shuttleRate)));
      if (Math.abs(a.currentTime - audioTime) > 0.4) {
        try {
          a.currentTime = audioTime;
        } catch {
          /* ignore */
        }
      }
      void a.play().catch(() => undefined);
    }
  }, [playing, playhead, activeAudioClip, audioStreamSrc, shuttleRate]);

  // Live CSS preview filter chain for color-grade, grayscale, blur
  const cssFilters: string[] = [];
  if (clip) {
    for (const eff of clip.effects) {
      const p = eff.params as Record<string, number>;
      if (eff.type === "grayscale" || eff.type === "black-and-white") cssFilters.push("grayscale(100%)");
      if (eff.type === "blur") cssFilters.push(`blur(${Math.max(1, Number(p.sigma ?? 4))}px)`);
      if (eff.type === "color" || eff.type === "color-grade") {
        if (p.brightness != null) cssFilters.push(`brightness(${(1 + Number(p.brightness)).toFixed(2)})`);
        if (p.contrast != null) cssFilters.push(`contrast(${Number(p.contrast).toFixed(2)})`);
        if (p.saturation != null) cssFilters.push(`saturate(${Number(p.saturation).toFixed(2)})`);
      }
    }
  }

  const activeCaptions = seq.captions.filter((c) => playhead >= c.start && playhead <= c.end);
  const t = clip?.transform;
  const frameStep = 1 / Math.max(1, seq.fps || 30);

  return (
    <section className="panel preview-panel">
      <h2>
        Preview <span className="muted">— Real-Time Stream + FFmpeg Decoder</span>
      </h2>
      <div
        ref={stageRef}
        className="preview-stage"
        style={{ aspectRatio: `${seq.width} / ${seq.height}`, position: "relative" }}
      >
        {clip && (streamSrc || frameUrl) ? (
          <div
            className="preview-clip preview-frame"
            style={{
              transform: t
                ? `translate(${t.x}px, ${t.y}px) rotate(${t.rotation}deg) scale(${t.scaleX}, ${t.scaleY})`
                : undefined,
              opacity: t?.opacity ?? 1,
              filter: cssFilters.length ? cssFilters.join(" ") : undefined,
            }}
          >
            {streamSrc ? (
              <video
                ref={videoRef}
                src={streamSrc}
                playsInline
                preload="auto"
                style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
              />
            ) : frameUrl ? (
              <img
                src={frameUrl}
                alt={clip.name}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ) : null}
            <div className="frame-label">
              <strong>{clip.name}</strong>
              <div className="muted">
                {fmt(clip.start)} → {fmt(clip.start + clip.duration)} • {clipSpeedEff !== 1 ? `${clipSpeedEff}× • ` : ""}
                {clip.effects.length} fx • {clip.keyframes.length} kf
              </div>
            </div>
          </div>
        ) : (
          <div className="preview-empty">Select a clip or move playhead over a clip</div>
        )}

        {activeCaptions.length > 0 && (
          <div
            style={{
              position: "absolute",
              bottom: 18,
              left: "8%",
              right: "8%",
              textAlign: "center",
              pointerEvents: "none",
            }}
          >
            {activeCaptions.map((c) => (
              <div
                key={c.id}
                style={{
                  display: "inline-block",
                  background: "rgba(0, 0, 0, 0.78)",
                  color: "#fff",
                  padding: "4px 12px",
                  borderRadius: 5,
                  fontSize: 15,
                  fontWeight: 600,
                  marginTop: 4,
                  textShadow: "0 1px 3px #000",
                }}
              >
                {c.text}
              </div>
            ))}
          </div>
        )}

        {audioStreamSrc && <audio ref={audioRef} src={audioStreamSrc} preload="auto" />}
      </div>

      {/* Pro NLE Transport Bar */}
      <div
        className="preview-meta"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}
      >
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button type="button" title="Jump to start (Home)" onClick={() => onSeek(0)}>
            ⏮
          </button>
          <button type="button" title="Previous frame (←)" onClick={() => onSeek(Math.max(0, playhead - frameStep))}>
            ⏪ -1f
          </button>
          <button
            type="button"
            title="Play / Pause (Space, J/K/L shuttle)"
            onClick={onTogglePlay}
            style={{ fontWeight: 700, minWidth: 74 }}
          >
            {playing ? "⏸ Pause" : "▶ Play"}
          </button>
          <button type="button" title="Next frame (→)" onClick={() => onSeek(playhead + frameStep)}>
            +1f ⏩
          </button>
          <button
            type="button"
            title="Toggle Fullscreen Monitor"
            onClick={() => {
              if (document.fullscreenElement) {
                void document.exitFullscreen();
              } else {
                void stageRef.current?.requestFullscreen?.();
              }
            }}
          >
            ⛶ Fullscreen
          </button>
        </div>
        <span>
          {seq.width}×{seq.height} • {seq.fps} fps • playhead <strong>{fmt(playhead)}</strong>
          {playing && shuttleRate !== 1 ? ` (${shuttleRate}×)` : ""}
        </span>
      </div>
    </section>
  );
}

// ---------- Vedit Gen Studio (F4) ----------

export function GenPanel({
  providers,
  cameraMoves,
  selectedClipId,
  busy,
  onGenerate,
}: {
  providers: GenProviderInfo[];
  cameraMoves: CameraMoveInfo[];
  selectedClipId: string | null;
  busy: boolean;
  onGenerate: (req: GenerateMediaRequest) => void;
}) {
  const [kind, setKind] = useState<GenerateMediaRequest["kind"]>("video");
  const compatible = providers.filter((p) => p.kinds.includes(kind));
  const [providerId, setProviderId] = useState<string>("stub");
  const activeProvider = compatible.find((p) => p.id === providerId) ?? compatible[0];
  const [model, setModel] = useState<string>(activeProvider?.defaultModel ?? "stub-v0");
  const [prompt, setPrompt] = useState("cinematic drone shot over Prague Castle at golden hour");
  const [duration, setDuration] = useState(5);
  const [cameraMove, setCameraMove] = useState("push-in");
  const [useContinuity, setUseContinuity] = useState(false);
  const [insertToTimeline, setInsertToTimeline] = useState(true);

  useEffect(() => {
    if (!compatible.some((p) => p.id === providerId) && compatible[0]) {
      setProviderId(compatible[0].id);
      setModel(compatible[0].defaultModel);
    }
  }, [kind, compatible, providerId]);

  useEffect(() => {
    if (activeProvider && !activeProvider.models.includes(model)) {
      setModel(activeProvider.defaultModel);
    }
  }, [activeProvider, model]);

  return (
    <section className="panel">
      <h2>Vedit Gen (AI Video / Image / Audio)</h2>
      <form
        className="import-form"
        onSubmit={(e) => {
          e.preventDefault();
          onGenerate({
            kind,
            prompt,
            provider: activeProvider?.id ?? "stub",
            model,
            duration,
            cameraMove: kind === "video" || kind === "image" ? cameraMove : undefined,
            continuityFromClipId: useContinuity && selectedClipId ? selectedClipId : undefined,
            insertToTimeline,
          });
        }}
      >
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value as GenerateMediaRequest["kind"])}>
            <option value="video">🎬 Video</option>
            <option value="image">🖼 Image</option>
            <option value="music">🎵 Music</option>
            <option value="sfx">🔊 Sound Effect</option>
          </select>
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value) || 5)}
            title="Duration (seconds)"
          />
        </div>
        <select
          value={activeProvider?.id ?? "stub"}
          onChange={(e) => {
            const next = compatible.find((p) => p.id === e.target.value);
            setProviderId(e.target.value);
            if (next) setModel(next.defaultModel);
          }}
          title={activeProvider?.reason ?? "Ready"}
        >
          {compatible.map((p) => (
            <option key={p.id} value={p.id}>
              {p.available ? "●" : "○"} {p.label}
            </option>
          ))}
        </select>
        {activeProvider && (
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {activeProvider.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        {(kind === "video" || kind === "image") && (
          <select value={cameraMove} onChange={(e) => setCameraMove(e.target.value)} title="Camera movement">
            {cameraMoves.map((c) => (
              <option key={c.id} value={c.id}>
                🎥 {c.label}
              </option>
            ))}
          </select>
        )}
        <textarea
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe your shot, lighting, action, or soundtrack…"
          required
        />
        <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={insertToTimeline}
            onChange={(e) => setInsertToTimeline(e.target.checked)}
          />
          Insert directly onto timeline
        </label>
        <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={useContinuity}
            disabled={!selectedClipId}
            onChange={(e) => setUseContinuity(e.target.checked)}
          />
          Shot continuity from selected clip
        </label>
        {activeProvider && !activeProvider.available && (
          <div className="muted" style={{ fontSize: 11 }}>
            {activeProvider.reason} — falls back to offline FFmpeg synth
          </div>
        )}
        <button type="submit" disabled={busy || !prompt.trim()}>
          ✨ Generate {kind.toUpperCase()}
        </button>
      </form>
    </section>
  );
}

// ---------- Marketplace, Collaboration Checkpoints & Review Notes (F5) ----------

export function StudioPanel({
  packs,
  project,
  playhead,
  busy,
  onApplyTemplate,
  onRunPlugin,
  onAddGraphic,
  onSaveSnapshot,
  onRestoreSnapshot,
  onAddComment,
  onResolveComment,
  onSeek,
}: {
  packs: MarketplacePackInfo[];
  project: Project;
  playhead: number;
  busy: boolean;
  onApplyTemplate: (templateId: string, title?: string) => void;
  onRunPlugin: (pluginId: string) => void;
  onAddGraphic: (kind: string, label?: string, svgMarkup?: string) => void;
  onSaveSnapshot: (label: string) => void;
  onRestoreSnapshot: (snapshotId: string) => void;
  onAddComment: (text: string, timecode: number) => void;
  onResolveComment: (commentId: string, resolved: boolean) => void;
  onSeek: (t: number) => void;
}) {
  const templates = packs.filter((p) => p.kind === "template");
  const plugins = packs.filter((p) => p.kind === "plugin");
  const [tplId, setTplId] = useState(templates[0]?.id ?? "tpl-youtube-intro");
  const [tplTitle, setTplTitle] = useState("");
  const [pluginId, setPluginId] = useState(plugins[0]?.id ?? "plg-auto-chapters");
  const [gfxKind, setGfxKind] = useState("lower-third-card");
  const [gfxLabel, setGfxLabel] = useState("");
  const [svgCode, setSvgCode] = useState('<svg><rect x="20" y="20" width="240" height="72" rx="14" fill="#2563eb"/></svg>');
  const [snapLabel, setSnapLabel] = useState("");
  const [noteText, setNoteText] = useState("");

  useEffect(() => {
    if (templates[0] && !templates.some((t) => t.id === tplId)) setTplId(templates[0].id);
  }, [templates, tplId]);

  useEffect(() => {
    if (plugins[0] && !plugins.some((p) => p.id === pluginId)) setPluginId(plugins[0].id);
  }, [plugins, pluginId]);

  return (
    <section className="panel">
      <h2>Marketplace &amp; Team Studio</h2>
      <div className="import-form">
        <h3>Templates &amp; Plugins</h3>
        <select value={tplId} onChange={(e) => setTplId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              🎞 {t.name}
            </option>
          ))}
        </select>
        <div className="row">
          <input
            value={tplTitle}
            onChange={(e) => setTplTitle(e.target.value)}
            placeholder="Custom title override (optional)…"
          />
          <button disabled={busy} onClick={() => onApplyTemplate(tplId, tplTitle || undefined)}>
            Apply
          </button>
        </div>
        <div className="row">
          <select value={pluginId} onChange={(e) => setPluginId(e.target.value)}>
            {plugins.map((p) => (
              <option key={p.id} value={p.id}>
                🧩 {p.name}
              </option>
            ))}
          </select>
          <button disabled={busy} onClick={() => onRunPlugin(pluginId)}>
            Run Plugin
          </button>
        </div>

        <h3>Vector Shapes, Callouts &amp; SVG</h3>
        <div className="row">
          <select value={gfxKind} onChange={(e) => setGfxKind(e.target.value)}>
            <option value="lower-third-card">Lower Third Card</option>
            <option value="callout-arrow">Callout Pointer Arrow</option>
            <option value="spotlight-ring">Spotlight Focus Ring</option>
            <option value="pill-badge">Pill CTA Badge</option>
            <option value="progress-ribbon">Progress Bar Ribbon</option>
            <option value="custom-svg">Custom &lt;svg&gt; Layer</option>
          </select>
          <button
            disabled={busy}
            onClick={() => {
              onAddGraphic(gfxKind, gfxLabel || undefined, gfxKind === "custom-svg" ? svgCode : undefined);
              setGfxLabel("");
            }}
          >
            + Add Layer
          </button>
        </div>
        <input
          value={gfxLabel}
          onChange={(e) => setGfxLabel(e.target.value)}
          placeholder="Overlay caption label (optional)…"
        />
        {gfxKind === "custom-svg" && (
          <textarea
            rows={2}
            value={svgCode}
            onChange={(e) => setSvgCode(e.target.value)}
            placeholder="<svg>...</svg>"
          />
        )}

        <h3>Version Checkpoints ({project.snapshots?.length ?? 0})</h3>
        <div className="row">
          <input
            value={snapLabel}
            onChange={(e) => setSnapLabel(e.target.value)}
            placeholder="Checkpoint label (e.g. Rough Cut v1)…"
          />
          <button
            disabled={busy}
            onClick={() => {
              onSaveSnapshot(snapLabel || `Cut @ ${fmt(playhead)}`);
              setSnapLabel("");
            }}
          >
            💾 Save
          </button>
        </div>
        {(project.snapshots ?? []).slice(-3).reverse().map((s) => (
          <div key={s.id} className="row" style={{ fontSize: 12 }}>
            <span className="muted" style={{ flex: 1 }}>
              {s.label} ({s.clipCount} clips)
            </span>
            <button disabled={busy} onClick={() => onRestoreSnapshot(s.id)}>
              Restore
            </button>
          </div>
        ))}

        <h3>Review Notes ({project.comments?.length ?? 0})</h3>
        <div className="row">
          <input
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder={`Note @ ${fmt(playhead)}…`}
          />
          <button
            disabled={busy || !noteText.trim()}
            onClick={() => {
              onAddComment(noteText.trim(), playhead);
              setNoteText("");
            }}
          >
            + Note
          </button>
        </div>
        {(project.comments ?? []).slice(-4).map((c) => (
          <div key={c.id} className="row" style={{ fontSize: 12 }}>
            <span
              style={{
                flex: 1,
                cursor: "pointer",
                textDecoration: c.resolved ? "line-through" : "none",
                opacity: c.resolved ? 0.6 : 1,
              }}
              onClick={() => onSeek(c.timecode)}
              title="Click to jump playhead to note"
            >
              <strong>[{fmt(c.timecode)}]</strong> {c.text}
            </span>
            <button disabled={busy} onClick={() => onResolveComment(c.id, !c.resolved)}>
              {c.resolved ? "Reopen" : "✓"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- AI captions & editing (F2/F3) ----------

export function AiPanel({
  caps,
  assets,
  busy,
  selectedClipId,
  onVoiceover,
  onTranscribe,
  onAiEdit,
}: {
  caps: { tts: { engine: string; available: boolean }; asr: { engine: string; available: boolean }; voices: string[] } | null;
  assets: Asset[];
  busy: boolean;
  selectedClipId: string | null;
  onVoiceover: (script: string, voice: string) => void;
  onTranscribe: (assetId: string) => void;
  onAiEdit: (
    action: "remove-silences" | "highlight" | "beat-sync" | "auto-reframe" | "track-motion",
    params: Record<string, string>,
  ) => void;
}) {
  const audioAssets = assets.filter((a) => a.kind === "audio");
  const videoAssets = assets.filter((a) => a.kind === "video" || a.kind === "generated");
  return (
    <section className="panel">
      <h2>AI Captions &amp; Voiceover</h2>
      <p className="muted">
        TTS: {caps?.tts.available ? caps.tts.engine : "unavailable"} • ASR:{" "}
        {caps?.asr.available ? caps.asr.engine : "unavailable"}
      </p>
      <form
        className="import-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          onVoiceover(String(data.get("script") || ""), String(data.get("voice") || "en"));
        }}
      >
        <textarea name="script" rows={3} placeholder="Script — each sentence becomes a caption…" required />
        <div className="row">
          <select name="voice" defaultValue="en">
            {(caps?.voices.length ? caps.voices : ["en", "cs"]).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy || !caps?.tts.available}>
            🎙 Voiceover + Captions
          </button>
        </div>
      </form>
      <div className="row">
        <select id="transcribe-asset">
          {assets
            .filter((a) => a.kind !== "image")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <button
          disabled={busy || !caps?.asr.available || assets.length === 0}
          title="Transcribe speech from media to captions"
          onClick={() => {
            const select = document.getElementById("transcribe-asset") as HTMLSelectElement | null;
            if (select?.value) onTranscribe(select.value);
          }}
        >
          📝 Transcribe
        </button>
      </div>
      <h2>AI Editing</h2>
      <p className="muted">
        {selectedClipId ? `clip ${selectedClipId.slice(0, 8)}…` : "select a clip on timeline"}
      </p>
      <div className="row">
        <button
          disabled={busy || !selectedClipId}
          title="Detect silences and close gaps on the selected clip track"
          onClick={() => selectedClipId && onAiEdit("remove-silences", { clipId: selectedClipId })}
        >
          ✂️ Remove Silences
        </button>
        <button
          disabled={busy || videoAssets.length === 0}
          title="Build highlight reel (motion + energy + scenes) to a new track"
          onClick={() => onAiEdit("highlight", {})}
        >
          ⭐ Highlight
        </button>
      </div>
      <div className="row">
        <select id="beat-music">
          {audioAssets.map((a) => (
            <option key={a.id} value={a.id}>
              🎵 {a.name}
            </option>
          ))}
        </select>
        <button
          disabled={busy || !selectedClipId || audioAssets.length === 0}
          title="Split selected clip on music beats"
          onClick={() => {
            const music = (document.getElementById("beat-music") as HTMLSelectElement | null)?.value;
            if (selectedClipId && music) onAiEdit("beat-sync", { clipId: selectedClipId, musicAssetId: music });
          }}
        >
          🥁 Beat Sync
        </button>
      </div>
      <div className="row">
        <button
          disabled={busy || !selectedClipId}
          title="Center motion in clip (pan keyframes) — for 9:16 crop"
          onClick={() => selectedClipId && onAiEdit("auto-reframe", { clipId: selectedClipId })}
        >
          📐 Auto-reframe
        </button>
        <select id="motion-source">
          {videoAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          disabled={busy || !selectedClipId || videoAssets.length === 0}
          title="Selected clip (graphics/text) will follow motion in source"
          onClick={() => {
            const src = (document.getElementById("motion-source") as HTMLSelectElement | null)?.value;
            if (selectedClipId && src) onAiEdit("track-motion", { clipId: selectedClipId, sourceAssetId: src });
          }}
        >
          🎯 Track Motion
        </button>
      </div>
    </section>
  );
}

// ---------- Jobs ----------

export function JobsPanel({ project }: { project: Project }) {
  const jobs = [...project.jobs].reverse().slice(0, 8);
  return (
    <section className="panel">
      <h2>Jobs</h2>
      {jobs.length === 0 && <p className="muted">No jobs yet.</p>}
      <ul className="job-list">
        {jobs.map((j) => (
          <li key={j.id} className={`job job-${j.status}`}>
            <div className="job-row">
              <span className="job-type">{j.type}</span>
              <span className="muted">{j.status}</span>
            </div>
            <div className="job-bar">
              <div className="job-fill" style={{ width: `${j.status === "done" ? 100 : j.progress}%` }} />
            </div>
            {j.error && <div className="muted" style={{ fontSize: 11 }}>{j.error}</div>}
            {j.status === "done" && (j.output as { outPath?: string } | undefined)?.outPath && (
              <a className="job-dl" href={withToken(`/api/v1/jobs/${j.id}/output`)} download>
                ⬇ download output
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Timeline ----------

const TRACK_COLOR: Record<Track["kind"], string> = {
  video: "#2e6bd1",
  audio: "#2f9e6e",
  text: "#b06ad1",
  graphics: "#c98b2f",
};

export function Timeline({
  project,
  selection,
  onSelect,
  playhead,
  onSeek,
  zoom,
  onZoom,
  onAddTrack,
  onUpdateTrack,
  onClipEdit,
}: {
  project: Project;
  selection: { trackId: string; clipId: string } | null;
  onSelect: (trackId: string, clipId: string) => void;
  playhead: number;
  onSeek: (t: number) => void;
  zoom: number;
  onZoom: (z: number) => void;
  onAddTrack: (kind: Track["kind"]) => void;
  onUpdateTrack: (
    trackId: string,
    patch: { muted?: boolean; solo?: boolean; locked?: boolean; volumeDb?: number },
  ) => void;
  onClipEdit: (clipId: string, patch: Record<string, unknown>) => void;
}) {
  const seq = project.sequences.find((s) => s.id === project.activeSequenceId)!;
  const duration = Math.max(20, ...seq.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
  const width = duration * zoom + 80;
  const ticks = Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => i);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [waveCache, setWaveCache] = useState<Record<string, number[]>>({});
  const [dragPreview, setDragPreview] = useState<{ clipId: string; start: number; duration: number } | null>(null);

  // Load real audio waveform peaks lazily for visible audio/video assets
  useEffect(() => {
    for (const a of project.assets) {
      if (a.kind === "image" || waveCache[a.id]) continue;
      void api
        .waveform(a.id, 64)
        .then((res) => setWaveCache((prev) => ({ ...prev, [a.id]: res.peaks })))
        .catch(() => undefined);
    }
  }, [project.assets, waveCache]);

  const snapPoints = [
    0,
    playhead,
    ...seq.tracks.flatMap((t) => t.clips.flatMap((c) => [c.start, c.start + c.duration])),
  ];

  const applySnap = (timeSec: number, excludeClipId: string): number => {
    if (!snapEnabled) return Math.max(0, Number(timeSec.toFixed(3)));
    const threshSec = 8 / Math.max(20, zoom);
    let best = timeSec;
    let bestDist = threshSec;
    for (const sp of snapPoints) {
      const d = Math.abs(sp - timeSec);
      if (d < bestDist) {
        best = sp;
        bestDist = d;
      }
    }
    void excludeClipId;
    return Math.max(0, Number(best.toFixed(3)));
  };

  const beginClipDrag = (
    e: React.MouseEvent,
    track: Track,
    clip: Clip,
    mode: "move" | "trim-left" | "trim-right",
  ) => {
    if (track.locked) return;
    e.stopPropagation();
    onSelect(track.id, clip.id);
    const startX = e.clientX;
    const origStart = clip.start;
    const origDur = clip.duration;
    const origIn = clip.in;
    let latest = { start: origStart, duration: origDur, in: origIn };

    const onMove = (ev: MouseEvent) => {
      const dt = (ev.clientX - startX) / zoom;
      if (mode === "move") {
        const nextStart = applySnap(Math.max(0, origStart + dt), clip.id);
        latest = { start: nextStart, duration: origDur, in: origIn };
      } else if (mode === "trim-right") {
        const rawEnd = Math.max(origStart + 0.15, origStart + origDur + dt);
        const snappedEnd = applySnap(rawEnd, clip.id);
        latest = { start: origStart, duration: Math.max(0.15, snappedEnd - origStart), in: origIn };
      } else {
        const maxShift = origDur - 0.15;
        const clampedDt = Math.max(-origIn, Math.min(maxShift, dt));
        const rawStart = Math.max(0, origStart + clampedDt);
        const snappedStart = applySnap(rawStart, clip.id);
        const actualShift = snappedStart - origStart;
        latest = {
          start: snappedStart,
          duration: Math.max(0.15, origDur - actualShift),
          in: Math.max(0, origIn + actualShift),
        };
      }
      setDragPreview({ clipId: clip.id, start: latest.start, duration: latest.duration });
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDragPreview(null);
      if (Math.abs(latest.start - origStart) > 0.005 || Math.abs(latest.duration - origDur) > 0.005) {
        onClipEdit(clip.id, {
          start: Number(latest.start.toFixed(3)),
          duration: Number(latest.duration.toFixed(3)),
          in: Number(latest.in.toFixed(3)),
          out: Number((latest.in + latest.duration).toFixed(3)),
        });
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <section className="panel timeline-panel">
      <div className="timeline-head" style={{ gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <h2>Timeline &amp; Mixer</h2>
          <button type="button" onClick={() => onAddTrack("video")} style={{ fontSize: 11, padding: "2px 6px" }}>
            + Video
          </button>
          <button type="button" onClick={() => onAddTrack("audio")} style={{ fontSize: 11, padding: "2px 6px" }}>
            + Audio
          </button>
          <button type="button" onClick={() => onAddTrack("graphics")} style={{ fontSize: 11, padding: "2px 6px" }}>
            + Graphics
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label className="muted" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <input type="checkbox" checked={snapEnabled} onChange={(e) => setSnapEnabled(e.target.checked)} />
            🧲 Snap
          </label>
          <label className="muted">
            zoom{" "}
            <input
              type="range"
              min={20}
              max={160}
              value={zoom}
              onChange={(e) => onZoom(Number(e.target.value))}
            />
          </label>
        </div>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-inner" style={{ width }}>
          <div
            className="ruler"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onSeek(Math.max(0, (e.clientX - rect.left) / zoom));
            }}
          >
            {ticks.map((s) => (
              <span key={s} className="tick" style={{ left: s * zoom }}>
                {s}s
              </span>
            ))}
          </div>
          {seq.tracks.map((track) => (
            <div key={track.id} className="track" style={{ opacity: track.muted ? 0.48 : 1 }}>
              <div
                className="track-label"
                style={{
                  borderColor: TRACK_COLOR[track.kind],
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  minWidth: 132,
                  padding: "3px 6px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 3 }}>
                  <strong style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {track.name}
                  </strong>
                  <span style={{ display: "flex", gap: 2 }}>
                    <button
                      type="button"
                      title="Mute Track"
                      onClick={() => onUpdateTrack(track.id, { muted: !track.muted })}
                      style={{
                        padding: "0 4px",
                        fontSize: 10,
                        background: track.muted ? "#dc2626" : undefined,
                      }}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      title="Solo Track"
                      onClick={() => onUpdateTrack(track.id, { solo: !track.solo })}
                      style={{
                        padding: "0 4px",
                        fontSize: 10,
                        background: track.solo ? "#ca8a04" : undefined,
                      }}
                    >
                      S
                    </button>
                    <button
                      type="button"
                      title="Lock Track"
                      onClick={() => onUpdateTrack(track.id, { locked: !track.locked })}
                      style={{
                        padding: "0 4px",
                        fontSize: 10,
                        background: track.locked ? "#4b5563" : undefined,
                      }}
                    >
                      🔒
                    </button>
                  </span>
                </div>
                {(track.kind === "audio" || track.kind === "video") && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                    <input
                      type="range"
                      min={-24}
                      max={12}
                      step={1}
                      defaultValue={track.volumeDb ?? 0}
                      title={`Track Gain: ${track.volumeDb ?? 0} dB`}
                      style={{ width: 78 }}
                      onMouseUp={(e) =>
                        onUpdateTrack(track.id, { volumeDb: Number((e.target as HTMLInputElement).value) })
                      }
                    />
                    <span className="muted">{track.volumeDb ?? 0}dB</span>
                  </div>
                )}
              </div>
              <div className="track-lane">
                {track.clips.map((clip) => {
                  const selected = selection?.clipId === clip.id;
                  const visStart = dragPreview?.clipId === clip.id ? dragPreview.start : clip.start;
                  const visDur = dragPreview?.clipId === clip.id ? dragPreview.duration : clip.duration;
                  const peaks = waveCache[clip.assetId];
                  const pxWidth = Math.max(12, visDur * zoom);
                  return (
                    <div
                      key={clip.id}
                      className={`clip ${selected ? "clip-selected" : ""}`}
                      style={{
                        left: visStart * zoom,
                        width: pxWidth,
                        background: TRACK_COLOR[track.kind],
                        cursor: track.locked ? "not-allowed" : "grab",
                        overflow: "hidden",
                      }}
                      title={`${clip.name} (${fmt(visStart)}–${fmt(visStart + visDur)}) — drag to move, drag edges to trim`}
                      onMouseDown={(e) => beginClipDrag(e, track, clip, "move")}
                      onClick={() => onSelect(track.id, clip.id)}
                    >
                      {peaks && peaks.length > 0 && (
                        <svg
                          viewBox={`0 0 ${peaks.length} 24`}
                          preserveAspectRatio="none"
                          style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            opacity: 0.35,
                            pointerEvents: "none",
                          }}
                        >
                          {peaks.map((pk, idx) => {
                            const h = Math.max(2, pk * 22);
                            return (
                              <rect
                                key={idx}
                                x={idx}
                                y={12 - h / 2}
                                width={0.75}
                                height={h}
                                fill="#ffffff"
                              />
                            );
                          })}
                        </svg>
                      )}
                      <div
                        title="Trim In Point"
                        onMouseDown={(e) => beginClipDrag(e, track, clip, "trim-left")}
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: 6,
                          cursor: "ew-resize",
                          background: "rgba(255,255,255,0.28)",
                        }}
                      />
                      <span className="clip-name" style={{ paddingLeft: 6 }}>
                        {clip.name}
                      </span>
                      {clip.keyframes.length > 0 && <span className="clip-kf">◆{clip.keyframes.length}</span>}
                      <div
                        title="Trim Out Point"
                        onMouseDown={(e) => beginClipDrag(e, track, clip, "trim-right")}
                        style={{
                          position: "absolute",
                          right: 0,
                          top: 0,
                          bottom: 0,
                          width: 6,
                          cursor: "ew-resize",
                          background: "rgba(255,255,255,0.28)",
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="playhead" style={{ left: playhead * zoom }} />
        </div>
      </div>
    </section>
  );
}

// ---------- Inspector ----------

export function Inspector({
  clip,
  asset,
  onPatch,
  onProAction,
  captions,
}: {
  clip: Clip | null;
  asset: Asset | null;
  onPatch: (patch: Record<string, unknown>) => void;
  onProAction: (
    action:
      | "speed"
      | "color-grade"
      | "chroma-key"
      | "fade"
      | "lut3d"
      | "stabilize"
      | "layout"
      | "enhance-audio"
      | "duck-audio"
      | "remove-effect",
    payload?: Record<string, unknown>,
  ) => void;
  captions: Caption[];
}) {
  if (!clip) {
    return (
      <section className="panel">
        <h2>Inspector</h2>
        <p className="muted">Select any video or audio clip on the timeline to edit transforms, speed, VFX, or audio DSP.</p>
        <Captions captions={captions} />
      </section>
    );
  }
  const currentSpeed = Number(clip.effects.find((e) => e.type === "speed")?.params?.rate ?? 1) || 1;
  const field = (label: string, key: string, value: number | string, step = 0.1) => (
    <label key={`${clip.id}-${key}-${value}`}>
      {label}
      <input
        defaultValue={value}
        step={step}
        onBlur={(e) => {
          const raw = e.target.value;
          const num = Number(raw);
          const next = typeof value === "number" ? num : raw;
          if (String(next) !== String(value)) onPatch({ [key]: next });
        }}
      />
    </label>
  );
  return (
    <section className="panel">
      <h2>Inspector &amp; Pro FX</h2>
      <div className="inspector-grid">
        {field("name", "name", clip.name)}
        {field("start (s)", "start", clip.start)}
        {field("duration (s)", "duration", clip.duration)}
        {field("in (s)", "in", clip.in)}
        {field("out (s)", "out", clip.out)}
        {field("X", "transform.x", clip.transform.x)}
        {field("Y", "transform.y", clip.transform.y)}
        {field("rotation", "transform.rotation", clip.transform.rotation, 1)}
        {field("opacity", "transform.opacity", clip.transform.opacity)}
      </div>

      <h3>Speed Control ({currentSpeed}×)</h3>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        {[0.5, 1, 1.5, 2, 4].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onProAction("speed", { speed: s })}
            style={{ fontWeight: Math.abs(currentSpeed - s) < 0.01 ? 700 : 400 }}
          >
            {s}×
          </button>
        ))}
      </div>

      <h3>Color Grading, Chroma Key &amp; Transitions</h3>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        <select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) {
              onProAction("color-grade", { preset: e.target.value });
              e.target.value = "";
            }
          }}
        >
          <option value="">🎨 Color Grade Preset…</option>
          <option value="cinematic-contrast">Cinematic Punch</option>
          <option value="warm-golden">Golden Hour Warm</option>
          <option value="cool-noir">Moody Cool Noir</option>
          <option value="vivid-social">Vivid Social Pop</option>
          <option value="neutral">Reset Neutral Rec.709</option>
        </select>
        <button type="button" onClick={() => onProAction("chroma-key", { color: "#00ff00" })}>
          🟩 Green Key
        </button>
        <button type="button" onClick={() => onProAction("chroma-key", { color: "blue" })}>
          🟦 Blue Key
        </button>
        <button type="button" onClick={() => onProAction("fade", { fadeIn: 0.5, fadeOut: 0.5 })}>
          🌅 Fade In/Out
        </button>
      </div>

      <h3>Cinema 3D LUTs, Stabilization &amp; PiP Layout</h3>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        <select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) {
              onProAction("lut3d", { lutId: e.target.value });
              e.target.value = "";
            }
          }}
        >
          <option value="">🎞 3D .cube Film LUT…</option>
          <option value="kodak-2383">Kodak 2383 Print Film</option>
          <option value="teal-orange-blockbuster">Blockbuster Teal &amp; Orange</option>
          <option value="fuji-eterna-soft">Fuji Eterna Soft Cinema</option>
          <option value="bleach-bypass">Silver Bleach Bypass</option>
          <option value="cyberpunk-neon">Cyberpunk Neon Night</option>
        </select>
        <button type="button" onClick={() => onProAction("stabilize")}>
          🎥 Stabilize
        </button>
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        <button type="button" onClick={() => onProAction("layout", { layout: "pip-bottom-right" })}>
          ↘ PiP BR
        </button>
        <button type="button" onClick={() => onProAction("layout", { layout: "pip-top-right" })}>
          ↗ PiP TR
        </button>
        <button type="button" onClick={() => onProAction("layout", { layout: "split-left" })}>
          ◧ Split L
        </button>
        <button type="button" onClick={() => onProAction("layout", { layout: "split-right" })}>
          ◨ Split R
        </button>
        <button type="button" onClick={() => onProAction("layout", { layout: "full-reset" })}>
          ⛶ Full
        </button>
      </div>

      <h3>Pro Audio DSP</h3>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        <button
          type="button"
          title="FFT spectral denoise + vocal EQ + compressor + -16 LUFS normalize"
          onClick={() => onProAction("enhance-audio")}
        >
          🎙 Enhance Voice
        </button>
        <button
          type="button"
          title="Automatically lower background music during active speech"
          onClick={() => onProAction("duck-audio")}
        >
          🔉 Duck Music
        </button>
      </div>

      {clip.effects.length > 0 && (
        <>
          <h3>Active Effects ({clip.effects.length})</h3>
          <ul className="kf-list">
            {clip.effects.map((ef) => (
              <li key={ef.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>
                  <strong>{ef.type}</strong>{" "}
                  <span className="muted" style={{ fontSize: 11 }}>
                    {JSON.stringify(ef.params)}
                  </span>
                </span>
                <button
                  type="button"
                  style={{ padding: "0 5px", fontSize: 11 }}
                  onClick={() => onProAction("remove-effect", { effectId: ef.id })}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {asset?.source?.prompt && (
        <>
          <h3>Generation Metadata</h3>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
            <div>
              <strong>Model:</strong> {asset.source.provider ?? "gen"} / {asset.source.model ?? "default"}
            </div>
            {asset.source.cameraMove && (
              <div>
                <strong>Camera:</strong> {asset.source.cameraMove}
              </div>
            )}
            <div>
              <strong>Prompt:</strong> {asset.source.prompt}
            </div>
          </div>
        </>
      )}
      <h3>Keyframes ({clip.keyframes.length})</h3>
      <ul className="kf-list">
        {clip.keyframes.map((k, i) => (
          <li key={i}>
            {fmt(k.time)} • {k.property} = {String(k.value)}
            {k.easing ? ` (${k.easing})` : ""}
          </li>
        ))}
      </ul>
      <Captions captions={captions} />
    </section>
  );
}

function Captions({ captions }: { captions: Caption[] }) {
  return (
    <>
      <h3>Captions ({captions.length})</h3>
      <ul className="caption-list">
        {captions.map((c) => (
          <li key={c.id}>
            <span className="muted">
              {fmt(c.start)}–{fmt(c.end)}
            </span>{" "}
            {c.text}
          </li>
        ))}
      </ul>
    </>
  );
}
