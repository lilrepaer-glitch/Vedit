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
  type HistoryState,
  type Project,
  type ProjectSummary,
  type Track,
} from "./api";
import { CompositorStage, StudioTimeline } from "./components";
import {
  AUDIO_EQ_PRESETS_UI,
  computeCurvePoints,
  getCachedCurveLut,
  getClipSpeed,
  getClipTransition,
  getSequenceDuration,
  isClipReversed,
  LOOK_PRESETS,
  readClipAdjustments,
  readClipAudioEq,
  readClipChromaKey,
  readClipCurves,
  readClipLook,
  TONE_CURVE_PRESETS_UI,
  type ToneCurvePoint,
  type ToneCurvePresetUi,
} from "./compositor";
import {
  IconAdjust,
  IconAudio,
  IconCheck,
  IconChevronDown,
  IconCrop,
  IconDownload,
  IconDuplicate,
  IconExport,
  IconFilter,
  IconFlipH,
  IconFlipV,
  IconFreeze,
  IconKey,
  IconKeyboard,
  IconLogo,
  IconMedia,
  IconMic,
  IconPlus,
  IconRedo,
  IconReverse,
  IconRotate,
  IconSave,
  IconScissors,
  IconSend,
  IconSparkles,
  IconSpeed,
  IconSubtitles,
  IconText,
  IconTrash,
  IconUndo,
} from "./Icons";
import { ApiSettingsModal, ExportModal } from "./StudioModals";

