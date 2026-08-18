"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

type Props = {
  orientation: "horizontal" | "vertical";
  onDelta: (delta: number) => void;
  onDragEnd?: () => void;
  className?: string;
  label?: string;
};

export function SplitHandle({
  orientation,
  onDelta,
  onDragEnd,
  className = "",
  label,
}: Props) {
  const dragging = useRef(false);
  const last = useRef(0);
  const onDeltaRef = useRef(onDelta);
  const onDragEndRef = useRef(onDragEnd);
  onDeltaRef.current = onDelta;
  onDragEndRef.current = onDragEnd;

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragging.current) return;
      e.preventDefault();
      const pos = orientation === "horizontal" ? e.clientY : e.clientX;
      const delta = pos - last.current;
      if (delta === 0) return;
      last.current = pos;
      onDeltaRef.current(delta);
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("is-resizing-panels");
      delete document.body.dataset.panelResize;
      onDragEndRef.current?.();
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("is-resizing-panels");
      delete document.body.dataset.panelResize;
    };
  }, [orientation]);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    last.current = orientation === "horizontal" ? e.clientY : e.clientX;
    document.body.classList.add("is-resizing-panels");
    document.body.dataset.panelResize = orientation;
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label || (orientation === "horizontal" ? "Yükseklik" : "Genişlik")}
      title="Sürükleyerek boyutu ayarla"
      className={`split-handle split-${orientation} ${className}`.trim()}
      onPointerDown={onPointerDown}
    />
  );
}
