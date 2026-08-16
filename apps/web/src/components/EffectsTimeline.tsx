"use client";

import { useMemo, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import type { TimelineOverlay } from "@/lib/api";
import { formatDuration } from "@/lib/api";

type Props = {
  overlays: TimelineOverlay[];
  duration: number;
  current: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<TimelineOverlay>) => void;
  onCommit?: () => void;
  onRemove: (id: string) => void;
  onAdd?: () => void;
};

const LABELS: Record<string, string> = {
  text: "Metin",
  rect: "Şekil",
  fade: "Fade",
  fadeblack: "Siyah fade",
  speed: "Hız",
  brightness: "Parlaklık",
  contrast: "Kontrast",
  vignette: "Vinyet",
  blur: "Bulanıklık",
  saturate: "Doygunluk",
  grayscale: "Siyah-beyaz",
  sepia: "Sepya",
  sharpen: "Keskinlik",
  noise: "Gren",
  letterbox: "Letterbox",
  mirror: "Ayna",
  tint: "Renk tonu",
};

type DragMode = "move" | "start" | "end";

const SNAP_PX = 14;

function snapTime(t: number, dur: number, ctrl: boolean, viewDur: number, laneWidth: number) {
  if (!ctrl || laneWidth <= 0) return Math.max(0, Math.min(dur, t));
  const threshold = (SNAP_PX / laneWidth) * viewDur;
  if (t <= threshold) return 0;
  if (t >= dur - threshold) return dur;
  return Math.max(0, Math.min(dur, t));
}

