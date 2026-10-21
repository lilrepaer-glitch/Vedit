import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  connectWs,
  setCurrentId,
  withToken,
  type CameraMoveInfo,
  type Clip,
  type ExportPresetInfo,
  type GenProviderInfo,
  type MarketplacePackInfo,
  type Project,
} from "./api";
import { AiPanel, GenPanel, Inspector, JobsPanel, MediaPool, Preview, StudioPanel, Timeline, fmt } from "./components";

interface Selection {
  trackId: string;
  clipId: string;
}

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shuttleRate, setShuttleRate] = useState(1);
  const [zoom, setZoom] = useState(60);
  const [toast, setToast] = useState<string | null>(null);
  const [presets, setPresets] = useState<Array<{ id: string; label: string }>>([]);
  const [presetId, setPresetId] = useState("fade-in");
  const [prompt, setPrompt] = useState("fireworks over Prague, night skyline");
  const [copilotPrompt, setCopilotPrompt] = useState("Apply Kodak 2383 LUT, add lower third \"Vedit Studio\", duck music");
  const [busy, setBusy] = useState(false);
  const [aiCaps, setAiCaps] = useState<Awaited<ReturnType<typeof api.aiCaps>> | null>(null);
  const [genProviders, setGenProviders] = useState<GenProviderInfo[]>([]);
  const [cameraMoves, setCameraMoves] = useState<CameraMoveInfo[]>([]);
  const [exportPresets, setExportPresets] = useState<ExportPresetInfo[]>([]);
  const [exportPresetId, setExportPresetId] = useState("youtube-1080p");
  const [hwAccel, setHwAccel] = useState("auto");
  const [loudnessLufs, setLoudnessLufs] = useState<string>("-14");
  const [packs, setPacks] = useState<MarketplacePackInfo[]>([]);

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
          const [presetRes, capsRes, genRes, expRes, marketRes] = await Promise.all([
            api.presets(),
            api.aiCaps(),
            api.genProviders(),
            api.exportPresets(),
            api.marketplaceList(),
          ]);
          if (cancelled) return;
          setPresets(presetRes.presets);
          setAiCaps(capsRes);
          setGenProviders(genRes.providers);
          setCameraMoves(genRes.cameraMoves);
          setExportPresets(expRes.presets);
          setPacks(marketRes.packs);
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

  const totalSeqDuration = useMemo(() => {
    if (!seq) return 10;
    return Math.max(
      1,
      ...seq.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)),
      ...seq.captions.map((c) => c.end),
    );
  }, [seq]);

  // Real-time 60Hz transport loop when playing
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPlayhead((prev) => {
        const next = prev + dt * shuttleRate;
        if (next >= totalSeqDuration) {
          setPlaying(false);
          return totalSeqDuration;
        }
        if (next <= 0) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, shuttleRate, totalSeqDuration]);

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

  // Global NLE keyboard shortcuts (Space, J/K/L, Frame Step, Save, Undo/Redo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const fps = seq?.fps || 30;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void act(async () => {
          const saved = await api.saveProjectDisk();
          flash(`Saved → ${saved.filePath.split(/[\\/]/).pop()}`);
        });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void act(() => api.undo(), "Undo");
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void act(() => api.redo(), "Redo");
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        setShuttleRate(1);
        setPlaying((p) => !p);
      } else if (e.key.toLowerCase() === "k") {
        setPlaying(false);
      } else if (e.key.toLowerCase() === "l") {
        setPlaying((wasPlaying) => {
          setShuttleRate((r) => (!wasPlaying || r < 0 ? 1 : Math.min(4, r * 2)));
          return true;
        });
      } else if (e.key.toLowerCase() === "j") {
        setShuttleRate(-1);
        setPlaying(true);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        setPlayhead((p) => Math.max(0, p - 1 / fps));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        setPlayhead((p) => Math.min(totalSeqDuration, p + 1 / fps));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seq, totalSeqDuration, act, flash]);

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
          <button
            disabled={busy}
            title="Save .vedit project to disk (Ctrl+S)"
            onClick={() =>
              act(async () => {
                const saved = await api.saveProjectDisk();
                flash(`Saved → ${saved.filePath.split(/[\\/]/).pop()}`);
              })
            }
          >
            💾 Save
          </button>
          <button
            disabled={busy}
            title="Open most recent saved .vedit project"
            onClick={() =>
              act(async () => {
                const { saved } = await api.savedProjects();
                if (!saved.length) {
                  flash("No saved .vedit projects on disk yet");
                  return;
                }
                const opened = await api.openProjectDisk(saved[0]!.filePath);
                setCurrentId(opened.project.id);
                setProject(opened.project);
                flash(`Opened "${opened.project.name}"`);
              })
            }
          >
            📂 Open
          </button>
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
          <input
            className="prompt"
            value={copilotPrompt}
            onChange={(e) => setCopilotPrompt(e.target.value)}
            placeholder='AI Copilot: e.g. "Apply Kodak LUT & duck music"'
          />
          <button
            disabled={busy || !copilotPrompt.trim()}
            title="Execute multi-step AI Studio Copilot workflow with auto checkpoint"
            onClick={() =>
              act(async () => {
                const res = await api.runCopilot(copilotPrompt);
                flash(res.summary);
              })
            }
          >
            🤖 Copilot
          </button>
          <input
            className="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Quick AI shot prompt…"
          />
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
          <select value={exportPresetId} onChange={(e) => setExportPresetId(e.target.value)} title="Export preset">
            {exportPresets.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.label}
              </option>
            ))}
          </select>
          <select value={hwAccel} onChange={(e) => setHwAccel(e.target.value)} title="Hardware GPU Encoder">
            <option value="auto">⚡ Auto GPU/CPU</option>
            <option value="nvenc">NVIDIA NVENC</option>
            <option value="amf">AMD AMF</option>
            <option value="qsv">Intel QuickSync</option>
            <option value="cpu">CPU Software</option>
          </select>
          <select value={loudnessLufs} onChange={(e) => setLoudnessLufs(e.target.value)} title="Audio Loudness Target">
            <option value="-14">-14 LUFS (Web)</option>
            <option value="-16">-16 LUFS (Voice)</option>
            <option value="-23">-23 LUFS (EBU)</option>
            <option value="off">Raw Audio</option>
          </select>
          <button
            disabled={busy}
            onClick={() =>
              act(async () => {
                const lufs = loudnessLufs === "off" ? undefined : Number(loudnessLufs);
                const res = await api.exportRender(exportPresetId, hwAccel, lufs);
                flash(`Export (${exportPresetId}, ${hwAccel}) job ${res.jobId.slice(0, 8)}…`);
              })
            }
          >
            📤 Export
          </button>
          <button
            disabled={busy}
            title="Auto-select sharpest frame & export 1280×720 YouTube thumbnail"
            onClick={() =>
              act(async () => {
                const res = await api.exportThumbnail();
                flash(`Thumbnail saved (t=${res.selectedTime}s) → ${res.outPath.split(/[\\/]/).pop()}`);
                window.open(withToken(`/api/v1/projects/${project.id}/thumbnail/image`), "_blank");
              })
            }
          >
            🖼 Thumbnail
          </button>
          <button
            disabled={busy}
            title="Render YouTube 16:9 + TikTok 9:16 + WebM simultaneously"
            onClick={() =>
              act(async () => {
                const res = await api.batchExport(["youtube-1080p", "tiktok-reels", "webm-vp9"]);
                flash(`Batch export queued (${res.jobIds.length} targets)`);
              })
            }
          >
            📦 Batch
          </button>
          <button
            disabled={busy}
            title="Export DaVinci Resolve / Premiere CMX 3600 .edl"
            onClick={() => window.open(withToken(`/api/v1/projects/${project.id}/export/edl`), "_blank")}
          >
            🎞 EDL
          </button>
          <button
            disabled={busy}
            title="Export Final Cut Pro / DaVinci Resolve .fcpxml"
            onClick={() => window.open(withToken(`/api/v1/projects/${project.id}/export/fcpxml`), "_blank")}
          >
            🎬 XML
          </button>
        </div>
      </header>

      <main className="main">
        <div className="left-col">
          <MediaPool
            project={project}
            projectId={project.id}
            playhead={playhead}
            onImported={(msg) => {
              void refresh();
              if (msg) flash(msg);
            }}
            onQuickAdd={(asset) =>
              act(async () => {
                const isAud = asset.kind === "audio";
                let track = seq.tracks.find((t) => t.kind === (isAud ? "audio" : "video") && !t.locked);
                if (!track) {
                  const created = await api.addTrack(isAud ? "audio" : "video", isAud ? "A1" : "V1");
                  track = created.track;
                }
                const dur = asset.duration ?? 5;
                await api.addClip({
                  trackId: track.id,
                  assetId: asset.id,
                  start: playhead,
                  duration: dur,
                  in: 0,
                  out: dur,
                });
                flash(`Added "${asset.name}" @ ${fmt(playhead)}`);
              })
            }
          />
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
        <Preview
          project={project}
          clip={activeClip}
          playhead={playhead}
          playing={playing}
          shuttleRate={shuttleRate}
          frameUrl={frameUrl}
          onTogglePlay={() => {
            setShuttleRate(1);
            setPlaying((p) => !p);
          }}
          onSeek={(t) => {
            setPlaying(false);
            setPlayhead(t);
          }}
        />
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
          <StudioPanel
            packs={packs}
            project={project}
            playhead={playhead}
            busy={busy}
            onApplyTemplate={(templateId, title) =>
              act(() => api.applyTemplate(templateId, title ? { title } : {}), "Template applied")
            }
            onRunPlugin={(pluginId) => act(() => api.runPlugin(pluginId), `Plugin ${pluginId} finished`)}
            onAddGraphic={(kind, label, svgMarkup) =>
              act(
                () =>
                  api.addGraphic({
                    kind,
                    label,
                    svgMarkup,
                    start: playhead,
                    duration: 3,
                    animationPreset: "fade-in",
                  }),
                `Graphic overlay "${kind}" added`,
              )
            }
            onSaveSnapshot={(label) => act(() => api.saveSnapshot(label), `Checkpoint "${label}" saved`)}
            onRestoreSnapshot={(snapshotId) => act(() => api.restoreSnapshot(snapshotId), "Checkpoint restored")}
            onAddComment={(text, timecode) => act(() => api.addComment(text, timecode), "Review note added")}
            onResolveComment={(id, resolved) => act(() => api.resolveComment(id, resolved))}
            onSeek={setPlayhead}
          />
          <Inspector
            clip={selected?.clip ?? null}
            asset={selectedAsset}
            captions={seq.captions}
            onProAction={(action, payload) => {
              if (!clipId) return;
              switch (action) {
                case "speed":
                  void act(
                    () => api.setClipSpeed(clipId, Number(payload?.speed ?? 1)),
                    `Clip speed set to ${payload?.speed}×`,
                  );
                  break;
                case "color-grade":
                  void act(
                    () => api.colorGrade(clipId, String(payload?.preset ?? "cinematic-contrast")),
                    `Color grade "${payload?.preset}" applied`,
                  );
                  break;
                case "chroma-key":
                  void act(
                    () => api.chromaKey(clipId, String(payload?.color ?? "#00ff00")),
                    `Chroma key (${payload?.color}) applied`,
                  );
                  break;
                case "fade":
                  void act(
                    () => api.fadeClip(clipId, Number(payload?.fadeIn ?? 0.5), Number(payload?.fadeOut ?? 0.5)),
                    "Fade transition applied",
                  );
                  break;
                case "lut3d":
                  void act(
                    () => api.applyLut(clipId, String(payload?.lutId ?? "kodak-2383")),
                    `3D .cube LUT "${payload?.lutId}" applied`,
                  );
                  break;
                case "stabilize":
                  void act(async () => {
                    const res = await api.stabilizeClip(clipId);
                    flash(`Stabilized clip (${res.method})`);
                  });
                  break;
                case "layout":
                  void act(
                    () => api.applyLayout(clipId, String(payload?.layout ?? "pip-bottom-right")),
                    `Layout "${payload?.layout}" applied`,
                  );
                  break;
                case "enhance-audio":
                  void act(
                    () => api.enhanceAudio(clipId),
                    "Voice enhanced (FFT denoise + EQ + -16 LUFS)",
                  );
                  break;
                case "duck-audio":
                  void act(async () => {
                    const res = await api.duckAudio(clipId);
                    flash(`Music auto-ducked across ${res.speechIntervals.length} speech segment(s)`);
                  });
                  break;
                case "remove-effect":
                  void act(() => api.removeEffect(clipId, String(payload?.effectId ?? "")), "Effect removed");
                  break;
              }
            }}
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
        onSeek={(t) => {
          setPlaying(false);
          setPlayhead(t);
        }}
        zoom={zoom}
        onZoom={setZoom}
        onAddTrack={(kind) => act(() => api.addTrack(kind), `Added ${kind} track`)}
        onUpdateTrack={(trackId, patch) => act(() => api.updateTrack(trackId, patch))}
        onClipEdit={(id, patch) => act(() => api.updateClip(id, patch), "Clip updated")}
      />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
