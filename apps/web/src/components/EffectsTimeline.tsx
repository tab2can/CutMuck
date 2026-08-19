"use client";

import { useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { TimelineOverlay } from "@/lib/api";
import { formatDuration } from "@/lib/api";
import { clampViewStart, useTimelineWheel, zoomAround } from "@/lib/timelineView";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";

type Props = {
  overlays: TimelineOverlay[];
  duration: number;
  current: number;
  inPoint: number;
  outPoint: number;
  zoom: number;
  viewStart: number;
  onZoom: (z: number) => void;
  onViewStart: (t: number) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<TimelineOverlay>) => void;
  onCommit?: () => void;
  onRemove: (id: string) => void;
  onAdd?: () => void;
  onMove?: (id: string, where: "front" | "back" | "up" | "down") => void;
  onDuplicate?: (id: string) => void;
  onReorder?: (fromId: string, toId: string) => void;
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

function snapTime(
  t: number,
  dur: number,
  ctrl: boolean,
  viewDur: number,
  laneWidth: number,
  inPoint: number,
  outPoint: number
) {
  if (!ctrl || laneWidth <= 0) return Math.max(0, Math.min(dur, t));
  const threshold = (SNAP_PX / laneWidth) * viewDur;
  const candidates = [0, dur, inPoint, outPoint];
  let best = t;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(t - c);
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return Math.max(0, Math.min(dur, best));
}

export function EffectsTimeline({
  overlays,
  duration,
  current,
  inPoint,
  outPoint,
  zoom,
  viewStart,
  onZoom,
  onViewStart,
  selectedId,
  onSelect,
  onChange,
  onCommit,
  onRemove,
  onAdd,
  onMove,
  onDuplicate,
  onReorder,
}: Props) {
  const dur = Math.max(duration, 1);
  const rootRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const dragTrackId = useRef<string | null>(null);
  const [hover, setHover] = useState<{ id: string; t: number } | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    mode: DragMode;
    originX: number;
    start: number;
    end: number;
    tip: number;
  } | null>(null);

  const viewDur = dur / Math.max(1, zoom);
  const clampedStart = clampViewStart(viewStart, dur, viewDur);

  const playheadPct = useMemo(() => {
    if (viewDur <= 0) return -1;
    return ((current - clampedStart) / viewDur) * 100;
  }, [current, clampedStart, viewDur]);

  const inPct = ((inPoint - clampedStart) / viewDur) * 100;
  const outPct = ((outPoint - clampedStart) / viewDur) * 100;

  function timeFromClientX(id: string, clientX: number) {
    const lane = laneRefs.current[id] || rootRef.current?.querySelector(".fx-track-lane");
    if (!lane || viewDur <= 0) return 0;
    const r = (lane as HTMLElement).getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return clampedStart + ratio * viewDur;
  }

  function laneWidth(id: string) {
    return laneRefs.current[id]?.getBoundingClientRect().width || 1;
  }

  useTimelineWheel(
    rootRef,
    (e) => {
      const anyLane = Object.values(laneRefs.current).find(Boolean) || rootRef.current;
      if (!anyLane || viewDur <= 0) return;
      const r = anyLane.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
      const anchor = clampedStart + ratio * viewDur;
      if (e.ctrlKey || e.metaKey) {
        const next = zoomAround(
          dur,
          clampedStart,
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
        onViewStart(clampViewStart(clampedStart + pan, dur, viewDur));
      }
    },
    [dur, clampedStart, zoom, viewDur, onZoom, onViewStart]
  );

  function onClipPointerDown(e: PointerEvent, ov: TimelineOverlay, mode: DragMode) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(ov.id);
    if (ov.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
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
    t = snapTime(t, dur, e.ctrlKey || e.metaKey, viewDur, width, inPoint, outPoint);

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
      const thr = (SNAP_PX / width) * viewDur;
      if (Math.abs(ns - 0) <= thr) ns = 0;
      else if (Math.abs(ns + len - dur) <= thr) ns = dur - len;
      else if (Math.abs(ns - inPoint) <= thr) ns = inPoint;
      else if (Math.abs(ns + len - outPoint) <= thr) ns = outPoint - len;
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
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      onSelect(ov.id);
      const t = timeFromClientX(ov.id, e.clientX);
      const start = ov.start_sec ?? 0;
      onChange(ov.id, { end_sec: Math.max(t, start + 0.1) });
      onCommit?.();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onSelect(ov.id);
    setMenu({ x: e.clientX, y: e.clientY, id: ov.id });
  }

  function reorderVisual(fromId: string, toId: string) {
    if (fromId === toId) return;
    onReorder?.(fromId, toId);
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
      { id: "del", label: "Sil", danger: true, onSelect: () => onRemove(id) },
    ];
  }

  if (overlays.length === 0) {
    return (
      <div className="fx-timeline empty" ref={rootRef}>
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
      ref={rootRef}
      onPointerMove={onClipPointerMove}
      onPointerUp={onClipPointerUp}
      onPointerCancel={onClipPointerUp}
    >
      <div className="fx-timeline-toolbar">
        <span className="muted">
          Ctrl+kaydır yakınlaştır · Shift+kaydır kaydır · Ctrl+sürükle (In/Out’a yapış) · Ctrl+sol/sağ
          tık
        </span>
        <span className="muted">
          {formatDuration(clampedStart)}–{formatDuration(clampedStart + viewDur)} · {zoom.toFixed(1)}x
        </span>
      </div>
      <div className="fx-tracks">
        {overlays.map((ov) => {
          const start = ov.start_sec ?? 0;
          const end = ov.end_sec ?? dur;
          const left = ((start - clampedStart) / viewDur) * 100;
          const width = Math.max(1.2, ((end - start) / viewDur) * 100);
          const visible = end >= clampedStart && start <= clampedStart + viewDur;
          const tipT =
            drag?.id === ov.id
              ? drag.tip
              : hover?.id === ov.id
                ? hover.t
                : null;
          return (
            <div
              key={ov.id}
              className={`fx-track ${selectedId === ov.id ? "selected" : ""} ${ov.hidden ? "is-hidden" : ""}`}
              onClick={() => onSelect(ov.id)}
              onContextMenu={(e) => onLaneContextMenu(e, ov)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragTrackId.current;
                dragTrackId.current = null;
                if (from) reorderVisual(from, ov.id);
              }}
            >
              <button
                type="button"
                className="fx-eye"
                title={ov.hidden ? "Göster" : "Gizle"}
                aria-label={ov.hidden ? "Göster" : "Gizle"}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(ov.id, { hidden: !ov.hidden });
                  onCommit?.();
                }}
              >
                {ov.hidden ? "○" : "●"}
              </button>
              <span
                className="fx-track-label"
                draggable
                onDragStart={() => {
                  dragTrackId.current = ov.id;
                }}
                title="Sürükleyerek sıra değiştir"
              >
                {LABELS[ov.type] || ov.type}
              </span>
              <div
                className="fx-track-lane"
                ref={(el) => {
                  laneRefs.current[ov.id] = el;
                }}
                onPointerDown={(e) => onLaneClick(e, ov)}
                onContextMenu={(e) => onLaneContextMenu(e, ov)}
                onPointerMove={(e) => {
                  if (drag) return;
                  setHover({ id: ov.id, t: timeFromClientX(ov.id, e.clientX) });
                }}
                onPointerLeave={() => setHover((h) => (h?.id === ov.id ? null : h))}
              >
                {/* Cut range (In–Out) mirrored from main timeline */}
                <div
                  className="fx-cut-range"
                  style={{
                    left: `${inPct}%`,
                    width: `${Math.max(0, outPct - inPct)}%`,
                  }}
                />
                <div className="fx-cut-mark in" style={{ left: `${inPct}%` }} title="In" />
                <div className="fx-cut-mark out" style={{ left: `${outPct}%` }} title="Out" />
                {playheadPct >= 0 && playheadPct <= 100 ? (
                  <div className="fx-lane-playhead" style={{ left: `${playheadPct}%` }} />
                ) : null}
                {visible ? (
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
                ) : null}
                {tipT != null ? (
                  <div className="fx-hover-tip" style={{ left: `${((tipT - clampedStart) / viewDur) * 100}%` }}>
                    {formatDuration(tipT)}
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
