"use client";

import { useRef, type PointerEvent } from "react";

type Props = {
  orientation: "horizontal" | "vertical";
  onDelta: (delta: number) => void;
  onDragEnd?: () => void;
  className?: string;
};

export function SplitHandle({
  orientation,
  onDelta,
  onDragEnd,
  className = "",
}: Props) {
  const dragging = useRef(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const delta = orientation === "horizontal" ? e.movementY : e.movementX;
    if (delta !== 0) onDelta(delta);
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    onDragEnd?.();
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation === "horizontal" ? "horizontal" : "vertical"}
      className={`split-handle split-${orientation} ${className}`.trim()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
