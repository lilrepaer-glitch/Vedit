import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  connectWs,
  setCurrentId,
  withToken,
  type CameraMoveInfo,
  type Clip,
  type GenProviderInfo,
  type Project,
} from "./api";
import { AiPanel, GenPanel, Inspector, JobsPanel, MediaPool, Preview, Timeline, fmt } from "./components";

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
  const [prompt, setPrompt] = useState("fireworks over Prague, night skyline");
  const [busy, setBusy] = useState(false);
  const [aiCaps, setAiCaps] = useState<Awaited<ReturnType<typeof api.aiCaps>> | null>(null);
  const [genProviders, setGenProviders] = useState<GenProviderInfo[]>([]);
  const [cameraMoves, setCameraMoves] = useState<CameraMoveInfo[]>([]);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  }, []);

  const refresh = useCallback(async () => {
    const { projects } = await api.listProjects();
    let id = projects[0]?.id;
    if (!id) {
      const created = await api.createProject("My Vedit Project", true);
      id = created.project.id;
    }
    setCurrentId(id);
    const { project } = await api.getProject(id);
    setProject(project);
    (window as unknown as { __veditProject: string }).__veditProject = id;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; !cancelled && attempt < 40; attempt++) {
        try {
          await refresh();
          const [presetRes, capsRes, genRes] = await Promise.all([
            api.presets(),
            api.aiCaps(),
            api.genProviders(),
          ]);
          if (cancelled) return;
          setPresets(presetRes.presets);
          setAiCaps(capsRes);
          setGenProviders(genRes.providers);
          setCameraMoves(genRes.cameraMoves);
          return;
        } catch (err) {
          if (attempt === 39) flash(`Error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    })();
    const disconnect = connectWs(() => void refresh().catch(() => undefined));
    return () => {
      cancelled = true;
      disconnect();
    };
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

  const selectedAsset = useMemo(() => {
    if (!project || !selected) return null;
    return project.assets.find((a) => a.id === selected.clip.assetId) ?? null;
  }, [project, selected]);

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
        flash(`Error: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh, flash],
  );

  if (!project || !seq) {
    return <div className="app loading">Connecting to Vedit Engine…</div>;
  }

  const clipId = selection?.clipId;
  const captionText = `Caption @ ${fmt(playhead)}`;

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
            title="Split selected clip at playhead"
            onClick={() => clipId && act(() => api.splitClip(clipId, playhead), `Split @ ${fmt(playhead)}`)}
          >
            ✂ Split @ playhead
          </button>
          <button disabled={busy || !clipId} onClick={() => clipId && act(() => api.deleteClip(clipId), "Clip deleted")}>
            🗑 Delete
          </button>
          <button
            disabled={busy || !clipId}
            onClick={() => clipId && act(() => api.deleteClip(clipId, true), "Clip deleted (ripple)")}
          >
            Ripple delete
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
            onClick={() => clipId && act(() => api.applyPreset(clipId, presetId), `Animation ${presetId}`)}
          >
            ✨ Animation
          </button>
          <button
            disabled={busy}
            onClick={() =>
              act(() => api.addCaption({ text: captionText, start: playhead, end: playhead + 2 }), "Caption added")
            }
          >
            💬 Caption
          </button>
        </div>
        <div className="toolbar-group">
          <input className="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Quick AI shot prompt…" />
          <button
            disabled={busy}
            title="Generate AI video shot & insert onto timeline"
            onClick={() =>
              act(async () => {
                const res = await api.genVideo(prompt, 5);
                flash(`Vedit Gen job ${res.jobId.slice(0, 8)}… queued`);
              })
            }
          >
            🎬 Gen Video
          </button>
          <button
            disabled={busy}
            onClick={() =>
              act(async () => {
                const res = await api.exportRender();
                flash(`Export MP4 job ${res.jobId.slice(0, 8)}… started`);
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
          <AiPanel
            caps={aiCaps}
            assets={project.assets}
            busy={busy}
            onVoiceover={(script, voice) =>
              act(async () => {
                const res = await api.voiceover(script, voice, playhead);
                flash(`Voiceover job ${res.jobId.slice(0, 8)}… (TTS + captions)`);
              })
            }
            onTranscribe={(assetId) =>
              act(async () => {
                const res = await api.transcribe(assetId);
                flash(`Transcription job ${res.jobId.slice(0, 8)}…`);
              })
            }
            selectedClipId={selection?.clipId ?? null}
            onAiEdit={(action, params) =>
              act(async () => {
                switch (action) {
                  case "remove-silences": {
                    const res = await api.removeSilences(params.clipId);
                    flash(`Silences removed: −${res.savedDuration.toFixed(2)}s`);
                    break;
                  }
                  case "highlight": {
                    const res = await api.highlight(15);
                    flash(`Highlight ${res.totalDuration.toFixed(1)}s (${res.clips.length} clips)`);
                    break;
                  }
                  case "beat-sync": {
                    const res = await api.beatSync(params.clipId!, params.musicAssetId!);
                    flash(`Beat-sync: ${res.beats.length} beats → ${res.splits.length} cuts`);
                    break;
                  }
                  case "auto-reframe": {
                    const res = await api.autoReframe(params.clipId!);
                    flash(`Auto-reframe: ${res.keyframes} keyframes`);
                    break;
                  }
                  case "track-motion": {
                    const res = await api.trackMotion(params.clipId!, params.sourceAssetId!);
                    flash(`Tracking: ${res.keyframes} keyframes`);
                    break;
                  }
                }
              })
            }
          />
          <JobsPanel project={project} />
        </div>
        <Preview project={project} clip={activeClip} playhead={playhead} frameUrl={frameUrl} />
        <div className="right-col">
          <GenPanel
            providers={genProviders}
            cameraMoves={cameraMoves}
            selectedClipId={selection?.clipId ?? null}
            busy={busy}
            onGenerate={(req) =>
              act(async () => {
                const res = await api.generateMedia(req);
                flash(`Vedit Gen (${req.kind}): job ${res.jobId.slice(0, 8)}…`);
              })
            }
          />
          <Inspector
            clip={selected?.clip ?? null}
            asset={selectedAsset}
            captions={seq.captions}
            onPatch={(patch) => {
              if (!clipId) return;
              const nested: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(patch)) {
                if (key.startsWith("transform.")) {
                  (nested.transform ??= {});
                  (nested.transform as Record<string, unknown>)[key.slice("transform.".length)] = value;
                } else {
                  nested[key] = value;
                }
              }
              void act(() => api.updateClip(clipId, nested), "Clip updated");
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
