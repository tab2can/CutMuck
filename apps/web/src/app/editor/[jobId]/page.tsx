"use client";

import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type CSSProperties,
} from "react";
import {
  api,
  formatDuration,
  mediaSrc,
  type Job,
  type TimelineOverlay,
} from "@/lib/api";
import { FX_PALETTE, FX_STACKABLE, FX_LABELS } from "@/lib/effects";
import { ContextSurface, useNativeContextBlock } from "@/components/ContextMenu";
import { EffectsTimeline } from "@/components/EffectsTimeline";
import { HlsPlayer, seekHlsLiveEdge } from "@/components/HlsPlayer";
import { KickChatPanel } from "@/components/KickChatPanel";
import { OverlayCanvas } from "@/components/OverlayCanvas";
import { Timeline } from "@/components/Timeline";
import { SmoothFadeOverlay } from "@/components/SmoothFadeOverlay";
import { VideoControls } from "@/components/VideoControls";
import { SplitHandle } from "@/components/SplitHandle";
import { useToast } from "@/components/Toast";
import {
  DEFAULT_EDITOR_LAYOUT,
  readEditorLayout,
  writeEditorLayout,
  type EditorLayout,
} from "@/lib/editorLayout";
import type Hls from "hls.js";

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function moveById<T extends { id: string }>(items: T[], id: string, where: "front" | "back" | "up" | "down") {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return items;
  const next = [...items];
  const [item] = next.splice(i, 1);
  if (where === "front") next.push(item);
  else if (where === "back") next.unshift(item);
  else if (where === "up") next.splice(Math.min(i + 1, next.length), 0, item);
  else next.splice(Math.max(i - 1, 0), 0, item);
  return next;
}

