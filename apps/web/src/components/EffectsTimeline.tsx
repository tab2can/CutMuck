"use client";

import { useRef, useState, type PointerEvent } from "react";
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
  const playhead = Math.min(100, (current / dur) * 100);
  const laneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [drag, setDrag] = useState<{
    id: string;
    mode: DragMode;
    originX: number;
    start: number;
    end: number;
  } | null>(null);

  function timeFromClientX(id: string, clientX: number) {
    const lane = laneRefs.current[id];
    if (!lane) return 0;
    const r = lane.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return ratio * dur;
  }

  function onClipPointerDown(
    e: PointerEvent,
    ov: TimelineOverlay,
    mode: DragMode
  ) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSelect(ov.id);
    setDrag({
      id: ov.id,
      mode,
      originX: e.clientX,
      start: ov.start_sec ?? 0,
      end: ov.end_sec ?? dur,
    });
  }

  function onClipPointerMove(e: PointerEvent) {
    if (!drag) return;
    const t = timeFromClientX(drag.id, e.clientX);
    if (drag.mode === "start") {
      onChange(drag.id, {
        start_sec: Math.min(t, drag.end - 0.1),
      });
      return;
    }
    if (drag.mode === "end") {
      onChange(drag.id, {
        end_sec: Math.max(t, drag.start + 0.1),
      });
      return;
    }
    const lane = laneRefs.current[drag.id];
    if (!lane) return;
    const dx = e.clientX - drag.originX;
    const dt = (dx / lane.getBoundingClientRect().width) * dur;
    const len = Math.max(0.1, drag.end - drag.start);
    let ns = drag.start + dt;
    ns = Math.max(0, Math.min(dur - len, ns));
    onChange(drag.id, { start_sec: ns, end_sec: ns + len });
  }

  function onClipPointerUp() {
    if (drag) onCommit?.();
    setDrag(null);
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
    >
      <div className="fx-tracks" style={{ ["--ph" as string]: playhead / 100 }}>
        <div className="fx-playhead-line" />
        {overlays.map((ov) => {
          const start = ov.start_sec ?? 0;
          const end = ov.end_sec ?? dur;
          const left = (start / dur) * 100;
          const width = Math.max(1.5, ((end - start) / dur) * 100);
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
              >
                <div
                  className="fx-clip"
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${formatDuration(start)} → ${formatDuration(end)}`}
                  onPointerDown={(e) => onClipPointerDown(e, ov, "move")}
                >
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
