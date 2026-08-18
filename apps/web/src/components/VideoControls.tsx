"use client";

import Hls from "hls.js";
import { formatDuration } from "@/lib/api";
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

type Props = {
  current: number;
  duration: number;
  playing: boolean;
  buffering?: boolean;
  muted?: boolean;
  volume?: number;
  rate: number;
  disabled?: boolean;
  live?: boolean;
  atLiveEdge?: boolean;
  expanded?: boolean;
  overlay?: boolean;
  previewSrc?: string | null;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSkip: (delta: number) => void;
  onRateChange: (rate: number) => void;
  onMuteToggle?: () => void;
  onVolumeChange?: (v: number) => void;
  onGoLive?: () => void;
  onToggleExpand?: () => void;
};

function IconPlay() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7L8 5z" />
    </svg>
  );
}
function IconPause() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
    </svg>
  );
}
function IconBack() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 5v6l4 2" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
function IconFwd() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 5v6l4 2" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
function IconVol({ muted }: { muted: boolean }) {
  if (muted) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M11 5L6 9H3v6h3l5 4V5z" />
        <path d="M22 9l-6 6M16 9l6 6" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M11 5L6 9H3v6h3l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" />
    </svg>
  );
}

function IconExpand({ expanded }: { expanded: boolean }) {
  if (expanded) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M9 9H4V4M15 9h5V4M9 15H4v5M15 15h5v5" />
        <path d="M4 9l5-5M20 9l-5-5M4 15l5 5M20 15l-5 5" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M21 15v6h-6" />
      <path d="M3 9l6-6M21 9l-6-6M3 15l6 6M21 15l-6 6" />
    </svg>
  );
}

