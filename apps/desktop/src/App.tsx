import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  connectWs,
  setCurrentId,
  withToken,
  type ApiSettingsResponse,
  type Asset,
  type CameraMoveInfo,
  type Clip,
  type ExportPresetInfo,
  type GenProviderInfo,
  type MarketplacePackInfo,
  type Project,
} from "./api";
import { AiPanel, GenPanel, Inspector, JobsPanel, MediaPool, Preview, StudioPanel, Timeline, fmt } from "./components";
import { ApiSettingsModal, StudioCatalogBrowser, ExportModal, ShowcaseModal, type CatalogItem } from "./StudioModals";

interface Selection {
  trackId: string;
  clipId: string;
}

type LeftTabId = "media" | "audio" | "text" | "effects" | "transitions" | "ai" | "gen" | "templates";

const RAIL_TABS: Array<{ id: LeftTabId; icon: string; label: string }> = [
  { id: "media", icon: "📂", label: "Media" },
  { id: "audio", icon: "🎵", label: "Audio" },
  { id: "text", icon: "🔤", label: "Text" },
  { id: "effects", icon: "✨", label: "Effects" },
  { id: "transitions", icon: "🔀", label: "Motion" },
  { id: "ai", icon: "🤖", label: "AI Edit" },
  { id: "gen", icon: "🎬", label: "AI Gen" },
  { id: "templates", icon: "📦", label: "Studio" },
];

