import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeSequence,
  withToken,
  type Asset,
  type Caption,
  type Clip,
  type Project,
  type Track,
} from "./api";
import {
  analyzeCanvasScopes,
  extractMediaFilmstrip,
  getClipFadeEnvelope,
  getClipSpeed,
  getClipTransition,
  getClipVolumeGain,
  getSequenceDuration,
  isClipReversed,
  renderSequenceFrame,
} from "./compositor";

type LiveScopeData = ReturnType<typeof analyzeCanvasScopes>;
import {
  IconFullscreen,
  IconImport,
  IconMagnet,
  IconMute,
  IconPause,
  IconPlay,
  IconPlus,
  IconScissors,
  IconScopes,
  IconStepBack,
  IconStepFwd,
  IconTrash,
  IconVolume,
  IconZoomIn,
  IconZoomOut,
} from "./Icons";

export function formatTimecode(seconds: number): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// ==================== LIVE HARDWARE COMPOSITOR STAGE ====================

export const CompositorStage = memo(function CompositorStage({
  project,
  playhead,
  playing,
  muted,
  selectedCaptionId,
  onPlayhead,
  onPlaying,
  onToggleMute,
  onSelectCaption,
  onMoveCaptionPosition,
  onImportRequest,
  onQuickSplit,
}: {
  project: Project;
  playhead: number;
  playing: boolean;
  muted: boolean;
  selectedCaptionId: string | null;
  onPlayhead: (t: number) => void;
  onPlaying: (playing: boolean) => void;
  onToggleMute: () => void;
  onSelectCaption: (captionId: string | null) => void;
  onMoveCaptionPosition: (captionId: string, normX: number, normY: number) => void;
  onImportRequest: () => void;
  onQuickSplit?: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaElsRef = useRef<Map<string, HTMLVideoElement | HTMLImageElement>>(new Map());
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const captionBoxesRef = useRef<Array<{ id: string; boxX: number; boxY: number; boxW: number; boxH: number }>>([]);

  const [stageBox, setStageBox] = useState<{ w: number; h: number }>({ w: 640, h: 360 });
  const [splitComparePct, setSplitComparePct] = useState<number | undefined>(undefined);
  const [showScopes, setShowScopes] = useState(false);
  const [liveScopes, setLiveScopes] = useState<LiveScopeData | null>(null);
  const [, setMediaReadyTick] = useState(0);

  const seq = useMemo(() => activeSequence(project), [project]);
  const duration = useMemo(() => getSequenceDuration(seq), [seq]);
  const seqWidth = Math.max(240, seq.width || 1920);
  const seqHeight = Math.max(240, seq.height || 1080);

  const hasAnyTimelineContent = useMemo(
    () => seq.tracks.some((tr) => tr.clips.length > 0) || seq.captions.length > 0,
    [seq.tracks, seq.captions],
  );

  // Measure available stage container size and fit exact aspect ratio canvas cleanly inside
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const computeFit = () => {
      const rect = el.getBoundingClientRect();
      const pad = 16;
      const availW = Math.max(120, rect.width - pad);
      const availH = Math.max(120, rect.height - pad);
      const targetAspect = seqWidth / seqHeight;
      let fitW = availW;
      let fitH = fitW / targetAspect;
      if (fitH > availH) {
        fitH = availH;
        fitW = fitH * targetAspect;
      }
      setStageBox({ w: Math.round(fitW), h: Math.round(fitH) });
    };
    computeFit();
    const ro = new ResizeObserver(computeFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [seqWidth, seqHeight]);

  // Keep offscreen HTMLVideoElement / HTMLImageElement / HTMLAudioElement pool warm for all project assets
  useEffect(() => {
    const validIds = new Set(project.assets.map((m) => m.id));
    for (const [key, el] of mediaElsRef.current.entries()) {
      if (!validIds.has(key)) {
        if (el instanceof HTMLVideoElement) {
          el.pause();
          el.removeAttribute("src");
          el.load();
        }
        mediaElsRef.current.delete(key);
      }
    }
    for (const [clipKey, audioEl] of audioElsRef.current.entries()) {
      const stillExists = seq.tracks.some((tr) => tr.clips.some((c) => c.id === clipKey));
      if (!stillExists) {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioElsRef.current.delete(clipKey);
      }
    }

    for (const item of project.assets) {
      const url = withToken(`/api/v1/projects/${project.id}/assets/${item.id}/file`);
      if (item.kind === "video") {
        let vid = mediaElsRef.current.get(item.id);
        if (!(vid instanceof HTMLVideoElement)) {
          vid = document.createElement("video");
          vid.playsInline = true;
          vid.preload = "auto";
          if (/^https?:/i.test(url)) vid.crossOrigin = "anonymous";
          const bump = () => setMediaReadyTick((n) => n + 1);
          vid.addEventListener("loadeddata", bump);
          vid.addEventListener("seeked", bump);
          vid.src = url;
          mediaElsRef.current.set(item.id, vid);
        } else if (vid.src !== url && !vid.src.endsWith(url)) {
          vid.src = url;
        }
      } else if (item.kind === "image" || item.kind === "generated") {
        let img = mediaElsRef.current.get(item.id);
        if (!(img instanceof HTMLImageElement)) {
          img = new Image();
          if (/^https?:/i.test(url)) img.crossOrigin = "anonymous";
          img.onload = () => setMediaReadyTick((n) => n + 1);
          img.src = url;
          mediaElsRef.current.set(item.id, img);
        }
      }
    }
  }, [project.id, project.assets, seq.tracks]);

  // Synchronize video & audio elements to playhead, speed, volume, fades, and play/pause state
  useEffect(() => {
    const assetMap = new Map<string, Asset>(project.assets.map((m) => [m.id, m]));

    for (const track of seq.tracks) {
      for (const clip of track.clips) {
        const item = assetMap.get(clip.assetId);
        if (!item) continue;
        const speed = getClipSpeed(clip);
        const reversed = isClipReversed(clip);
        const active = playhead >= clip.start && playhead < clip.start + clip.duration - 0.005;
        const localTime = Math.max(0, playhead - clip.start);
        const localOffset = localTime * speed;
        const srcDur = Math.max(clip.duration * speed, item.duration || 0);
        const mediaTime = reversed
          ? Math.max(0, clip.in + clip.duration * speed - localOffset)
          : Math.min(Math.max(0, srcDur - 0.01), clip.in + Math.max(0, localOffset));

        const env = getClipFadeEnvelope(clip, localTime);
        const gain = muted ? 0 : Math.max(0, Math.min(1, getClipVolumeGain(clip, track) * env));

        if (track.kind !== "audio" && item.kind === "video") {
          const vid = mediaElsRef.current.get(item.id);
          if (vid instanceof HTMLVideoElement) {
            vid.muted = gain <= 0.001 || reversed;
            vid.volume = gain;
            const safeRate = Math.max(0.25, Math.min(4, speed));
            if (Math.abs(vid.playbackRate - safeRate) > 0.01) vid.playbackRate = safeRate;

            if (active) {
              const drift = Math.abs((vid.currentTime || 0) - mediaTime);
              if (drift > (playing && !reversed ? 0.22 : 0.045)) {
                try {
                  vid.currentTime = mediaTime;
                } catch {
                  // Ignore pre-metadata seek error
                }
              }
              if (playing && !reversed) {
                if (vid.paused) vid.play().catch(() => undefined);
              } else if (!vid.paused) {
                vid.pause();
              }
            } else if (!vid.paused) {
              vid.pause();
            }
          }
        } else if (track.kind === "audio" && (item.kind === "audio" || item.kind === "video")) {
          let aud = audioElsRef.current.get(clip.id);
          if (!aud) {
            aud = new Audio();
            aud.preload = "auto";
            aud.src = withToken(`/api/v1/projects/${project.id}/assets/${item.id}/file`);
            audioElsRef.current.set(clip.id, aud);
          }
          aud.muted = gain <= 0.001;
          aud.volume = gain;
          const safeRate = Math.max(0.25, Math.min(4, speed));
          if (Math.abs(aud.playbackRate - safeRate) > 0.01) aud.playbackRate = safeRate;

          if (active && playing && !reversed) {
            if (Math.abs((aud.currentTime || 0) - mediaTime) > 0.25) {
              try {
                aud.currentTime = mediaTime;
              } catch {
                // Ignore
              }
            }
            if (aud.paused) aud.play().catch(() => undefined);
          } else if (!aud.paused) {
            aud.pause();
          }
        }
      }
    }
  }, [project.id, project.assets, seq, playhead, playing, muted]);

  // Pause all media cleanly on unmount
  useEffect(() => {
    return () => {
      for (const el of mediaElsRef.current.values()) {
        if (el instanceof HTMLVideoElement) el.pause();
      }
      for (const aud of audioElsRef.current.values()) {
        aud.pause();
      }
    };
  }, []);

  // Master 60 FPS playback clock
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      const next = playheadRef.current + dt;
      if (next >= duration) {
        onPlayhead(0);
        onPlaying(false);
        return;
      }
      onPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, onPlayhead, onPlaying]);

  // Draw composite frame whenever playhead, project, stage size, or media readiness updates
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetW = Math.max(240, Math.round(stageBox.w * dpr));
    const targetH = Math.max(240, Math.round(stageBox.h * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const bgSetting = seq.background ?? "blur";
    const backdropMode: "black" | "blur" | "dark" | "white" =
      bgSetting === "#000000" || bgSetting === "black"
        ? "black"
        : bgSetting === "#ffffff" || bgSetting === "white"
          ? "white"
          : bgSetting === "#18181b" || bgSetting === "dark"
            ? "dark"
            : "blur";

    captionBoxesRef.current = renderSequenceFrame(ctx, {
      project,
      sequence: seq,
      time: playhead,
      mediaElements: mediaElsRef.current,
      splitComparePct,
      backdropMode,
    });

    if (showScopes) {
      try {
        setLiveScopes(analyzeCanvasScopes(canvas, playhead));
      } catch {
        // Ignore cross-origin canvas read if external stream
      }
    }
  });

  // Direct touch / pointer manipulation on the preview canvas (drag titles & drag split-compare bar)
  const dragStateRef = useRef<
    | { mode: "split" }
    | { mode: "caption"; captionId: string; startX: number; startY: number; origX: number; origY: number }
    | null
  >(null);

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const relY = (e.clientY - rect.top) / Math.max(1, rect.height);

    // Check before/after split wipe handle first
    if (splitComparePct !== undefined && Math.abs(relX * 100 - splitComparePct) < 6) {
      dragStateRef.current = { mode: "split" };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    // Hit-test exact rendered caption bounding boxes in canvas pixel space
    const px = relX * canvas.width;
    const py = relY * canvas.height;
    for (let i = captionBoxesRef.current.length - 1; i >= 0; i--) {
      const b = captionBoxesRef.current[i]!;
      if (px >= b.boxX - 16 && px <= b.boxX + b.boxW + 16 && py >= b.boxY - 16 && py <= b.boxY + b.boxH + 16) {
        const cap = seq.captions.find((c) => c.id === b.id);
        const st = (cap?.style ?? {}) as Record<string, unknown>;
        const cx = typeof st.x === "number" ? st.x : 0.5;
        const cy = typeof st.y === "number" ? st.y : 0.85;
        onSelectCaption(b.id);
        dragStateRef.current = {
          mode: "caption",
          captionId: b.id,
          startX: relX,
          startY: relY,
          origX: cx,
          origY: cy,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = dragStateRef.current;
    const canvas = canvasRef.current;
    if (!st || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const relY = (e.clientY - rect.top) / Math.max(1, rect.height);

    if (st.mode === "split") {
      setSplitComparePct(Math.max(5, Math.min(95, Math.round(relX * 100))));
    } else if (st.mode === "caption") {
      const nextX = Number(Math.max(0.08, Math.min(0.92, st.origX + (relX - st.startX))).toFixed(3));
      const nextY = Number(Math.max(0.08, Math.min(0.92, st.origY + (relY - st.startY))).toFixed(3));
      onMoveCaptionPosition(st.captionId, nextX, nextY);
    }
  };

  const handleCanvasPointerUp = () => {
    dragStateRef.current = null;
  };

  return (
    <div className="player-container">
      <div ref={viewportRef} className="stage-viewport">
        <div className="stage-canvas-wrap" style={{ width: stageBox.w, height: stageBox.h }}>
          <canvas
            ref={canvasRef}
            className="stage-canvas"
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerUp}
            onDoubleClick={() => onPlaying(!playing)}
          />

          {/* Clean empty-state prompt right on canvas when project has no clips yet */}
          {!hasAnyTimelineContent && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                background: "rgba(9, 9, 11, 0.72)",
              }}
            >
              <button type="button" className="btn-primary" onClick={onImportRequest} style={{ padding: "9px 16px" }}>
                <IconImport size={16} /> Import Video or Photo
              </button>
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                MP4 · MOV · WebM · JPG · PNG · MP3 · WAV
              </span>
            </div>
          )}

          {/* Selected caption selection indicator */}
          {selectedCaptionId &&
            (() => {
              const cap = seq.captions.find(
                (c) => c.id === selectedCaptionId && playhead >= c.start && playhead <= c.end,
              );
              if (!cap) return null;
              const st = (cap.style ?? {}) as Record<string, unknown>;
              const xPct = (typeof st.x === "number" ? st.x : 0.5) * 100;
              const yPct = (typeof st.y === "number" ? st.y : 0.85) * 100;
              return (
                <div
                  style={{
                    position: "absolute",
                    left: `${xPct}%`,
                    top: `${yPct}%`,
                    transform: "translate(-50%, -50%)",
                    padding: "10px 34px",
                    border: "1.5px dashed #60a5fa",
                    borderRadius: 6,
                    pointerEvents: "none",
                  }}
                />
              );
            })()}
        </div>

        {/* Clean floating monitor controls */}
        <div className="stage-overlay-bar">
          <button
            type="button"
            className={`stage-pill ${splitComparePct !== undefined ? "active" : ""}`}
            onClick={() => setSplitComparePct((prev) => (prev === undefined ? 50 : undefined))}
            title="Before / After Color Split Wipe"
          >
            Split
          </button>
          <button
            type="button"
            className={`stage-pill ${showScopes ? "active" : ""}`}
            onClick={() => setShowScopes((s) => !s)}
            title="Live RGB & Luma Scopes"
          >
            <IconScopes size={13} /> Scopes
          </button>
          <button
            type="button"
            className="stage-pill"
            onClick={() => {
              const el = viewportRef.current;
              if (!el) return;
              if (document.fullscreenElement) void document.exitFullscreen();
              else void el.requestFullscreen?.();
            }}
            title="Fullscreen Preview"
          >
            <IconFullscreen size={13} />
          </button>
        </div>

        {/* Real Live Pixel Histogram & IRE Scope Overlay */}
        {showScopes && liveScopes && (
          <div
            style={{
              position: "absolute",
              left: 10,
              top: 10,
              width: 196,
              padding: 8,
              borderRadius: 8,
              background: "rgba(9, 9, 11, 0.88)",
              backdropFilter: "blur(8px)",
              border: "1px solid var(--border-strong)",
              pointerEvents: "none",
              zIndex: 6,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginBottom: 4 }}>
              <span>RGB PARADE / LUMA</span>
              <span className="mono">{liveScopes.metrics.avgLumaIre.toFixed(0)} IRE</span>
            </div>
            <svg viewBox="0 0 32 36" style={{ width: "100%", height: 52, display: "block" }}>
              {liveScopes.lumaHistogram.map((v: number, idx: number) => (
                <g key={idx}>
                  <line x1={idx} y1={36} x2={idx} y2={36 - Math.min(35, (liveScopes.redHistogram[idx] ?? 0) * 0.35)} stroke="rgba(239,68,68,0.6)" strokeWidth="0.9" />
                  <line x1={idx} y1={36} x2={idx} y2={36 - Math.min(35, (liveScopes.greenHistogram[idx] ?? 0) * 0.35)} stroke="rgba(34,197,94,0.6)" strokeWidth="0.9" />
                  <line x1={idx} y1={36} x2={idx} y2={36 - Math.min(35, (liveScopes.blueHistogram[idx] ?? 0) * 0.35)} stroke="rgba(59,130,246,0.6)" strokeWidth="0.9" />
                  <circle cx={idx} cy={36 - Math.min(35, v * 0.35)} r="0.55" fill="#fafafa" />
                </g>
              ))}
            </svg>
          </div>
        )}
      </div>

      {/* Tactile Transport Bar */}
      <div className="transport-bar">
        <div className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)", minWidth: 108 }}>
          <span style={{ color: "var(--text)", fontWeight: 600 }}>{formatTimecode(playhead)}</span>
          {" / "}
          <span>{formatTimecode(duration)}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              onPlaying(false);
              onPlayhead(Math.max(0, playhead - 1 / Math.max(24, seq.fps || 30)));
            }}
            title="Previous Frame"
          >
            <IconStepBack size={15} />
          </button>

          <button
            type="button"
            className="play-btn"
            onClick={() => onPlaying(!playing)}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
          </button>

          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              onPlaying(false);
              onPlayhead(Math.min(duration, playhead + 1 / Math.max(24, seq.fps || 30)));
            }}
            title="Next Frame"
          >
            <IconStepFwd size={15} />
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {onQuickSplit && (
            <button
              type="button"
              className="btn-ghost"
              onClick={onQuickSplit}
              title="Split clip at playhead"
              style={{ padding: "5px 8px", fontSize: 11.5 }}
            >
              <IconScissors size={14} /> Split
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleMute}
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? <IconMute size={15} /> : <IconVolume size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
});

