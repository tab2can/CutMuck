"use client";

import { useEffect, useRef, type RefObject } from "react";

/** Non-passive wheel so Ctrl+scroll zooms the timeline instead of the browser page. */
export function useTimelineWheel(
  ref: RefObject<HTMLElement | null>,
  handler: (e: WheelEvent) => void,
  deps: unknown[]
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handlerRef.current(e);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);
}

export function clampViewStart(start: number, duration: number, viewDur: number) {
  return Math.max(0, Math.min(Math.max(0, duration - viewDur), start));
}

export function zoomAround(
  duration: number,
  viewStart: number,
  zoom: number,
  nextZoom: number,
  anchorTime: number
) {
  const z = Math.min(12, Math.max(1, nextZoom));
  const oldDur = duration / Math.max(1, zoom);
  const newDur = duration / Math.max(1, z);
  const ratio = oldDur > 0 ? (anchorTime - viewStart) / oldDur : 0.5;
  const start = clampViewStart(anchorTime - ratio * newDur, duration, newDur);
  return { zoom: z, viewStart: start };
}