type ToolTab = "media" | "edit" | "adjust" | "filters" | "text" | "canvas" | "audio" | "ai";
type AdjustSubTab = "light" | "curves" | "key";
type DesktopInspectorTab = "adjust" | "audio" | "edit" | "canvas";

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
  { kind: "wipe-left", label: "Wipe Left" },
  { kind: "wipe-right", label: "Wipe Right" },
  { kind: "slide-left", label: "Slide Left" },
  { kind: "slide-up", label: "Slide Up" },
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
  const [historyState, setHistoryState] = useState<HistoryState>({
    canUndo: false,
    canRedo: false,
    undoCount: 0,
    redoCount: 0,
  });
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ToolTab>("media");
  const [adjustSubTab, setAdjustSubTab] = useState<AdjustSubTab>("light");
  const [inspectorTab, setInspectorTab] = useState<DesktopInspectorTab>("adjust");
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const [pxPerSec, setPxPerSec] = useState(64);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [leftWidth, setLeftWidth] = useState(296);
  const [rightWidth, setRightWidth] = useState(304);
  const [timelineHeight, setTimelineHeight] = useState(235);
  const [isMobileLayout, setIsMobileLayout] = useState(() => window.innerWidth < 900);

  const [apiSettings, setApiSettings] = useState<ApiSettingsResponse | null>(null);
  const [exportPresets, setExportPresets] = useState<ExportPresetInfo[]>([]);
  const [showApiModal, setShowApiModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [dragDropActive, setDragDropActive] = useState(false);
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
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const commitTimersRef = useRef<Map<string, number>>(new Map());
  const isInteractingRef = useRef(false);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
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
    const res = await api.getProject(target);
    setProject(res.project);
    if (res.history) setHistoryState(res.history);
    return res.project;
  }, [project?.id]);

  // Schedule a single coalesced API write so 60 FPS slider/canvas drags have 0ms lag & 1 clean undo step
  const scheduleCommit = useCallback(
    (key: string, fn: () => Promise<unknown>, delayMs = 150) => {
      isInteractingRef.current = true;
      const existing = commitTimersRef.current.get(key);
      if (existing) window.clearTimeout(existing);
      const timer = window.setTimeout(async () => {
        commitTimersRef.current.delete(key);
        try {
          await fn();
          await refreshCurrentProject();
        } catch {
          await refreshCurrentProject();
        } finally {
          isInteractingRef.current = commitTimersRef.current.size > 0;
        }
      }, delayMs);
      commitTimersRef.current.set(key, timer);
    },
    [refreshCurrentProject],
  );

  // Optimistic synchronous React state helper for instant 60 FPS clip updates
  const mutateClipLocal = useCallback((clipId: string, mutator: (clip: Clip) => Clip) => {
    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sequences: prev.sequences.map((s) =>
          s.id !== prev.activeSequenceId
            ? s
            : {
                ...s,
                tracks: s.tracks.map((tr) => ({
                  ...tr,
                  clips: tr.clips.map((c) => (c.id === clipId ? mutator(c) : c)),
                })),
              },
        ),
      };
    });
  }, []);

  const mutateCaptionLocal = useCallback((captionId: string, mutator: (cap: Caption) => Caption) => {
    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sequences: prev.sequences.map((s) =>
          s.id !== prev.activeSequenceId
            ? s
            : {
                ...s,
                captions: s.captions.map((c) => (c.id === captionId ? mutator(c) : c)),
              },
        ),
      };
    });
  }, []);

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
        const res =
          list.length > 0
            ? await api.getProject(list[0]!.id)
            : { ...(await api.createProject("Untitled Edit", false)), history: undefined };
        setCurrentId(res.project.id);
        setProject(res.project);
        if (res.history) setHistoryState(res.history);
        await refreshProjectsList();
      } catch (err) {
        flash(`Startup error: ${(err as Error).message}`);
      }
      api.getApiSettings().then(setApiSettings).catch(() => undefined);
      api.exportPresets().then((r) => setExportPresets(r.presets)).catch(() => undefined);
    })();
  }, [refreshProjectsList, flash]);

  // Subscribe to live project updates without clobbering active 60 FPS slider gestures
  useEffect(() => {
    if (!project?.id) return;
    setCurrentId(project.id);
    const close = connectWs(() => {
      if (isInteractingRef.current) return;
      api
        .getProject(project.id)
        .then((res) => {
          setProject(res.project);
          if (res.history) setHistoryState(res.history);
        })
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

  // ==================== CORE EDITING & SUBTITLE IMPORT ACTIONS ====================

  const triggerFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || !project) return;
      const subFiles = files.filter((f) => /\.(srt|vtt)$/i.test(f.name));
      const mediaFiles = files.filter((f) => !/\.(srt|vtt)$/i.test(f.name));

      let importedSubs = 0;
      for (const sf of subFiles) {
        try {
          const text = await sf.text();
          const res = await api.importSubtitles(text, false);
          importedSubs += res.count;
        } catch (err) {
          flash(`Subtitle import failed: ${(err as Error).message}`);
        }
      }

      if (mediaFiles.length > 0) {
        flash(`Importing ${mediaFiles.length} file${mediaFiles.length > 1 ? "s" : ""}…`);
      }
      let addedCount = 0;
      for (const file of mediaFiles) {
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
      if (addedCount > 0 && importedSubs > 0) {
        flash(`Imported ${addedCount} clip(s) and ${importedSubs} subtitles`);
      } else if (addedCount > 0) {
        setPlayhead(0);
        flash(`Added ${addedCount} clip${addedCount > 1 ? "s" : ""} to timeline`);
      } else if (importedSubs > 0) {
        flash(`Imported ${importedSubs} subtitle cues`);
      }
    },
    [project, refreshCurrentProject, flash],
  );

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await ingestFiles(files);
  };

  const handleExportSubtitlesFile = async (format: "srt" | "vtt") => {
    try {
      const res = await api.exportSubtitles(format);
      if (res.count === 0) {
        flash("Add titles or captions first");
        return;
      }
      const blob = new Blob([res.text], { type: format === "vtt" ? "text/vtt" : "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(project?.name || "subtitles").replace(/\s+/g, "_")}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      flash(`Exported ${res.count} cues as .${format.toUpperCase()}`);
    } catch (err) {
      flash(`Subtitle export error: ${(err as Error).message}`);
    }
  };

  const addAssetToTimeline = async (item: Asset, asOverlay = false) => {
    if (!project || !seq) return;
    const wantKind = item.kind === "audio" ? "audio" : "video";
    const matchingTracks = seq.tracks.filter((t) =>
      wantKind === "audio" ? t.kind === "audio" : t.kind !== "audio",
    );
    let targetTrack: Track | undefined = asOverlay ? matchingTracks[1] : matchingTracks[0];
    if (!targetTrack) {
      const createdTrack = await api.addTrack(wantKind, asOverlay ? "V2 Overlay" : undefined);
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
        transform: { ...clip.transform, scaleX: 0.45, scaleY: 0.45, x: 240, y: 200 },
      });
    }
    setSelectedClipId(clip.id);
    await refreshCurrentProject();
    flash(asOverlay ? `Added ${item.name} on ${targetTrack.name}` : `Added ${item.name}`);
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

  const handleSaveProject = useCallback(async () => {
    if (!project) return;
    try {
      await api.saveProjectDisk();
      flash(`Saved "${project.name}"`);
    } catch (err) {
      flash(`Save failed: ${(err as Error).message}`);
    }
  }, [project, flash]);

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

  // Instant 0ms optimistic effect update + debounced single-undo API commit
  const updateSelectedEffect = useCallback(
    (type: string, patch: Record<string, unknown>, immediate = false) => {
      const clip = ensureTargetClip();
      if (!clip || !project) {
        flash("Import or select a clip first");
        return;
      }
      const existing = getEffectParams(clip, type);
      const merged = { ...existing, ...patch };
      mutateClipLocal(clip.id, (c) => ({
        ...c,
        effects: [
          ...c.effects.filter((e) => e.type !== type),
          { id: `fx-${type}`, type, params: merged },
        ],
      }));
      scheduleCommit(
        `fx:${clip.id}:${type}`,
        () => api.setClipEffect(clip.id, type, merged),
        immediate ? 10 : 150,
      );
    },
    [ensureTargetClip, project, flash, mutateClipLocal, scheduleCommit],
  );

  // Instant 0ms Curves update + single API commit to `/curves`
  const updateSelectedCurves = useCallback(
    (
      opts: {
        preset?: ToneCurvePresetUi["id"];
        shadows?: number;
        midtones?: number;
        highlights?: number;
        clarity?: number;
        points?: ToneCurvePoint[];
      },
      immediate = false,
    ) => {
      const clip = ensureTargetClip();
      if (!clip || !project) {
        flash("Import or select a clip first");
        return;
      }
      const cur = readClipCurves(clip);
      const preset = opts.preset ?? (cur.preset === "custom" ? undefined : cur.preset);
      const shadows = opts.shadows ?? cur.shadows;
      const midtones = opts.midtones ?? cur.midtones;
      const highlights = opts.highlights ?? cur.highlights;
      const clarity = opts.clarity ?? cur.clarity;
      const points =
        opts.points ??
        computeCurvePoints(shadows, midtones, highlights, preset ?? "linear");

      mutateClipLocal(clip.id, (c) => ({
        ...c,
        effects: [
          ...c.effects.filter((e) => e.type !== "curves"),
          {
            id: "fx-curves",
            type: "curves",
            params: { preset: preset ?? "custom", shadows, midtones, highlights, clarity, points },
          },
        ],
      }));
      scheduleCommit(
        `curves:${clip.id}`,
        () => api.applyCurves(clip.id, { preset, shadows, midtones, highlights, clarity, points }),
        immediate ? 10 : 150,
      );
    },
    [ensureTargetClip, project, flash, mutateClipLocal, scheduleCommit],
  );

  // Instant 0ms Chroma Key update + single API commit to `/chroma-key`
  const updateSelectedChromaKey = useCallback(
    (
      patch: { enabled?: boolean; color?: string; similarity?: number; blend?: number; despill?: boolean },
      immediate = false,
    ) => {
      const clip = ensureTargetClip();
      if (!clip || !project) {
        flash("Import or select a clip first");
        return;
      }
      const cur = readClipChromaKey(clip);
      if (patch.enabled === false) {
        const existingFx = clip.effects.find((e) => e.type === "chroma-key" || e.type === "chromakey");
        mutateClipLocal(clip.id, (c) => ({
          ...c,
          effects: c.effects.filter((e) => e.type !== "chroma-key" && e.type !== "chromakey"),
        }));
        if (existingFx) {
          scheduleCommit(`ck:${clip.id}`, () => api.removeEffect(clip.id, existingFx.id), 10);
        }
        return;
      }
      const color = patch.color ?? cur.color;
      const similarity = patch.similarity ?? cur.similarity;
      const blend = patch.blend ?? cur.blend;
      const despill = patch.despill ?? cur.despill;
      mutateClipLocal(clip.id, (c) => ({
        ...c,
        effects: [
          ...c.effects.filter((e) => e.type !== "chroma-key" && e.type !== "chromakey"),
          { id: "fx-ck", type: "chroma-key", params: { color, similarity, blend, despill } },
        ],
      }));
      scheduleCommit(
        `ck:${clip.id}`,
        () => api.chromaKey(clip.id, color, similarity, blend, despill),
        immediate ? 10 : 150,
      );
    },
    [ensureTargetClip, project, flash, mutateClipLocal, scheduleCommit],
  );

  // Instant 0ms 3-Band Audio EQ + Voice Clarity update
  const updateSelectedEq = useCallback(
    (
      opts: { preset?: string; lowDb?: number; midDb?: number; highDb?: number; voiceClarity?: boolean },
      immediate = false,
    ) => {
      const clip = ensureTargetClip();
      if (!clip || !project) {
        flash("Import or select a clip first");
        return;
      }
      const cur = readClipAudioEq(clip);
      const presetObj = AUDIO_EQ_PRESETS_UI.find((p) => p.id === opts.preset);
      const lowDb = opts.lowDb ?? (presetObj ? presetObj.lowDb : cur.lowDb);
      const midDb = opts.midDb ?? (presetObj ? presetObj.midDb : cur.midDb);
      const highDb = opts.highDb ?? (presetObj ? presetObj.highDb : cur.highDb);
      const voiceClarity = opts.voiceClarity ?? (presetObj ? presetObj.voiceClarity : cur.voiceClarity);
      const preset = opts.preset ?? "custom";

      mutateClipLocal(clip.id, (c) => ({
        ...c,
        effects: [
          ...c.effects.filter((e) => e.type !== "eq"),
          { id: "fx-eq", type: "eq", params: { preset, lowDb, midDb, highDb, voiceClarity } },
        ],
      }));
      scheduleCommit(
        `eq:${clip.id}`,
        () => api.applyEq(clip.id, { preset, lowDb, midDb, highDb, voiceClarity }),
        immediate ? 10 : 150,
      );
    },
    [ensureTargetClip, project, flash, mutateClipLocal, scheduleCommit],
  );

  // Voiceover Microphone Recorder
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

  // Full Pro NLE Keyboard Shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.code === "Space" || e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key.toLowerCase() === "l" && !e.ctrlKey && !e.metaKey) {
        setPlaying(true);
      } else if (e.key.toLowerCase() === "j" && !e.ctrlKey && !e.metaKey) {
        setPlaying(false);
        setPlayhead((t) => Math.max(0, t - 0.5));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        const step = e.shiftKey ? 1 : 1 / Math.max(24, seq?.fps || 30);
        setPlayhead((t) => Math.max(0, t - step));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        const dur = getSequenceDuration(seq);
        const step = e.shiftKey ? 1 : 1 / Math.max(24, seq?.fps || 30);
        setPlayhead((t) => Math.min(dur, t + step));
      } else if (e.key === "Home") {
        setPlayhead(0);
      } else if (e.key === "End") {
        setPlayhead(getSequenceDuration(seq));
      } else if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey) {
        void handleSplitAtPlayhead();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveProject();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setShowExportModal(true);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        void handleDeleteSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void api.redo().then(() => refreshCurrentProject());
        else void api.undo().then(() => refreshCurrentProject());
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void api.redo().then(() => refreshCurrentProject());
      } else if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        setShowShortcuts((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seq, handleSplitAtPlayhead, handleDeleteSelected, handleSaveProject, refreshCurrentProject]);

  // Resizable desktop splitters
  const startResize = (axis: "left" | "right" | "timeline", e: React.PointerEvent) => {
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = leftWidth;
    const origRight = rightWidth;
    const origTl = timelineHeight;
    const onMove = (ev: PointerEvent) => {
      if (axis === "left") setLeftWidth(Math.max(230, Math.min(440, origLeft + (ev.clientX - startX))));
      else if (axis === "right") setRightWidth(Math.max(250, Math.min(430, origRight - (ev.clientX - startX))));
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
  const curvesInfo = selectedClip ? readClipCurves(selectedClip) : null;
  const chromaInfo = selectedClip ? readClipChromaKey(selectedClip) : null;
  const eqInfo = selectedClip ? readClipAudioEq(selectedClip) : null;
  const activeLookId = selectedClip ? readClipLook(selectedClip).id : "none";
  const cropParams = getEffectParams(selectedClip, "crop");
  const volFx = getEffectParams(selectedClip, "volume");
  const fadeFx = getEffectParams(selectedClip, "fade");
  const clipSpeed = selectedClip ? getClipSpeed(selectedClip) : 1;

  // Interactive SVG Tone Curve Pad pointer drag handler
  const handleCurvePadPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const clip = ensureTargetClip();
    if (!clip) return;
    const svg = e.currentTarget;
    svg.setPointerCapture(e.pointerId);
    const curPts = readClipCurves(clip).points.map((p) => ({ ...p }));
    const rect = svg.getBoundingClientRect();
    const rx = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    // Pick nearest control knot
    let knotIdx = 0;
    let bestD = Infinity;
    curPts.forEach((p, idx) => {
      const d = Math.abs(p.x - rx);
      if (d < bestD) {
        bestD = d;
        knotIdx = idx;
      }
    });

    const updatePoint = (clientX: number, clientY: number, commit: boolean) => {
      const r = svg.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      const ny = Math.max(0, Math.min(1, 1 - (clientY - r.top) / Math.max(1, r.height)));
      const minX = knotIdx === 0 ? 0 : curPts[knotIdx - 1]!.x + 0.04;
      const maxX = knotIdx === curPts.length - 1 ? 1 : curPts[knotIdx + 1]!.x - 0.04;
      curPts[knotIdx] = {
        x: knotIdx === 0 ? 0 : knotIdx === curPts.length - 1 ? 1 : Number(Math.max(minX, Math.min(maxX, nx)).toFixed(3)),
        y: Number(ny.toFixed(3)),
      };
      updateSelectedCurves({ points: curPts.slice() }, commit);
    };

    updatePoint(e.clientX, e.clientY, false);
    const onMove = (ev: PointerEvent) => updatePoint(ev.clientX, ev.clientY, false);
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      updatePoint(ev.clientX, ev.clientY, true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

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
              <div style={{ padding: "22px 12px", textAlign: "center", color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
                Import videos, photos, audio, or <span className="mono">.srt</span> subtitles from your device or drag files straight onto the window.
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
                            title="Add as Picture-in-Picture / Chroma Key overlay"
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
              <div
                className="slider-head"
                onDoubleClick={async () => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  await api.setClipSpeed(c.id, 1);
                  await refreshCurrentProject();
                }}
              >
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
                onChange={(e) => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  const nextRate = Number(e.target.value);
                  const prevRate = getClipSpeed(c);
                  const nextDur = Math.max(0.15, Number(((c.duration * prevRate) / nextRate).toFixed(3)));
                  mutateClipLocal(c.id, (prev) => ({
                    ...prev,
                    duration: nextDur,
                    effects: [
                      ...prev.effects.filter((fx) => fx.type !== "speed"),
                      { id: "fx-speed", type: "speed", params: { rate: nextRate } },
                    ],
                  }));
                  scheduleCommit(`speed:${c.id}`, () => api.setClipSpeed(c.id, nextRate), 160);
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

      case "adjust": {
        const lut = curvesInfo ? getCachedCurveLut(curvesInfo.points) : null;
        const polyPoints = lut
          ? Array.from({ length: 65 }, (_, idx) => {
              const i = Math.min(255, idx * 4);
              const x = (i / 255) * 160;
              const y = 100 - (lut[i]! / 255) * 100;
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            }).join(" ")
          : "0,100 160,0";

        return (
          <>
            <div className="seg-control">
              <button
                type="button"
                className={`seg-btn ${adjustSubTab === "light" ? "active" : ""}`}
                onClick={() => setAdjustSubTab("light")}
              >
                Light
              </button>
              <button
                type="button"
                className={`seg-btn ${adjustSubTab === "curves" ? "active" : ""}`}
                onClick={() => setAdjustSubTab("curves")}
              >
                Curves
              </button>
              <button
                type="button"
                className={`seg-btn ${adjustSubTab === "key" ? "active" : ""}`}
                onClick={() => setAdjustSubTab("key")}
              >
                Chroma Key
              </button>
            </div>

            {adjustSubTab === "light" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="section-label" style={{ margin: 0 }}>Color &amp; Light</span>
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ padding: "3px 8px", fontSize: 11 }}
                    onClick={() =>
                      updateSelectedEffect(
                        "adjust",
                        {
                          exposure: 0,
                          brightness: 0,
                          contrast: 0,
                          saturation: 0,
                          temperature: 0,
                          tint: 0,
                          vignette: 0,
                          fade: 0,
                          blur: 0,
                        },
                        true,
                      )
                    }
                  >
                    Reset
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
                    { key: "fade", label: "Matte Fade", min: 0, max: 100 },
                    { key: "blur", label: "Optical Blur", min: 0, max: 20 },
                  ] as const
                ).map(({ key, label, min, max }) => {
                  const val = Number(colorAdj?.[key] ?? 0);
                  return (
                    <div key={key} className="slider-row">
                      <div
                        className="slider-head"
                        onDoubleClick={() => updateSelectedEffect("adjust", { [key]: 0 }, true)}
                        title="Double-click to reset"
                      >
                        <span>{label}</span>
                        <span className="mono">{val > 0 ? `+${val}` : val}</span>
                      </div>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={1}
                        value={val}
                        onChange={(e) => updateSelectedEffect("adjust", { [key]: Number(e.target.value) })}
                      />
                    </div>
                  );
                })}
              </>
            )}

            {adjustSubTab === "curves" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="section-label" style={{ margin: 0 }}>Tone Curve &amp; Clarity</span>
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ padding: "3px 8px", fontSize: 11 }}
                    onClick={() =>
                      updateSelectedCurves(
                        { preset: "linear", shadows: 0, midtones: 0, highlights: 0, clarity: 0, points: TONE_CURVE_PRESETS_UI[0]!.points },
                        true,
                      )
                    }
                  >
                    Reset
                  </button>
                </div>

                <svg
                  viewBox="0 0 160 100"
                  className="curve-pad"
                  onPointerDown={handleCurvePadPointer}
                  aria-label="Interactive Tone Curve"
                >
                  {[40, 80, 120].map((gx) => (
                    <line key={gx} x1={gx} y1={0} x2={gx} y2={100} stroke="rgba(255,255,255,0.07)" strokeWidth="0.7" />
                  ))}
                  {[25, 50, 75].map((gy) => (
                    <line key={gy} x1={0} y1={gy} x2={160} y2={gy} stroke="rgba(255,255,255,0.07)" strokeWidth="0.7" />
                  ))}
                  <line x1={0} y1={100} x2={160} y2={0} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" strokeWidth="0.8" />
                  <polyline fill="none" stroke="#fafafa" strokeWidth="1.8" points={polyPoints} />
                  {(curvesInfo?.points ?? TONE_CURVE_PRESETS_UI[0]!.points).map((pt, idx) => (
                    <circle
                      key={idx}
                      cx={pt.x * 160}
                      cy={100 - pt.y * 100}
                      r={3.2}
                      fill="#3b82f6"
                      stroke="#fafafa"
                      strokeWidth="1.1"
                    />
                  ))}
                </svg>

                <div className="pill-strip">
                  {TONE_CURVE_PRESETS_UI.map((pr) => (
                    <button
                      key={pr.id}
                      type="button"
                      className={`chip-btn ${curvesInfo?.preset === pr.id ? "active" : ""}`}
                      onClick={() =>
                        updateSelectedCurves(
                          { preset: pr.id, shadows: 0, midtones: 0, highlights: 0, points: pr.points },
                          true,
                        )
                      }
                    >
                      {pr.label}
                    </button>
                  ))}
                </div>

                {(
                  [
                    { key: "shadows", label: "Shadows", val: curvesInfo?.shadows ?? 0 },
                    { key: "midtones", label: "Midtones", val: curvesInfo?.midtones ?? 0 },
                    { key: "highlights", label: "Highlights", val: curvesInfo?.highlights ?? 0 },
                    { key: "clarity", label: "Clarity", val: curvesInfo?.clarity ?? 0 },
                  ] as const
                ).map(({ key, label, val }) => (
                  <div key={key} className="slider-row">
                    <div
                      className="slider-head"
                      onDoubleClick={() => updateSelectedCurves({ [key]: 0 }, true)}
                    >
                      <span>{label}</span>
                      <span className="mono">{val > 0 ? `+${val}` : val}</span>
                    </div>
                    <input
                      type="range"
                      min={-100}
                      max={100}
                      value={val}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (key === "clarity") {
                          updateSelectedCurves({ clarity: v, points: curvesInfo?.points });
                        } else {
                          const nextS = key === "shadows" ? v : (curvesInfo?.shadows ?? 0);
                          const nextM = key === "midtones" ? v : (curvesInfo?.midtones ?? 0);
                          const nextH = key === "highlights" ? v : (curvesInfo?.highlights ?? 0);
                          updateSelectedCurves({
                            shadows: nextS,
                            midtones: nextM,
                            highlights: nextH,
                            points: computeCurvePoints(nextS, nextM, nextH, "linear"),
                          });
                        }
                      }}
                    />
                  </div>
                ))}
              </>
            )}

            {adjustSubTab === "key" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="section-label" style={{ margin: 0 }}>Green / Blue Screen Keyer</span>
                  {chromaInfo?.enabled && (
                    <button
                      type="button"
                      className="btn-danger"
                      style={{ padding: "3px 9px", fontSize: 11 }}
                      onClick={() => updateSelectedChromaKey({ enabled: false }, true)}
                    >
                      Disable Key
                    </button>
                  )}
                </div>

                <div className="pill-strip">
                  <button
                    type="button"
                    className={`chip-btn ${chromaInfo?.enabled && chromaInfo.color.toLowerCase() === "#00ff00" ? "active" : ""}`}
                    onClick={() => updateSelectedChromaKey({ enabled: true, color: "#00ff00" }, true)}
                  >
                    Green Screen
                  </button>
                  <button
                    type="button"
                    className={`chip-btn ${chromaInfo?.enabled && chromaInfo.color.toLowerCase() === "#0055ff" ? "active" : ""}`}
                    onClick={() => updateSelectedChromaKey({ enabled: true, color: "#0055ff" }, true)}
                  >
                    Blue Screen
                  </button>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <span>Custom</span>
                    <input
                      type="color"
                      value={chromaInfo?.color || "#00ff00"}
                      onChange={(e) => updateSelectedChromaKey({ enabled: true, color: e.target.value }, true)}
                      style={{ width: 32, height: 28, padding: 2 }}
                    />
                  </label>
                </div>

                <div className="slider-row">
                  <div className="slider-head">
                    <span>Similarity</span>
                    <span className="mono">{Math.round((chromaInfo?.similarity ?? 0.3) * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={90}
                    value={Math.round((chromaInfo?.similarity ?? 0.3) * 100)}
                    onChange={(e) =>
                      updateSelectedChromaKey({ enabled: true, similarity: Number(e.target.value) / 100 })
                    }
                  />
                </div>

                <div className="slider-row">
                  <div className="slider-head">
                    <span>Edge Smoothness</span>
                    <span className="mono">{Math.round((chromaInfo?.blend ?? 0.1) * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    value={Math.round((chromaInfo?.blend ?? 0.1) * 100)}
                    onChange={(e) =>
                      updateSelectedChromaKey({ enabled: true, blend: Number(e.target.value) / 100 })
                    }
                  />
                </div>

                <button
                  type="button"
                  className={chromaInfo?.despill !== false ? "btn-accent" : ""}
                  onClick={() =>
                    updateSelectedChromaKey({ enabled: true, despill: !(chromaInfo?.despill !== false) }, true)
                  }
                >
                  Spill Suppression: {chromaInfo?.despill !== false ? "On" : "Off"}
                </button>
              </>
            )}
          </>
        );
      }

      case "filters": {
        const previewThumb = project.assets[0]
          ? withToken(`/api/v1/projects/${project.id}/assets/${project.assets[0].id}/thumbnail`)
          : "";
        const curTx = selectedClip ? getClipTransition(selectedClip) : null;
        const curTxKind = curTx?.kind ?? "none";
        const curTxDur = curTx?.duration ?? 0.5;
        return (
          <>
            <div className="section-label">Cinema Filter Looks</div>
            <div className="look-grid">
              {LOOK_PRESETS.map((look) => (
                <button
                  key={look.id}
                  type="button"
                  className={`look-card ${activeLookId === look.id ? "active" : ""}`}
                  onClick={() => updateSelectedEffect("lut3d", { lutId: look.id, intensity: 100 }, true)}
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
                  onClick={() => {
                    updateSelectedEffect("transition", { kind: tr.kind, duration: curTxDur }, true);
                    flash(`Transition: ${tr.label}`);
                  }}
                >
                  {tr.label}
                </button>
              ))}
            </div>

            {curTxKind !== "none" && (
              <div className="slider-row">
                <div className="slider-head">
                  <span>Transition Duration</span>
                  <span className="mono">{curTxDur.toFixed(2)}s</span>
                </div>
                <input
                  type="range"
                  min={0.2}
                  max={2}
                  step={0.05}
                  value={curTxDur}
                  onChange={(e) =>
                    updateSelectedEffect("transition", { kind: curTxKind, duration: Number(e.target.value) })
                  }
                />
              </div>
            )}
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
                  onChange={(e) => {
                    const val = e.target.value;
                    mutateCaptionLocal(selectedCaption.id, (c) => ({ ...c, text: val }));
                    scheduleCommit(`cap:${selectedCaption.id}`, () => api.updateCaption(selectedCaption.id, { text: val }), 180);
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
                      onChange={(e) => {
                        const fontSize = Number(e.target.value);
                        const nextStyle = { ...capStyle, fontSize };
                        mutateCaptionLocal(selectedCaption.id, (c) => ({ ...c, style: nextStyle }));
                        scheduleCommit(
                          `cap-style:${selectedCaption.id}`,
                          () => api.updateCaption(selectedCaption.id, { style: nextStyle }),
                          150,
                        );
                      }}
                    />
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <span>Color</span>
                      <input
                        type="color"
                        value={String(capStyle.color || "#ffffff")}
                        onChange={(e) => {
                          const nextStyle = { ...capStyle, color: e.target.value };
                          mutateCaptionLocal(selectedCaption.id, (c) => ({ ...c, style: nextStyle }));
                          scheduleCommit(
                            `cap-color:${selectedCaption.id}`,
                            () => api.updateCaption(selectedCaption.id, { style: nextStyle }),
                            120,
                          );
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
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                Add a title above, click any text block on the preview to drag it directly, or import subtitles below.
              </div>
            )}

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="section-label" style={{ margin: 0 }}>Subtitles (.SRT / .VTT)</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" onClick={() => subtitleInputRef.current?.click()}>
                  <IconSubtitles size={14} /> Import .SRT / .VTT
                </button>
                <button type="button" onClick={() => void handleExportSubtitlesFile("srt")}>
                  <IconDownload size={13} /> Export .SRT
                </button>
                <button type="button" onClick={() => void handleExportSubtitlesFile("vtt")}>
                  <IconDownload size={13} /> Export .VTT
                </button>
              </div>
            </div>
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
              <div
                className="slider-head"
                onDoubleClick={async () => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  await api.updateClip(c.id, { transform: { ...c.transform, scaleX: 1, scaleY: 1 } });
                  await refreshCurrentProject();
                }}
              >
                <span>Zoom / Scale</span>
                <span className="mono">{curScalePct}%</span>
              </div>
              <input
                type="range"
                min={25}
                max={250}
                value={curScalePct}
                onChange={(e) => {
                  const c = ensureTargetClip();
                  if (!c) return;
                  const s = Number(e.target.value) / 100;
                  const signX = (c.transform.scaleX || 1) < 0 ? -1 : 1;
                  const signY = (c.transform.scaleY || 1) < 0 ? -1 : 1;
                  const nextTransform = { ...c.transform, scaleX: s * signX, scaleY: s * signY };
                  mutateClipLocal(c.id, (prev) => ({ ...prev, transform: nextTransform }));
                  scheduleCommit(`scale:${c.id}`, () => api.updateClip(c.id, { transform: nextTransform }), 150);
                }}
              />
            </div>

            <div className="form-grid-2">
              {(["left", "right", "top", "bottom"] as const).map((edge) => {
                const rawEdge = Number(cropParams[edge] ?? 0);
                const v = Math.round(Math.abs(rawEdge) > 0.5 ? rawEdge : rawEdge * 100);
                return (
                  <div key={edge} className="slider-row">
                    <div
                      className="slider-head"
                      onDoubleClick={() => updateSelectedEffect("crop", { [edge]: 0 }, true)}
                    >
                      <span style={{ textTransform: "capitalize" }}>Crop {edge}</span>
                      <span className="mono">{v}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={45}
                      value={v}
                      onChange={(e) =>
                        updateSelectedEffect("crop", { [edge]: Number(e.target.value) / 100 })
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
                {recordingVo ? `Stop (${voSeconds}s)` : "Record Voiceover"}
              </button>
              <button
                type="button"
                onClick={() => updateSelectedEffect("volume", { gain: volPct <= 1 ? 1 : 0 }, true)}
              >
                {volPct <= 1 ? "Unmute Clip" : "Mute Clip"}
              </button>
            </div>

            <div className="slider-row">
              <div
                className="slider-head"
                onDoubleClick={() => updateSelectedEffect("volume", { gain: 1 }, true)}
              >
                <span>Clip Volume</span>
                <span className="mono">{volPct}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={200}
                value={volPct}
                onChange={(e) => updateSelectedEffect("volume", { gain: Number(e.target.value) / 100 })}
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
                  onChange={(e) => updateSelectedEffect("fade", { fadeIn: Number(e.target.value) })}
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
                  onChange={(e) => updateSelectedEffect("fade", { fadeOut: Number(e.target.value) })}
                />
              </div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="section-label" style={{ margin: 0 }}>3-Band EQ &amp; Voice Clarity</span>
                <button
                  type="button"
                  className={eqInfo?.voiceClarity ? "btn-accent" : ""}
                  style={{ padding: "3px 9px", fontSize: 11 }}
                  onClick={() => updateSelectedEq({ voiceClarity: !eqInfo?.voiceClarity }, true)}
                >
                  Voice Clarity: {eqInfo?.voiceClarity ? "On" : "Off"}
                </button>
              </div>

              <div className="pill-strip">
                {AUDIO_EQ_PRESETS_UI.map((pr) => (
                  <button
                    key={pr.id}
                    type="button"
                    className={`chip-btn ${eqInfo?.preset === pr.id ? "active" : ""}`}
                    onClick={() =>
                      updateSelectedEq(
                        {
                          preset: pr.id,
                          lowDb: pr.lowDb,
                          midDb: pr.midDb,
                          highDb: pr.highDb,
                          voiceClarity: pr.voiceClarity,
                        },
                        true,
                      )
                    }
                  >
                    {pr.label}
                  </button>
                ))}
              </div>

              {(
                [
                  { key: "lowDb", label: "Bass (120 Hz)", val: eqInfo?.lowDb ?? 0 },
                  { key: "midDb", label: "Mid Presence (1.2 kHz)", val: eqInfo?.midDb ?? 0 },
                  { key: "highDb", label: "Treble Air (4.8 kHz)", val: eqInfo?.highDb ?? 0 },
                ] as const
              ).map(({ key, label, val }) => (
                <div key={key} className="slider-row">
                  <div
                    className="slider-head"
                    onDoubleClick={() => updateSelectedEq({ [key]: 0 }, true)}
                  >
                    <span>{label}</span>
                    <span className="mono">{val > 0 ? `+${val}` : val} dB</span>
                  </div>
                  <input
                    type="range"
                    min={-15}
                    max={15}
                    step={0.5}
                    value={val}
                    onChange={(e) => updateSelectedEq({ [key]: Number(e.target.value) })}
                  />
                </div>
              ))}
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
                <span>{apiSettings?.hasApiKey ? apiSettings.model : "Offline Studio Mode"}</span>
              </div>
              <button type="button" onClick={() => setShowApiModal(true)} style={{ padding: "4px 9px", fontSize: 11.5 }}>
                <IconKey size={13} /> {apiSettings?.hasApiKey ? "Change API" : "Connect API"}
              </button>
            </div>

            <div className="pill-strip">
              {[
                { label: "9:16 Reels", prompt: "Convert project to 9:16 vertical aspect ratio" },
                { label: "Cinema Grade", prompt: "Apply Kodak film LUT look" },
                { label: "Silver Mono", prompt: "Apply black and white mono film look" },
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

  const handleStageClipMove = useCallback(
    (clipId: string, x: number, y: number, commit = false) => {
      mutateClipLocal(clipId, (prev) => ({
        ...prev,
        transform: { ...prev.transform, x, y },
      }));
      if (commit) {
        const found = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
        const base = found ? { ...found.transform, x, y } : { x, y, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };
        scheduleCommit(`pos:${clipId}`, () => api.updateClip(clipId, { transform: base }), 20);
      }
    },
    [mutateClipLocal, scheduleCommit, seq.tracks],
  );

  const handleStageCaptionMove = useCallback(
    (capId: string, x: number, y: number, commit = false) => {
      mutateCaptionLocal(capId, (prev) => ({
        ...prev,
        style: { ...(prev.style ?? {}), x, y },
      }));
      if (commit) {
        const cap = seq.captions.find((c) => c.id === capId);
        scheduleCommit(
          `cap-pos:${capId}`,
          () => api.updateCaption(capId, { style: { ...(cap?.style ?? {}), x, y } }),
          20,
        );
      }
    },
    [mutateCaptionLocal, scheduleCommit, seq.captions],
  );

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragDropActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragDropActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragDropActive(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) void ingestFiles(files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*,.srt,.vtt"
        style={{ display: "none" }}
        onChange={handleFilesSelected}
      />
      <input
        ref={subtitleInputRef}
        type="file"
        accept=".srt,.vtt,text/plain,text/vtt"
        style={{ display: "none" }}
        onChange={handleFilesSelected}
      />

      {dragDropActive && (
        <div className="drop-overlay">
          <IconPlus size={28} style={{ color: "#60a5fa" }} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>Drop files into Vedit Studio</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Videos, Photos, Music, or .SRT / .VTT Subtitles
          </div>
        </div>
      )}

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
                const res = await api.getProject(val);
                setProject(res.project);
                if (res.history) setHistoryState(res.history);
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
            disabled={!historyState.canUndo}
            onClick={() => void api.undo().then(() => refreshCurrentProject())}
            title="Undo (Ctrl+Z)"
          >
            <IconUndo size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={!historyState.canRedo}
            onClick={() => void api.redo().then(() => refreshCurrentProject())}
            title="Redo (Ctrl+Shift+Z)"
          >
            <IconRedo size={15} />
          </button>

          {!isMobileLayout && (
            <>
              <button
                type="button"
                className="icon-btn"
                onClick={handleSaveProject}
                title="Save Project (Ctrl+S)"
              >
                <IconSave size={15} />
              </button>
              <button
                type="button"
                className={`icon-btn ${showShortcuts ? "active" : ""}`}
                onClick={() => setShowShortcuts((s) => !s)}
                title="Keyboard Shortcuts (?)"
              >
                <IconKeyboard size={15} />
              </button>
            </>
          )}

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
              selectedClipId={selectedClipId}
              selectedCaptionId={selectedCaptionId}
              onPlayhead={setPlayhead}
              onPlaying={setPlaying}
              onToggleMute={() => setMuted((m) => !m)}
              onSelectClip={setSelectedClipId}
              onSelectCaption={(id) => {
                setSelectedCaptionId(id);
                if (id) {
                  setActiveTab("text");
                  setMobileSheetOpen(true);
                }
              }}
              onMoveClipPosition={handleStageClipMove}
              onMoveCaptionPosition={handleStageCaptionMove}
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
              onMoveClip={async (clipId, start, trackId) => {
                await api.moveClip(clipId, start, trackId);
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
              selectedClipId={selectedClipId}
              selectedCaptionId={selectedCaptionId}
              onPlayhead={setPlayhead}
              onPlaying={setPlaying}
              onToggleMute={() => setMuted((m) => !m)}
              onSelectClip={setSelectedClipId}
              onSelectCaption={setSelectedCaptionId}
              onMoveClipPosition={handleStageClipMove}
              onMoveCaptionPosition={handleStageCaptionMove}
              onImportRequest={triggerFilePicker}
              onQuickSplit={handleSplitAtPlayhead}
            />

            <div className="splitter-v" onPointerDown={(e) => startResize("right", e)} />

            <aside className="side-panel" style={{ width: rightWidth }}>
              <div className="panel-header" style={{ gap: 8 }}>
                <span>{selectedCaption ? "Text Inspector" : selectedClip ? "Clip Inspector" : "Sequence"}</span>
                {selectedClip && !selectedCaption && (
                  <div className="seg-control" style={{ flex: 1, maxWidth: 196 }}>
                    {(
                      [
                        { id: "adjust", label: "Color" },
                        { id: "audio", label: "Audio" },
                        { id: "edit", label: "Clip" },
                        { id: "canvas", label: "Crop" },
                      ] as const
                    ).map((it) => (
                      <button
                        key={it.id}
                        type="button"
                        className={`seg-btn ${inspectorTab === it.id ? "active" : ""}`}
                        style={{ height: 24, padding: "0 6px", fontSize: 11 }}
                        onClick={() => setInspectorTab(it.id)}
                      >
                        {it.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="panel-scroll">
                {selectedCaption
                  ? renderToolContent("text")
                  : selectedClip
                    ? renderToolContent(inspectorTab)
                    : renderToolContent("canvas")}
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
              onMoveClip={async (clipId, start, trackId) => {
                await api.moveClip(clipId, start, trackId);
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

      {showShortcuts && (
        <div className="modal-backdrop" onClick={() => setShowShortcuts(false)}>
          <div className="modal-card" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Studio Keyboard Shortcuts</h2>
              <button type="button" className="btn-ghost" onClick={() => setShowShortcuts(false)}>
                Done
              </button>
            </div>
            <div className="modal-body" style={{ gap: 9 }}>
              {[
                ["Space / K", "Play / Pause"],
                ["J / L", "Step Back / Play Forward"],
                ["← / →", "Step 1 Frame (Shift = 1s)"],
                ["S", "Split Clip at Playhead"],
                ["Delete / Backspace", "Delete Selected Clip or Title"],
                ["Ctrl + Z / Ctrl + Y", "Undo / Redo"],
                ["Ctrl + S", "Save Project"],
                ["Ctrl + E", "Export Video (.MP4)"],
                ["Double-Click Slider", "Reset Parameter to Default"],
              ].map(([keys, desc]) => (
                <div key={keys} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                  <span style={{ color: "var(--text-secondary)" }}>{desc}</span>
                  <span className="kbd-badge mono">{keys}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
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
          onProjectRefresh={refreshCurrentProject}
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