// ==================== REAL MULTI-TRACK FILMSTRIP & WAVEFORM TIMELINE ====================

export const StudioTimeline = memo(function StudioTimeline({
  project,
  playhead,
  pxPerSec,
  snapEnabled,
  selectedClipId,
  selectedCaptionId,
  onPlayhead,
  onSelectClip,
  onSelectCaption,
  onZoomChange,
  onToggleSnap,
  onMoveClip,
  onTrimClip,
  onUpdateCaptionTiming,
  onToggleTrackMute,
  onDeleteSelected,
  onSplitAtPlayhead,
  onImportMedia,
  onAddTrack,
}: {
  project: Project;
  playhead: number;
  pxPerSec: number;
  snapEnabled: boolean;
  selectedClipId: string | null;
  selectedCaptionId: string | null;
  onPlayhead: (t: number) => void;
  onSelectClip: (clipId: string | null) => void;
  onSelectCaption: (captionId: string | null) => void;
  onZoomChange: (nextPxPerSec: number) => void;
  onToggleSnap: () => void;
  onMoveClip: (clipId: string, start: number, trackId?: string) => void;
  onTrimClip: (clipId: string, edge: "start" | "end", time: number) => void;
  onUpdateCaptionTiming: (captionId: string, start: number, end: number) => void;
  onToggleTrackMute: (track: Track) => void;
  onDeleteSelected: () => void;
  onSplitAtPlayhead: () => void;
  onImportMedia: () => void;
  onAddTrack: (kind: "video" | "audio") => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filmstrips, setFilmstrips] = useState<Record<string, string[]>>({});
  const [dragPreview, setDragPreview] = useState<{
    id: string;
    start: number;
    duration: number;
  } | null>(null);

  const seq = useMemo(() => activeSequence(project), [project]);
  const duration = useMemo(() => getSequenceDuration(seq), [seq]);
  const totalWidth = Math.max(600, (duration + 8) * pxPerSec);

  const assetsById = useMemo(
    () => new Map<string, Asset>(project.assets.map((m) => [m.id, m])),
    [project.assets],
  );

  // Asynchronously extract real multi-frame filmstrips for video & image assets
  useEffect(() => {
    let cancelled = false;
    for (const item of project.assets) {
      if (filmstrips[item.id] || item.kind === "audio") continue;
      const url = withToken(`/api/v1/projects/${project.id}/assets/${item.id}/file`);
      const thumbFallback = withToken(`/api/v1/projects/${project.id}/assets/${item.id}/thumbnail`);
      extractMediaFilmstrip(item.id, url, item.kind, item.duration ?? 5, 6)
        .then((frames) => {
          if (!cancelled) {
            setFilmstrips((prev) => ({
              ...prev,
              [item.id]: frames.length > 0 ? frames : [thumbFallback],
            }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFilmstrips((prev) => ({ ...prev, [item.id]: [thumbFallback] }));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [project.id, project.assets, filmstrips]);

  // Keep playhead visible smoothly while playing
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = playhead * pxPerSec;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
    }
  }, [playhead, pxPerSec]);

  // 2-finger pinch-to-zoom on touch screens
  const pinchDistRef = useRef<number | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
      const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
      pinchDistRef.current = Math.hypot(dx, dy);
    }
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchDistRef.current !== null) {
      const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
      const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
      const dist = Math.hypot(dx, dy);
      const ratio = dist / Math.max(10, pinchDistRef.current);
      pinchDistRef.current = dist;
      onZoomChange(Math.max(18, Math.min(280, Math.round(pxPerSec * ratio))));
    }
  };

  // Magnetic snap points
  const snapPoints = useMemo(() => {
    const pts = [0, playhead];
    for (const tr of seq.tracks) {
      for (const c of tr.clips) {
        pts.push(c.start, c.start + c.duration);
      }
    }
    for (const cap of seq.captions) {
      pts.push(cap.start, cap.end);
    }
    return pts;
  }, [seq.tracks, seq.captions, playhead]);

  const snapTime = useCallback(
    (rawT: number, haptic = false): number => {
      if (!snapEnabled) return Math.max(0, rawT);
      const thresholdSec = 10 / pxPerSec;
      let best = Math.max(0, rawT);
      let bestDist = thresholdSec;
      for (const p of snapPoints) {
        const d = Math.abs(p - rawT);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      if (best !== rawT && haptic) {
        navigator.vibrate?.(4);
      }
      return Math.max(0, best);
    },
    [snapEnabled, pxPerSec, snapPoints],
  );

  // Interactive clip move / left-trim / right-trim via Pointer Events
  const beginClipGesture = (
    e: React.PointerEvent,
    clip: Clip,
    mode: "move" | "trim-left" | "trim-right",
  ) => {
    e.stopPropagation();
    onSelectClip(clip.id);
    onSelectCaption(null);

    const startClientX = e.clientX;
    const origStart = clip.start;
    const origDur = clip.duration;
    const speed = getClipSpeed(clip);
    const media = assetsById.get(clip.assetId);
    const maxMediaDur = media && media.kind !== "video" && media.kind !== "audio" ? 300 : Math.max(clip.out, media?.duration ?? 300);

    let latestStart = origStart;
    let latestDur = origDur;

    const onMove = (ev: PointerEvent) => {
      const dt = (ev.clientX - startClientX) / pxPerSec;
      if (mode === "move") {
        latestStart = snapTime(Math.max(0, origStart + dt), true);
        latestDur = origDur;
      } else if (mode === "trim-left") {
        const maxTrimIn = origDur - 0.12;
        const minTrimIn = -clip.in / speed;
        const clampedDt = Math.max(minTrimIn, Math.min(maxTrimIn, dt));
        latestStart = Math.max(0, origStart + clampedDt);
        latestDur = Math.max(0.12, origDur - clampedDt);
      } else {
        const maxExtend = (maxMediaDur - clip.out) / speed;
        const clampedDt = Math.max(-(origDur - 0.12), Math.min(maxExtend, dt));
        latestStart = origStart;
        latestDur = Math.max(0.12, origDur + clampedDt);
      }
      setDragPreview({ id: clip.id, start: latestStart, duration: latestDur });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragPreview(null);
      if (Math.abs(latestStart - origStart) < 0.005 && Math.abs(latestDur - origDur) < 0.005) {
        return;
      }
      if (mode === "move") {
        onMoveClip(clip.id, Number(latestStart.toFixed(3)));
      } else if (mode === "trim-left") {
        onTrimClip(clip.id, "start", Number(latestStart.toFixed(3)));
      } else {
        onTrimClip(clip.id, "end", Number((latestStart + latestDur).toFixed(3)));
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Interactive Caption move / trim right on the timeline
  const beginCaptionGesture = (
    e: React.PointerEvent,
    cap: Caption,
    mode: "move" | "trim-left" | "trim-right",
  ) => {
    e.stopPropagation();
    onSelectCaption(cap.id);
    onSelectClip(null);

    const startX = e.clientX;
    const origStart = cap.start;
    const origEnd = cap.end;
    const origDur = Math.max(0.2, origEnd - origStart);
    let latestStart = origStart;
    let latestDur = origDur;

    const onMove = (ev: PointerEvent) => {
      const dt = (ev.clientX - startX) / pxPerSec;
      if (mode === "move") {
        latestStart = snapTime(Math.max(0, origStart + dt), true);
        latestDur = origDur;
      } else if (mode === "trim-left") {
        const clamped = Math.max(-origStart, Math.min(origDur - 0.25, dt));
        latestStart = origStart + clamped;
        latestDur = origDur - clamped;
      } else {
        latestStart = origStart;
        latestDur = Math.max(0.25, origDur + dt);
      }
      setDragPreview({ id: cap.id, start: latestStart, duration: latestDur });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragPreview(null);
      if (Math.abs(latestStart - origStart) > 0.005 || Math.abs(latestDur - origDur) > 0.005) {
        onUpdateCaptionTiming(
          cap.id,
          Number(latestStart.toFixed(3)),
          Number((latestStart + latestDur).toFixed(3)),
        );
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Scrub ruler via drag or tap
  const beginRulerScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const updateAt = (clientX: number) => {
      const rect = scrollEl.getBoundingClientRect();
      const x = clientX - rect.left + scrollEl.scrollLeft;
      onPlayhead(Math.max(0, Math.min(duration + 2, x / pxPerSec)));
    };
    updateAt(e.clientX);
    const onMove = (ev: PointerEvent) => updateAt(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Adaptive ruler tick interval
  const tickStep = pxPerSec >= 120 ? 1 : pxPerSec >= 55 ? 2 : pxPerSec >= 28 ? 5 : 10;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 8; t += tickStep) ticks.push(t);

  return (
    <div className="timeline-shell" style={{ height: "100%" }}>
      {/* Clean Quick-Action Timeline Toolbar */}
      <div className="timeline-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            type="button"
            className="btn-ghost"
            onClick={onSplitAtPlayhead}
            disabled={!selectedClipId}
            title="Split clip (S)"
            style={{ padding: "4px 8px", fontSize: 11.5 }}
          >
            <IconScissors size={14} /> Split
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={onDeleteSelected}
            disabled={!selectedClipId && !selectedCaptionId}
            title="Delete selected (Del)"
            style={{ padding: "4px 8px", fontSize: 11.5 }}
          >
            <IconTrash size={14} /> Delete
          </button>
          <button
            type="button"
            className={`icon-btn ${snapEnabled ? "active" : ""}`}
            onClick={onToggleSnap}
            title="Magnetic Snap"
            style={{ width: 28, height: 28 }}
          >
            <IconMagnet size={14} />
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onAddTrack("video")}
            style={{ padding: "4px 7px", fontSize: 11 }}
            title="Add Video Overlay Track (PiP)"
          >
            +V
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onAddTrack("audio")}
            style={{ padding: "4px 7px", fontSize: 11 }}
            title="Add Audio Track"
          >
            +A
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            className="icon-btn"
            style={{ width: 28, height: 28 }}
            onClick={() => onZoomChange(Math.max(18, Math.round(pxPerSec * 0.78)))}
            aria-label="Zoom out timeline"
          >
            <IconZoomOut size={14} />
          </button>
          <input
            type="range"
            min={18}
            max={260}
            value={pxPerSec}
            onChange={(e) => onZoomChange(Number(e.target.value))}
            style={{ width: 72 }}
            aria-label="Timeline zoom"
          />
          <button
            type="button"
            className="icon-btn"
            style={{ width: 28, height: 28 }}
            onClick={() => onZoomChange(Math.min(260, Math.round(pxPerSec * 1.25)))}
            aria-label="Zoom in timeline"
          >
            <IconZoomIn size={14} />
          </button>
        </div>
      </div>

      {/* Scrollable Multi-Track Body */}
      <div
        className="timeline-body"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
      >
        <div className="track-headers">
          <div className="ruler-corner">TRACKS</div>
          {seq.captions.length > 0 && (
            <div className="track-hdr caption-hdr">
              <span>T1 · Text</span>
            </div>
          )}
          {seq.tracks.map((tr) => (
            <div key={tr.id} className="track-hdr">
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {tr.name}
              </span>
              <button
                type="button"
                className="icon-btn"
                style={{ width: 26, height: 26 }}
                onClick={() => onToggleTrackMute(tr)}
                title={tr.muted ? "Unmute track" : "Mute track"}
              >
                {tr.muted ? <IconMute size={13} /> : <IconVolume size={13} />}
              </button>
            </div>
          ))}
        </div>

        <div
          ref={scrollRef}
          className="tracks-scroll"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              onSelectClip(null);
              onSelectCaption(null);
            }
          }}
        >
          <div style={{ width: totalWidth, minHeight: "100%", position: "relative" }}>
            {/* Time Ruler */}
            <div className="ruler" onPointerDown={beginRulerScrub}>
              {ticks.map((t) => (
                <div key={t} className="ruler-tick mono" style={{ left: t * pxPerSec }}>
                  {formatTimecode(t).slice(0, 5)}
                </div>
              ))}
            </div>

            {/* Captions / Titles Interactive Track */}
            {seq.captions.length > 0 && (
              <div className="track-lane caption-lane">
                {seq.captions.map((cap: Caption) => {
                  const preview = dragPreview?.id === cap.id ? dragPreview : null;
                  const cStart = preview ? preview.start : cap.start;
                  const cDur = preview ? preview.duration : Math.max(0.25, cap.end - cap.start);
                  const isSel = selectedCaptionId === cap.id;
                  return (
                    <div
                      key={cap.id}
                      className={`tl-clip caption ${isSel ? "selected" : ""}`}
                      style={{
                        left: cStart * pxPerSec,
                        width: Math.max(24, cDur * pxPerSec),
                      }}
                      onPointerDown={(e) => beginCaptionGesture(e, cap, "move")}
                    >
                      <div
                        className="trim-handle left"
                        onPointerDown={(e) => beginCaptionGesture(e, cap, "trim-left")}
                      >
                        <span className="trim-grip-bar" />
                      </div>
                      <span className="tl-clip-label">{cap.text}</span>
                      <div
                        className="trim-handle right"
                        onPointerDown={(e) => beginCaptionGesture(e, cap, "trim-right")}
                      >
                        <span className="trim-grip-bar" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Video & Audio Tracks */}
            {seq.tracks.map((tr: Track) => (
              <div
                key={tr.id}
                className="track-lane"
                onClick={(e) => {
                  if (e.target === e.currentTarget) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    onPlayhead(Math.max(0, (e.clientX - rect.left) / pxPerSec));
                  }
                }}
              >
                {tr.clips.map((clip: Clip) => {
                  const preview = dragPreview?.id === clip.id ? dragPreview : null;
                  const cStart = preview ? preview.start : clip.start;
                  const cDur = preview ? preview.duration : clip.duration;
                  const widthPx = Math.max(22, cDur * pxPerSec);
                  const isSel = selectedClipId === clip.id;
                  const item = assetsById.get(clip.assetId);
                  const frames = filmstrips[clip.assetId] ?? [];
                  const speed = getClipSpeed(clip);
                  const tx = getClipTransition(clip);
                  const rev = isClipReversed(clip);

                  return (
                    <div
                      key={clip.id}
                      className={`tl-clip ${tr.kind === "audio" ? "audio" : ""} ${isSel ? "selected" : ""}`}
                      style={{
                        left: cStart * pxPerSec,
                        width: widthPx,
                        opacity: tr.muted ? 0.45 : 1,
                      }}
                      onPointerDown={(e) => beginClipGesture(e, clip, "move")}
                    >
                      {/* Real extracted video frame filmstrip */}
                      {tr.kind !== "audio" && frames.length > 0 && (
                        <div className="tl-filmstrip">
                          {Array.from({ length: Math.max(1, Math.min(12, Math.ceil(widthPx / 64))) }).map((_, idx) => (
                            <img
                              key={idx}
                              src={frames[idx % frames.length]}
                              alt=""
                              draggable={false}
                            />
                          ))}
                        </div>
                      )}

                      {/* Subtle audio waveform bars on audio tracks */}
                      {tr.kind === "audio" && (
                        <svg
                          preserveAspectRatio="none"
                          viewBox="0 0 100 32"
                          style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            opacity: 0.45,
                            pointerEvents: "none",
                          }}
                        >
                          {Array.from({ length: 40 }).map((_, idx) => {
                            const h = 5 + ((Math.sin(idx * 1.9 + clip.in) + 1) * 0.5) * 20;
                            return (
                              <rect
                                key={idx}
                                x={idx * 2.5}
                                y={(32 - h) / 2}
                                width="1.6"
                                height={h}
                                rx="0.8"
                                fill="#6ee7b7"
                              />
                            );
                          })}
                        </svg>
                      )}

                      {/* Left Trim Handle */}
                      <div
                        className="trim-handle left"
                        onPointerDown={(e) => beginClipGesture(e, clip, "trim-left")}
                      >
                        <span className="trim-grip-bar" />
                      </div>

                      <span className="tl-clip-label">
                        {item?.name ?? clip.name}
                        {Math.abs(speed - 1) > 0.02 ? ` · ${speed.toFixed(2)}×` : ""}
                        {rev ? " · Rev" : ""}
                      </span>

                      {/* Transition indicator pill */}
                      {tx && (
                        <span
                          style={{
                            position: "absolute",
                            left: 16,
                            bottom: 2,
                            fontSize: 9,
                            padding: "1px 4px",
                            borderRadius: 4,
                            background: "rgba(59,130,246,0.85)",
                            color: "#fff",
                            pointerEvents: "none",
                          }}
                        >
                          {tx.kind}
                        </span>
                      )}

                      {/* Right Trim Handle */}
                      <div
                        className="trim-handle right"
                        onPointerDown={(e) => beginClipGesture(e, clip, "trim-right")}
                      >
                        <span className="trim-grip-bar" />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Playhead Needle */}
            <div className="playhead-line" style={{ left: playhead * pxPerSec }}>
              <div className="playhead-cap" />
            </div>
          </div>
        </div>

        {/* Tactile Floating '+' Import Button */}
        <button
          type="button"
          className="fab-import"
          onClick={onImportMedia}
          title="Import Video, Photo, or Music"
          aria-label="Import media"
        >
          <IconPlus size={20} />
        </button>
      </div>
    </div>
  );
});
