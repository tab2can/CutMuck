"use client";

import { useRef, useState, type PointerEvent, type MouseEvent } from "react";
import type { TimelineOverlay } from "@/lib/api";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";

type MoveWhere = "front" | "back" | "up" | "down";

type Props = {
  overlays: TimelineOverlay[];
  current: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<TimelineOverlay>) => void;
  onCommit?: () => void;
  onMove?: (id: string, where: MoveWhere) => void;
  onRemove?: (id: string) => void;
  onDuplicate?: (id: string) => void;
};

function visibleAt(ov: TimelineOverlay, t: number) {
  if (ov.hidden) return false;
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
  onMove,
  onRemove,
  onDuplicate,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<"move" | "resize" | null>(null);
  const dragId = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const visual = overlays.filter((o) => (o.type === "text" || o.type === "rect") && visibleAt(o, current));

  function toNorm(clientX: number, clientY: number) {
    const el = stageRef.current;
    if (!el) return { x: 0.5, y: 0.5 };
    const r = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    };
  }

  function onPointerDown(e: PointerEvent, id: string, mode: "move" | "resize") {
    e.stopPropagation();
    e.preventDefault();
    const ov = overlays.find((o) => o.id === id);
    onSelect(id);
    if (ov?.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragId.current = id;
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

  function openMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    onSelect(id);
    setMenu({ x: e.clientX, y: e.clientY, id });
  }

  function menuItems(id: string): MenuItem[] {
    const ov = overlays.find((o) => o.id === id);
    if (!ov) return [];
    const i = overlays.findIndex((o) => o.id === id);
    const last = overlays.length - 1;
    const noop = () => undefined;
    return [
      { id: "front", label: "Üste taşı", disabled: i === last, onSelect: () => onMove?.(id, "front") },
      { id: "back", label: "Alta taşı", disabled: i === 0, onSelect: () => onMove?.(id, "back") },
      { id: "up", label: "Bir üste", disabled: i === last, onSelect: () => onMove?.(id, "up") },
      { id: "down", label: "Bir alta", disabled: i === 0, onSelect: () => onMove?.(id, "down") },
      { id: "sep1", label: "", separator: true, onSelect: noop },
      { id: "vis", label: ov.hidden ? "Göster" : "Gizle", onSelect: () => { onChange(id, { hidden: !ov.hidden }); onCommit?.(); } },
      { id: "lock", label: ov.locked ? "Kilidi aç" : "Kilitle", onSelect: () => { onChange(id, { locked: !ov.locked }); onCommit?.(); } },
      { id: "sep2", label: "", separator: true, onSelect: noop },
      { id: "dup", label: "Kopyala", onSelect: () => onDuplicate?.(id) },
      { id: "del", label: "Sil", danger: true, onSelect: () => onRemove?.(id) },
    ];
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
        const z = 4 + overlays.findIndex((o) => o.id === ov.id);
        if (ov.type === "rect") {
          return (
            <div
              key={ov.id}
              className={`ov-item ov-rect ${selected ? "selected" : ""} ${ov.locked ? "locked" : ""}`}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                width: `${w}%`,
                height: `${h}%`,
                zIndex: z,
                background: ov.color || "rgba(61,214,198,0.35)",
                opacity: ov.opacity ?? 0.7,
                transform: `translate(-50%, -50%) rotate(${ov.rotation || 0}deg)`,
                cursor: ov.locked ? "default" : "move",
              }}
              onPointerDown={(e) => onPointerDown(e, ov.id, "move")}
              onContextMenu={(e) => openMenu(e, ov.id)}
            >
              {selected && !ov.locked ? (
                <span className="ov-handle" onPointerDown={(e) => onPointerDown(e, ov.id, "resize")} />
              ) : null}
            </div>
          );
        }
        return (
          <div
            key={ov.id}
            className={`ov-item ov-text ${selected ? "selected" : ""} ${ov.locked ? "locked" : ""}`}
            style={{
              left: `${x}%`,
              top: `${y}%`,
              zIndex: z,
              fontSize: `clamp(14px, ${(ov.font_size || 42) * 0.055}vw, ${ov.font_size || 42}px)`,
              color: ov.color || "#fff",
              background: ov.bg || "transparent",
              opacity: ov.opacity ?? 1,
              transform: `translate(-50%, -50%) rotate(${ov.rotation || 0}deg)`,
              cursor: ov.locked ? "default" : "move",
            }}
            onPointerDown={(e) => onPointerDown(e, ov.id, "move")}
            onContextMenu={(e) => openMenu(e, ov.id)}
          >
            {ov.text || "Metin"}
            {selected && !ov.locked ? (
              <span className="ov-handle" onPointerDown={(e) => onPointerDown(e, ov.id, "resize")} />
            ) : null}
          </div>
        );
      })}
      <ContextMenu
        open={!!menu}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu ? menuItems(menu.id) : []}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}
