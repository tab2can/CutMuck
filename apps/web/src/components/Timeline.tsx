"use client";

import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { formatDuration } from "@/lib/api";
import { clampViewStart, useTimelineWheel, zoomAround } from "@/lib/timelineView";

type Props = {
  duration: number;
  current: number;
  inPoint: number;
  outPoint: number;
  zoom: number;
  viewStart: number;
  onZoom: (z: number) => void;
  onViewStart: (t: number) => void;
  onSeek: (t: number) => void;
  onInChange: (t: number) => void;
  onOutChange: (t: number) => void;
  rangeLocked?: boolean;
};

const SNAP_PX = 14;
const LABEL_W = "72px";

export function Timeline({
  duration,
  current,
  inPoint,
  outPoint,
  zoom,
  viewStart,
  onZoom,
  onViewStart,
  onSeek,
  onInChange,
  onOutChange,
  rangeLocked = false,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragTip, setDragTip] = useState<number | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);

  const viewDur = duration > 0 ? duration / Math.max(1, zoom) : 0;
  const start = clampViewStart(viewStart, duration, viewDur);

  const toX = useCallback(
    (t: number) => {
      if (viewDur <= 0) return 0;
      return ((t - start) / viewDur) * 100;
    },
    [viewDur, start]
  );

  const fromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || viewDur <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return start + ratio * viewDur;
    },
    [viewDur, start]
  );

  function snap(t: number, ctrl: boolean) {
    const el = trackRef.current;
    if (!ctrl || !el || viewDur <= 0) return Math.max(0, Math.min(duration, t));
    const threshold = (SNAP_PX / el.getBoundingClientRect().width) * viewDur;
    if (Math.abs(t - 0) <= threshold) return 0;
    if (Math.abs(t - duration) <= threshold) return duration;
    if (Math.abs(t - inPoint) <= threshold) return inPoint;
    if (Math.abs(t - outPoint) <= threshold) return outPoint;
    return Math.max(0, Math.min(duration, t));
  }

  useTimelineWheel(
    rootRef,
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        const anchor = fromClientX(e.clientX);
        const next = zoomAround(
          duration,
          start,
          zoom,
          zoom + (e.deltaY < 0 ? 0.35 : -0.35),
          anchor
        );
        onZoom(next.zoom);
        onViewStart(next.viewStart);
        return;
      }
      if (e.shiftKey) {
        const pan = (e.deltaY !== 0 ? e.deltaY : e.deltaX) * (viewDur / 400);
        onViewStart(clampViewStart(start + pan, duration, viewDur));
      }
    },
    [duration, start, zoom, viewDur, fromClientX, onZoom, onViewStart]
  );

  function onTrackClick(e: ReactMouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).dataset.handle) return;
    onSeek(fromClientX(e.clientX));
  }

  function startDrag(kind: "in" | "out" | "play", e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (rangeLocked && (kind === "in" || kind === "out")) return;
    const move = (ev: MouseEvent) => {
      let t = snap(fromClientX(ev.clientX), ev.ctrlKey || ev.metaKey);
      if (kind === "in") {
        t = Math.min(t, outPoint - 0.1);
        onInChange(t);
        setDragTip(t);
      } else if (kind === "out") {
        t = Math.max(t, inPoint + 0.1);
        onOutChange(t);
        setDragTip(t);
      } else {
        onSeek(t);
        setDragTip(t);
      }
    };
    const up = () => {
      setDragTip(null);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const tipT = dragTip ?? hoverT;

  return (
    <div className="timeline-pro" ref={rootRef}>
      <div className="timeline-toolbar">
        <span className="muted">
          {formatDuration(0)} → {formatDuration(duration)} · görünüm{" "}
          {formatDuration(start)}–{formatDuration(start + viewDur)}
        </span>
        <div className="timeline-zoom">
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              const mid = start + viewDur / 2;
              const next = zoomAround(duration, start, zoom, zoom - 0.5, mid);
              onZoom(next.zoom);
              onViewStart(next.viewStart);
            }}
          >
            −
          </button>
          <span>{zoom.toFixed(1)}x</span>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              const mid = start + viewDur / 2;
              const next = zoomAround(duration, start, zoom, zoom + 0.5, mid);
              onZoom(next.zoom);
              onViewStart(next.viewStart);
            }}
          >
            +
          </button>
        </div>
      </div>
      <div className="timeline-row" style={{ gridTemplateColumns: `${LABEL_W} 1fr 28px` }}>
        <span className="timeline-row-label">Kesit</span>
        <div
          ref={trackRef}
          className={`timeline-track pro ${rangeLocked ? "range-locked" : ""}`}
          onClick={onTrackClick}
          onPointerMove={(e) => setHoverT(fromClientX(e.clientX))}
          onPointerLeave={() => setHoverT(null)}
        >
          {duration > 0 ? (
            <>
              <div
                className="timeline-range"
                style={{
                  left: `${toX(inPoint)}%`,
                  width: `${Math.max(0, toX(outPoint) - toX(inPoint))}%`,
                }}
              />
              <div
                className={`timeline-handle in ${rangeLocked ? "locked" : ""}`}
                data-handle="in"
                style={{ left: `${toX(inPoint)}%` }}
                onMouseDown={(e) => startDrag("in", e)}
              />
              <div
                className={`timeline-handle out ${rangeLocked ? "locked" : ""}`}
                data-handle="out"
                style={{ left: `${toX(outPoint)}%` }}
                onMouseDown={(e) => startDrag("out", e)}
              />
              <div
                className="timeline-playhead"
                data-handle="play"
                style={{ left: `${toX(current)}%` }}
                onMouseDown={(e) => startDrag("play", e)}
              />
              {tipT != null ? (
                <div className="timeline-hover-tip" style={{ left: `${toX(tipT)}%` }}>
                  {formatDuration(tipT)}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <span className="timeline-row-spacer" aria-hidden />
      </div>
    </div>
  );
}
