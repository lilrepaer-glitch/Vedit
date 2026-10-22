import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeSequence,
  api,
  connectWs,
  setCurrentId,
  withToken,
  type ApiSettingsResponse,
  type Asset,
  type Caption,
  type Clip,
  type ExportPresetInfo,
  type Project,
  type ProjectSummary,
  type Track,
} from "./api";
import { CompositorStage, StudioTimeline } from "./components";
import {
  getClipSpeed,
  getClipTransition,
  getSequenceDuration,
  isClipReversed,
  LOOK_PRESETS,
  readClipAdjustments,
  readClipLook,
} from "./compositor";
import {
  IconAdjust,
  IconAudio,
  IconCheck,
  IconChevronDown,
  IconCrop,
  IconDuplicate,
  IconExport,
  IconFilter,
  IconFlipH,
  IconFlipV,
  IconFreeze,
  IconKey,
  IconLogo,
  IconMedia,
  IconMic,
  IconPlus,
  IconRedo,
  IconReverse,
  IconRotate,
  IconScissors,
  IconSend,
  IconSparkles,
  IconSpeed,
  IconText,
  IconTrash,
  IconUndo,
} from "./Icons";
import { ApiSettingsModal, ExportModal } from "./StudioModals";

type ToolTab = "media" | "edit" | "adjust" | "filters" | "text" | "canvas" | "audio" | "ai";

const ASPECT_PRESETS: Array<{ id: string; label: string; width: number; height: number }> = [
  { id: "9:16", label: "9:16", width: 1080, height: 1920 },
  { id: "16:9", label: "16:9", width: 1920, height: 1080 },
  { id: "1:1", label: "1:1", width: 1080, height: 1080 },
  { id: "4:5", label: "4:5", width: 1080, height: 1350 },
  { id: "21:9", label: "21:9", width: 2560, height: 1080 },
];

const TRANSITION_OPTIONS: Array<{ kind: string; label: string }> = [
  { kind: "none", label: "None (Cut)" },
  { kind: "dissolve", label: "Cross Dissolve" },
  { kind: "fade-black", label: "Fade Black" },
  { kind: "fade-white", label: "Fade White" },
  { kind: "slide-left", label: "Slide Left" },
  { kind: "wipe-right", label: "Wipe Right" },
  { kind: "zoom-in", label: "Zoom In" },
];

const TEXT_PRESETS: Array<{ label: string; text: string; style: Record<string, unknown> }> = [
  {
    label: "Clean Subtitle",
    text: "Your subtitle here",
    style: { fontSize: 48, color: "#ffffff", bgColor: "#09090b", bgOpacity: 0.65, x: 0.5, y: 0.85, bold: true, animation: "fade" },
  },
  {
    label: "Bold Title",
    text: "MAIN HEADLINE",
    style: { fontSize: 74, color: "#ffffff", bgOpacity: 0, x: 0.5, y: 0.48, bold: true, animation: "pop" },
  },
  {
    label: "Minimal Pill",
    text: "Location · Day 01",
    style: { fontSize: 38, color: "#09090b", bgColor: "#fafafa", bgOpacity: 0.94, x: 0.5, y: 0.16, bold: true, animation: "slide-up" },
  },
  {
    label: "Typewriter",
    text: "CHAPTER ONE",
    style: { fontSize: 56, color: "#facc15", bgColor: "#09090b", bgOpacity: 0.72, x: 0.5, y: 0.24, bold: true, animation: "typewriter" },
  },
];

