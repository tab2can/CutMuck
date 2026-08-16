"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { TimelineOverlay } from "@/lib/api";
import { fadeBlackAlpha } from "@/lib/fadeBlack";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlays: TimelineOverlay[];
  current: number;
};

/**
 * Frame-synced black fade. Opacity updates every animation frame from
 * video.currentTime — avoids the stepped look from sparse timeupdate events.
 */
export function SmoothFadeOverlay({ videoRef, overlays, current }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const overlaysRef = useRef(overlays);
  const currentRef = useRef(current);
  overlaysRef.current = overlays;
  currentRef.current = current;

  const hasFade = overlays.some((o) => o.type === "fadeblack" || o.type === "fade");

  useEffect(() => {
    if (!hasFade) return;

    let raf = 0;
    let lastAlpha = -1;

    const tick = () => {
      const el = layerRef.current;
      const v = videoRef.current;
      if (el) {
        const t =
          v && Number.isFinite(v.currentTime)
            ? v.currentTime
            : currentRef.current;
        const { alpha, color } = fadeBlackAlpha(overlaysRef.current, t);
        // sub-frame precision; skip tiny writes
        if (Math.abs(alpha - lastAlpha) > 0.00005 || lastAlpha < 0) {
          lastAlpha = alpha;
          el.style.background = color;
          el.style.opacity = alpha.toFixed(5);
          el.style.visibility = alpha > 0.0002 ? "visible" : "hidden";
        }
      }
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [hasFade, videoRef]);

  if (!hasFade) return null;

  return (
    <div
      ref={layerRef}
      className="player-fx-filter fade-black smooth"
      style={{ opacity: 0, willChange: "opacity" }}
      aria-hidden
    />
  );
}
