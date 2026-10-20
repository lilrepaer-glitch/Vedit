import { useCallback, useEffect, useMemo, useState } from "react";
import { api, connectWs, setCurrentId, withToken, type Clip, type Project } from "./api";
import { Inspector, JobsPanel, MediaPool, Preview, Timeline, fmt } from "./components";

interface Selection {
  trackId: string;
  clipId: string;
}

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [playhead, setPlayhead] = useState(2);
  const [zoom, setZoom] = useState(60);
  const [toast, setToast] = useState<string | null>(null);
  const [presets, setPresets] = useState<Array<{ id: string; label: string }>>([]);
  const [presetId, setPresetId] = useState("fade-in");
  const [prompt, setPrompt] = useState("ohňostroj nad Prahou, noční panorama");
  const [busy, setBusy] = useState(false);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  }, []);

  const refresh = useCallback(async () => {
    const { projects } = await api.listProjects();
    const id = projects[0]?.id;
    if (!id) return;
    setCurrentId(id);
    const { project } = await api.getProject(id);
    setProject(project);
    (window as unknown as { __veditProject: string }).__veditProject = id;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
        setPresets((await api.presets()).presets);
      } catch (err) {
        flash(`Chyba: ${(err as Error).message}`);
      }
    })();
    return connectWs(() => void refresh());
  }, [refresh, flash]);

  const seq = project?.sequences.find((s) => s.id === project.activeSequenceId) ?? null;
  const selected: { clip: Clip; trackId: string } | null = useMemo(() => {
    if (!seq || !selection) return null;
    for (const track of seq.tracks) {
      const clip = track.clips.find((c) => c.id === selection.clipId);
      if (clip) return { clip, trackId: track.id };
    }
    return null;
  }, [seq, selection]);

  // F1: aktivní klip pro náhled = vybraný klip pod playheadem, jinak klip pod playheadem
  const activeClip: Clip | null = useMemo(() => {
    if (!seq) return null;
    const inside = (c: Clip) => playhead >= c.start && playhead <= c.start + c.duration;
    if (selected && inside(selected.clip)) return selected.clip;
    for (const track of [...seq.tracks].filter((t) => t.kind !== "audio").reverse()) {
      const c = track.clips.find(inside);
      if (c) return c;
    }
    return selected?.clip ?? null;
  }, [seq, selected, playhead]);

  const frameUrl = useMemo(() => {
    if (!project || !activeClip) return null;
    const t = activeClip.in + Math.min(Math.max(0, playhead - activeClip.start), activeClip.duration);
    return withToken(
      `/api/v1/projects/${project.id}/assets/${activeClip.assetId}/frame?t=${t.toFixed(2)}&width=640`,
    );
  }, [project, activeClip, playhead]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, okMessage?: string) => {
      setBusy(true);
      try {
        await fn();
        await refresh();
        if (okMessage) flash(okMessage);
      } catch (err) {
        flash(`Chyba: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh, flash],
  );

  if (!project || !seq) {
    return <div className="app loading">Připojuji se k Vedit API…</div>;
  }

  const clipId = selection?.clipId;
  const captionText = `Popisek @ ${fmt(playhead)}`;

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="logo">Vedit</span>
          <span className="muted">{project.name}</span>
        </div>
        <div className="toolbar-group">
          <button disabled={busy} onClick={() => act(() => api.undo(), "Undo")}>
            ↶ Undo
          </button>
          <button disabled={busy} onClick={() => act(() => api.redo(), "Redo")}>
            ↷ Redo
          </button>
        </div>
        <div className="toolbar-group">
          <button
            disabled={busy || !clipId}
            title="Rozdělí vybraný klip v playhead"
            onClick={() => clipId && act(() => api.splitClip(clipId, playhead), `Rozděleno @ ${fmt(playhead)}`)}
          >
            ✂ Split @ playhead
          </button>
          <button disabled={busy || !clipId} onClick={() => clipId && act(() => api.deleteClip(clipId), "Klip smazán")}>
            🗑 Delete
          </button>
          <button
            disabled={busy || !clipId}
            onClick={() => clipId && act(() => api.deleteClip(clipId, true), "Klip smazán (ripple)")}
          >
             ripple delete
          </button>
        </div>
        <div className="toolbar-group">
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            disabled={busy || !clipId}
            onClick={() => clipId && act(() => api.applyPreset(clipId, presetId), `Animace ${presetId}`)}
          >
            ✨ Animace
          </button>
          <button
            disabled={busy}
            onClick={() =>
              act(() => api.addCaption({ text: captionText, start: playhead, end: playhead + 2 }), "Titulek přidán")
            }
          >
            💬 Titulek
          </button>
        </div>
        <div className="toolbar-group">
          <input className="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="AI prompt…" />
          <button
            disabled={busy}
            title="F0: simulované generování (reálné modely ve F4)"
            onClick={() =>
              act(async () => {
                const res = await api.genVideo(prompt, 5);
                flash(`Gen video job ${res.jobId.slice(0, 8)}… (F0 stub)`);
              })
            }
          >
            🎬 Gen video
          </button>
          <button
            disabled={busy}
            onClick={() =>
              act(async () => {
                const res = await api.exportRender();
                flash(`Export job ${res.jobId.slice(0, 8)}… (F0 stub)`);
              })
            }
          >
            📤 Export
          </button>
        </div>
      </header>

      <main className="main">
        <div className="left-col">
          <MediaPool project={project} projectId={project.id} onImported={() => void refresh()} />
          <JobsPanel project={project} />
        </div>
        <Preview project={project} clip={activeClip} playhead={playhead} frameUrl={frameUrl} />
        <div className="right-col">
          <Inspector
            clip={selected?.clip ?? null}
            captions={seq.captions}
            onPatch={(patch) => {
              if (!clipId) return;
              // transform.x → nested patch
              const nested: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(patch)) {
                if (key.startsWith("transform.")) {
                  (nested.transform ??= {});
                  (nested.transform as Record<string, unknown>)[key.slice("transform.".length)] = value;
                } else {
                  nested[key] = value;
                }
              }
              void act(() => api.updateClip(clipId, nested), "Klip upraven");
            }}
          />
        </div>
      </main>

      <Timeline
        project={project}
        selection={selection}
        onSelect={(trackId, clipId) => setSelection({ trackId, clipId })}
        playhead={playhead}
        onSeek={setPlayhead}
        zoom={zoom}
        onZoom={setZoom}
      />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