export default function EditorPage() {
  useNativeContextBlock(true);
  const params = useParams<{ jobId: string }>();
  const router = useRouter();
  const { push } = useToast();
  const jobId = params.jobId;
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const waitTimerRef = useRef<number | null>(null);

  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(60);
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rangeTouched, setRangeTouched] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const [loopSel, setLoopSel] = useState(false);
  const [rangeLocked, setRangeLocked] = useState(false);
  const [sideTab, setSideTab] = useState<"fx" | "chat">("fx");
  const [overlays, setOverlays] = useState<TimelineOverlay[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ringNote, setRingNote] = useState<string | null>(null);
  const [behindLive, setBehindLive] = useState(false);
  const [tabFs, setTabFs] = useState(false);
  const [controlsHover, setControlsHover] = useState(false);
  const [layout, setLayout] = useState<EditorLayout>(DEFAULT_EDITOR_LAYOUT);
  const controlsHideTimer = useRef<number | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [holdHud, setHoldHud] = useState<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const boostingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const savedRateRef = useRef(1);
  const holdRateRef = useRef(2);
  const rateRef = useRef(rate);
  const liveRangeInitRef = useRef(false);
  rateRef.current = rate;

  const isLive = job?.meta?.mode === "live" || job?.kind === "live";
  const selected = overlays.find((o) => o.id === selectedId) || null;
  const atLiveEdge = isLive && !behindLive;

  const activeFilters = useMemo(() => {
    let brightness = 0;
    let contrast = 1;
    let saturate = 1;
    let blur = 0;
    let vignette = false;
    let grayscale = false;
    let sepia = false;
    let mirror = false;
    let letterbox = 0;
    for (const o of overlays) {
      if (o.hidden) continue;
      const start = o.start_sec ?? 0;
      const end = o.end_sec ?? Number.POSITIVE_INFINITY;
      if (current < start || current > end) continue;
      if (o.type === "brightness") {
        brightness = o.brightness ?? 0;
        contrast = o.contrast ?? contrast;
      }
      if (o.type === "contrast") contrast = o.contrast ?? 1;
      if (o.type === "saturate") saturate = o.saturation ?? o.amount ?? 1;
      if (o.type === "blur") blur = o.blur ?? o.amount ?? 0;
      if (o.type === "vignette") vignette = true;
      if (o.type === "grayscale") grayscale = true;
      if (o.type === "sepia") sepia = true;
      if (o.type === "mirror") mirror = true;
      if (o.type === "letterbox") letterbox = o.amount ?? o.h ?? 0.12;
    }
    return {
      brightness,
      contrast,
      saturate,
      blur,
      vignette,
      grayscale,
      sepia,
      mirror,
      letterbox,
    };
  }, [overlays, current]);

  const refresh = useCallback(async () => {
    const data = await api<Job>(`/jobs/${jobId}`);
    setJob(data);
    if (data.error) setError(data.error);
    const metaDur = Number(data.meta?.dvr_seconds || data.meta?.duration || 0);
    if (metaDur > 0) {
      setDuration((d) => Math.max(d, metaDur));
      // Live: Out is user-pinned after first set — never chase the live edge
      if (!isLive && !rangeTouched) {
        setOutPoint(Math.min(metaDur, 60));
      }
    }
    const ov = data.meta?.overlays;
    if (Array.isArray(ov)) setOverlays(ov as TimelineOverlay[]);
    return data;
  }, [jobId, rangeTouched, isLive]);

  useEffect(() => {
    liveRangeInitRef.current = false;
    setRangeTouched(false);
  }, [jobId]);

  useEffect(() => {
    void refresh().catch((e) =>
      setError(e instanceof Error ? e.message : "Job yüklenemedi")
    );
  }, [refresh]);

  useEffect(() => {
    if (!isLive) return;
    const t = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(t);
  }, [isLive, refresh]);

  useEffect(() => {
    if (!isLive) return;
    const t = window.setInterval(() => {
      void api<{ duration?: number; active?: boolean }>(`/jobs/${jobId}/ring`)
        .then((st) => {
          if (st.duration && st.duration > 0) {
            setRingNote(`Ring yedek: ${formatDuration(st.duration)}`);
          } else {
            setRingNote("Canlı DVR · geçmişe sarabilirsin");
          }
        })
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(t);
  }, [isLive, jobId]);

  useEffect(() => {
    if (!isLive) {
      setBehindLive(false);
      return;
    }
    const edge = hlsRef.current?.liveSyncPosition;
    if (edge != null && Number.isFinite(edge)) {
      setBehindLive(current < edge - 3);
      return;
    }
    if (duration > 0) setBehindLive(current < duration - 4);
  }, [isLive, current, duration]);

  const src = useMemo(() => {
    if (job?.stream_url) return mediaSrc(job.stream_url);
    if (job?.media_url) return mediaSrc(job.media_url);
    return null;
  }, [job]);

  const poster = (job?.meta?.thumbnail as string) || null;

  useEffect(() => {
    setLayout(readEditorLayout());
  }, []);

  function persistLayout() {
    writeEditorLayout(layoutRef.current);
  }

  function showPlayerControls() {
    if (controlsHideTimer.current != null) {
      window.clearTimeout(controlsHideTimer.current);
      controlsHideTimer.current = null;
    }
    setControlsHover(true);
  }

  function hidePlayerControlsSoon() {
    if (controlsHideTimer.current != null) window.clearTimeout(controlsHideTimer.current);
    controlsHideTimer.current = window.setTimeout(() => {
      controlsHideTimer.current = null;
      setControlsHover(false);
    }, 420);
  }

  useEffect(() => {
    return () => {
      if (controlsHideTimer.current != null) {
        window.clearTimeout(controlsHideTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isLive) return;
    setMuted(true);
  }, [isLive]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const parts = [
      `brightness(${1 + activeFilters.brightness})`,
      `contrast(${activeFilters.contrast})`,
      `saturate(${activeFilters.saturate})`,
    ];
    if (activeFilters.blur > 0.05) parts.push(`blur(${activeFilters.blur}px)`);
    if (activeFilters.grayscale) parts.push("grayscale(1)");
    if (activeFilters.sepia) parts.push("sepia(0.85)");
    v.style.filter = parts.join(" ");
    v.style.transform = activeFilters.mirror ? "scaleX(-1)" : "";
  }, [activeFilters]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    v.volume = volume;
  }, [muted, volume]);

  useEffect(() => {
    if (!loopSel || !playing || isLive) return;
    if (current >= outPoint - 0.05) seekTo(inPoint);
  }, [current, loopSel, playing, inPoint, outPoint, isLive]);

  function seekTo(time: number) {
    const v = videoRef.current;
    if (!v) return;
    const liveEdge = hlsRef.current?.liveSyncPosition;
    const max = Math.max(
      duration || 0,
      Number.isFinite(v.duration) ? v.duration : 0,
      liveEdge != null && Number.isFinite(liveEdge) ? liveEdge : 0
    );
    const t = Math.max(0, Math.min(max > 0 ? max : time, time));
    try {
      v.currentTime = t;
    } catch {
      // ignore
    }
    setCurrent(t);
    if (isLive) {
      if (liveEdge != null && Number.isFinite(liveEdge)) {
        setBehindLive(t < liveEdge - 3);
      } else if (max > 0) {
        setBehindLive(t < max - 4);
      }
    }
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (loopSel && !isLive) {
        seekTo(inPoint);
      } else if (isLive && !behindLive) {
        // Watching live edge: on resume, catch up to Kick live (not the pause point)
        seekHlsLiveEdge(hlsRef.current, v);
        setBehindLive(false);
      }
      void v.play().catch(() => setError("Oynatma başlatılamadı"));
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  function clearClickTimer() {
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }

  function clearHoldTimer() {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }

  function endHoldBoost() {
    clearHoldTimer();
    if (!boostingRef.current) return;
    boostingRef.current = false;
    setRate(savedRateRef.current);
    setHoldHud(null);
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 280);
  }

  function isPlayerUi(target: EventTarget | null) {
    return (
      target instanceof Element &&
      !!target.closest(".player-controls-overlay, .pc-controls, .tab-fs-exit")
    );
  }

  function onStageClick(e: ReactMouseEvent) {
    if (isPlayerUi(e.target)) return;
    if (e.detail > 1) return;
    if (suppressClickRef.current || boostingRef.current) return;
    clearClickTimer();
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      if (!suppressClickRef.current && !boostingRef.current) togglePlay();
    }, 220);
  }

  function onStageDblClick(e: ReactMouseEvent) {
    if (isPlayerUi(e.target)) return;
    e.preventDefault();
    clearClickTimer();
    clearHoldTimer();
    setTabFs((v) => !v);
  }

  function onStagePointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    if (isPlayerUi(e.target)) return;
    clearHoldTimer();
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      boostingRef.current = true;
      suppressClickRef.current = true;
      clearClickTimer();
      savedRateRef.current = rateRef.current || 1;
      holdRateRef.current = 2;
      setRate(2);
      setHoldHud(2);
      const v = videoRef.current;
      if (v?.paused) {
        if (loopSel && !isLive) seekTo(inPoint);
        void v.play().catch(() => undefined);
        setPlaying(true);
      }
    }, 260);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  function onStagePointerUp() {
    endHoldBoost();
  }

  function onStagePointerCancel() {
    endHoldBoost();
  }

  function onStageWheel(e: ReactWheelEvent) {
    if (!boostingRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.deltaY < 0 ? 0.25 : -0.25;
    const next = Math.min(
      8,
      Math.max(0.5, Math.round((holdRateRef.current + step) * 100) / 100)
    );
    holdRateRef.current = next;
    setRate(next);
    setHoldHud(next);
  }

  useEffect(() => {
    return () => {
      clearClickTimer();
      clearHoldTimer();
    };
  }, []);

  useEffect(() => {
    if (holdHud == null) return;
    const onWheelNative = (e: WheelEvent) => {
      if (!boostingRef.current) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 0.25 : -0.25;
      const next = Math.min(
        8,
        Math.max(0.5, Math.round((holdRateRef.current + step) * 100) / 100)
      );
      holdRateRef.current = next;
      setRate(next);
      setHoldHud(next);
    };
    window.addEventListener("wheel", onWheelNative, { passive: false });
    return () => window.removeEventListener("wheel", onWheelNative);
  }, [holdHud]);

  function goLiveEdge() {
    const v = videoRef.current;
    if (!v) return;
    seekHlsLiveEdge(hlsRef.current, v);
    setBehindLive(false);
    const edge = hlsRef.current?.liveSyncPosition;
    const now = v.currentTime || 0;
    setCurrent(edge != null && Number.isFinite(edge) ? edge : now);
    // Never shrink DVR duration when catching up to live
    const vd = v.duration;
    const bump = Math.max(
      duration,
      Number.isFinite(vd) && vd > 0 && vd < 1e7 ? vd : 0,
      edge != null && Number.isFinite(edge) ? edge : 0,
      now
    );
    if (bump > 0) setDuration(bump);
    void v.play().catch(() => undefined);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if ((e.key === "i" || e.key === "I") && !rangeLocked) {
        setRangeTouched(true);
        setInPoint(current);
      } else if ((e.key === "o" || e.key === "O") && !rangeLocked) {
        setRangeTouched(true);
        setOutPoint(current || duration);
      } else if (e.key === "j" || e.key === "J") {
        seekTo(current - 5);
      } else if (e.key === "l" || e.key === "L") {
        seekTo(current + 5);
      } else if (e.key === "k" || e.key === "K") {
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        seekTo(current - (e.shiftKey ? 5 : 1));
      } else if (e.key === "ArrowRight") {
        seekTo(current + (e.shiftKey ? 5 : 1));
      } else if (isLive && (e.key === "End" || e.key === ".")) {
        goLiveEdge();
      } else if (e.key === "Escape" && tabFs) {
        setTabFs(false);
      } else if (e.key === "f" || e.key === "F") {
        setTabFs((v) => !v);
      } else if (e.key === "Enter") {
        goPublish();
      } else if (e.key === "Delete" && selectedId) {
        void removeOverlay(selectedId);
      } else if (e.key === "]" && selectedId) {
        persistOverlays(moveById(overlaysRef.current, selectedId, e.ctrlKey || e.metaKey ? "front" : "up"), true);
      } else if (e.key === "[" && selectedId) {
        persistOverlays(moveById(overlaysRef.current, selectedId, e.ctrlKey || e.metaKey ? "back" : "down"), true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, duration, inPoint, outPoint, playing, isLive, selectedId, tabFs, rangeLocked]);

  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;
  const persistTimer = useRef<number | null>(null);

  async function saveOverlays(next: TimelineOverlay[]) {
    try {
      await api(`/jobs/${jobId}/timeline`, {
        method: "PUT",
        body: JSON.stringify({ overlays: next }),
      });
    } catch (e) {
      push(e instanceof Error ? e.message : "Timeline kaydedilemedi", "error");
    }
  }

  function persistOverlays(next: TimelineOverlay[], immediate = true) {
    setOverlays(next);
    overlaysRef.current = next;
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    if (immediate) {
      void saveOverlays(next);
      return;
    }
    persistTimer.current = window.setTimeout(() => {
      void saveOverlays(overlaysRef.current);
    }, 400);
  }

  function patchOverlay(
    id: string,
    patch: Partial<TimelineOverlay>,
    opts?: { persist?: boolean }
  ) {
    const next = overlaysRef.current.map((o) =>
      o.id === id ? { ...o, ...patch } : o
    );
    const shouldPersist = opts?.persist !== false;
    if (shouldPersist) persistOverlays(next, true);
    else {
      setOverlays(next);
      overlaysRef.current = next;
    }
  }

  function commitOverlays() {
    void saveOverlays(overlaysRef.current);
  }

  function removeOverlay(id: string) {
    if (selectedId === id) setSelectedId(null);
    persistOverlays(overlaysRef.current.filter((o) => o.id !== id), true);
  }

  function moveOverlay(id: string, where: "front" | "back" | "up" | "down") {
    persistOverlays(moveById(overlaysRef.current, id, where), true);
  }

  function duplicateOverlay(id: string) {
    const src = overlaysRef.current.find((o) => o.id === id);
    if (!src) return;
    const copy: TimelineOverlay = { ...src, id: uid() };
    const i = overlaysRef.current.findIndex((o) => o.id === id);
    const next = [...overlaysRef.current];
    next.splice(Math.max(0, i) + 1, 0, copy);
    setSelectedId(copy.id);
    persistOverlays(next, true);
  }

  function reorderOverlays(fromId: string, toId: string) {
    if (fromId === toId) return;
    const prev = overlaysRef.current;
    const from = prev.findIndex((o) => o.id === fromId);
    const to = prev.findIndex((o) => o.id === toId);
    if (from < 0 || to < 0) return;
    const next = [...prev];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    persistOverlays(next, true);
  }

  function addEffect(type: TimelineOverlay["type"]) {
    const start = isLive ? Math.max(0, duration - 15) : current;
    const end = isLive
      ? duration || start + 15
      : Math.min(duration || start + 8, start + 8);
    const base: TimelineOverlay = {
      id: uid(),
      type,
      start_sec: start,
      end_sec: end > start ? end : start + 5,
      x: 0.5,
      y: 0.5,
      w: type === "text" ? 0.35 : 0.25,
      h: type === "text" ? 0.1 : 0.18,
      opacity: 1,
    };
    if (type === "text") {
      Object.assign(base, {
        text: "Yeni metin",
        font_size: 48,
        color: "#ffffff",
        bg: "rgba(0,0,0,0.45)",
        y: 0.82,
      });
    } else if (type === "rect") {
      Object.assign(base, { color: "rgba(61,214,198,0.4)", opacity: 0.7 });
    } else if (type === "fadeblack" || type === "fade") {
      Object.assign(base, {
        type: "fadeblack",
        hold_in: 2,
        hold_out: 2,
        fade_in: 1.5,
        fade_out: 1.5,
        color: "#000000",
        opacity: 1,
        start_sec: Math.max(0, inPoint - 0.5),
        end_sec: Math.min(duration || outPoint + 0.5, outPoint + 0.5),
      });
    } else if (type === "speed") {
      Object.assign(base, { speed: 1.25, start_sec: inPoint, end_sec: outPoint });
    } else if (type === "brightness") {
      Object.assign(base, {
        brightness: 0.08,
        contrast: 1.05,
        start_sec: inPoint,
        end_sec: outPoint,
      });
    } else if (type === "contrast") {
      Object.assign(base, { contrast: 1.2, start_sec: inPoint, end_sec: outPoint });
    } else if (type === "saturate") {
      Object.assign(base, {
        saturation: 1.35,
        amount: 1.35,
        start_sec: inPoint,
        end_sec: outPoint,
      });
    } else if (type === "blur") {
      Object.assign(base, { blur: 4, amount: 4, start_sec: inPoint, end_sec: outPoint });
    } else if (type === "sharpen") {
      Object.assign(base, { amount: 0.6, start_sec: inPoint, end_sec: outPoint });
    } else if (type === "noise") {
      Object.assign(base, { amount: 12, start_sec: inPoint, end_sec: outPoint });
    } else if (type === "letterbox") {
      Object.assign(base, { amount: 0.12, h: 0.12, start_sec: inPoint, end_sec: outPoint });
    } else if (type === "tint") {
      Object.assign(base, {
        color: "#ffaa66",
        amount: 0.28,
        opacity: 0.28,
        start_sec: inPoint,
        end_sec: outPoint,
      });
    } else if (
      type === "vignette" ||
      type === "grayscale" ||
      type === "sepia" ||
      type === "mirror"
    ) {
      Object.assign(base, { start_sec: inPoint, end_sec: outPoint });
    }
    const next = FX_STACKABLE.has(base.type)
      ? [...overlaysRef.current, base]
      : [...overlaysRef.current.filter((o) => o.type !== base.type), base];
    setSelectedId(base.id);
    persistOverlays(next, true);
    push(`${FX_LABELS[base.type] || base.type} eklendi`, "ok");
  }

  function goPublish() {
    if (outPoint <= inPoint) {
      push("Geçerli In/Out seçin", "error");
      return;
    }
    router.push(
      `/publish/${jobId}?start=${inPoint.toFixed(3)}&end=${outPoint.toFixed(3)}`
    );
  }

  const ready =
    job?.status === "ready" ||
    job?.status === "cut" ||
    job?.status === "done" ||
    job?.status === "error";
  const clipLen = Math.max(0, outPoint - inPoint);
  const timelineDur = duration > 0 ? duration : Math.max(outPoint, 60);

  return (
    <div className={`editor-shell ${tabFs ? "is-tab-fs" : ""}`}>
      <header className="editor-titlebar">
        <div className="titlebar-left">
          <button type="button" className="btn ghost" onClick={() => router.push("/")}>
            ← Ana menü
          </button>
          <strong>{job?.title || "Düzenleyici"}</strong>
          {job?.channel_slug ? <span className="muted">@{job.channel_slug}</span> : null}
          {isLive ? <span className="live-badge">CANLI</span> : null}
        </div>
        <div className="titlebar-right">
          <span className="muted">
            {isLive
              ? `Canlı DVR · ${formatDuration(timelineDur)} geçmiş`
              : "Önizleme"}{" "}
            · kesit {formatDuration(clipLen)}
          </span>
          <button type="button" className="btn primary" disabled={!ready} onClick={goPublish}>
            Sonraki aşama →
          </button>
        </div>
      </header>

      <div
        className="editor-body"
        style={
          {
            "--editor-side-w": `${layout.sideW}px`,
            "--editor-player-h": `${layout.playerH}px`,
          } as CSSProperties
        }
      >
        <div className="editor-main">
          <div
            className={`player-chrome ${tabFs ? "tab-fs" : ""} ${controlsHover || tabFs ? "show-controls" : ""}`}
            onMouseEnter={showPlayerControls}
            onMouseLeave={hidePlayerControlsSoon}
          >
            {tabFs ? (
              <button
                type="button"
                className="tab-fs-exit"
                onClick={() => setTabFs(false)}
                title="Küçült (Esc)"
              >
                ✕
              </button>
            ) : null}
            <div
              className={`player-stage ${holdHud != null ? "holding" : ""}`}
              onClick={onStageClick}
              onDoubleClick={onStageDblClick}
              onPointerDown={onStagePointerDown}
              onPointerUp={onStagePointerUp}
              onPointerCancel={onStagePointerCancel}
              onWheel={onStageWheel}
            >
              {src && ready ? (
                <>
                  <HlsPlayer
                    src={src}
                    videoRef={videoRef}
                    hlsRef={hlsRef}
                    live={isLive}
                    poster={poster}
                    onReady={(d) => {
                      if (d && Number.isFinite(d) && d > 0 && d < 1e7) {
                        setDuration((prev) => Math.max(prev, d));
                        if (isLive) {
                          if (!liveRangeInitRef.current && !rangeTouched && !rangeLocked) {
                            liveRangeInitRef.current = true;
                            setOutPoint(d);
                            setInPoint(Math.max(0, d - 30));
                          }
                        } else if (!rangeTouched && !rangeLocked) {
                          setOutPoint(Math.min(d, 60));
                        }
                      }
                    }}
                    onTime={(t) => {
                      setCurrent(t);
                      const v = videoRef.current;
                      if (isLive) {
                        const candidates = [t];
                        if (v && Number.isFinite(v.duration) && v.duration > 0 && v.duration < 1e7) {
                          candidates.push(v.duration);
                        }
                        const edge = hlsRef.current?.liveSyncPosition;
                        if (edge != null && Number.isFinite(edge)) {
                          candidates.push(edge);
                          setBehindLive(t < edge - 3);
                        } else if (duration > 0) {
                          setBehindLive(t < duration - 4);
                        }
                        setDuration((prev) => Math.max(prev, ...candidates));
                      }
                    }}
                    onPlay={() => {
                      setPlaying(true);
                      if (waitTimerRef.current) {
                        window.clearTimeout(waitTimerRef.current);
                        waitTimerRef.current = null;
                      }
                      setBuffering(false);
                    }}
                    onPause={() => setPlaying(false)}
                    onWaiting={() => {
                      if (waitTimerRef.current) window.clearTimeout(waitTimerRef.current);
                      waitTimerRef.current = window.setTimeout(() => setBuffering(true), 280);
                    }}
                    onPlaying={() => {
                      if (waitTimerRef.current) {
                        window.clearTimeout(waitTimerRef.current);
                        waitTimerRef.current = null;
                      }
                      setBuffering(false);
                    }}
                    onError={(msg) => setError(msg)}
                  />
                  {activeFilters.vignette ? (
                    <div
                      className="player-fx-filter"
                      style={{
                        background:
                          "radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,0.62) 100%)",
                      }}
                    />
                  ) : null}
                  {activeFilters.letterbox > 0 ? (
                    <>
                      <div
                        className="player-fx-filter letterbox-bar top"
                        style={{ height: `${activeFilters.letterbox * 100}%` }}
                      />
                      <div
                        className="player-fx-filter letterbox-bar bottom"
                        style={{ height: `${activeFilters.letterbox * 100}%` }}
                      />
                    </>
                  ) : null}
                  <SmoothFadeOverlay
                    videoRef={videoRef}
                    overlays={overlays}
                    current={current}
                  />
                  <OverlayCanvas
                    overlays={overlays}
                    current={current}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onChange={(id, patch) => patchOverlay(id, patch, { persist: false })}
                    onCommit={commitOverlays}
                    onMove={moveOverlay}
                    onRemove={removeOverlay}
                    onDuplicate={duplicateOverlay}
                  />
                  {holdHud != null ? (
                    <div className="player-hold-hud">{holdHud.toFixed(2).replace(/\.00$/, "")}x</div>
                  ) : null}
                </>
              ) : (
                <p className="muted">{error || "Önizleme hazırlanıyor…"}</p>
              )}
              {buffering && src ? <div className="player-buffering">Yükleniyor…</div> : null}

              <div
                className="player-controls-overlay"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <VideoControls
                  current={current}
                  duration={timelineDur}
                  playing={playing}
                  buffering={buffering}
                  muted={muted}
                  volume={volume}
                  rate={rate}
                  live={isLive}
                  atLiveEdge={atLiveEdge}
                  expanded={tabFs}
                  overlay
                  disabled={!ready || !src}
                  previewSrc={src}
                  onTogglePlay={togglePlay}
                  onSeek={seekTo}
                  onSkip={(d) => seekTo(current + d)}
                  onRateChange={setRate}
                  onMuteToggle={() => setMuted((m) => !m)}
                  onVolumeChange={(v) => {
                    setVolume(v);
                    setMuted(v === 0);
                  }}
                  onGoLive={goLiveEdge}
                  onToggleExpand={() => setTabFs((v) => !v)}
                />
              </div>
            </div>
          </div>

          {!tabFs ? (
            <SplitHandle
              orientation="horizontal"
              label="Video yüksekliği"
              onDelta={(dy) =>
                setLayout((prev) => ({
                  ...prev,
                  playerH: Math.min(720, Math.max(220, prev.playerH + dy)),
                }))
              }
              onDragEnd={persistLayout}
            />
          ) : null}

          <div className="editor-dock">
            <div className="transport compact">
              <button
                type="button"
                className="btn"
                disabled={!ready || rangeLocked}
                title={rangeLocked ? "In/Out kilitli" : "In noktasını buraya al"}
                onClick={() => {
                  if (rangeLocked) return;
                  setRangeTouched(true);
                  setInPoint(current);
                }}
              >
                In {formatDuration(inPoint)}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!ready || rangeLocked}
                title={rangeLocked ? "In/Out kilitli" : "Out noktasını buraya al"}
                onClick={() => {
                  if (rangeLocked) return;
                  setRangeTouched(true);
                  setOutPoint(current || duration);
                }}
              >
                Out {formatDuration(outPoint)}
              </button>
              {isLive ? (
                <button
                  type="button"
                  className="btn primary"
                  disabled={!ready || atLiveEdge}
                  onClick={goLiveEdge}
                >
                  Canlıya dön
                </button>
              ) : (
                <button
                  type="button"
                  className={`btn ${loopSel ? "primary" : ""}`}
                  onClick={() => setLoopSel((v) => !v)}
                >
                  Loop
                </button>
              )}
              <button
                type="button"
                className={`btn ${rangeLocked ? "primary" : ""}`}
                disabled={!ready}
                title={rangeLocked ? "In/Out kilidini aç" : "In/Out kilitle"}
                onClick={() => setRangeLocked((v) => !v)}
              >
                {rangeLocked ? "Kilitli" : "Kilitle"}
              </button>
              {ringNote ? <span className="muted">{ringNote}</span> : null}
            </div>

            <div className="dock-clip-panel" style={{ height: layout.clipTimelineH }}>
            <ContextSurface
              className="timeline docked"
              items={[
                {
                  id: "in",
                  label: "In buraya",
                  disabled: rangeLocked,
                  onSelect: () => {
                    if (rangeLocked) return;
                    setRangeTouched(true);
                    setInPoint(current);
                  },
                },
                {
                  id: "out",
                  label: "Out buraya",
                  disabled: rangeLocked,
                  onSelect: () => {
                    if (rangeLocked) return;
                    setRangeTouched(true);
                    setOutPoint(current);
                  },
                },
              ]}
            >
              <Timeline
                duration={timelineDur}
                current={current}
                inPoint={inPoint}
                outPoint={outPoint}
                zoom={zoom}
                viewStart={viewStart}
                onZoom={setZoom}
                onViewStart={setViewStart}
                onSeek={seekTo}
                onInChange={(t) => {
                  if (rangeLocked) return;
                  setRangeTouched(true);
                  setInPoint(t);
                }}
                onOutChange={(t) => {
                  if (rangeLocked) return;
                  setRangeTouched(true);
                  setOutPoint(t);
                }}
                rangeLocked={rangeLocked}
              />
            </ContextSurface>
            </div>

            <SplitHandle
              orientation="horizontal"
              className="dock-split"
              label="Klip timeline yüksekliği"
              onDelta={(dy) =>
                setLayout((prev) => ({
                  ...prev,
                  clipTimelineH: Math.min(320, Math.max(88, prev.clipTimelineH + dy)),
                }))
              }
              onDragEnd={persistLayout}
            />

            <div className="dock-fx-panel">
            <EffectsTimeline
              overlays={overlays}
              duration={timelineDur}
              current={current}
              inPoint={inPoint}
              outPoint={outPoint}
              zoom={zoom}
              viewStart={viewStart}
              onZoom={setZoom}
              onViewStart={setViewStart}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={(id, patch) => patchOverlay(id, patch, { persist: false })}
              onCommit={commitOverlays}
              onRemove={removeOverlay}
              onAdd={() => addEffect("text")}
              onMove={moveOverlay}
              onDuplicate={duplicateOverlay}
              onReorder={reorderOverlays}
            />
            </div>

            {error ? <p className="form-message">{error}</p> : null}
          </div>
        </div>

        <SplitHandle
          orientation="vertical"
          label="Sağ panel genişliği"
          onDelta={(dx) =>
            setLayout((prev) => ({
              ...prev,
              sideW: Math.min(640, Math.max(340, prev.sideW - dx)),
            }))
          }
          onDragEnd={persistLayout}
        />

        <aside className="editor-side">
          <div className="editor-side-tabs">
            <button
              type="button"
              className={sideTab === "fx" ? "active" : ""}
              onClick={() => setSideTab("fx")}
            >
              Efektler
            </button>
            <button
              type="button"
              className={sideTab === "chat" ? "active" : ""}
              onClick={() => setSideTab("chat")}
            >
              Sohbet
            </button>
          </div>
          {sideTab === "chat" ? (
            <KickChatPanel
              jobId={jobId}
              current={current}
              live={isLive}
              atLiveEdge={atLiveEdge}
            />
          ) : (
            <div className="editor-side-fx">
          <div className="fx-side-palette">
            <h3>Efekt ekle</h3>
            <p className="muted fx-side-hint">
              Siyah fade: kesitin başına/sonuna. Metin/şekil videoda sürüklenir.
            </p>
            <div className="fx-palette">
              {FX_PALETTE.map((p) => (
                <button
                  key={p.type}
                  type="button"
                  className="fx-palette-item"
                  onClick={() => addEffect(p.type as TimelineOverlay["type"])}
                  title={p.hint}
                >
                  <strong>{p.label}</strong>
                  <span>{p.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="fx-applied-scroll">
            <div className="fx-applied-head">
              <h3>Efekt ayarları</h3>
            </div>
            {!selected ? (
              <p className="muted fx-side-hint">
                Alttaki timeline’dan bir efekt seç — ayarları burada görünür.
              </p>
            ) : (
              <div className="fx-inspector">
                <h4>{FX_LABELS[selected.type] || selected.type}</h4>
                {selected.type === "text" ? (
                  <>
                    <label className="field">
                      <span>Metin</span>
                      <input
                        value={selected.text || ""}
                        onChange={(e) => patchOverlay(selected.id, { text: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Boyut</span>
                      <input
                        type="range"
                        min={16}
                        max={96}
                        value={selected.font_size || 42}
                        onChange={(e) =>
                          patchOverlay(selected.id, { font_size: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Renk</span>
                      <input
                        type="color"
                        value={selected.color?.startsWith("#") ? selected.color : "#ffffff"}
                        onChange={(e) => patchOverlay(selected.id, { color: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Opaklık</span>
                      <input
                        type="range"
                        min={0.2}
                        max={1}
                        step={0.05}
                        value={selected.opacity ?? 1}
                        onChange={(e) =>
                          patchOverlay(selected.id, { opacity: Number(e.target.value) })
                        }
                      />
                    </label>
                  </>
                ) : null}
                {selected.type === "rect" ? (
                  <>
                    <label className="field">
                      <span>Renk</span>
                      <input
                        type="color"
                        value="#3dd6c6"
                        onChange={(e) => patchOverlay(selected.id, { color: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Opaklık</span>
                      <input
                        type="range"
                        min={0.1}
                        max={1}
                        step={0.05}
                        value={selected.opacity ?? 0.7}
                        onChange={(e) =>
                          patchOverlay(selected.id, { opacity: Number(e.target.value) })
                        }
                      />
                    </label>
                  </>
                ) : null}
                {selected.type === "fadeblack" || selected.type === "fade" ? (
                  <>
                    <p className="muted fx-side-hint">
                      Başta 2sn siyah → yumuşak açılış; sonda yumuşak kararma → 2sn siyah.
                      Kilit: In−0.5s / Out+0.5s (ilk kare flaşını önler).
                    </p>
                    <label className="field">
                      <span>Başta sabit siyah (sn)</span>
                      <input
                        type="range"
                        min={0}
                        max={5}
                        step={0.1}
                        value={selected.hold_in ?? 2}
                        onChange={(e) =>
                          patchOverlay(selected.id, { hold_in: Number(e.target.value) })
                        }
                      />
                      <em>{(selected.hold_in ?? 2).toFixed(1)}s</em>
                    </label>
                    <label className="field">
                      <span>Açılış geçişi (sn)</span>
                      <input
                        type="range"
                        min={0.3}
                        max={5}
                        step={0.1}
                        value={selected.fade_in ?? 1.5}
                        onChange={(e) =>
                          patchOverlay(selected.id, { fade_in: Number(e.target.value) })
                        }
                      />
                      <em>{(selected.fade_in ?? 1.5).toFixed(1)}s</em>
                    </label>
                    <label className="field">
                      <span>Kapanış geçişi (sn)</span>
                      <input
                        type="range"
                        min={0.3}
                        max={5}
                        step={0.1}
                        value={selected.fade_out ?? 1.5}
                        onChange={(e) =>
                          patchOverlay(selected.id, { fade_out: Number(e.target.value) })
                        }
                      />
                      <em>{(selected.fade_out ?? 1.5).toFixed(1)}s</em>
                    </label>
                    <label className="field">
                      <span>Sonda sabit siyah (sn)</span>
                      <input
                        type="range"
                        min={0}
                        max={5}
                        step={0.1}
                        value={selected.hold_out ?? 2}
                        onChange={(e) =>
                          patchOverlay(selected.id, { hold_out: Number(e.target.value) })
                        }
                      />
                      <em>{(selected.hold_out ?? 2).toFixed(1)}s</em>
                    </label>
                    <div className="effect-row">
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          patchOverlay(selected.id, {
                            hold_in: 2,
                            hold_out: 2,
                            fade_in: 1.5,
                            fade_out: 1.5,
                          })
                        }
                      >
                        Varsayılan
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          patchOverlay(selected.id, {
                            hold_in: 1,
                            hold_out: 1,
                            fade_in: 1,
                            fade_out: 1,
                          })
                        }
                      >
                        Kısa
                      </button>
                    </div>
                    <label className="field">
                      <span>Fade rengi</span>
                      <input
                        type="color"
                        value={selected.color?.startsWith("#") ? selected.color : "#000000"}
                        onChange={(e) => patchOverlay(selected.id, { color: e.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        patchOverlay(selected.id, {
                          start_sec: Math.max(0, inPoint - 0.5),
                          end_sec: Math.min(timelineDur, outPoint + 0.5),
                        })
                      }
                    >
                      In/Out kilitle (−0.5 / +0.5)
                    </button>
                  </>
                ) : null}
                {selected.type === "speed" ? (
                  <div className="effect-row">
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`btn ${(selected.speed ?? 1) === s ? "primary" : ""}`}
                        onClick={() => patchOverlay(selected.id, { speed: s })}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>
                ) : null}
                {selected.type === "brightness" ? (
                  <>
                    <label className="field">
                      <span>Parlaklık</span>
                      <input
                        type="range"
                        min={-0.3}
                        max={0.3}
                        step={0.01}
                        value={selected.brightness ?? 0}
                        onChange={(e) =>
                          patchOverlay(selected.id, { brightness: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Kontrast</span>
                      <input
                        type="range"
                        min={0.7}
                        max={1.4}
                        step={0.01}
                        value={selected.contrast ?? 1}
                        onChange={(e) =>
                          patchOverlay(selected.id, { contrast: Number(e.target.value) })
                        }
                      />
                    </label>
                  </>
                ) : null}
                {selected.type === "contrast" ? (
                  <label className="field">
                    <span>Kontrast</span>
                    <input
                      type="range"
                      min={0.6}
                      max={1.6}
                      step={0.01}
                      value={selected.contrast ?? 1}
                      onChange={(e) =>
                        patchOverlay(selected.id, { contrast: Number(e.target.value) })
                      }
                    />
                  </label>
                ) : null}
                {selected.type === "saturate" ? (
                  <label className="field">
                    <span>Doygunluk</span>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.05}
                      value={selected.saturation ?? selected.amount ?? 1}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        patchOverlay(selected.id, { saturation: v, amount: v });
                      }}
                    />
                  </label>
                ) : null}
                {selected.type === "blur" ? (
                  <label className="field">
                    <span>Bulanıklık</span>
                    <input
                      type="range"
                      min={0}
                      max={12}
                      step={0.5}
                      value={selected.blur ?? selected.amount ?? 0}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        patchOverlay(selected.id, { blur: v, amount: v });
                      }}
                    />
                  </label>
                ) : null}
                {selected.type === "sharpen" || selected.type === "noise" ? (
                  <label className="field">
                    <span>Yoğunluk</span>
                    <input
                      type="range"
                      min={0}
                      max={selected.type === "noise" ? 40 : 1}
                      step={selected.type === "noise" ? 1 : 0.05}
                      value={selected.amount ?? (selected.type === "noise" ? 10 : 0.5)}
                      onChange={(e) =>
                        patchOverlay(selected.id, { amount: Number(e.target.value) })
                      }
                    />
                  </label>
                ) : null}
                {selected.type === "letterbox" ? (
                  <label className="field">
                    <span>Şerit kalınlığı</span>
                    <input
                      type="range"
                      min={0.04}
                      max={0.28}
                      step={0.01}
                      value={selected.amount ?? selected.h ?? 0.12}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        patchOverlay(selected.id, { amount: v, h: v });
                      }}
                    />
                  </label>
                ) : null}
                {selected.type === "tint" ? (
                  <>
                    <label className="field">
                      <span>Ton</span>
                      <input
                        type="color"
                        value={selected.color?.startsWith("#") ? selected.color : "#ffaa66"}
                        onChange={(e) => patchOverlay(selected.id, { color: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Yoğunluk</span>
                      <input
                        type="range"
                        min={0}
                        max={0.6}
                        step={0.02}
                        value={selected.amount ?? selected.opacity ?? 0.25}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          patchOverlay(selected.id, { amount: v, opacity: v });
                        }}
                      />
                    </label>
                    <div className="effect-row">
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          patchOverlay(selected.id, { color: "#ffaa66", amount: 0.28 })
                        }
                      >
                        Warm
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          patchOverlay(selected.id, { color: "#66aaff", amount: 0.28 })
                        }
                      >
                        Cool
                      </button>
                    </div>
                  </>
                ) : null}
                {selected.type === "vignette" ||
                selected.type === "grayscale" ||
                selected.type === "sepia" ||
                selected.type === "mirror" ? (
                  <p className="muted fx-side-hint">
                    Bu efekt In/Out aralığında aktif. Süreyi aşağıdan veya timeline’dan ayarla.
                  </p>
                ) : null}
                <label className="field">
                  <span>Başlangıç (sn)</span>
                  <input
                    type="number"
                    step={0.1}
                    value={Number((selected.start_sec ?? 0).toFixed(1))}
                    onChange={(e) =>
                      patchOverlay(selected.id, { start_sec: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="field">
                  <span>Bitiş (sn)</span>
                  <input
                    type="number"
                    step={0.1}
                    value={Number((selected.end_sec ?? timelineDur).toFixed(1))}
                    onChange={(e) =>
                      patchOverlay(selected.id, { end_sec: Number(e.target.value) })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn ghost block"
                  onClick={() => removeOverlay(selected.id)}
                >
                  Efekti sil
                </button>
              </div>
            )}
          </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
