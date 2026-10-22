import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeSequence,
  api,
  withToken,
  type Asset,
  type Caption,
  type Clip,
  type Project,
  type Track,
} from "./api";
import {
  analyzeCanvasScopes,
  extractBrowserWaveformPeaks,
  extractMediaFilmstrip,
  getCachedWaveform,
  getClipFadeEnvelope,
  getClipSpeed,
  getClipTransition,
  getClipVolumeGain,
  getLastRenderedClipBoxes,
  getSequenceDuration,
  isClipReversed,
  readClipAudioEq,
  readClipChromaKey,
  renderSequenceFrame,
  setCachedWaveform,
} from "./compositor";
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

type LiveScopeData = ReturnType<typeof analyzeCanvasScopes>;

interface LiveAudioGraph {
  ctx: AudioContext;
  hp: BiquadFilterNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  gain: GainNode;
}

const mediaAudioGraphs = new WeakMap<HTMLMediaElement, LiveAudioGraph>();
let sharedLiveAudioCtx: AudioContext | null = null;

function ensureLiveAudioGraph(el: HTMLMediaElement): LiveAudioGraph | null {
  const existing = mediaAudioGraphs.get(el);
  if (existing) return existing;
  if (typeof AudioContext === "undefined") return null;
  try {
    if (!sharedLiveAudioCtx) {
      sharedLiveAudioCtx = new AudioContext();
    }
    const ctx = sharedLiveAudioCtx;
    const src = ctx.createMediaElementSource(el);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 10;

    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 120;

    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1200;
    mid.Q.value = 1.1;

    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 4800;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = 0;
    comp.ratio.value = 1;

    const gain = ctx.createGain();
    gain.gain.value = 1;

    src.connect(hp);
    hp.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(comp);
    comp.connect(gain);
    gain.connect(ctx.destination);

    const graph: LiveAudioGraph = { ctx, hp, low, mid, high, comp, gain };
    mediaAudioGraphs.set(el, graph);
    return graph;
  } catch {
    return null;
  }
}

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
  selectedClipId,
  selectedCaptionId,
  onPlayhead,
  onPlaying,
  onToggleMute,
  onSelectClip,
  onSelectCaption,
  onMoveClipPosition,
  onMoveCaptionPosition,
  onImportRequest,
  onQuickSplit,
}: {
  project: Project;
  playhead: number;
  playing: boolean;
  muted: boolean;
  selectedClipId?: string | null;
  selectedCaptionId: string | null;
  onPlayhead: (t: number) => void;
  onPlaying: (playing: boolean) => void;
  onToggleMute: () => void;
  onSelectClip?: (clipId: string | null) => void;
  onSelectCaption: (captionId: string | null) => void;
  onMoveClipPosition?: (clipId: string, x: number, y: number, commit?: boolean) => void;
  onMoveCaptionPosition: (captionId: string, normX: number, normY: number, commit?: boolean) => void;
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
  const [snapGuides, setSnapGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
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
          vid.crossOrigin = "anonymous";
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
          img.crossOrigin = "anonymous";
          img.onload = () => setMediaReadyTick((n) => n + 1);
          img.src = url;
          mediaElsRef.current.set(item.id, img);
        }
      }
    }
  }, [project.id, project.assets, seq.tracks]);

  // Synchronize video & audio elements to playhead, speed, volume (0%..200%), fades, and 3-Band EQ
  useEffect(() => {
    const assetMap = new Map<string, Asset>(project.assets.map((m) => [m.id, m]));
    const soloActive = seq.tracks.some((t) => t.solo);

    if (playing && sharedLiveAudioCtx?.state === "suspended") {
      void sharedLiveAudioCtx.resume().catch(() => undefined);
    }

    const syncElementAudio = (el: HTMLMediaElement, clip: Clip, rawGain: number, reversed: boolean) => {
      const eq = readClipAudioEq(clip);
      const needsWebAudio =
        rawGain > 1.005 ||
        eq.voiceClarity ||
        Math.abs(eq.lowDb) > 0.05 ||
        Math.abs(eq.midDb) > 0.05 ||
        Math.abs(eq.highDb) > 0.05 ||
        mediaAudioGraphs.has(el);

      if (needsWebAudio) {
        const graph = ensureLiveAudioGraph(el);
        if (graph) {
          if (playing && graph.ctx.state === "suspended") {
            void graph.ctx.resume().catch(() => undefined);
          }
          el.muted = reversed;
          el.volume = 1;
          graph.hp.frequency.value = eq.voiceClarity ? 85 : 10;
          graph.low.gain.value = eq.lowDb;
          graph.mid.gain.value = eq.midDb;
          graph.high.gain.value = eq.highDb;
          graph.comp.threshold.value = eq.voiceClarity ? -18 : 0;
          graph.comp.ratio.value = eq.voiceClarity ? 3.2 : 1;
          graph.gain.gain.value = reversed ? 0 : Math.max(0, Math.min(3, rawGain));
          return;
        }
      }

      el.muted = rawGain <= 0.001 || reversed;
      el.volume = Math.max(0, Math.min(1, rawGain));
    };

    for (const track of seq.tracks) {
      const trackAudible = !track.muted && (!soloActive || track.solo);
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
        const rawGain = muted || !trackAudible ? 0 : getClipVolumeGain(clip, track) * env;

        if (track.kind !== "audio" && item.kind === "video") {
          const vid = mediaElsRef.current.get(item.id);
          if (vid instanceof HTMLVideoElement) {
            syncElementAudio(vid, clip, rawGain, reversed);
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
            aud.crossOrigin = "anonymous";
            aud.src = withToken(`/api/v1/projects/${project.id}/assets/${item.id}/file`);
            audioElsRef.current.set(clip.id, aud);
          }
          syncElementAudio(aud, clip, rawGain, reversed);
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

    try {
      captionBoxesRef.current = renderSequenceFrame(ctx, {
        project,
        sequence: seq,
        time: playhead,
        mediaElements: mediaElsRef.current,
        splitComparePct,
        backdropMode,
      });
    } catch {
      captionBoxesRef.current = [];
    }

    if (showScopes) {
      try {
        setLiveScopes(analyzeCanvasScopes(canvas, playhead));
      } catch {
        // Ignore cross-origin canvas read if external stream
      }
    }
  });

  // Direct touch / pointer manipulation on the preview canvas (drag titles, video/PiP clips & split bar)
  const dragStateRef = useRef<
    | { mode: "split" }
    | {
        mode: "caption";
        captionId: string;
        startX: number;
        startY: number;
        origX: number;
        origY: number;
        lastX: number;
        lastY: number;
      }
    | {
        mode: "clip";
        clipId: string;
        startClientX: number;
        startClientY: number;
        origTx: number;
        origTy: number;
        lastTx: number;
        lastTy: number;
      }
    | null
  >(null);

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const relY = (e.clientY - rect.top) / Math.max(1, rect.height);

    if (splitComparePct !== undefined && Math.abs(relX * 100 - splitComparePct) < 6) {
      dragStateRef.current = { mode: "split" };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

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
        onSelectClip?.(null);
        dragStateRef.current = {
          mode: "caption",
          captionId: b.id,
          startX: relX,
          startY: relY,
          origX: cx,
          origY: cy,
          lastX: cx,
          lastY: cy,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }

    // Hit-test rendered visual / PiP clips from top-most overlay track down
    const clipBoxes = getLastRenderedClipBoxes();
    for (let i = clipBoxes.length - 1; i >= 0; i--) {
      const cb = clipBoxes[i]!;
      if (px >= cb.x && px <= cb.x + cb.w && py >= cb.y && py <= cb.y + cb.h) {
        const foundClip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === cb.clipId);
        if (foundClip && onMoveClipPosition) {
          onSelectCaption(null);
          onSelectClip?.(foundClip.id);
          dragStateRef.current = {
            mode: "clip",
            clipId: foundClip.id,
            startClientX: e.clientX,
            startClientY: e.clientY,
            origTx: foundClip.transform.x ?? 0,
            origTy: foundClip.transform.y ?? 0,
            lastTx: foundClip.transform.x ?? 0,
            lastTy: foundClip.transform.y ?? 0,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
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
      let nextX = Math.max(0.06, Math.min(0.94, st.origX + (relX - st.startX)));
      let nextY = Math.max(0.06, Math.min(0.94, st.origY + (relY - st.startY)));
      const snapX = Math.abs(nextX - 0.5) < 0.024;
      const snapY = Math.abs(nextY - 0.5) < 0.024;
      if (snapX) nextX = 0.5;
      if (snapY) nextY = 0.5;
      setSnapGuides({ x: snapX, y: snapY });
      st.lastX = Number(nextX.toFixed(3));
      st.lastY = Number(nextY.toFixed(3));
      onMoveCaptionPosition(st.captionId, st.lastX, st.lastY, false);
    } else if (st.mode === "clip" && onMoveClipPosition) {
      const scaleFactor = canvas.width / Math.max(1, rect.width);
      let nextTx = Math.round(st.origTx + (e.clientX - st.startClientX) * scaleFactor);
      let nextTy = Math.round(st.origTy + (e.clientY - st.startClientY) * scaleFactor);
      const snapX = Math.abs(nextTx) < 14;
      const snapY = Math.abs(nextTy) < 14;
      if (snapX) nextTx = 0;
      if (snapY) nextTy = 0;
      setSnapGuides({ x: snapX, y: snapY });
      st.lastTx = nextTx;
      st.lastTy = nextTy;
      onMoveClipPosition(st.clipId, nextTx, nextTy, false);
    }
  };

  const handleCanvasPointerUp = () => {
    const st = dragStateRef.current;
    dragStateRef.current = null;
    setSnapGuides({ x: false, y: false });
    if (!st) return;
    if (st.mode === "caption" && (st.lastX !== st.origX || st.lastY !== st.origY)) {
      onMoveCaptionPosition(st.captionId, st.lastX, st.lastY, true);
    } else if (st.mode === "clip" && onMoveClipPosition && (st.lastTx !== st.origTx || st.lastTy !== st.origTy)) {
      onMoveClipPosition(st.clipId, st.lastTx, st.lastTy, true);
    }
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
            onPointerCancel={handleCanvasPointerUp}
            onDoubleClick={() => onPlaying(!playing)}
          />

          {/* Live Magnetic Center Alignment Crosshairs */}
          {snapGuides.x && (
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: "50%",
                width: 1,
                background: "rgba(96, 165, 250, 0.9)",
                pointerEvents: "none",
              }}
            />
          )}
          {snapGuides.y && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "50%",
                height: 1,
                background: "rgba(96, 165, 250, 0.9)",
                pointerEvents: "none",
              }}
            />
          )}

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
                background: "rgba(9, 9, 11, 0.78)",
              }}
            >
              <button type="button" className="btn-primary" onClick={onImportRequest} style={{ padding: "9px 18px" }}>
                <IconImport size={16} /> Import Video or Photo
              </button>
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                MP4 · MOV · WebM · JPG · PNG · MP3 · WAV · SRT
              </span>
            </div>
          )}

          {/* Selected caption indicator */}
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

          {/* Subtle selected overlay/scaled clip indicator */}
          {selectedClipId &&
            !selectedCaptionId &&
            (() => {
              const canvas = canvasRef.current;
              const cb = getLastRenderedClipBoxes().find((b) => b.clipId === selectedClipId);
              if (!canvas || !cb) return null;
              const rx = stageBox.w / Math.max(1, canvas.width);
              const ry = stageBox.h / Math.max(1, canvas.height);
              const wCss = cb.w * rx;
              const hCss = cb.h * ry;
              if (Math.abs(wCss - stageBox.w) < 4 && Math.abs(hCss - stageBox.h) < 4) return null;
              return (
                <div
                  style={{
                    position: "absolute",
                    left: cb.x * rx,
                    top: cb.y * ry,
                    width: wCss,
                    height: hCss,
                    border: "1.5px solid rgba(96, 165, 250, 0.85)",
                    borderRadius: 4,
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
            title="Previous Frame (Left Arrow)"
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
            title="Next Frame (Right Arrow)"
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
              title="Split clip at playhead (S)"
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
  const laneRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [filmstrips, setFilmstrips] = useState<Record<string, string[]>>({});
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});
  const [dragPreview, setDragPreview] = useState<{
    id: string;
    start: number;
    duration: number;
    targetTrackId?: string;
  } | null>(null);

  const seq = useMemo(() => activeSequence(project), [project]);
  const duration = useMemo(() => getSequenceDuration(seq), [seq]);
  const totalWidth = Math.max(600, (duration + 8) * pxPerSec);

  const assetsById = useMemo(
    () => new Map<string, Asset>(project.assets.map((m) => [m.id, m])),
    [project.assets],
  );

  // Extract real multi-frame filmstrips AND real decoded audio waveforms
  useEffect(() => {
    let cancelled = false;
    for (const item of project.assets) {
      const url = withToken(`/api/v1/projects/${project.id}/assets/${item.id}/file`);
      if (!filmstrips[item.id] && item.kind !== "audio") {
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

      if (!waveforms[item.id] && (item.kind === "audio" || item.kind === "video")) {
        const cached = getCachedWaveform(item.id);
        if (cached) {
          setWaveforms((prev) => ({ ...prev, [item.id]: cached }));
        } else {
          extractBrowserWaveformPeaks(item.id, url, 72)
            .then(async (peaks) => {
              if (peaks.length > 0) return peaks;
              try {
                const srv = await api.waveform(item.id, 72);
                setCachedWaveform(item.id, srv.peaks);
                return srv.peaks;
              } catch {
                return [];
              }
            })
            .then((peaks) => {
              if (!cancelled && peaks.length > 0) {
                setWaveforms((prev) => ({ ...prev, [item.id]: peaks }));
              }
            })
            .catch(() => undefined);
        }
      }
    }
    return () => {
      cancelled = true;
    };
  }, [project.id, project.assets, filmstrips, waveforms]);

  // Keep playhead visible smoothly while playing
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = playhead * pxPerSec;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
    }
  }, [playhead, pxPerSec]);

  // Desktop Ctrl+Wheel Zoom & Horizontal Wheel Scroll
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      onZoomChange(Math.max(18, Math.min(280, Math.round(pxPerSec * factor))));
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY * 0.75;
    }
  };

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

  // Interactive clip move (horizontal + vertical across compatible tracks!) / left-trim / right-trim
  const beginClipGesture = (
    e: React.PointerEvent,
    sourceTrack: Track,
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
    const maxMediaDur =
      media && media.kind !== "video" && media.kind !== "audio" ? 300 : Math.max(clip.out, media?.duration ?? 300);

    let latestStart = origStart;
    let latestDur = origDur;
    let latestTrackId = sourceTrack.id;

    const onMove = (ev: PointerEvent) => {
      const dt = (ev.clientX - startClientX) / pxPerSec;
      if (mode === "move") {
        latestStart = snapTime(Math.max(0, origStart + dt), true);
        latestDur = origDur;
        // Detect vertical track switch across compatible lanes
        for (const tr of seq.tracks) {
          if ((sourceTrack.kind === "audio") !== (tr.kind === "audio") || tr.locked) continue;
          const el = laneRefs.current.get(tr.id);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
            latestTrackId = tr.id;
            break;
          }
        }
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
      setDragPreview({ id: clip.id, start: latestStart, duration: latestDur, targetTrackId: latestTrackId });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragPreview(null);
      const movedTime = Math.abs(latestStart - origStart) >= 0.005 || Math.abs(latestDur - origDur) >= 0.005;
      const movedTrack = latestTrackId !== sourceTrack.id;
      if (!movedTime && !movedTrack) return;

      if (mode === "move") {
        onMoveClip(clip.id, Number(latestStart.toFixed(3)), movedTrack ? latestTrackId : undefined);
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

  const tickStep = pxPerSec >= 120 ? 1 : pxPerSec >= 55 ? 2 : pxPerSec >= 28 ? 5 : 10;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 8; t += tickStep) ticks.push(t);

  return (
    <div className="timeline-shell" style={{ height: "100%" }} onWheel={handleWheel}>
      {/* Clean Quick-Action Timeline Toolbar */}
      <div className="timeline-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            type="button"
            className="btn-ghost"
            onClick={onSplitAtPlayhead}
            disabled={!selectedClipId && seq.tracks.every((t) => t.clips.length === 0)}
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
            title="Add Video Overlay Track (PiP / Chroma Key)"
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
            {seq.tracks.map((tr: Track) => {
              const isDropTarget = dragPreview?.targetTrackId === tr.id;
              return (
                <div
                  key={tr.id}
                  ref={(el) => {
                    if (el) laneRefs.current.set(tr.id, el);
                    else laneRefs.current.delete(tr.id);
                  }}
                  className={`track-lane ${isDropTarget ? "drop-target" : ""}`}
                  onPointerDown={(e) => {
                    if (e.target === e.currentTarget) {
                      onSelectClip(null);
                      onSelectCaption(null);
                      beginRulerScrub(e);
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
                    const peaks = waveforms[clip.assetId];
                    const speed = getClipSpeed(clip);
                    const tx = getClipTransition(clip);
                    const rev = isClipReversed(clip);
                    const ck = readClipChromaKey(clip);
                    const gainScale = Math.min(1.35, getClipVolumeGain(clip, tr));

                    return (
                      <div
                        key={clip.id}
                        className={`tl-clip ${tr.kind === "audio" ? "audio" : ""} ${isSel ? "selected" : ""}`}
                        style={{
                          left: cStart * pxPerSec,
                          width: widthPx,
                          opacity: tr.muted ? 0.45 : 1,
                        }}
                        onPointerDown={(e) => beginClipGesture(e, tr, clip, "move")}
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

                        {/* Real decoded audio waveform on both Audio tracks & Video clips */}
                        {peaks && peaks.length > 0 && (
                          <svg
                            preserveAspectRatio="none"
                            viewBox={`0 0 ${peaks.length * 2} 32`}
                            style={{
                              position: "absolute",
                              left: 0,
                              right: 0,
                              bottom: 0,
                              height: tr.kind === "audio" ? "100%" : "36%",
                              width: "100%",
                              opacity: tr.kind === "audio" ? 0.72 : 0.52,
                              pointerEvents: "none",
                            }}
                          >
                            {peaks.map((amp, idx) => {
                              const h = Math.max(2, Math.min(30, amp * 26 * gainScale));
                              return (
                                <rect
                                  key={idx}
                                  x={idx * 2}
                                  y={tr.kind === "audio" ? (32 - h) / 2 : 32 - h}
                                  width="1.35"
                                  height={h}
                                  rx="0.6"
                                  fill={tr.kind === "audio" ? "#6ee7b7" : "#93c5fd"}
                                />
                              );
                            })}
                          </svg>
                        )}

                        {/* Left Trim Handle */}
                        <div
                          className="trim-handle left"
                          onPointerDown={(e) => beginClipGesture(e, tr, clip, "trim-left")}
                        >
                          <span className="trim-grip-bar" />
                        </div>

                        <span className="tl-clip-label">
                          {item?.name ?? clip.name}
                          {Math.abs(speed - 1) > 0.02 ? ` · ${speed.toFixed(2)}×` : ""}
                          {rev ? " · Rev" : ""}
                          {ck.enabled ? " · Key" : ""}
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
                              background: "rgba(59,130,246,0.88)",
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
                          onPointerDown={(e) => beginClipGesture(e, tr, clip, "trim-right")}
                        >
                          <span className="trim-grip-bar" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}

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
          title="Import Video, Photo, Music, or Subtitles"
          aria-label="Import media"
        >
          <IconPlus size={20} />
        </button>
      </div>
    </div>
  );
});