// Memoized heavy studio panels so 60 FPS playback NEVER re-renders side drawers!
const MemoMediaPool = memo(MediaPool);
const MemoAiPanel = memo(AiPanel);
const MemoGenPanel = memo(GenPanel);
const MemoStudioPanel = memo(StudioPanel);
const MemoInspector = memo(Inspector);
const MemoJobsPanel = memo(JobsPanel);

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  playheadRef.current = playhead;

  const [playing, setPlaying] = useState(false);
  const [shuttleRate, setShuttleRate] = useState(1);
  const [zoom, setZoom] = useState(64);
  const [toast, setToast] = useState<string | null>(null);
  const [presets, setPresets] = useState<Array<{ id: string; label: string }>>([]);
  const [copilotPrompt, setCopilotPrompt] = useState(
    'Apply Kodak 2383 LUT, add lower third "Vedit Studio", duck music',
  );
  const [busy, setBusy] = useState(false);
  const [aiCaps, setAiCaps] = useState<Awaited<ReturnType<typeof api.aiCaps>> | null>(null);
  const [genProviders, setGenProviders] = useState<GenProviderInfo[]>([]);
  const [cameraMoves, setCameraMoves] = useState<CameraMoveInfo[]>([]);
  const [exportPresets, setExportPresets] = useState<ExportPresetInfo[]>([]);
  const [exportPresetId, setExportPresetId] = useState("youtube-1080p");
  const [hwAccel, setHwAccel] = useState("auto");
  const [loudnessLufs, setLoudnessLufs] = useState<string>("-14");
  const [packs, setPacks] = useState<MarketplacePackInfo[]>([]);
  const [bootStatus, setBootStatus] = useState<string>("Starting local Vedit Studio engine…");
  const [bootNonce, setBootNonce] = useState<number>(0);
  const [windowDragOver, setWindowDragOver] = useState<boolean>(false);

  // Vedit Studio Workspace Navigation, Search, Modals, Fullscreen & Multi-Pane Resizable Scaling
  const [activeTab, setActiveTab] = useState<LeftTabId>("media");
  const [sectionSearch, setSectionSearch] = useState<string>("");
  const globalSearchRef = useRef<HTMLInputElement | null>(null);
  const [showApiModal, setShowApiModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showShowcaseModal, setShowShowcaseModal] = useState(false);
  const [apiSettings, setApiSettings] = useState<ApiSettingsResponse | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [uiScale, setUiScale] = useState<number>(() => {
    const saved = Number(localStorage.getItem("vedit.uiScale") || 100);
    return Number.isFinite(saved) && saved >= 70 && saved <= 150 ? saved : 100;
  });
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("vedit.leftWidth") || 320);
    return Number.isFinite(saved) && saved >= 190 && saved <= 620 ? saved : 320;
  });
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("vedit.rightWidth") || 315);
    return Number.isFinite(saved) && saved >= 200 && saved <= 620 ? saved : 315;
  });
  const [timelineHeight, setTimelineHeight] = useState<number>(() => {
    const saved = Number(localStorage.getItem("vedit.timelineHeight") || 255);
    return Number.isFinite(saved) && saved >= 130 && saved <= 620 ? saved : 255;
  });
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(
    () => typeof window !== "undefined" && window.innerWidth < 680,
  );
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(
    () => typeof window !== "undefined" && window.innerWidth < 920,
  );
  const [draggingSplitter, setDraggingSplitter] = useState<"left" | "right" | "bottom" | null>(null);

  const [updateInfo, setUpdateInfo] = useState<{
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
    downloadUrl: string | null;
  } | null>(null);

  useEffect(() => {
    localStorage.setItem("vedit.uiScale", String(uiScale));
  }, [uiScale]);
  useEffect(() => {
    localStorage.setItem("vedit.leftWidth", String(leftWidth));
  }, [leftWidth]);
  useEffect(() => {
    localStorage.setItem("vedit.rightWidth", String(rightWidth));
  }, [rightWidth]);
  useEffect(() => {
    localStorage.setItem("vedit.timelineHeight", String(timelineHeight));
  }, [timelineHeight]);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3200);
  }, []);

  const refreshInFlightRef = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
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
    } finally {
      refreshInFlightRef.current = false;
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      const native = await api.windowFullscreen("toggle");
      if (native.supported) {
        setIsFullscreen(native.fullscreen);
        return;
      }
    } catch {
      /* fallback to browser Fullscreen API below */
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      setIsFullscreen(false);
    } else {
      await document.documentElement.requestFullscreen?.().catch(() => undefined);
      setIsFullscreen(true);
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      if (document.fullscreenElement) setIsFullscreen(true);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let attempt = 0;
      while (!cancelled) {
        attempt++;
        try {
          await refresh();
          if (cancelled) return;
          void api.presets().then((r) => !cancelled && setPresets(r.presets)).catch(() => {});
          void api.aiCaps().then((r) => !cancelled && setAiCaps(r)).catch(() => {});
          void api
            .genProviders()
            .then((r) => {
              if (!cancelled) {
                setGenProviders(r.providers);
                setCameraMoves(r.cameraMoves);
              }
            })
            .catch(() => {});
          void api.exportPresets().then((r) => !cancelled && setExportPresets(r.presets)).catch(() => {});
          void api.marketplaceList().then((r) => !cancelled && setPacks(r.packs)).catch(() => {});
          void api.checkUpdate().then((u) => !cancelled && setUpdateInfo(u)).catch(() => {});
          void api.getApiSettings().then((s) => !cancelled && setApiSettings(s)).catch(() => {});
          void api.windowFullscreen("state").then((fs) => !cancelled && fs.supported && setIsFullscreen(fs.fullscreen)).catch(() => {});
          return;
        } catch (err) {
          if (attempt >= 3) {
            const diag = (window as unknown as { __VEDIT_DIAG__?: string }).__VEDIT_DIAG__;
            setBootStatus(
              diag
                ? `Engine diagnostic: ${diag}`
                : `Waiting for local engine on 127.0.0.1:47000 (attempt #${attempt}: ${(err as Error).message})`,
            );
          }
          await new Promise((r) => setTimeout(r, 350));
        }
      }
    })();
    const disconnect = connectWs(() => void refresh().catch(() => undefined));
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [refresh, bootNonce]);

  const seq = project?.sequences.find((s) => s.id === project.activeSequenceId) ?? null;

  const totalSeqDuration = useMemo(() => {
    if (!seq) return 10;
    return Math.max(
      1,
      ...seq.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)),
      ...seq.captions.map((c) => c.end),
    );
  }, [seq]);

  // Smooth 60 FPS transport loop
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

  // Global Studio Keyboard Shortcuts (Space, J/K/L, Arrows, Ctrl+K Search, Ctrl+-/+/0 Scale, F11 Fullscreen)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (e.key === "Escape") {
        if (showApiModal) {
          setShowApiModal(false);
          return;
        }
        if (showExportModal) {
          setShowExportModal(false);
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        globalSearchRef.current?.focus();
        globalSearchRef.current?.select();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setUiScale((s) => Math.min(150, s + 10));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        setUiScale((s) => Math.max(70, s - 10));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        setUiScale(100);
        return;
      }

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
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (selection?.clipId) {
          void act(() => api.splitClip(selection.clipId, playheadRef.current), "Split clip at playhead");
        }
      } else if (e.key === "Delete" && selection?.clipId) {
        e.preventDefault();
        void act(() => api.deleteClip(selection.clipId), "Deleted selected clip");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seq, totalSeqDuration, selection, act, flash, toggleFullscreen, showApiModal, showExportModal]);

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

  // ZERO-LAG FIX: Never spawn 60 FFmpeg frame extractions/sec for streaming videos!
  // Only request still frame fallback for static image assets (quantized when stopped).
  const activeClipAsset = useMemo(
    () => (project && activeClip ? project.assets.find((a) => a.id === activeClip.assetId) ?? null : null),
    [project, activeClip],
  );
  const quantizedStopTime = playing ? 0 : Math.round(playhead * 4) / 4;
  const frameUrl = useMemo(() => {
    if (!project || !activeClip || !activeClipAsset) return null;
    if (activeClipAsset.kind !== "image") return null;
    const t = activeClip.in + Math.min(Math.max(0, quantizedStopTime - activeClip.start), activeClip.duration);
    return withToken(`/api/v1/projects/${project.id}/assets/${activeClip.assetId}/frame?t=${t.toFixed(2)}&width=640`);
  }, [project, activeClip, activeClipAsset, quantizedStopTime]);

  // Target clip helper: uses selected clip, or active clip under playhead, or lead video clip automatically!
  const resolveTargetClipId = useCallback((): string | null => {
    if (selection?.clipId) return selection.clipId;
    if (activeClip?.id) return activeClip.id;
    const first = seq?.tracks.flatMap((t) => t.clips)[0];
    return first?.id ?? null;
  }, [selection, activeClip, seq]);

  // Stable memoized callbacks (using playheadRef so side panels NEVER re-render during playback!)
  const handleQuickAddAsset = useCallback(
    (asset: Asset) => {
      if (!seq) return;
      void act(async () => {
        const at = playheadRef.current;
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
          start: at,
          duration: dur,
          in: 0,
          out: dur,
        });
        flash(`Added "${asset.name}" @ ${fmt(at)}`);
      });
    },
    [seq, act, flash],
  );

  // Vedit Studio Visual Preset Cards for Effects, LUTs, Motion/Transitions, Text & Smart Tools
  const catalogItems: CatalogItem[] = useMemo(() => {
    const withClip = (fn: (cid: string) => Promise<unknown>, msg: string) => () => {
      const cid = resolveTargetClipId();
      if (!cid) {
        flash("Add or select a clip on the timeline first");
        return;
      }
      if (window.innerWidth < 900) setLeftCollapsed(true);
      void act(() => fn(cid), msg);
    };

    const effectCards: CatalogItem[] = [
      {
        id: "lut-kodak",
        section: "effects",
        badge: "3D LUT",
        title: "Kodak 2383 Film",
        subtitle: "Warm Hollywood print film stock",
        gradient: "linear-gradient(135deg, #92400e, #f59e0b)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        previewFilter: "sepia(0.28) contrast(1.16) saturate(1.26)",
        run: withClip((cid) => api.applyLut(cid, "kodak-2383"), "Applied Kodak 2383 3D LUT"),
      },
      {
        id: "lut-teal",
        section: "effects",
        badge: "3D LUT",
        title: "Teal & Orange",
        subtitle: "Blockbuster cinema color contrast",
        gradient: "linear-gradient(135deg, #0f766e, #ea580c)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        previewFilter: "hue-rotate(-14deg) contrast(1.26) saturate(1.48)",
        run: withClip((cid) => api.applyLut(cid, "teal-orange-blockbuster"), "Applied Teal & Orange LUT"),
      },
      {
        id: "lut-fuji",
        section: "effects",
        badge: "3D LUT",
        title: "Fuji Eterna Soft",
        subtitle: "Soft highlight roll-off look",
        gradient: "linear-gradient(135deg, #065f46, #34d399)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        previewFilter: "brightness(1.07) contrast(0.92) saturate(0.86)",
        run: withClip((cid) => api.applyLut(cid, "fuji-eterna-soft"), "Applied Fuji Eterna LUT"),
      },
      {
        id: "lut-cyber",
        section: "effects",
        badge: "3D LUT",
        title: "Cyberpunk Neon",
        subtitle: "Electric magenta & cyan night",
        gradient: "linear-gradient(135deg, #7e22ce, #06b6d4)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        previewFilter: "hue-rotate(38deg) saturate(1.85) contrast(1.22)",
        run: withClip((cid) => api.applyLut(cid, "cyberpunk-neon"), "Applied Cyberpunk Neon LUT"),
      },
      {
        id: "lut-bleach",
        section: "effects",
        badge: "3D LUT",
        title: "Silver Bleach",
        subtitle: "Grit high-contrast bleach bypass",
        gradient: "linear-gradient(135deg, #334155, #94a3b8)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        previewFilter: "grayscale(0.72) contrast(1.44) brightness(0.95)",
        run: withClip((cid) => api.applyLut(cid, "bleach-bypass"), "Applied Bleach Bypass LUT"),
      },
      {
        id: "grade-punch",
        section: "effects",
        badge: "GRADE",
        title: "Cinematic Punch",
        subtitle: "Rich contrast & saturation boost",
        gradient: "linear-gradient(135deg, #1d4ed8, #7c3aed)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        previewFilter: "contrast(1.32) saturate(1.35)",
        run: withClip((cid) => api.colorGrade(cid, "cinematic-contrast"), "Applied Cinematic Punch grade"),
      },
      {
        id: "grade-golden",
        section: "effects",
        badge: "GRADE",
        title: "Golden Hour",
        subtitle: "Sunlit warm skin tones",
        gradient: "linear-gradient(135deg, #b45309, #fde047)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        previewFilter: "sepia(0.35) brightness(1.06) saturate(1.32)",
        run: withClip((cid) => api.colorGrade(cid, "warm-golden"), "Applied Golden Hour grade"),
      },
      {
        id: "grade-noir",
        section: "effects",
        badge: "GRADE",
        title: "Moody Cool Noir",
        subtitle: "Deep shadows & cool steel",
        gradient: "linear-gradient(135deg, #0f172a, #38bdf8)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        previewFilter: "hue-rotate(175deg) saturate(0.75) contrast(1.25)",
        run: withClip((cid) => api.colorGrade(cid, "cool-noir"), "Applied Cool Noir grade"),
      },
      {
        id: "key-green",
        section: "effects",
        badge: "KEYING",
        title: "Green Screen Key",
        subtitle: "Chroma key + automatic spill removal",
        gradient: "linear-gradient(135deg, #15803d, #22c55e)",
        thumbUrl: "/showcase/motion-neon.jpg",
        previewFilter: "hue-rotate(92deg) saturate(1.5)",
        run: withClip((cid) => api.chromaKey(cid, "#00ff00"), "Applied Green Screen Chroma Key"),
      },
      {
        id: "stabilize",
        section: "effects",
        badge: "PRO",
        title: "Video Stabilizer",
        subtitle: "Smooth handheld camera shake",
        gradient: "linear-gradient(135deg, #0369a1, #2dd4bf)",
        thumbUrl: "/showcase/motion-neon.jpg",
        previewFilter: "contrast(1.1)",
        run: withClip((cid) => api.stabilizeClip(cid), "Stabilized video clip"),
      },
    ];

    const transitionCards: CatalogItem[] = [
      {
        id: "tr-fade",
        section: "transitions",
        badge: "FADE",
        title: "Smooth Dissolve",
        subtitle: "0.5s fade in & out transition",
        gradient: "linear-gradient(135deg, #1e293b, #00c8d7)",
        thumbUrl: "/showcase/motion-neon.jpg",
        previewFilter: "brightness(1.12) contrast(1.08)",
        run: withClip((cid) => api.fadeClip(cid, 0.5, 0.5), "Added 0.5s Fade In/Out"),
      },
      ...presets.map((p) => ({
        id: `anim-${p.id}`,
        section: "transitions" as const,
        badge: "MOTION",
        title: p.label,
        subtitle: "Keyframe motion animation",
        gradient: "linear-gradient(135deg, #1e3a8a, #6366f1)",
        thumbUrl: "/showcase/motion-neon.jpg",
        previewFilter: "saturate(1.25)",
        run: withClip((cid) => api.applyPreset(cid, p.id), `Applied ${p.label}`),
      })),
      {
        id: "spd-05",
        section: "transitions",
        badge: "SPEED",
        title: "Slow Motion 0.5×",
        subtitle: "Smooth cinematic slow-mo",
        gradient: "linear-gradient(135deg, #0f766e, #0ea5e9)",
        thumbUrl: "/showcase/motion-neon.jpg",
        previewFilter: "hue-rotate(-18deg) brightness(1.05)",
        run: withClip((cid) => api.setClipSpeed(cid, 0.5), "Set speed 0.5×"),
      },
      {
        id: "spd-20",
        section: "transitions",
        badge: "SPEED",
        title: "Fast Cut 2×",
        subtitle: "Snappy double-speed ramp",
        gradient: "linear-gradient(135deg, #b91c1c, #f97316)",
        thumbUrl: "/showcase/motion-neon.jpg",
        previewFilter: "contrast(1.3) saturate(1.55)",
        run: withClip((cid) => api.setClipSpeed(cid, 2), "Set speed 2×"),
      },
      {
        id: "reverse-clip",
        section: "transitions",
        badge: "TIME",
        title: "Reverse Clip",
        subtitle: "Play video & audio backwards",
        gradient: "linear-gradient(135deg, #4338ca, #ec4899)",
        thumbUrl: "/showcase/motion-neon.jpg",
        previewFilter: "hue-rotate(155deg) saturate(1.3)",
        run: withClip((cid) => api.reverseClip(cid), "Reversed clip"),
      },
      {
        id: "freeze-clip",
        section: "transitions",
        badge: "TIME",
        title: "Freeze Frame 1.5s",
        subtitle: "Hold still frame at playhead",
        gradient: "linear-gradient(135deg, #0284c7, #bae6fd)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        previewFilter: "saturate(0.55) brightness(1.12) contrast(1.15)",
        run: withClip((cid) => api.freezeClip(cid, playheadRef.current, 1.5), "Inserted 1.5s Freeze Frame"),
      },
      {
        id: "pip-br",
        section: "transitions",
        badge: "LAYOUT",
        title: "PiP Facecam Corner",
        subtitle: "Bottom-right Picture-in-Picture",
        gradient: "linear-gradient(135deg, #334155, #00c8d7)",
        thumbUrl: "/showcase/hero-cinema.jpg",
        overlayKind: "pip",
        run: withClip((cid) => api.applyLayout(cid, "pip-bottom-right"), "Applied PiP Bottom-Right"),
      },
      {
        id: "split-lr",
        section: "transitions",
        badge: "LAYOUT",
        title: "Split Screen 50/50",
        subtitle: "Side-by-side comparison frame",
        gradient: "linear-gradient(135deg, #4f46e5, #14b8a6)",
        thumbUrl: "/showcase/motion-neon.jpg",
        overlayKind: "split",
        run: withClip((cid) => api.applyLayout(cid, "split-left"), "Applied Split Screen Left"),
      },
    ];

    return [...effectCards, ...transitionCards];
  }, [presets, resolveTargetClipId, act, flash]);

  // Unified Mouse + Finger Touch Pointer drag handlers for all Workspace Splitters!
  const startSplitterDrag = (which: "left" | "right" | "bottom", e: React.PointerEvent) => {
    e.preventDefault();
    setDraggingSplitter(which);
    const scaleFactor = uiScale / 100;
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = leftWidth;
    const origRight = rightWidth;
    const origBottom = timelineHeight;

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / scaleFactor;
      const dy = (ev.clientY - startY) / scaleFactor;
      if (which === "left") {
        setLeftCollapsed(false);
        setLeftWidth(Math.max(180, Math.min(620, Math.round(origLeft + dx))));
      } else if (which === "right") {
        setRightCollapsed(false);
        setRightWidth(Math.max(190, Math.min(620, Math.round(origRight - dx))));
      } else {
        setTimelineHeight(Math.max(120, Math.min(620, Math.round(origBottom - dy))));
      }
    };
    const onUp = () => {
      setDraggingSplitter(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  if (!project || !seq) {
    return (
      <div className="app loading" style={{ flexDirection: "column", gap: 12, textAlign: "center", padding: 24 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Starting Vedit Studio…</div>
        <div className="muted" style={{ maxWidth: 560, fontSize: 12 }}>
          {bootStatus}
        </div>
        <button type="button" onClick={() => setBootNonce((n) => n + 1)}>
          🔄 Retry Connection
        </button>
      </div>
    );
  }

  const clipId = selection?.clipId ?? null;
  const searchTrimmed = sectionSearch.trim().toLowerCase();
  const matchingAssets = searchTrimmed
    ? project.assets.filter(
        (a) =>
          a.name.toLowerCase().includes(searchTrimmed) ||
          (a.tags ?? []).some((tg) => tg.toLowerCase().includes(searchTrimmed)),
      )
    : [];
  const matchingPacks = searchTrimmed
    ? packs.filter(
        (p) => p.name.toLowerCase().includes(searchTrimmed) || p.description.toLowerCase().includes(searchTrimmed),
      )
    : [];

  const scaleCss =
    uiScale === 100
      ? undefined
      : ({
          zoom: uiScale / 100,
        } as React.CSSProperties);

  return (
    <div
      className="app"
      style={{
        ...scaleCss,
        ...(windowDragOver ? { outline: "2px dashed #00e5ff", outlineOffset: -4 } : {}),
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!windowDragOver) setWindowDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setWindowDragOver(false);
      }}
      onDrop={(e) => {
        setWindowDragOver(false);
        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;
        e.preventDefault();
        void act(async () => {
          let cursor = playheadRef.current;
          for (const file of Array.from(files)) {
            const res = await api.uploadAssetFile(file, cursor, true);
            cursor += res.asset.duration ?? 5;
          }
          flash(`Imported ${files.length} file${files.length > 1 ? "s" : ""} onto timeline`);
        });
      }}
    >
      {windowDragOver && (
        <div
          style={{
            position: "fixed",
            top: 10,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 9999,
            background: "linear-gradient(135deg, #00c8d7, #2563eb)",
            color: "#fff",
            padding: "6px 16px",
            borderRadius: 999,
            fontWeight: 700,
            fontSize: 12.5,
            pointerEvents: "none",
            boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
          }}
        >
          📂 Drop video, audio, or image files anywhere onto Vedit
        </div>
      )}

      {/* ==================== Vedit Studio TOP HEADER BAR ==================== */}
      <header className="toolbar">
        {/* Left: Brand + Project + Undo/Redo + Self-Update */}
        <div className="topbar-left">
          <span className="logo">Vedit</span>
          <span className="muted" style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {project.name}
          </span>
          <button
            type="button"
            disabled={busy}
            title="Save project (Ctrl+S)"
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
            type="button"
            disabled={busy}
            title="Open saved project"
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
          <button type="button" className="icon-btn" disabled={busy} title="Undo (Ctrl+Z)" onClick={() => act(() => api.undo(), "Undo")}>
            ↶
          </button>
          <button type="button" className="icon-btn" disabled={busy} title="Redo (Ctrl+Y)" onClick={() => act(() => api.redo(), "Redo")}>
            ↷
          </button>
          <button
            type="button"
            disabled={busy}
            title={
              updateInfo?.updateAvailable
                ? `Install Vedit v${updateInfo.latestVersion} update in place`
                : "Check GitHub Releases for updates"
            }
            style={
              updateInfo?.updateAvailable
                ? { background: "#15803d", color: "#fff", borderColor: "#22c55e", fontWeight: 700 }
                : undefined
            }
            onClick={() =>
              act(async () => {
                const latest = await api.checkUpdate();
                setUpdateInfo(latest);
                if (latest.updateAvailable) {
                  flash(`Downloading Vedit v${latest.latestVersion}…`);
                  const res = await api.installUpdate(latest.downloadUrl ?? undefined);
                  flash(res.launched ? `Updating to v${res.latestVersion}…` : `Saved → ${res.installerPath}`);
                } else if (
                  latest.downloadUrl &&
                  window.confirm(
                    `Vedit v${latest.currentVersion} is up to date (latest: v${latest.latestVersion}).\n\nDownload and run in-place repair installer anyway?`,
                  )
                ) {
                  const res = await api.installUpdate(latest.downloadUrl);
                  flash(res.launched ? "Launching repair installer…" : `Saved → ${res.installerPath}`);
                } else {
                  flash(`Vedit v${latest.currentVersion} is up to date ✓`);
                }
              })
            }
          >
            {updateInfo?.updateAvailable ? `⬆ v${updateInfo.latestVersion}` : "🔄 Update"}
          </button>
        </div>

        {/* Center: Instant Universal Vedit Studio Search Bar (Ctrl+K) */}
        <div className="topbar-center">
          <div className="global-search">
            <input
              ref={globalSearchRef}
              value={sectionSearch}
              onChange={(e) => {
                setSectionSearch(e.target.value);
                if (leftCollapsed) setLeftCollapsed(false);
              }}
              placeholder="🔍 Search media, effects, 3D LUTs, transitions, templates… (Ctrl+K)"
            />
            {sectionSearch && (
              <button
                type="button"
                className="global-search-clear"
                onClick={() => setSectionSearch("")}
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Right Corner: Showcase + API & Models + UI Scaling + Panel Toggles + Export + FULLSCREEN */}
        <div className="topbar-right">
          <button
            type="button"
            onClick={() => setShowShowcaseModal(true)}
            title="Visual Studio Presets & Interactive Demo Scenes"
            style={{ borderColor: "rgba(0, 200, 215, 0.45)" }}
          >
            ✨ Showcase
          </button>

          <button
            type="button"
            onClick={() => setShowApiModal(true)}
            title="Configure Custom API Key, Base URL & AI Model"
            style={{
              borderColor: apiSettings?.hasApiKey ? "rgba(34, 197, 94, 0.55)" : undefined,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: apiSettings?.hasApiKey ? "#22c55e" : "#64748b",
                display: "inline-block",
              }}
            />
            ⚙ API {apiSettings?.model ? `(${apiSettings.model.split("/").pop()})` : "& Model"}
          </button>

          {/* UI Scaling Control (70% – 150%) */}
          <div className="scale-pill" title="Scale Entire Interface (Ctrl - / Ctrl + / Ctrl 0)">
            <button type="button" onClick={() => setUiScale((s) => Math.max(70, s - 10))} title="Scale UI Down (Ctrl -)">
              −
            </button>
            <button
              type="button"
              onClick={() => {
                setUiScale(100);
                setLeftWidth(320);
                setRightWidth(315);
                setTimelineHeight(255);
                setLeftCollapsed(false);
                setRightCollapsed(false);
              }}
              title="Click to reset UI scale (100%) & default panel layout"
              style={{ minWidth: 44, fontWeight: 600 }}
            >
              {uiScale}%
            </button>
            <button type="button" onClick={() => setUiScale((s) => Math.min(150, s + 10))} title="Scale UI Up (Ctrl +)">
              +
            </button>
          </div>

          <button
            type="button"
            className="icon-btn"
            title={leftCollapsed ? "Show Left Browser Drawer" : "Collapse Left Browser Drawer"}
            onClick={() => setLeftCollapsed((c) => !c)}
          >
            ◧
          </button>
          <button
            type="button"
            className="icon-btn"
            title={rightCollapsed ? "Show Right Inspector" : "Collapse Right Inspector"}
            onClick={() => setRightCollapsed((c) => !c)}
          >
            ◨
          </button>

          <button
            type="button"
            className="btn-accent"
            onClick={() => setShowExportModal(true)}
            title="Export Video, Batch Render, Thumbnails & EDL/XML"
          >
            📤 Export
          </button>

          {/* TOP-RIGHT CORNER NATIVE FULLSCREEN BUTTON (F11) */}
          <button
            type="button"
            className={`fullscreen-corner-btn ${isFullscreen ? "is-fs" : ""}`}
            onClick={() => void toggleFullscreen()}
            title={isFullscreen ? "Exit Fullscreen (F11)" : "Enter Fullscreen (F11)"}
          >
            {isFullscreen ? "🗗 Exit" : "⛶ Fullscreen"}
          </button>
        </div>
      </header>

      {/* ==================== UPPER Vedit Studio 4-ZONE RESIZABLE WORKSPACE ==================== */}
      <div className="workspace-upper">
        {/* 1. Far-Left Vedit Studio Section Icon Rail */}
        <nav className="studio-rail" aria-label="Studio Sections">
          {RAIL_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`rail-tab ${!leftCollapsed && activeTab === tab.id ? "active" : ""}`}
              onClick={() => {
                if (!leftCollapsed && activeTab === tab.id) {
                  setLeftCollapsed(true);
                } else {
                  setActiveTab(tab.id);
                  setLeftCollapsed(false);
                }
              }}
            >
              <span className="rail-icon">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        {/* 2. Resizable Left Section Drawer with Built-in Search */}
        {!leftCollapsed && (
          <>
            <aside className="left-drawer" style={{ width: leftWidth }}>
              <div className="drawer-search-bar" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  style={{ flex: 1 }}
                  value={sectionSearch}
                  onChange={(e) => setSectionSearch(e.target.value)}
                  placeholder={`🔍 Search ${RAIL_TABS.find((t) => t.id === activeTab)?.label ?? "studio"} or all presets…`}
                />
                {sectionSearch && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setSectionSearch("")}
                    title="Clear filter"
                  >
                    ✕
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setLeftCollapsed(true)}
                  title="Collapse panel"
                  style={{ flex: "none" }}
                >
                  ‹
                </button>
              </div>

              <div className="drawer-scroll">
                {searchTrimmed ? (
                  <StudioCatalogBrowser
                    title={`Search Results: "${sectionSearch}"`}
                    query={sectionSearch}
                    items={catalogItems}
                    matchingAssets={matchingAssets}
                    matchingPacks={matchingPacks}
                    onQuickAddAsset={handleQuickAddAsset}
                    onApplyTemplate={(tplId) =>
                      void act(() => api.applyTemplate(tplId, {}), "Template applied")
                    }
                  />
                ) : activeTab === "media" ? (
                  <>
                    <div
                      className="hero-showcase-banner"
                      style={{
                        backgroundImage:
                          "linear-gradient(125deg, rgba(11,13,17,0.92), rgba(11,13,17,0.58)), url('/showcase/ai-gen-banner.jpg')",
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>
                        🎬 Vedit Cinema Studio
                      </div>
                      <div className="muted" style={{ fontSize: 11, color: "#cbd5e1", margin: "2px 0 8px" }}>
                        Drop media anywhere or click to load HD demo plates onto timeline:
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn-accent"
                          style={{ padding: "3px 8px", fontSize: 11 }}
                          onClick={() =>
                            void act(async () => {
                              const resp = await fetch("/showcase/hero-cinema.jpg");
                              const blob = await resp.blob();
                              const file = new File([blob], "prague-cinema-35mm.jpg", { type: "image/jpeg" });
                              await api.uploadAssetFile(file, playheadRef.current, true);
                              flash("Loaded Prague 35mm Cinema plate onto timeline!");
                            })
                          }
                        >
                          + Cinema Scene
                        </button>
                        <button
                          type="button"
                          style={{ padding: "3px 8px", fontSize: 11 }}
                          onClick={() =>
                            void act(async () => {
                              const resp = await fetch("/showcase/motion-neon.jpg");
                              const blob = await resp.blob();
                              const file = new File([blob], "neon-hypercar-shot.jpg", { type: "image/jpeg" });
                              await api.uploadAssetFile(file, playheadRef.current, true);
                              flash("Loaded Neon Hypercar shot onto timeline!");
                            })
                          }
                        >
                          + Neon Action
                        </button>
                        <button
                          type="button"
                          style={{ padding: "3px 8px", fontSize: 11 }}
                          onClick={() => setShowShowcaseModal(true)}
                        >
                          ✨ Gallery
                        </button>
                      </div>
                    </div>

                    <MemoMediaPool
                      project={project}
                      projectId={project.id}
                      playhead={quantizedStopTime}
                      onImported={(msg) => {
                        void refresh();
                        if (msg) flash(msg);
                      }}
                      onQuickAdd={handleQuickAddAsset}
                    />
                  </>
                ) : activeTab === "effects" ? (
                  <StudioCatalogBrowser
                    title="Cinema 3D LUTs & Video Effects"
                    query=""
                    items={catalogItems.filter((i) => i.section === "effects")}
                    matchingAssets={[]}
                    matchingPacks={[]}
                    onQuickAddAsset={handleQuickAddAsset}
                    onApplyTemplate={() => {}}
                  />
                ) : activeTab === "transitions" ? (
                  <StudioCatalogBrowser
                    title="Transitions, Motion, Speed & Layouts"
                    query=""
                    items={catalogItems.filter((i) => i.section === "transitions")}
                    matchingAssets={[]}
                    matchingPacks={[]}
                    onQuickAddAsset={handleQuickAddAsset}
                    onApplyTemplate={() => {}}
                  />
                ) : activeTab === "text" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <h2>Text, Captions &amp; Lower-Thirds</h2>
                    <div className="studio-card-grid">
                      <button
                        type="button"
                        className="studio-card"
                        onClick={() =>
                          void act(
                            () =>
                              api.addCaption({
                                text: `Subtitle @ ${fmt(playheadRef.current)}`,
                                start: playheadRef.current,
                                end: playheadRef.current + 2.5,
                              }),
                            "Subtitle added at playhead",
                          )
                        }
                      >
                        <div className="studio-card-thumb" style={{ background: "linear-gradient(135deg, #0284c7, #38bdf8)" }}>
                          <span className="studio-card-badge">SUBTITLE</span>
                          <span className="studio-card-plus">+</span>
                        </div>
                        <div className="studio-card-title">Default Caption</div>
                        <div className="studio-card-sub">Add 2.5s subtitle @ playhead</div>
                      </button>

                      <button
                        type="button"
                        className="studio-card"
                        onClick={() =>
                          void act(
                            () =>
                              api.addGraphic({
                                kind: "lower-third-card",
                                label: "Vedit Studio",
                                start: playheadRef.current,
                                duration: 3.5,
                                animationPreset: "fade-in",
                              }),
                            "Lower-third title added",
                          )
                        }
                      >
                        <div className="studio-card-thumb" style={{ background: "linear-gradient(135deg, #7c3aed, #ec4899)" }}>
                          <span className="studio-card-badge">TITLE</span>
                          <span className="studio-card-plus">+</span>
                        </div>
                        <div className="studio-card-title">Lower Third Bar</div>
                        <div className="studio-card-sub">Clean broadcast nameplate</div>
                      </button>

                      <button
                        type="button"
                        className="studio-card"
                        onClick={() =>
                          void act(
                            () =>
                              api.addGraphic({
                                kind: "callout-arrow",
                                label: "Key Highlight",
                                start: playheadRef.current,
                                duration: 3,
                                animationPreset: "zoom-in",
                              }),
                            "Callout badge added",
                          )
                        }
                      >
                        <div className="studio-card-thumb" style={{ background: "linear-gradient(135deg, #ea580c, #facc15)" }}>
                          <span className="studio-card-badge">CALLOUT</span>
                          <span className="studio-card-plus">+</span>
                        </div>
                        <div className="studio-card-title">Pop Callout Badge</div>
                        <div className="studio-card-sub">Animated pointer badge</div>
                      </button>
                    </div>

                    <h3>Active Captions ({seq.captions.length})</h3>
                    {seq.captions.length === 0 ? (
                      <div className="muted">No captions yet — click Default Caption above or auto-transcribe in Audio.</div>
                    ) : (
                      <ul className="caption-list" style={{ maxHeight: 260 }}>
                        {seq.captions.map((c) => (
                          <li key={c.id} className="asset" style={{ cursor: "pointer" }} onClick={() => setPlayhead(c.start)}>
                            <span className="muted">
                              {fmt(c.start)}–{fmt(c.end)}
                            </span>
                            <span className="asset-name">{c.text}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : activeTab === "audio" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div
                      className="hero-showcase-banner"
                      style={{
                        backgroundImage:
                          "linear-gradient(125deg, rgba(11,13,17,0.9), rgba(11,13,17,0.52)), url('/showcase/audio-wave.jpg')",
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>
                        🎙 Broadcast Voiceover, Whisper STT &amp; Audio DSP
                      </div>
                      <div className="muted" style={{ fontSize: 11, color: "#cbd5e1", marginTop: 2 }}>
                        Generate studio TTS narration, auto-transcribe subtitles, enhance vocals &amp; beat-sync cuts.
                      </div>
                    </div>
                    <MemoAiPanel
                      caps={aiCaps}
                      assets={project.assets}
                      busy={busy}
                      onVoiceover={(script, voice) =>
                        act(async () => {
                          const res = await api.voiceover(script, voice, playheadRef.current);
                          flash(`Voiceover job ${res.jobId.slice(0, 8)}… queued`);
                        })
                      }
                      onTranscribe={(assetId) =>
                        act(async () => {
                          const res = await api.transcribe(assetId);
                          flash(`Auto-captions job ${res.jobId.slice(0, 8)}…`);
                        })
                      }
                      selectedClipId={clipId}
                      onAiEdit={(action, params) =>
                        act(async () => {
                          if (action === "beat-sync") {
                            const res = await api.beatSync(params.clipId!, params.musicAssetId!);
                            flash(`Beat-sync: ${res.splits.length} cuts`);
                          } else if (action === "remove-silences") {
                            const res = await api.removeSilences(params.clipId);
                            flash(`Removed ${res.savedDuration.toFixed(2)}s dead air`);
                          }
                        })
                      }
                    />
                  </div>
                ) : activeTab === "ai" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <h2 style={{ margin: 0 }}>AI Studio Copilot</h2>
                      <button type="button" onClick={() => setShowApiModal(true)} style={{ fontSize: 11, padding: "3px 8px" }}>
                        ⚙ {apiSettings?.hasApiKey ? apiSettings.model.split("/").pop() : "Set API & Model"}
                      </button>
                    </div>
                    <textarea
                      rows={3}
                      value={copilotPrompt}
                      onChange={(e) => setCopilotPrompt(e.target.value)}
                      placeholder='Describe your edit in English or Czech — e.g. "Dej filmový Kodak LUT, přidej titulek Vítejte a ztiš hudbu pod hlasem"'
                      style={{
                        width: "100%",
                        background: "var(--panel-2)",
                        color: "var(--text)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: 8,
                        fontSize: 12,
                        fontFamily: "inherit",
                      }}
                    />
                    <button
                      type="button"
                      className="btn-accent"
                      disabled={busy || !copilotPrompt.trim()}
                      onClick={() =>
                        act(async () => {
                          const res = await api.runCopilot(copilotPrompt);
                          flash(res.summary);
                        })
                      }
                    >
                      🤖 Run AI Copilot Edit (Auto Checkpoint)
                    </button>

                    <h3>1-Click Smart Actions</h3>
                    <div className="studio-card-grid">
                      <button
                        type="button"
                        className="studio-card"
                        onClick={() =>
                          act(async () => {
                            const res = await api.removeSilences(clipId ?? undefined);
                            flash(`Removed ${res.savedDuration.toFixed(2)}s of silence`);
                          })
                        }
                      >
                        <div className="studio-card-thumb" style={{ background: "linear-gradient(135deg, #0ea5e9, #2563eb)" }}>
                          <span className="studio-card-badge">SMART CUT</span>
                          <span className="studio-card-plus">⚡</span>
                        </div>
                        <div className="studio-card-title">Remove Silences</div>
                        <div className="studio-card-sub">Strip dead air automatically</div>
                      </button>

                      <button
                        type="button"
                        className="studio-card"
                        onClick={() =>
                          act(async () => {
                            const res = await api.highlight(15);
                            flash(`Built ${res.totalDuration.toFixed(1)}s highlight reel`);
                          })
                        }
                      >
                        <div className="studio-card-thumb" style={{ background: "linear-gradient(135deg, #7c3aed, #db2777)" }}>
                          <span className="studio-card-badge">HIGHLIGHT</span>
                          <span className="studio-card-plus">⚡</span>
                        </div>
                        <div className="studio-card-title">15s Highlight Reel</div>
                        <div className="studio-card-sub">Best high-energy moments</div>
                      </button>

                      <button
                        type="button"
                        className="studio-card"
                        onClick={() =>
                          act(async () => {
                            const res = await api.syncMulticam(2.5);
                            flash(`Synced ${res.angles.length} camera angles`);
                          })
                        }
                      >
                        <div className="studio-card-thumb" style={{ background: "linear-gradient(135deg, #0d9488, #16a34a)" }}>
                          <span className="studio-card-badge">MULTICAM</span>
                          <span className="studio-card-plus">🎥</span>
                        </div>
                        <div className="studio-card-title">Auto Multicam Sync</div>
                        <div className="studio-card-sub">Audio cross-correlation cuts</div>
                      </button>

                      <button
                        type="button"
                        className="studio-card"
                        onClick={() => {
                          const cid = resolveTargetClipId();
                          if (!cid) return flash("Select a clip first");
                          void act(async () => {
                            const res = await api.autoReframe(cid);
                            flash(`Auto-reframed (${res.keyframes} keyframes)`);
                          });
                        }}
                      >
                        <div className="studio-card-thumb" style={{ background: "linear-gradient(135deg, #d97706, #ef4444)" }}>
                          <span className="studio-card-badge">9:16 REELS</span>
                          <span className="studio-card-plus">📱</span>
                        </div>
                        <div className="studio-card-title">Smart Reframe</div>
                        <div className="studio-card-sub">Track subject into vertical crop</div>
                      </button>
                    </div>

                    <MemoJobsPanel project={project} />
                  </div>
                ) : activeTab === "gen" ? (
                  <MemoGenPanel
                    providers={genProviders}
                    cameraMoves={cameraMoves}
                    selectedClipId={clipId}
                    busy={busy}
                    onGenerate={(req) =>
                      act(async () => {
                        const res = await api.generateMedia(req);
                        flash(`AI Gen (${req.kind}) job ${res.jobId.slice(0, 8)}…`);
                      })
                    }
                  />
                ) : (
                  <MemoStudioPanel
                    packs={packs}
                    project={project}
                    playhead={quantizedStopTime}
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
                            start: playheadRef.current,
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
                )}
              </div>
            </aside>

            {/* Draggable Vertical Splitter #1 (Left Browser ↔ Center Monitor) */}
            <div
              className={`splitter-v ${draggingSplitter === "left" ? "dragging" : ""}`}
              title="Drag to resize left browser panel (double-click to reset)"
              onPointerDown={(e) => startSplitterDrag("left", e)}
              onDoubleClick={() => setLeftWidth(320)}
            />
          </>
        )}

        {/* 3. Center Real-Time Video Player Stage */}
        <div className="center-stage-col">
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
        </div>

        {/* 4. Draggable Vertical Splitter #2 + Right Vedit Studio Property Inspector */}
        {!rightCollapsed && (
          <>
            <div
              className={`splitter-v ${draggingSplitter === "right" ? "dragging" : ""}`}
              title="Drag to resize right Inspector panel (double-click to reset)"
              onPointerDown={(e) => startSplitterDrag("right", e)}
              onDoubleClick={() => setRightWidth(315)}
            />
            <aside className="right-drawer" style={{ width: rightWidth }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 10px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: "var(--muted)",
                }}
              >
                <span>🎛 CLIP INSPECTOR</span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setRightCollapsed(true)}
                  title="Close Inspector"
                >
                  ✕
                </button>
              </div>
              <div className="drawer-scroll">
                <MemoInspector
                  clip={selected?.clip ?? activeClip}
                  asset={selectedAsset ?? activeClipAsset}
                  playhead={quantizedStopTime}
                  captions={seq.captions}
                  onProAction={(action, payload) => {
                    const targetId = clipId ?? activeClip?.id;
                    if (!targetId) return;
                    switch (action) {
                      case "speed":
                        void act(
                          () => api.setClipSpeed(targetId, Number(payload?.speed ?? 1)),
                          `Speed set to ${payload?.speed}×`,
                        );
                        break;
                      case "reverse":
                        void act(() => api.reverseClip(targetId), "Clip reversed");
                        break;
                      case "freeze":
                        void act(() => api.freezeClip(targetId, playheadRef.current, 1.5), "1.5s freeze-frame added");
                        break;
                      case "color-grade":
                        void act(
                          () => api.colorGrade(targetId, String(payload?.preset ?? "cinematic-contrast")),
                          `Grade "${payload?.preset}" applied`,
                        );
                        break;
                      case "chroma-key":
                        void act(
                          () => api.chromaKey(targetId, String(payload?.color ?? "#00ff00")),
                          `Chroma key applied`,
                        );
                        break;
                      case "fade":
                        void act(
                          () => api.fadeClip(targetId, Number(payload?.fadeIn ?? 0.5), Number(payload?.fadeOut ?? 0.5)),
                          "Fade transition applied",
                        );
                        break;
                      case "lut3d":
                        void act(
                          () => api.applyLut(targetId, String(payload?.lutId ?? "kodak-2383")),
                          `3D LUT "${payload?.lutId}" applied`,
                        );
                        break;
                      case "stabilize":
                        void act(async () => {
                          const res = await api.stabilizeClip(targetId);
                          flash(`Stabilized (${res.method})`);
                        });
                        break;
                      case "layout":
                        void act(
                          () => api.applyLayout(targetId, String(payload?.layout ?? "pip-bottom-right")),
                          `Layout "${payload?.layout}" applied`,
                        );
                        break;
                      case "enhance-audio":
                        void act(() => api.enhanceAudio(targetId), "Voice DSP enhanced");
                        break;
                      case "duck-audio":
                        void act(async () => {
                          const res = await api.duckAudio(targetId);
                          flash(`Music auto-ducked (${res.speechIntervals.length} segments)`);
                        });
                        break;
                      case "remove-effect":
                        void act(() => api.removeEffect(targetId, String(payload?.effectId ?? "")), "Effect removed");
                        break;
                    }
                  }}
                  onPatch={(patch) => {
                    const targetId = clipId ?? activeClip?.id;
                    if (!targetId) return;
                    const nested: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(patch)) {
                      if (key.startsWith("transform.")) {
                        nested.transform ??= {};
                        (nested.transform as Record<string, unknown>)[key.slice("transform.".length)] = value;
                      } else {
                        nested[key] = value;
                      }
                    }
                    void act(() => api.updateClip(targetId, nested), "Clip updated");
                  }}
                />
              </div>
            </aside>
          </>
        )}
      </div>

      {/* Draggable Horizontal Splitter #3 (Upper Studio ↔ Multi-Track Timeline) */}
      <div
        className={`splitter-h ${draggingSplitter === "bottom" ? "dragging" : ""}`}
        title="Drag up/down to resize Timeline height (double-click to reset)"
        onPointerDown={(e) => startSplitterDrag("bottom", e)}
        onDoubleClick={() => setTimelineHeight(255)}
      />

      {/* ==================== Vedit Studio MULTI-TRACK TIMELINE ==================== */}
      <Timeline
        heightPx={timelineHeight}
        project={project}
        selection={selection}
        onSelect={(trackId, id) => setSelection({ trackId, clipId: id })}
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
        onSplitAtPlayhead={() => {
          const cid = resolveTargetClipId();
          if (cid) void act(() => api.splitClip(cid, playheadRef.current), `Split @ ${fmt(playheadRef.current)}`);
        }}
        onDeleteSelected={() => {
          if (clipId) void act(() => api.deleteClip(clipId), "Clip deleted");
        }}
        onRippleDeleteSelected={() => {
          if (clipId) void act(() => api.deleteClip(clipId, true), "Ripple deleted");
        }}
        onAddCaptionAtPlayhead={() =>
          void act(
            () =>
              api.addCaption({
                text: `Caption @ ${fmt(playheadRef.current)}`,
                start: playheadRef.current,
                end: playheadRef.current + 2.5,
              }),
            "Caption added",
          )
        }
        onDropOnTrack={(trackId, start, files, assetId) => {
          if (assetId) {
            const asset = project.assets.find((a) => a.id === assetId);
            const dur = Math.max(0.5, asset?.duration ?? 5);
            void act(
              async () => {
                const res = await api.addClip({ trackId, assetId, start, duration: dur, in: 0, out: dur });
                setSelection({ trackId, clipId: res.clip.id });
              },
              `Placed "${asset?.name ?? "clip"}" at ${fmt(start)}`,
            );
            return;
          }
          if (files && files.length > 0) {
            void act(async () => {
              let cursor = start;
              for (const file of Array.from(files)) {
                const res = await api.uploadAssetFile(file, cursor, true, trackId);
                if (res.clip) setSelection({ trackId, clipId: res.clip.id });
                cursor += res.asset.duration ?? 5;
              }
              flash(`Dropped ${files.length} file${files.length > 1 ? "s" : ""} at ${fmt(start)}`);
            });
          }
        }}
      />

      {/* Custom API Key, Base URL & Model Picker Modal */}
      {showApiModal && (
        <ApiSettingsModal
          initial={apiSettings}
          onClose={() => setShowApiModal(false)}
          onSaved={(next, msg) => {
            setApiSettings(next);
            flash(msg);
            void api
              .genProviders()
              .then((r) => {
                setGenProviders(r.providers);
                setCameraMoves(r.cameraMoves);
              })
              .catch(() => {});
          }}
        />
      )}

      {/* Export & Delivery Modal */}
      {showExportModal && (
        <ExportModal
          project={project}
          exportPresets={exportPresets}
          exportPresetId={exportPresetId}
          setExportPresetId={setExportPresetId}
          hwAccel={hwAccel}
          setHwAccel={setHwAccel}
          loudnessLufs={loudnessLufs}
          setLoudnessLufs={setLoudnessLufs}
          busy={busy}
          onExport={() =>
            void act(async () => {
              const lufs = loudnessLufs === "off" ? undefined : Number(loudnessLufs);
              const res = await api.exportRender(exportPresetId, hwAccel, lufs);
              flash(`Export started (${exportPresetId}, ${hwAccel}) — job ${res.jobId.slice(0, 8)}…`);
            })
          }
          onBatchExport={() =>
            void act(async () => {
              const res = await api.batchExport(["youtube-1080p", "tiktok-reels", "webm-vp9"]);
              flash(`Batch export queued (${res.jobIds.length} targets)`);
            })
          }
          onThumbnail={() =>
            void act(async () => {
              const res = await api.exportThumbnail();
              flash(`Thumbnail saved → ${res.outPath.split(/[\\/]/).pop()}`);
              window.open(withToken(`/api/v1/projects/${project.id}/thumbnail/image`), "_blank");
            })
          }
          onClose={() => setShowExportModal(false)}
        />
      )}

      {/* Interactive Studio Visual Showcase Modal */}
      {showShowcaseModal && (
        <ShowcaseModal
          onClose={() => setShowShowcaseModal(false)}
          onOpenApi={() => setShowApiModal(true)}
          onLoadDemoScene={(scene) => {
            void act(async () => {
              const imgPath =
                scene === "action"
                  ? "/showcase/motion-neon.jpg"
                  : scene === "podcast"
                    ? "/showcase/audio-wave.jpg"
                    : "/showcase/hero-cinema.jpg";
              const name =
                scene === "action"
                  ? "neon-hypercar-scene.jpg"
                  : scene === "podcast"
                    ? "studio-broadcast-stage.jpg"
                    : "prague-cinema-twilight.jpg";
              const resp = await fetch(imgPath);
              const blob = await resp.blob();
              const file = new File([blob], name, { type: "image/jpeg" });
              const uploaded = await api.uploadAssetFile(file, 0, true);
              if (uploaded.clip) {
                if (scene === "cinema") {
                  await api.applyLut(uploaded.clip.id, "kodak-2383");
                  await api.addCaption({ text: "Vedit Studio • Kodak 2383 Cinema Grade", start: 0, end: 4 });
                } else if (scene === "action") {
                  await api.applyLut(uploaded.clip.id, "cyberpunk-neon");
                  await api.fadeClip(uploaded.clip.id, 0.5, 0.5);
                  await api.addCaption({ text: "Cyberpunk Neon VFX • 60 FPS Timeline", start: 0, end: 4 });
                } else {
                  await api.addCaption({ text: "Broadcast Voice & Auto-Captions Ready", start: 0, end: 4 });
                }
              }
              setPlayhead(0.8);
              flash(`Loaded "${name}" demo scene onto timeline!`);
            });
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
