"use client";

import { useRef, useState, type PointerEvent } from "react";
import type { TimelineOverlay } from "@/lib/api";

type Props = {
  overlays: TimelineOverlay[];
  current: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<TimelineOverlay>) => void;
  onCommit?: () => void;
};

function visibleAt(ov: TimelineOverlay, t: number) {
  const start = ov.start_sec ?? 0;
  const end = ov.end_sec;
  if (t < start) return false;
  if (end != null && t > end) return false;
  return true;
}

export function OverlayCanvas({
  overlays,
  current,
  selectedId,
  onSelect,
  onChange,
  onCommit,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<"move" | "resize" | null>(null);
  const dragId = useRef<string | null>(null);

  const visual = overlays.filter(
    (o) => (o.type === "text" || o.type === "rect") && visibleAt(o, current)
  );

  function toNorm(clientX: number, clientY: number) {
    const el = stageRef.current;
    if (!el) return { x: 0.5, y: 0.5 };
    const r = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    };
  }

  function onPointerDown(
    e: PointerEvent,
    id: string,
    mode: "move" | "resize"
  ) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragId.current = id;
    onSelect(id);
    setDrag(mode);
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag || !dragId.current) return;
    const id = dragId.current;
    const { x, y } = toNorm(e.clientX, e.clientY);
    const ov = overlays.find((o) => o.id === id);
    if (!ov) return;
    if (drag === "move") {
      onChange(id, { x, y });
      return;
    }
    const cx = ov.x ?? 0.5;
    const cy = ov.y ?? 0.5;
    const w = Math.min(0.9, Math.max(0.06, Math.abs(x - cx) * 2));
    const h = Math.min(0.9, Math.max(0.04, Math.abs(y - cy) * 2));
    if (ov.type === "text") {
      const font = Math.round(16 + h * 160);
      onChange(id, { w, h, font_size: Math.min(96, Math.max(16, font)) });
    } else {
      onChange(id, { w, h });
    }
  }

  function onPointerUp() {
    if (drag) onCommit?.();
    setDrag(null);
    dragId.current = null;
  }

  return (
    <div
      ref={stageRef}
      className="overlay-canvas"
      onPointerDown={() => onSelect(null)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {visual.map((ov) => {
        const selected = selectedId === ov.id;
        const x = (ov.x ?? 0.5) * 100;
        const y = (ov.y ?? 0.5) * 100;
        const w = (ov.w ?? 0.28) * 100;
        const h = (ov.h ?? 0.12) * 100;
        if (ov.type === "rect") {
          return (
            <div
              key={ov.id}
              className={`ov-item ov-rect ${selected ? "selected" : ""}`}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                width: `${w}%`,
                height: `${h}%`,
                background: ov.color || "rgba(61,214,198,0.35)",
                opacity: ov.opacity ?? 0.7,
                transform: `translate(-50%, -50%) rotate(${ov.rotation || 0}deg)`,
              }}
              onPointerDown={(e) => onPointerDown(e, ov.id, "move")}
            >
              {selected ? (
                <span
                  className="ov-handle"
                  onPointerDown={(e) => onPointerDown(e, ov.id, "resize")}
                />
              ) : null}
            </div>
          );
        }
        return (
          <div
            key={ov.id}
            className={`ov-item ov-text ${selected ? "selected" : ""}`}
            style={{
              left: `${x}%`,
              top: `${y}%`,
              fontSize: `clamp(14px, ${(ov.font_size || 42) * 0.055}vw, ${ov.font_size || 42}px)`,
              color: ov.color || "#fff",
              background: ov.bg || "transparent",
              opacity: ov.opacity ?? 1,
              transform: `translate(-50%, -50%) rotate(${ov.rotation || 0}deg)`,
            }}
            onPointerDown={(e) => onPointerDown(e, ov.id, "move")}
          >
            {ov.text || "Metin"}
            {selected ? (
              <span
                className="ov-handle"
                onPointerDown={(e) => onPointerDown(e, ov.id, "resize")}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