function getEffectParams(clip: Clip | null, type: string): Record<string, unknown> {
  if (!clip) return {};
  return clip.effects.find((e) => e.type === type && e.enabled !== false)?.params ?? {};
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ToolTab>("media");
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const [pxPerSec, setPxPerSec] = useState(64);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(300);
  const [timelineHeight, setTimelineHeight] = useState(235);
  const [isMobileLayout, setIsMobileLayout] = useState(() => window.innerWidth < 900);

  const [apiSettings, setApiSettings] = useState<ApiSettingsResponse | null>(null);
  const [exportPresets, setExportPresets] = useState<ExportPresetInfo[]>([]);
  const [showApiModal, setShowApiModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Voiceover recording state
  const [recordingVo, setRecordingVo] = useState(false);
  const [voSeconds, setVoSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voChunksRef = useRef<Blob[]>([]);

  // AI Copilot chat state
  const [aiInput, setAiInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessages, setAiMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    const onResize = () => setIsMobileLayout(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const refreshCurrentProject = useCallback(async (idOverride?: string) => {
    const target = idOverride ?? project?.id;
    if (!target) return null;
    setCurrentId(target);
    const { project: next } = await api.getProject(target);
    setProject(next);
    return next;
  }, [project?.id]);

  const refreshProjectsList = useCallback(async () => {
    const res = await api.listProjects();
    setProjects(res.projects);
    return res.projects;
  }, []);

  // Initial load: open project, load API config & export presets
  useEffect(() => {
    (async () => {
      try {
        const list = await refreshProjectsList();
        const loaded =
          list.length > 0
            ? (await api.getProject(list[0]!.id)).project
            : (await api.createProject("Untitled Edit", false)).project;
        setCurrentId(loaded.id);
        setProject(loaded);
        await refreshProjectsList();
      } catch (err) {
        flash(`Startup error: ${(err as Error).message}`);
      }
      api.getApiSettings().then(setApiSettings).catch(() => undefined);
      api.exportPresets().then((r) => setExportPresets(r.presets)).catch(() => undefined);
    })();
  }, [refreshProjectsList, flash]);

  // Subscribe to live project updates (undo/redo, export progress, AI actions, edits)
  useEffect(() => {
    if (!project?.id) return;
    setCurrentId(project.id);
    const close = connectWs(() => {
      api
        .getProject(project.id)
        .then((res) => setProject(res.project))
        .catch(() => undefined);
    });
    return close;
  }, [project?.id]);

  const seq = useMemo(() => (project ? activeSequence(project) : null), [project]);

  const selectedClip = useMemo<Clip | null>(() => {
    if (!seq || !selectedClipId) return null;
    for (const tr of seq.tracks) {
      const found = tr.clips.find((c) => c.id === selectedClipId);
      if (found) return found;
    }
    return null;
  }, [seq, selectedClipId]);

  const selectedCaption = useMemo<Caption | null>(() => {
    if (!seq || !selectedCaptionId) return null;
    return seq.captions.find((c) => c.id === selectedCaptionId) ?? null;
  }, [seq, selectedCaptionId]);

  const ensureTargetClip = useCallback((): Clip | null => {
    if (selectedClip) return selectedClip;
    if (!seq) return null;
    for (const tr of seq.tracks) {
      const underPlayhead = tr.clips.find((c) => playhead >= c.start && playhead <= c.start + c.duration);
      if (underPlayhead) {
        setSelectedClipId(underPlayhead.id);
        return underPlayhead;
      }
    }
    for (const tr of seq.tracks) {
      if (tr.clips[0]) {
        setSelectedClipId(tr.clips[0].id);
        return tr.clips[0];
      }
    }
    return null;
  }, [selectedClip, seq, playhead]);

  // ==================== CORE EDITING ACTIONS ====================

  const triggerFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length || !project) return;

    flash(`Importing ${files.length} file${files.length > 1 ? "s" : ""}…`);
    let addedCount = 0;
    for (const file of files) {
      try {
        const uploaded = await api.uploadAssetFile(file, undefined, true);
        if (uploaded.clip) {
          setSelectedClipId(uploaded.clip.id);
        }
        addedCount++;
      } catch (err) {
        flash(`Import failed: ${(err as Error).message}`);
      }
    }
    await refreshCurrentProject();
    if (addedCount > 0) {
      setPlayhead(0);
      flash(`Added ${addedCount} clip${addedCount > 1 ? "s" : ""} to timeline`);
    }
  };

  const addAssetToTimeline = async (item: Asset, asOverlay = false) => {
    if (!project || !seq) return;
    const wantKind = item.kind === "audio" ? "audio" : "video";
    const matchingTracks = seq.tracks.filter((t) => t.kind === wantKind);
    let targetTrack: Track | undefined = asOverlay ? matchingTracks[1] : matchingTracks[0];
    if (!targetTrack) {
      const createdTrack = await api.addTrack(wantKind, asOverlay ? "V2 · Overlay" : undefined);
      targetTrack = createdTrack.track;
    }
    const insertAt = asOverlay
      ? Number(playhead.toFixed(3))
      : Number(targetTrack.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0).toFixed(3));
    const dur = Math.max(0.5, item.duration || (item.kind === "image" || item.kind === "generated" ? 4 : 5));
    const { clip } = await api.addClip({
      trackId: targetTrack.id,
      assetId: item.id,
      start: insertAt,
      in: 0,
      out: Number(dur.toFixed(3)),
    });
    if (asOverlay) {
      await api.updateClip(clip.id, {
        transform: { ...clip.transform, scaleX: 0.42, scaleY: 0.42, x: 260, y: 220 },
      });
    }
    setSelectedClipId(clip.id);
    await refreshCurrentProject();
    flash(asOverlay ? `Added ${item.name} as PiP overlay` : `Added ${item.name}`);
  };

  const handleSplitAtPlayhead = useCallback(async () => {
    if (!project) return;
    const clip = ensureTargetClip();
    if (!clip) {
      flash("Select a clip to split");
      return;
    }
    if (playhead <= clip.start + 0.06 || playhead >= clip.start + clip.duration - 0.06) {
      flash("Move playhead inside the clip to split");
      return;
    }
    try {
      await api.splitClip(clip.id, Number(playhead.toFixed(3)));
      await refreshCurrentProject();
      flash("Clip split");
    } catch (err) {
      flash((err as Error).message);
    }
  }, [project, ensureTargetClip, playhead, refreshCurrentProject, flash]);

  const handleDeleteSelected = useCallback(async () => {
    if (!project) return;
    if (selectedCaptionId) {
      await api.deleteCaption(selectedCaptionId);
      setSelectedCaptionId(null);
      await refreshCurrentProject();
      flash("Title deleted");
      return;
    }
    if (selectedClipId) {
      await api.deleteClip(selectedClipId);
      setSelectedClipId(null);
      await refreshCurrentProject();
      flash("Clip deleted");
    }
  }, [project, selectedCaptionId, selectedClipId, refreshCurrentProject, flash]);

  const handleAspectChange = async (width: number, height: number) => {
    if (!project) return;
    await api.updateSequence({ width, height });
    await refreshCurrentProject();
    flash(`Canvas set to ${width}×${height}`);
  };

  const handleBackgroundChange = async (background: string) => {
    if (!project) return;
    await api.updateSequence({ background });
    await refreshCurrentProject();
  };

  const updateSelectedEffect = async (type: string, patch: Record<string, unknown>) => {
    const clip = ensureTargetClip();
    if (!clip || !project) {
      flash("Import or select a clip first");
      return;
    }
    const existing = getEffectParams(clip, type);
    await api.setClipEffect(clip.id, type, { ...existing, ...patch });
    await refreshCurrentProject();
  };

  // Voiceover Microphone Recorder (works natively on Android WebView + Desktop)
  const toggleVoiceoverRecording = async () => {
    if (recordingVo && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setRecordingVo(false);
      return;
    }
    if (!project) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voChunksRef.current = [];
      const rec = new MediaRecorder(stream);
      mediaRecorderRef.current = rec;
      const recordStartPlayhead = playhead;
      setVoSeconds(0);
      setRecordingVo(true);

      const timer = window.setInterval(() => setVoSeconds((s) => s + 1), 1000);
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) voChunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        window.clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(voChunksRef.current, { type: rec.mimeType || "audio/webm" });
        const ext = blob.type.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `Voiceover_${Date.now()}.${ext}`, { type: blob.type });
        await api.uploadAssetFile(file, Number(recordStartPlayhead.toFixed(3)), true);
        await refreshCurrentProject();
        flash("Voiceover added to audio track");
      };
      rec.start(200);
    } catch (err) {
      setRecordingVo(false);
      flash(`Microphone error: ${(err as Error).message}`);
    }
  };

  // AI Assistant execution
  const sendAiPrompt = async (customText?: string) => {
    const prompt = (customText ?? aiInput).trim();
    if (!prompt || aiBusy || !project) return;
    if (!customText) setAiInput("");
    setAiMessages((prev) => [...prev, { role: "user", text: prompt }]);
    setAiBusy(true);
    try {
      const res = await api.runCopilot(prompt);
      const detail = res.stepsExecuted?.length
        ? `${res.summary}\n(${res.stepsExecuted.map((s) => `${s.step}: ${s.detail}`).join(" · ")})`
        : res.summary;
      setAiMessages((prev) => [...prev, { role: "assistant", text: detail }]);
      await refreshCurrentProject();
    } catch (err) {
      setAiMessages((prev) => [...prev, { role: "assistant", text: `Error: ${(err as Error).message}` }]);
    } finally {
      setAiBusy(false);
    }
  };

  // Desktop keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "s" || e.key === "S") {
        if (!e.ctrlKey && !e.metaKey) void handleSplitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        void handleDeleteSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void api.redo().then(() => refreshCurrentProject());
        else void api.undo().then(() => refreshCurrentProject());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSplitAtPlayhead, handleDeleteSelected, refreshCurrentProject]);

  // Resizable desktop splitters
  const startResize = (axis: "left" | "right" | "timeline", e: React.PointerEvent) => {
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = leftWidth;
    const origRight = rightWidth;
    const origTl = timelineHeight;
    const onMove = (ev: PointerEvent) => {
      if (axis === "left") setLeftWidth(Math.max(230, Math.min(440, origLeft + (ev.clientX - startX))));
      else if (axis === "right") setRightWidth(Math.max(240, Math.min(420, origRight - (ev.clientX - startX))));
      else setTimelineHeight(Math.max(150, Math.min(420, origTl - (ev.clientY - startY))));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!project || !seq) {
    return (
      <div className="app" style={{ alignItems: "center", justifyContent: "center", gap: 12 }}>
        <IconLogo size={32} />
        <span style={{ color: "var(--muted)", fontSize: 13 }}>Loading Vedit Studio…</span>
      </div>
    );
  }

  const seqW = seq.width || 1920;
  const seqH = seq.height || 1080;
  const currentAspectLabel =
    ASPECT_PRESETS.find((a) => Math.abs(a.width / a.height - seqW / seqH) < 0.03)?.label ??
    `${seqW}×${seqH}`;

  const colorAdj = selectedClip ? readClipAdjustments(selectedClip) : null;
  const activeLookId = selectedClip ? readClipLook(selectedClip).id : "none";
  const cropParams = getEffectParams(selectedClip, "crop");
  const volFx = getEffectParams(selectedClip, "volume");
  const fadeFx = getEffectParams(selectedClip, "fade");
  const clipSpeed = selectedClip ? getClipSpeed(selectedClip) : 1;

  // ==================== SHARED TOOL PANEL CONTENT ====================
  const renderToolContent = (tab: ToolTab) => {
    switch (tab) {
      case "media":
        return (
          <>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="btn-primary" style={{ flex: 1 }} onClick={triggerFilePicker}>
                <IconPlus size={15} /> Import Media
              </button>
              <button
                type="button"
                className={recordingVo ? "btn-danger" : ""}
                onClick={toggleVoiceoverRecording}
                title="Record microphone voiceover directly to timeline"
              >
                <IconMic size={15} />
                {recordingVo ? `Stop (${voSeconds}s)` : "Voice"}
              </button>
            </div>

            {project.assets.length === 0 ? (
              <div style={{ padding: "22px 12px", textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
                Import videos, photos, or music from your device gallery to start editing.
              </div>
            ) : (
              <div className="asset-grid">
                {project.assets.map((item) => (
                  <div key={item.id} className="media-card">
                    <img
                      className="media-thumb"
                      src={withToken(`/api/v1/projects/${project.id}/assets/${item.id}/thumbnail`)}
                      alt={item.name}
                      onClick={() => void addAssetToTimeline(item, false)}
                    />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px" }}>
                      <span className="media-meta" style={{ padding: 0, flex: 1 }}>{item.name}</span>
                      <div style={{ display: "flex", gap: 3 }}>
                        <button
                          type="button"
                          style={{ padding: "2px 6px", fontSize: 10.5 }}
                          onClick={() => void addAssetToTimeline(item, false)}
                          title="Append to main track"
                        >
                          +Main
                        </button>
                        {item.kind !== "audio" && (
                          <button
                            type="button"
                            style={{ padding: "2px 6px", fontSize: 10.5 }}
                            onClick={() => void addAssetToTimeline(item, true)}
                            title="Add as Picture-in-Picture overlay"
                          >
                            +PiP
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        );

      case "edit":
        return (
          <>
            <div className="pill-strip">
              <button type="button" onClick={handleSplitAtPlayhead}>
                <IconScissors size={14} /> Split
              </button>
              <button
                type="button"
                onClick={async () => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  const tr = seq.tracks.find((t) => t.clips.some((x) => x.id === c.id));
                  if (!tr) return;
                  const { clip: dup } = await api.addClip({
                    trackId: tr.id,
                    assetId: c.assetId,
                    start: Number((c.start + c.duration).toFixed(3)),
                    in: c.in,
                    out: c.out,
                  });
                  setSelectedClipId(dup.id);
                  await refreshCurrentProject();
                  flash("Clip duplicated");
                }}
              >
                <IconDuplicate size={14} /> Duplicate
              </button>
              <button
                type="button"
                onClick={async () => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  await api.freezeClip(c.id, Math.max(c.start, playhead), 2.5);
                  await refreshCurrentProject();
                  flash("2.5s freeze frame inserted");
                }}
              >
                <IconFreeze size={14} /> Freeze
              </button>
              <button
                type="button"
                onClick={async () => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  const wasRev = isClipReversed(c);
                  await api.reverseClip(c.id);
                  await refreshCurrentProject();
                  flash(wasRev ? "Normal direction" : "Reversed clip");
                }}
              >
                <IconReverse size={14} /> Reverse
              </button>
              <button type="button" className="btn-danger" onClick={handleDeleteSelected}>
                <IconTrash size={14} /> Delete
              </button>
            </div>

            <div className="slider-row">
              <div className="slider-head">
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <IconSpeed size={14} /> Playback Speed
                </span>
                <span className="mono">{clipSpeed.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.05}
                value={clipSpeed}
                onChange={async (e) => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  await api.setClipSpeed(c.id, Number(e.target.value));
                  await refreshCurrentProject();
                }}
              />
              <div className="pill-strip">
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    className={`chip-btn ${Math.abs(clipSpeed - sp) < 0.03 ? "active" : ""}`}
                    onClick={async () => {
                      const c = ensureTargetClip();
                      if (!c) return;
                      await api.setClipSpeed(c.id, sp);
                      await refreshCurrentProject();
                    }}
                  >
                    {sp}×
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="section-label">Motion Keyframes</div>
              <div className="pill-strip">
                <button
                  type="button"
                  onClick={async () => {
                    const c = ensureTargetClip();
                    if (!c) return;
                    await api.addKeyframes(c.id, [
                      { time: 0, property: "scaleX", value: 1 },
                      { time: c.duration, property: "scaleX", value: 1.22, easing: "ease-in-out" },
                      { time: 0, property: "scaleY", value: 1 },
                      { time: c.duration, property: "scaleY", value: 1.22, easing: "ease-in-out" },
                    ]);
                    await refreshCurrentProject();
                    flash("Applied smooth Zoom-In motion");
                  }}
                >
                  Zoom In
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const c = ensureTargetClip();
                    if (!c) return;
                    await api.addKeyframes(c.id, [
                      { time: 0, property: "scaleX", value: 1.22 },
                      { time: c.duration, property: "scaleX", value: 1, easing: "ease-in-out" },
                      { time: 0, property: "scaleY", value: 1.22 },
                      { time: c.duration, property: "scaleY", value: 1, easing: "ease-in-out" },
                    ]);
                    await refreshCurrentProject();
                    flash("Applied Zoom-Out motion");
                  }}
                >
                  Zoom Out
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const c = ensureTargetClip();
                    if (!c) return;
                    await api.updateClip(c.id, { keyframes: [] });
                    await refreshCurrentProject();
                    flash("Cleared motion keyframes");
                  }}
                >
                  Reset Motion
                </button>
              </div>
            </div>
          </>
        );

      case "adjust":
        return (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="section-label" style={{ margin: 0 }}>Color &amp; Light</span>
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: "3px 8px", fontSize: 11 }}
                onClick={() =>
                  void updateSelectedEffect("adjust", {
                    exposure: 0,
                    brightness: 0,
                    contrast: 0,
                    saturation: 0,
                    temperature: 0,
                    tint: 0,
                    vignette: 0,
                    fade: 0,
                    blur: 0,
                  })
                }
              >
                Reset All
              </button>
            </div>
            {(
              [
                { key: "exposure", label: "Exposure", min: -100, max: 100 },
                { key: "contrast", label: "Contrast", min: -100, max: 100 },
                { key: "saturation", label: "Saturation", min: -100, max: 100 },
                { key: "temperature", label: "Temperature", min: -100, max: 100 },
                { key: "tint", label: "Tint", min: -100, max: 100 },
                { key: "vignette", label: "Vignette", min: 0, max: 100 },
              ] as const
            ).map(({ key, label, min, max }) => {
              const val = Number(colorAdj?.[key] ?? 0);
              return (
                <div key={key} className="slider-row">
                  <div className="slider-head">
                    <span>{label}</span>
                    <span className="mono">{val > 0 ? `+${val}` : val}</span>
                  </div>
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={1}
                    value={val}
                    onChange={(e) => void updateSelectedEffect("adjust", { [key]: Number(e.target.value) })}
                  />
                </div>
              );
            })}
          </>
        );

      case "filters": {
        const previewThumb = project.assets[0]
          ? withToken(`/api/v1/projects/${project.id}/assets/${project.assets[0].id}/thumbnail`)
          : "";
        const curTxKind = selectedClip ? getClipTransition(selectedClip)?.kind ?? "none" : "none";
        return (
          <>
            <div className="section-label">Cinema Filter Looks</div>
            <div className="look-grid">
              {LOOK_PRESETS.map((look) => (
                <button
                  key={look.id}
                  type="button"
                  className={`look-card ${activeLookId === look.id ? "active" : ""}`}
                  onClick={async () => {
                    const c = ensureTargetClip();
                    if (!c) {
                      flash("Import a video or photo first");
                      return;
                    }
                    await api.setClipEffect(c.id, "lut3d", { lutId: look.id, intensity: 100 });
                    await refreshCurrentProject();
                  }}
                >
                  {previewThumb ? (
                    <img
                      className="look-preview"
                      src={previewThumb}
                      alt={look.label}
                      style={{ filter: look.cssFilter }}
                    />
                  ) : (
                    <div className="look-preview" style={{ filter: look.cssFilter, background: "linear-gradient(135deg,#3b82f6,#f97316)" }} />
                  )}
                  <span style={{ fontSize: 11, fontWeight: 500 }}>{look.label}</span>
                </button>
              ))}
            </div>

            <div className="section-label" style={{ marginTop: 6 }}>Clip In-Transition</div>
            <div className="pill-strip">
              {TRANSITION_OPTIONS.map((tr) => (
                <button
                  key={tr.kind}
                  type="button"
                  className={`chip-btn ${curTxKind === tr.kind ? "active" : ""}`}
                  onClick={async () => {
                    const c = ensureTargetClip();
                    if (!c) return;
                    await api.setClipEffect(c.id, "transition", {
                      kind: tr.kind,
                      duration: Math.min(0.6, Math.max(0.2, c.duration * 0.35)),
                    });
                    await refreshCurrentProject();
                    flash(`Transition: ${tr.label}`);
                  }}
                >
                  {tr.label}
                </button>
              ))}
            </div>
          </>
        );
      }

      case "text": {
        const capStyle = (selectedCaption?.style ?? {}) as Record<string, unknown>;
        return (
          <>
            <div className="pill-strip">
              {TEXT_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={async () => {
                    const dur = getSequenceDuration(seq);
                    const start = Number(Math.min(playhead, Math.max(0, dur - 0.5)).toFixed(2));
                    const { caption } = await api.addCaption({
                      start,
                      end: Number((start + 3).toFixed(2)),
                      text: preset.text,
                      style: preset.style,
                    });
                    setSelectedCaptionId(caption.id);
                    await refreshCurrentProject();
                  }}
                >
                  <IconPlus size={13} /> {preset.label}
                </button>
              ))}
            </div>

            {selectedCaption ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <input
                  value={selectedCaption.text}
                  onChange={async (e) => {
                    const val = e.target.value;
                    await api.updateCaption(selectedCaption.id, { text: val });
                    await refreshCurrentProject();
                  }}
                  placeholder="Enter title or subtitle…"
                />

                <div className="form-grid-2">
                  <div className="slider-row">
                    <div className="slider-head">
                      <span>Font Size</span>
                      <span className="mono">{Number(capStyle.fontSize ?? 52)}px</span>
                    </div>
                    <input
                      type="range"
                      min={22}
                      max={110}
                      value={Number(capStyle.fontSize ?? 52)}
                      onChange={async (e) => {
                        await api.updateCaption(selectedCaption.id, {
                          style: { ...capStyle, fontSize: Number(e.target.value) },
                        });
                        await refreshCurrentProject();
                      }}
                    />
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <span>Color</span>
                      <input
                        type="color"
                        value={String(capStyle.color || "#ffffff")}
                        onChange={async (e) => {
                          await api.updateCaption(selectedCaption.id, {
                            style: { ...capStyle, color: e.target.value },
                          });
                          await refreshCurrentProject();
                        }}
                        style={{ width: 34, height: 30, padding: 2 }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={async () => {
                        const curOp = Number(capStyle.bgOpacity ?? 0.62);
                        await api.updateCaption(selectedCaption.id, {
                          style: { ...capStyle, bgOpacity: curOp > 0.05 ? 0 : 0.65 },
                        });
                        await refreshCurrentProject();
                      }}
                    >
                      Backdrop
                    </button>
                    <button type="button" className="btn-danger" onClick={handleDeleteSelected}>
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>

                <div className="pill-strip">
                  {(["none", "fade", "pop", "slide-up", "typewriter"] as const).map((anim) => (
                    <button
                      key={anim}
                      type="button"
                      className={`chip-btn ${(capStyle.animation ?? "none") === anim ? "active" : ""}`}
                      onClick={async () => {
                        await api.updateCaption(selectedCaption.id, {
                          style: { ...capStyle, animation: anim },
                        });
                        await refreshCurrentProject();
                      }}
                    >
                      {anim === "none" ? "Static" : anim}
                    </button>
                  ))}
                </div>

                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  Tip: Drag text directly on the video preview to position it anywhere.
                </span>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                Tap a preset above to add a title at the playhead, or tap any text block on the preview / timeline.
              </div>
            )}
          </>
        );
      }

      case "canvas": {
        const curScalePct = selectedClip ? Math.round(Math.abs(selectedClip.transform.scaleX || 1) * 100) : 100;
        const curRot = selectedClip?.transform.rotation ?? 0;
        return (
          <>
            <div className="section-label">Canvas Aspect Ratio</div>
            <div className="pill-strip">
              {ASPECT_PRESETS.map((ap) => (
                <button
                  key={ap.id}
                  type="button"
                  className={`chip-btn ${currentAspectLabel === ap.label ? "active" : ""}`}
                  onClick={() => void handleAspectChange(ap.width, ap.height)}
                >
                  {ap.label}
                </button>
              ))}
            </div>

            <div className="section-label">Canvas Background Fill</div>
            <div className="pill-strip">
              {[
                { id: "blur", label: "Blurred Video" },
                { id: "black", label: "Black" },
                { id: "dark", label: "Charcoal" },
                { id: "white", label: "White" },
              ].map((bg) => (
                <button
                  key={bg.id}
                  type="button"
                  className={`chip-btn ${(seq.background ?? "blur") === bg.id ? "active" : ""}`}
                  onClick={() => void handleBackgroundChange(bg.id)}
                >
                  {bg.label}
                </button>
              ))}
            </div>

            <div className="section-label">Clip Transform &amp; Crop</div>
            <div className="pill-strip">
              <button
                type="button"
                onClick={async () => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  await api.updateClip(c.id, {
                    transform: { ...c.transform, rotation: (curRot + 90) % 360 },
                  });
                  await refreshCurrentProject();
                }}
              >
                <IconRotate size={14} /> Rotate 90°
              </button>
              <button
                type="button"
                onClick={async () => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  await api.updateClip(c.id, {
                    transform: { ...c.transform, scaleX: -(c.transform.scaleX || 1) },
                  });
                  await refreshCurrentProject();
                }}
              >
                <IconFlipH size={14} /> Flip H
              </button>
              <button
                type="button"
                onClick={async () => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  await api.updateClip(c.id, {
                    transform: { ...c.transform, scaleY: -(c.transform.scaleY || 1) },
                  });
                  await refreshCurrentProject();
                }}
              >
                <IconFlipV size={14} /> Flip V
              </button>
              <button
                type="button"
                onClick={async () => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  await api.updateClip(c.id, {
                    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
                  });
                  await refreshCurrentProject();
                }}
              >
                Reset
              </button>
            </div>

            <div className="slider-row">
              <div className="slider-head">
                <span>Zoom / Scale</span>
                <span className="mono">{curScalePct}%</span>
              </div>
              <input
                type="range"
                min={25}
                max={250}
                value={curScalePct}
                onChange={async (e) => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  const s = Number(e.target.value) / 100;
                  const signX = (c.transform.scaleX || 1) < 0 ? -1 : 1;
                  const signY = (c.transform.scaleY || 1) < 0 ? -1 : 1;
                  await api.updateClip(c.id, {
                    transform: { ...c.transform, scaleX: s * signX, scaleY: s * signY },
                  });
                  await refreshCurrentProject();
                }}
              />
            </div>

            <div className="form-grid-2">
              {(["left", "right", "top", "bottom"] as const).map((edge) => {
                const v = Math.round(Number(cropParams[edge] ?? 0) * 100);
                return (
                  <div key={edge} className="slider-row">
                    <div className="slider-head">
                      <span style={{ textTransform: "capitalize" }}>Crop {edge}</span>
                      <span className="mono">{v}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={45}
                      value={v}
                      onChange={(e) =>
                        void updateSelectedEffect("crop", { [edge]: Number(e.target.value) / 100 })
                      }
                    />
                  </div>
                );
              })}
            </div>
          </>
        );
      }

      case "audio": {
        const volPct = Math.round(Number(volFx.gain ?? 1) * 100);
        const fadeIn = Number(fadeFx.fadeIn ?? 0);
        const fadeOut = Number(fadeFx.fadeOut ?? 0);
        return (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                className={recordingVo ? "btn-danger" : "btn-primary"}
                onClick={toggleVoiceoverRecording}
              >
                <IconMic size={14} />
                {recordingVo ? `Stop Recording (${voSeconds}s)` : "Record Voiceover"}
              </button>
              <button
                type="button"
                onClick={() => void updateSelectedEffect("volume", { gain: volPct <= 1 ? 1 : 0 })}
              >
                {volPct <= 1 ? "Unmute Clip" : "Mute Clip"}
              </button>
            </div>

            <div className="slider-row">
              <div className="slider-head">
                <span>Clip Volume</span>
                <span className="mono">{volPct}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={200}
                value={volPct}
                onChange={(e) => void updateSelectedEffect("volume", { gain: Number(e.target.value) / 100 })}
              />
            </div>

            <div className="form-grid-2">
              <div className="slider-row">
                <div className="slider-head">
                  <span>Fade In</span>
                  <span className="mono">{fadeIn.toFixed(1)}s</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.1}
                  value={fadeIn}
                  onChange={(e) => void updateSelectedEffect("fade", { fadeIn: Number(e.target.value) })}
                />
              </div>
              <div className="slider-row">
                <div className="slider-head">
                  <span>Fade Out</span>
                  <span className="mono">{fadeOut.toFixed(1)}s</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.1}
                  value={fadeOut}
                  onChange={(e) => void updateSelectedEffect("fade", { fadeOut: Number(e.target.value) })}
                />
              </div>
            </div>
          </>
        );
      }

      case "ai":
        return (
          <>
            <div
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
                <span className={`status-dot ${apiSettings?.hasApiKey ? "online" : ""}`} />
                <span>{apiSettings?.hasApiKey ? apiSettings.model : "No API key set"}</span>
              </div>
              <button type="button" onClick={() => setShowApiModal(true)} style={{ padding: "4px 9px", fontSize: 11.5 }}>
                <IconKey size={13} /> {apiSettings?.hasApiKey ? "Change API" : "Connect API"}
              </button>
            </div>

            <div className="pill-strip">
              {[
                { label: "9:16 Reels", prompt: "Convert project to 9:16 vertical aspect ratio" },
                { label: "Cinema Color", prompt: "Apply cinematic Teal & Orange look with gentle contrast" },
                { label: "Smooth Dissolves", prompt: "Add smooth cross-dissolve transitions between clips" },
                { label: "Add Title", prompt: "Title: NEW EDIT" },
              ].map((q) => (
                <button key={q.label} type="button" className="chip-btn" onClick={() => void sendAiPrompt(q.prompt)}>
                  {q.label}
                </button>
              ))}
            </div>

            {aiMessages.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 160, overflowY: "auto" }}>
                {aiMessages.map((m, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: "7px 10px",
                      borderRadius: 8,
                      fontSize: 12,
                      lineHeight: 1.4,
                      whiteSpace: "pre-wrap",
                      background: m.role === "user" ? "var(--accent-soft)" : "var(--panel-2)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {m.text}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={aiInput}
                onChange={(e) => setAiInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void sendAiPrompt();
                }}
                placeholder="Ask AI to edit clips, grade colors, add titles…"
                style={{ flex: 1 }}
              />
              <button type="button" className="btn-primary" onClick={() => void sendAiPrompt()} disabled={aiBusy}>
                <IconSend size={14} />
              </button>
            </div>
          </>
        );
    }
  };

  const NAV_ITEMS: Array<{ id: ToolTab; label: string; icon: React.ReactNode }> = [
    { id: "media", label: "Media", icon: <IconMedia size={17} /> },
    { id: "edit", label: "Edit", icon: <IconScissors size={17} /> },
    { id: "adjust", label: "Adjust", icon: <IconAdjust size={17} /> },
    { id: "filters", label: "Filters", icon: <IconFilter size={17} /> },
    { id: "text", label: "Text", icon: <IconText size={17} /> },
    { id: "canvas", label: "Canvas", icon: <IconCrop size={17} /> },
    { id: "audio", label: "Audio", icon: <IconAudio size={17} /> },
    { id: "ai", label: "AI", icon: <IconSparkles size={17} /> },
  ];

  return (
    <div className="app">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*"
        style={{ display: "none" }}
        onChange={handleFilesSelected}
      />

      {/* ==================== CLEAN TOP STUDIO HEADER ==================== */}
      <header className="topbar">
        <div className="topbar-group">
          <div className="brand-mark">
            <IconLogo size={20} />
            {!isMobileLayout && <span>Vedit</span>}
          </div>

          <select
            className="project-pill"
            value={project.id}
            onChange={async (e) => {
              const val = e.target.value;
              if (val === "__new__") {
                const { project: created } = await api.createProject(`Edit ${projects.length + 1}`, false);
                setCurrentId(created.id);
                await refreshProjectsList();
                setProject(created);
                setSelectedClipId(null);
                setSelectedCaptionId(null);
                setPlayhead(0);
                flash("Created blank project");
              } else {
                setCurrentId(val);
                const { project: loaded } = await api.getProject(val);
                setProject(loaded);
                setSelectedClipId(null);
                setSelectedCaptionId(null);
                setPlayhead(0);
              }
            }}
            aria-label="Project selector"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="__new__">+ New Blank Project…</option>
          </select>

          <button
            type="button"
            className="aspect-pill"
            onClick={() => {
              const idx = ASPECT_PRESETS.findIndex((a) => a.label === currentAspectLabel);
              const next = ASPECT_PRESETS[(idx + 1) % ASPECT_PRESETS.length]!;
              void handleAspectChange(next.width, next.height);
            }}
            title="Cycle Canvas Aspect Ratio"
          >
            {currentAspectLabel}
          </button>
        </div>

        <div className="topbar-group">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void api.undo().then(() => refreshCurrentProject())}
            title="Undo (Ctrl+Z)"
          >
            <IconUndo size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void api.redo().then(() => refreshCurrentProject())}
            title="Redo (Ctrl+Shift+Z)"
          >
            <IconRedo size={15} />
          </button>

          <button
            type="button"
            onClick={() => setShowApiModal(true)}
            style={{ height: 32, padding: "0 10px", fontSize: 12 }}
            title="Configure AI API Key & Model"
          >
            <span className={`status-dot ${apiSettings?.hasApiKey ? "online" : ""}`} />
            <span>API</span>
          </button>

          <button
            type="button"
            className="btn-primary"
            onClick={() => setShowExportModal(true)}
            style={{ height: 32, padding: "0 12px", fontSize: 12 }}
          >
            <IconExport size={14} />
            <span>Export</span>
          </button>
        </div>
      </header>

      {/* ==================== ADAPTIVE BODY: NATIVE MOBILE vs PRO DESKTOP ==================== */}
      {isMobileLayout ? (
        <div className="mobile-root">
          <div style={{ flex: 1, minHeight: 190, display: "flex", flexDirection: "column" }}>
            <CompositorStage
              project={project}
              playhead={playhead}
              playing={playing}
              muted={muted}
              selectedCaptionId={selectedCaptionId}
              onPlayhead={setPlayhead}
              onPlaying={setPlaying}
              onToggleMute={() => setMuted((m) => !m)}
              onSelectCaption={(id) => {
                setSelectedCaptionId(id);
                if (id) {
                  setActiveTab("text");
                  setMobileSheetOpen(true);
                }
              }}
              onMoveCaptionPosition={async (capId, x, y) => {
                const cap = seq.captions.find((c) => c.id === capId);
                await api.updateCaption(capId, { style: { ...(cap?.style ?? {}), x, y } });
                await refreshCurrentProject();
              }}
              onImportRequest={triggerFilePicker}
              onQuickSplit={handleSplitAtPlayhead}
            />
          </div>

          <div style={{ height: mobileSheetOpen ? 155 : 210, flex: "none" }}>
            <StudioTimeline
              project={project}
              playhead={playhead}
              pxPerSec={pxPerSec}
              snapEnabled={snapEnabled}
              selectedClipId={selectedClipId}
              selectedCaptionId={selectedCaptionId}
              onPlayhead={setPlayhead}
              onSelectClip={setSelectedClipId}
              onSelectCaption={(id) => {
                setSelectedCaptionId(id);
                if (id) setActiveTab("text");
              }}
              onZoomChange={setPxPerSec}
              onToggleSnap={() => setSnapEnabled((s) => !s)}
              onMoveClip={async (clipId, start) => {
                await api.moveClip(clipId, start);
                await refreshCurrentProject();
              }}
              onTrimClip={async (clipId, edge, time) => {
                await api.trimClip(clipId, edge, time);
                await refreshCurrentProject();
              }}
              onUpdateCaptionTiming={async (capId, start, end) => {
                await api.updateCaption(capId, { start, end });
                await refreshCurrentProject();
              }}
              onToggleTrackMute={async (tr) => {
                await api.updateTrack(tr.id, { muted: !tr.muted });
                await refreshCurrentProject();
              }}
              onDeleteSelected={handleDeleteSelected}
              onSplitAtPlayhead={handleSplitAtPlayhead}
              onImportMedia={triggerFilePicker}
              onAddTrack={async (kind) => {
                await api.addTrack(kind);
                await refreshCurrentProject();
              }}
            />
          </div>

          {mobileSheetOpen && (
            <div className="mobile-sheet">
              <div className="mobile-sheet-head">
                <span>{NAV_ITEMS.find((i) => i.id === activeTab)?.label}</span>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 28, height: 28 }}
                  onClick={() => setMobileSheetOpen(false)}
                  aria-label="Collapse panel"
                >
                  <IconChevronDown size={16} />
                </button>
              </div>
              <div className="mobile-sheet-body">{renderToolContent(activeTab)}</div>
            </div>
          )}

          <nav className="mobile-dock">
            {NAV_ITEMS.map((item) => {
              const active = mobileSheetOpen && activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`dock-item ${active ? "active" : ""}`}
                  onClick={() => {
                    if (activeTab === item.id && mobileSheetOpen) {
                      setMobileSheetOpen(false);
                    } else {
                      setActiveTab(item.id);
                      setMobileSheetOpen(true);
                    }
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      ) : (
        /* ==================== PRO DESKTOP NLE WORKSPACE (>= 900px) ==================== */
        <>
          <div className="workspace-upper">
            <aside className="studio-rail">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`rail-tab ${activeTab === item.id ? "active" : ""}`}
                  onClick={() => setActiveTab(item.id)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </aside>

            <section className="side-panel" style={{ width: leftWidth, borderRight: "1px solid var(--border)" }}>
              <div className="panel-header">
                <span>{NAV_ITEMS.find((i) => i.id === activeTab)?.label}</span>
              </div>
              <div className="panel-scroll">{renderToolContent(activeTab)}</div>
            </section>

            <div className="splitter-v" onPointerDown={(e) => startResize("left", e)} />

            <CompositorStage
              project={project}
              playhead={playhead}
              playing={playing}
              muted={muted}
              selectedCaptionId={selectedCaptionId}
              onPlayhead={setPlayhead}
              onPlaying={setPlaying}
              onToggleMute={() => setMuted((m) => !m)}
              onSelectCaption={setSelectedCaptionId}
              onMoveCaptionPosition={async (capId, x, y) => {
                const cap = seq.captions.find((c) => c.id === capId);
                await api.updateCaption(capId, { style: { ...(cap?.style ?? {}), x, y } });
                await refreshCurrentProject();
              }}
              onImportRequest={triggerFilePicker}
              onQuickSplit={handleSplitAtPlayhead}
            />

            <div className="splitter-v" onPointerDown={(e) => startResize("right", e)} />

            <aside className="side-panel" style={{ width: rightWidth }}>
              <div className="panel-header">
                <span>{selectedCaption ? "Text Inspector" : selectedClip ? "Clip Inspector" : "Sequence Inspector"}</span>
              </div>
              <div className="panel-scroll">
                {selectedCaption ? (
                  renderToolContent("text")
                ) : selectedClip ? (
                  <>
                    {renderToolContent("adjust")}
                    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                      {renderToolContent("edit")}
                    </div>
                  </>
                ) : (
                  renderToolContent("canvas")
                )}
              </div>
            </aside>
          </div>

          <div className="splitter-h" onPointerDown={(e) => startResize("timeline", e)} />

          <div style={{ height: timelineHeight, flex: "none" }}>
            <StudioTimeline
              project={project}
              playhead={playhead}
              pxPerSec={pxPerSec}
              snapEnabled={snapEnabled}
              selectedClipId={selectedClipId}
              selectedCaptionId={selectedCaptionId}
              onPlayhead={setPlayhead}
              onSelectClip={setSelectedClipId}
              onSelectCaption={setSelectedCaptionId}
              onZoomChange={setPxPerSec}
              onToggleSnap={() => setSnapEnabled((s) => !s)}
              onMoveClip={async (clipId, start) => {
                await api.moveClip(clipId, start);
                await refreshCurrentProject();
              }}
              onTrimClip={async (clipId, edge, time) => {
                await api.trimClip(clipId, edge, time);
                await refreshCurrentProject();
              }}
              onUpdateCaptionTiming={async (capId, start, end) => {
                await api.updateCaption(capId, { start, end });
                await refreshCurrentProject();
              }}
              onToggleTrackMute={async (tr) => {
                await api.updateTrack(tr.id, { muted: !tr.muted });
                await refreshCurrentProject();
              }}
              onDeleteSelected={handleDeleteSelected}
              onSplitAtPlayhead={handleSplitAtPlayhead}
              onImportMedia={triggerFilePicker}
              onAddTrack={async (kind) => {
                await api.addTrack(kind);
                await refreshCurrentProject();
              }}
            />
          </div>
        </>
      )}

      {showApiModal && (
        <ApiSettingsModal
          initial={apiSettings}
          onClose={() => setShowApiModal(false)}
          onSaved={(next, msg) => {
            setApiSettings(next);
            flash(msg);
          }}
        />
      )}

      {showExportModal && (
        <ExportModal
          project={project}
          exportPresets={exportPresets}
          onClose={() => setShowExportModal(false)}
          onFlash={flash}
        />
      )}

      {toast && (
        <div className="toast">
          <IconCheck size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