export function EffectsTimeline({
  overlays,
  duration,
  current,
  selectedId,
  onSelect,
  onChange,
  onCommit,
  onRemove,
  onAdd,
}: Props) {
  const dur = Math.max(duration, 1);
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const laneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [drag, setDrag] = useState<{
    id: string;
    mode: DragMode;
    originX: number;
    start: number;
    end: number;
    tip: number;
  } | null>(null);

  const viewDur = dur / Math.max(1, zoom);
  const clampedStart = Math.max(0, Math.min(Math.max(0, dur - viewDur), viewStart));
  const playhead = useMemo(() => {
    if (viewDur <= 0) return 0;
    return ((current - clampedStart) / viewDur) * 100;
  }, [current, clampedStart, viewDur]);

  function timeFromClientX(id: string, clientX: number) {
    const lane = laneRefs.current[id];
    if (!lane || viewDur <= 0) return 0;
    const r = lane.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return clampedStart + ratio * viewDur;
  }

  function laneWidth(id: string) {
    return laneRefs.current[id]?.getBoundingClientRect().width || 1;
  }

  function onClipPointerDown(e: PointerEvent, ov: TimelineOverlay, mode: DragMode) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSelect(ov.id);
    const start = ov.start_sec ?? 0;
    const end = ov.end_sec ?? dur;
    setDrag({
      id: ov.id,
      mode,
      originX: e.clientX,
      start,
      end,
      tip: mode === "end" ? end : start,
    });
  }

  function onClipPointerMove(e: PointerEvent) {
    if (!drag) return;
    const width = laneWidth(drag.id);
    let t = timeFromClientX(drag.id, e.clientX);
    t = snapTime(t, dur, e.ctrlKey || e.metaKey, viewDur, width);

    if (drag.mode === "start") {
      const start = Math.min(t, drag.end - 0.1);
      onChange(drag.id, { start_sec: start });
      setDrag({ ...drag, tip: start });
      return;
    }
    if (drag.mode === "end") {
      const end = Math.max(t, drag.start + 0.1);
      onChange(drag.id, { end_sec: end });
      setDrag({ ...drag, tip: end });
      return;
    }
    const lane = laneRefs.current[drag.id];
    if (!lane) return;
    const dx = e.clientX - drag.originX;
    const dt = (dx / lane.getBoundingClientRect().width) * viewDur;
    const len = Math.max(0.1, drag.end - drag.start);
    let ns = drag.start + dt;
    ns = Math.max(0, Math.min(dur - len, ns));
    if (e.ctrlKey || e.metaKey) {
      if (ns <= (SNAP_PX / width) * viewDur) ns = 0;
      else if (ns + len >= dur - (SNAP_PX / width) * viewDur) ns = dur - len;
    }
    onChange(drag.id, { start_sec: ns, end_sec: ns + len });
    setDrag({ ...drag, tip: ns });
  }

  function onClipPointerUp() {
    if (drag) onCommit?.();
    setDrag(null);
  }

  function onLaneClick(e: PointerEvent, ov: TimelineOverlay) {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(ov.id);
    const t = timeFromClientX(ov.id, e.clientX);
    const end = ov.end_sec ?? dur;
    onChange(ov.id, { start_sec: Math.min(t, end - 0.1) });
    onCommit?.();
  }

  function onLaneContextMenu(e: MouseEvent, ov: TimelineOverlay) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(ov.id);
    const t = timeFromClientX(ov.id, e.clientX);
    const start = ov.start_sec ?? 0;
    onChange(ov.id, { end_sec: Math.max(t, start + 0.1) });
    onCommit?.();
  }

  function onWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const next = Math.min(12, Math.max(1, zoom + (e.deltaY < 0 ? 0.35 : -0.35)));
      const center = clampedStart + viewDur / 2;
      setZoom(next);
      const nd = dur / Math.max(1, next);
      setViewStart(Math.max(0, Math.min(dur - nd, center - nd / 2)));
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      const pan = (e.deltaY !== 0 ? e.deltaY : e.deltaX) * (viewDur / 400);
      setViewStart((s) => Math.max(0, Math.min(Math.max(0, dur - viewDur), s + pan)));
    }
  }

  if (overlays.length === 0) {
    return (
      <div className="fx-timeline empty">
        <p className="muted">
          Efekt yok — sağ panelden ekleyin; video üzerinde sürükleyip boyutlandırın.
        </p>
        {onAdd ? (
          <button type="button" className="btn" onClick={onAdd}>
            + Metin ekle
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="fx-timeline"
      onPointerMove={onClipPointerMove}
      onPointerUp={onClipPointerUp}
      onPointerCancel={onClipPointerUp}
      onWheel={onWheel}
    >
      <div className="fx-timeline-toolbar">
        <span className="muted">
          Ctrl+kaydır yakınlaştır · Shift+kaydır kaydır · Ctrl+sürükle kenara yapış · Ctrl+sol/sağ tık
          giriş/çıkış
        </span>
        <span className="muted">
          {formatDuration(clampedStart)}–{formatDuration(clampedStart + viewDur)} · {zoom.toFixed(1)}x
        </span>
      </div>
      <div className="fx-tracks" style={{ ["--ph" as string]: playhead / 100 }}>
        {playhead >= 0 && playhead <= 100 ? <div className="fx-playhead-line" /> : null}
        {overlays.map((ov) => {
          const start = ov.start_sec ?? 0;
          const end = ov.end_sec ?? dur;
          const left = ((start - clampedStart) / viewDur) * 100;
          const width = Math.max(1.2, ((end - start) / viewDur) * 100);
          const visible = end >= clampedStart && start <= clampedStart + viewDur;
          const showTip = drag?.id === ov.id && (drag.mode === "start" || drag.mode === "end");
          return (
            <div
              key={ov.id}
              className={`fx-track ${selectedId === ov.id ? "selected" : ""}`}
              onClick={() => onSelect(ov.id)}
            >
              <span className="fx-track-label">{LABELS[ov.type] || ov.type}</span>
              <div
                className="fx-track-lane"
                ref={(el) => {
                  laneRefs.current[ov.id] = el;
                }}
                onPointerDown={(e) => onLaneClick(e, ov)}
                onContextMenu={(e) => onLaneContextMenu(e, ov)}
              >
                {visible ? (
                  <div
                    className="fx-clip"
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${formatDuration(start)} → ${formatDuration(end)}`}
                    onPointerDown={(e) => onClipPointerDown(e, ov, "move")}
                  >
                    {showTip ? (
                      <span className="fx-drag-tip">
                        {formatDuration(drag.tip)}
                      </span>
                    ) : null}
                    <span
                      className="fx-handle start"
                      onPointerDown={(e) => onClipPointerDown(e, ov, "start")}
                    />
                    <span className="fx-clip-text">
                      {ov.type === "text"
                        ? ov.text || "Metin"
                        : ov.type === "speed"
                          ? `${ov.speed ?? 1}x`
                          : LABELS[ov.type]}
                    </span>
                    <span
                      className="fx-handle end"
                      onPointerDown={(e) => onClipPointerDown(e, ov, "end")}
                    />
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="fx-del"
                title="Sil"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(ov.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
