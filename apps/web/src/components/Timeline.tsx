"use client";

import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { formatDuration } from "@/lib/api";

type Props = {
  duration: number;
  current: number;
  inPoint: number;
  outPoint: number;
  zoom: number;
  onZoom: (z: number) => void;
  onSeek: (t: number) => void;
  onInChange: (t: number) => void;
  onOutChange: (t: number) => void;
};

const SNAP_PX = 14;

export function Timeline({
  duration,
  current,
  inPoint,
  outPoint,
  zoom,
  onZoom,
  onSeek,
  onInChange,
  onOutChange,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [panStart, setPanStart] = useState<number | null>(null);
  const [dragTip, setDragTip] = useState<{ t: number; x: number } | null>(null);

  const viewDur = duration > 0 ? duration / Math.max(1, zoom) : 0;
  const autoStart = Math.max(0, Math.min(duration - viewDur, current - viewDur / 2));
  const viewStart = panStart ?? autoStart;

  const toX = useCallback(
    (t: number) => {
      if (viewDur <= 0) return 0;
      return ((t - viewStart) / viewDur) * 100;
    },
    [viewDur, viewStart]
  );

  const fromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || viewDur <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return viewStart + ratio * viewDur;
    },
    [viewDur, viewStart]
  );

  function snap(t: number, ctrl: boolean) {
    const el = trackRef.current;
    if (!ctrl || !el || viewDur <= 0) return Math.max(0, Math.min(duration, t));
    const threshold = (SNAP_PX / el.getBoundingClientRect().width) * viewDur;
    if (t <= threshold) return 0;
    if (t >= duration - threshold) return duration;
    return Math.max(0, Math.min(duration, t));
  }

  function onTrackClick(e: ReactMouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).dataset.handle) return;
    setPanStart(null);
    onSeek(fromClientX(e.clientX));
  }

  function startDrag(kind: "in" | "out" | "play", e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev: MouseEvent) => {
      let t = snap(fromClientX(ev.clientX), ev.ctrlKey || ev.metaKey);
      if (kind === "in") {
        t = Math.min(t, outPoint - 0.1);
        onInChange(t);
      } else if (kind === "out") {
        t = Math.max(t, inPoint + 0.1);
        onOutChange(t);
      } else {
        onSeek(t);
      }
      if (kind === "in" || kind === "out") {
        setDragTip({ t, x: ev.clientX });
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

  return (
    <div className="timeline-pro">
      <div className="timeline-toolbar">
        <span className="muted">
          {formatDuration(0)} → {formatDuration(duration)} · görünüm{" "}
          {formatDuration(viewStart)}–{formatDuration(viewStart + viewDur)}
        </span>
        <div className="timeline-zoom">
          <button type="button" className="btn ghost" onClick={() => onZoom(Math.max(1, zoom - 0.5))}>
            −
          </button>
          <span>{zoom.toFixed(1)}x</span>
          <button type="button" className="btn ghost" onClick={() => onZoom(Math.min(12, zoom + 0.5))}>
            +
          </button>
        </div>
      </div>
      <div
        ref={trackRef}
        className="timeline-track pro"
        onClick={onTrackClick}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const next = Math.min(12, Math.max(1, zoom + (e.deltaY < 0 ? 0.3 : -0.3)));
            const center = viewStart + viewDur / 2;
            onZoom(next);
            const nd = duration / Math.max(1, next);
            setPanStart(Math.max(0, Math.min(duration - nd, center - nd / 2)));
            return;
          }
          if (e.shiftKey) {
            e.preventDefault();
            const pan = (e.deltaY !== 0 ? e.deltaY : e.deltaX) * (viewDur / 400);
            setPanStart((s) => {
              const base = s ?? autoStart;
              return Math.max(0, Math.min(Math.max(0, duration - viewDur), base + pan));
            });
          }
        }}
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
              className="timeline-handle in"
              data-handle="in"
              style={{ left: `${toX(inPoint)}%` }}
              onMouseDown={(e) => startDrag("in", e)}
            />
            <div
              className="timeline-handle out"
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
            {dragTip ? (
              <div
                className="timeline-drag-tip"
                style={{ left: `${toX(dragTip.t)}%` }}
              >
                {formatDuration(dragTip.t)}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