export function VideoControls({
  current,
  duration,
  playing,
  buffering,
  muted = false,
  volume = 1,
  rate,
  disabled,
  live,
  atLiveEdge = true,
  expanded,
  overlay,
  previewSrc,
  onTogglePlay,
  onSeek,
  onSkip,
  onRateChange,
  onMuteToggle,
  onVolumeChange,
  onGoLive,
  onToggleExpand,
}: Props) {
  const span = Math.max(duration, live ? current : 0, 0);
  const progress = span > 0 ? Math.min(100, (current / span) * 100) : 0;
  const previewRef = useRef<HTMLVideoElement>(null);
  const previewHls = useRef<Hls | null>(null);
  const wantedTime = useRef(0);
  const seeking = useRef(false);
  const [hover, setHover] = useState<{ pct: number; tipPct: number; time: number } | null>(null);

  useEffect(() => {
    const video = previewRef.current;
    const src = previewSrc;
    if (!video || !src) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 8,
        maxMaxBufferLength: 16,
        maxBufferSize: 8 * 1000 * 1000,
        capLevelToPlayerSize: true,
        startLevel: 0,
        autoStartLoad: true,
        testBandwidth: false,
      });
      previewHls.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (hls.levels.length > 0) hls.currentLevel = 0;
      });
      return () => {
        previewHls.current = null;
        hls.destroy();
      };
    }

    video.src = src;
    return () => {
      video.removeAttribute("src");
      video.load();
    };
  }, [previewSrc]);

  useEffect(() => {
    const video = previewRef.current;
    if (!video) return;
    const onSeeked = () => {
      seeking.current = false;
      if (Math.abs(wantedTime.current - video.currentTime) > 0.35) {
        seeking.current = true;
        try {
          video.currentTime = wantedTime.current;
        } catch {
          seeking.current = false;
        }
      }
    };
    video.addEventListener("seeked", onSeeked);
    return () => video.removeEventListener("seeked", onSeeked);
  }, [previewSrc]);

  function timeFromEvent(e: MouseEvent<HTMLDivElement> | PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = span > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
    return { pct: ratio * 100, time: ratio * span, width: rect.width };
  }

  function seekPreview(time: number) {
    wantedTime.current = time;
    const video = previewRef.current;
    if (!video || video.readyState < 1) return;
    if (seeking.current) return;
    seeking.current = true;
    try {
      video.currentTime = time;
    } catch {
      seeking.current = false;
    }
  }

  function onBarClick(e: MouseEvent<HTMLDivElement>) {
    if (!span || disabled) return;
    onSeek(timeFromEvent(e).time);
  }

  function onBarMove(e: PointerEvent<HTMLDivElement>) {
    if (!span || disabled) return;
    const next = timeFromEvent(e);
    const pad = next.width > 0 ? (92 / next.width) * 100 : 10;
    setHover({
      pct: next.pct,
      tipPct: Math.min(100 - pad, Math.max(pad, next.pct)),
      time: next.time,
    });
    seekPreview(next.time);
  }

  return (
    <div
      className={`pc-controls ${overlay ? "overlay" : ""} ${disabled ? "disabled" : ""} ${live ? "is-live" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="pc-scrub"
        onClick={onBarClick}
        onPointerMove={onBarMove}
        onPointerLeave={() => setHover(null)}
        role="slider"
        aria-valuenow={current}
      >
        <div
          className={`pc-hover-preview ${hover ? "show" : ""}`}
          style={{ left: `${hover?.tipPct ?? 0}%` }}
        >
          <div className="pc-hover-frame">
            <video
              ref={previewRef}
              className="pc-hover-video"
              muted
              playsInline
              preload="auto"
            />
          </div>
          <span className="pc-hover-time">
            {formatDuration(hover?.time ?? 0)}
          </span>
        </div>
        <div className="pc-scrub-track">
          <div className="pc-scrub-fill" style={{ width: `${progress}%` }} />
          <div className="pc-scrub-thumb" style={{ left: `${progress}%` }} />
          {hover ? <div className="pc-scrub-hover" style={{ left: `${hover.pct}%` }} /> : null}
        </div>
      </div>

      <div className="pc-row">
        <div className="pc-left">
          <button type="button" className="pc-btn" onClick={() => onSkip(-10)} disabled={disabled} title="-10s">
            <IconBack />
            <span>10</span>
          </button>
          <button
            type="button"
            className="pc-btn pc-play"
            onClick={onTogglePlay}
            disabled={disabled}
            title={playing ? "Duraklat" : "Oynat"}
          >
            {buffering ? <span className="pc-spinner" /> : playing ? <IconPause /> : <IconPlay />}
          </button>
          <button type="button" className="pc-btn" onClick={() => onSkip(10)} disabled={disabled} title="+10s">
            <span>10</span>
            <IconFwd />
          </button>
          <button type="button" className="pc-btn" onClick={onMuteToggle} disabled={disabled || !onMuteToggle}>
            <IconVol muted={muted || volume === 0} />
          </button>
          {onVolumeChange ? (
            <input
              className="pc-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              disabled={disabled}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
            />
          ) : null}
          <span className="pc-time">
            {live ? (
              <>
                <span className={`pc-live-dot ${atLiveEdge ? "" : "dim"}`} />
                {atLiveEdge ? "CANLI" : "GEÇMİŞ"}
                {duration > 0
                  ? ` · ${formatDuration(current)} / ${formatDuration(Math.max(duration, current))}`
                  : ""}
              </>
            ) : (
              `${formatDuration(current)} / ${formatDuration(duration)}`
            )}
          </span>
        </div>
        <div className="pc-right">
          {live && onGoLive ? (
            <button
              type="button"
              className={`pc-live-btn ${atLiveEdge ? "at-edge" : ""}`}
              onClick={onGoLive}
              disabled={disabled || atLiveEdge}
            >
              {atLiveEdge ? "Canlıdasın" : "Canlıya dön"}
            </button>
          ) : null}
          <label className="pc-rate">
            <select
              value={rate}
              disabled={disabled}
              onChange={(e) => onRateChange(Number(e.target.value))}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                <option key={r} value={r}>
                  {r}x
                </option>
              ))}
            </select>
          </label>
          {onToggleExpand ? (
            <button
              type="button"
              className="pc-btn"
              onClick={onToggleExpand}
              disabled={disabled}
              title={expanded ? "Küçült (Esc)" : "Sekme içi tam ekran"}
            >
              <IconExpand expanded={!!expanded} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
