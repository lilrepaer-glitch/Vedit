import { useEffect, useState } from "react";
import type {
  Asset,
  CameraMoveInfo,
  Caption,
  Clip,
  GenProviderInfo,
  GenerateMediaRequest,
  Project,
  Track,
} from "./api";
import { apiUrl, withToken } from "./api";

export function fmt(t: number): string {
  return `${t.toFixed(2)}s`;
}

// ---------- MediaPool ----------

export function MediaPool({
  project,
  projectId,
  onImported,
}: {
  project: Project;
  projectId: string;
  onImported: () => void;
}) {
  return (
    <section className="panel">
      <h2>Media Pool</h2>
      <ul className="asset-list">
        {project.assets.map((a) => (
          <li key={a.id} className="asset">
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
            <span className="muted">{a.duration != null ? fmt(a.duration) : "—"}</span>
            {a.source?.model && (
              <span className="badge badge-stub" title={a.source.directedPrompt ?? a.source.prompt}>
                {a.source.simulated ? "offline" : a.source.provider ?? "AI"}
              </span>
            )}
          </li>
        ))}
      </ul>
      <ImportForm projectId={projectId} onImported={onImported} />
    </section>
  );
}

function ImportForm({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  return (
    <form
      className="import-form"
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
      <h3>Import Media</h3>
      <input name="name" placeholder="name.mp4" required />
      <input name="path" placeholder="C:\\Videos\\clip.mp4" required />
      <select name="kind" defaultValue="video">
        <option value="video">video</option>
        <option value="audio">audio</option>
        <option value="image">image</option>
      </select>
      <input name="duration" type="number" placeholder="duration (s)" defaultValue={10} min={0} step={0.1} />
      <button type="submit">+ Import</button>
    </form>
  );
}

// ---------- Preview ----------

export function Preview({
  project,
  clip,
  playhead,
  frameUrl,
}: {
  project: Project;
  clip: Clip | null;
  playhead: number;
  frameUrl: string | null;
}) {
  const seq = project.sequences.find((s) => s.id === project.activeSequenceId)!;
  const t = clip?.transform;
  return (
    <section className="panel preview-panel">
      <h2>
        Preview <span className="muted">— live frame decoder (FFmpeg)</span>
      </h2>
      <div className="preview-stage" style={{ aspectRatio: `${seq.width} / ${seq.height}` }}>
        {clip && frameUrl ? (
          <div
            className="preview-clip preview-frame"
            style={{
              transform: t
                ? `translate(${t.x}px, ${t.y}px) rotate(${t.rotation}deg) scale(${t.scaleX}, ${t.scaleY})`
                : undefined,
              opacity: t?.opacity ?? 1,
            }}
          >
            <img
              src={frameUrl}
              alt={clip.name}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <div className="frame-label">
              <strong>{clip.name}</strong>
              <div className="muted">
                {fmt(clip.start)} → {fmt(clip.start + clip.duration)} • {clip.keyframes.length} kf
              </div>
            </div>
          </div>
        ) : (
          <div className="preview-empty">Select a clip or move playhead over a clip</div>
        )}
      </div>
      <div className="preview-meta">
        {seq.width}×{seq.height} • {seq.fps} fps • playhead {fmt(playhead)}
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
}: {
  project: Project;
  selection: { trackId: string; clipId: string } | null;
  onSelect: (trackId: string, clipId: string) => void;
  playhead: number;
  onSeek: (t: number) => void;
  zoom: number;
  onZoom: (z: number) => void;
}) {
  const seq = project.sequences.find((s) => s.id === project.activeSequenceId)!;
  const duration = Math.max(20, ...seq.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
  const width = duration * zoom + 80;
  const ticks = Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => i);

  return (
    <section className="panel timeline-panel">
      <div className="timeline-head">
        <h2>Timeline</h2>
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
            <div key={track.id} className="track">
              <div className="track-label" style={{ borderColor: TRACK_COLOR[track.kind] }}>
                {track.name}
              </div>
              <div className="track-lane">
                {track.clips.map((clip) => {
                  const selected = selection?.clipId === clip.id;
                  return (
                    <div
                      key={clip.id}
                      className={`clip ${selected ? "clip-selected" : ""}`}
                      style={{
                        left: clip.start * zoom,
                        width: Math.max(8, clip.duration * zoom),
                        background: TRACK_COLOR[track.kind],
                      }}
                      title={`${clip.name} (${fmt(clip.start)}–${fmt(clip.start + clip.duration)})`}
                      onClick={() => onSelect(track.id, clip.id)}
                    >
                      <span className="clip-name">{clip.name}</span>
                      {clip.keyframes.length > 0 && <span className="clip-kf">◆{clip.keyframes.length}</span>}
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
  captions,
}: {
  clip: Clip | null;
  asset: Asset | null;
  onPatch: (patch: Record<string, unknown>) => void;
  captions: Caption[];
}) {
  if (!clip) {
    return (
      <section className="panel">
        <h2>Inspector</h2>
        <p className="muted">Nothing selected.</p>
        <Captions captions={captions} />
      </section>
    );
  }
  const field = (label: string, key: string, value: number | string, step = 0.1) => (
    <label key={key}>
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
      <h2>Inspector</h2>
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
