import type { Asset, Caption, Clip, Project, Track } from "./api";
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
      <h2>Media pool</h2>
      <ul className="asset-list">
        {project.assets.map((a) => (
          <li key={a.id} className="asset">
            <span className={`badge badge-${a.kind}`}>{a.kind}</span>
            <span className="asset-name" title={a.path}>
              {a.name}
            </span>
            <span className="muted">{a.duration != null ? fmt(a.duration) : "—"}</span>
            {a.source?.simulated && <span className="badge badge-stub">AI stub</span>}
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
          alert((await res.json()).error ?? "import selhal");
        }
      }}
    >
      <h3>Import média</h3>
      <input name="name" placeholder="název.mp4" required />
      <input name="path" placeholder="/media/soubor.mp4" required />
      <select name="kind" defaultValue="video">
        <option value="video">video</option>
        <option value="audio">audio</option>
        <option value="image">obrázek</option>
      </select>
      <input name="duration" type="number" placeholder="délka (s)" defaultValue={10} min={0} step={0.1} />
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
        Náhled <span className="muted">— F1: skutečný snímek z média (FFmpeg)</span>
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
          <div className="preview-empty">Vyberte klip nebo posuňte playhead nad klip</div>
        )}
      </div>
      <div className="preview-meta">
        {seq.width}×{seq.height} • {seq.fps} fps • playhead {fmt(playhead)}
      </div>
    </section>
  );
}

// ---------- AI titulky (F2) ----------

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
  onAiEdit: (action: "remove-silences" | "highlight" | "beat-sync" | "auto-reframe" | "track-motion", params: Record<string, string>) => void;
}) {
  const audioAssets = assets.filter((a) => a.kind === "audio");
  const videoAssets = assets.filter((a) => a.kind === "video");
  return (
    <section className="panel">
      <h2>AI titulky &amp; voiceover</h2>
      <p className="muted">
        TTS: {caps?.tts.available ? caps.tts.engine : "nedostupný"} • ASR:{" "}
        {caps?.asr.available ? caps.asr.engine : "nedostupný"}
      </p>
      <form
        className="import-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          onVoiceover(String(data.get("script") || ""), String(data.get("voice") || "cs"));
        }}
      >
        <textarea
          name="script"
          rows={3}
          placeholder="Skript — každá věta bude titulek…"
          required
        />
        <div className="row">
          <select name="voice" defaultValue="cs">
            {(caps?.voices.length ? caps.voices : ["cs", "en"]).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy || !caps?.tts.available}>
            🎙 Voiceover + titulky
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
          title="Přepíše řeč z média na titulky (pocketsphinx/en)"
          onClick={() => {
            const select = document.getElementById("transcribe-asset") as HTMLSelectElement | null;
            if (select?.value) onTranscribe(select.value);
          }}
        >
          📝 Přepsat řeč
        </button>
      </div>
      <h2>AI střih</h2>
      <p className="muted">
        {selectedClipId ? `klip ${selectedClipId.slice(0, 8)}…` : "vyber klip na timeline"}
      </p>
      <div className="row">
        <button
          disabled={busy || !selectedClipId}
          title="Detekuje ticha a zavře mezery na stopě vybraného klipu"
          onClick={() => selectedClipId && onAiEdit("remove-silences", { clipId: selectedClipId })}
        >
          ✂️ Vyhoď ticha
        </button>
        <button
          disabled={busy || videoAssets.length === 0}
          title="Sestaví highlight reel (pohyb + energie + scény) do nové stopy"
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
          title="Rozdělí vybraný klip na střihy přesně na beaty hudby"
          onClick={() => {
            const music = (document.getElementById("beat-music") as HTMLSelectElement | null)?.value;
            if (selectedClipId && music) onAiEdit("beat-sync", { clipId: selectedClipId, musicAssetId: music });
          }}
        >
          🥁 Beat sync
        </button>
      </div>
      <div className="row">
        <button
          disabled={busy || !selectedClipId}
          title="Vycentruje pohyb v klipu (pan keyframy) — pro výřez 9:16"
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
          title="Vybraný klip (grafika/text) bude sledovat pohyb ve zdroji"
          onClick={() => {
            const src = (document.getElementById("motion-source") as HTMLSelectElement | null)?.value;
            if (selectedClipId && src) onAiEdit("track-motion", { clipId: selectedClipId, sourceAssetId: src });
          }}
        >
          🎯 Track motion
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
      <h2>Úlohy</h2>
      {jobs.length === 0 && <p className="muted">Zatím žádné úlohy.</p>}
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
            {j.status === "done" && (j.output as { outPath?: string } | undefined)?.outPath && (
              <a
                className="job-dl"
                href={withToken(`/api/v1/jobs/${j.id}/output`)}
                download
              >
                ⬇ stáhnout výstup
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
  const duration = Math.max(
    20,
    ...seq.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)),
  );
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
  onPatch,
  captions,
}: {
  clip: Clip | null;
  onPatch: (patch: Record<string, unknown>) => void;
  captions: Caption[];
}) {
  if (!clip) {
    return (
      <section className="panel">
        <h2>Inspector</h2>
        <p className="muted">Nic nevybráno.</p>
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
        {field("název", "name", clip.name)}
        {field("start (s)", "start", clip.start)}
        {field("délka (s)", "duration", clip.duration)}
        {field("in (s)", "in", clip.in)}
        {field("out (s)", "out", clip.out)}
        {field("X", "transform.x", clip.transform.x)}
        {field("Y", "transform.y", clip.transform.y)}
        {field("rotace", "transform.rotation", clip.transform.rotation, 1)}
        {field("opacity", "transform.opacity", clip.transform.opacity)}
      </div>
      <h3>Keyframy ({clip.keyframes.length})</h3>
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
      <h3>Titulky ({captions.length})</h3>
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
