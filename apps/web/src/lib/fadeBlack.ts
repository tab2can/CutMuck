import type { TimelineOverlay } from "@/lib/api";

/** Quintic smootherstep — C2 continuous, no visible steps */
export function smootherstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Black overlay opacity (0..1) for fadeblack/fade at time t */
export function fadeBlackAlpha(overlays: TimelineOverlay[], t: number): {
  alpha: number;
  color: string;
} {
  let alpha = 0;
  let color = "#000000";
  for (const o of overlays) {
    if (o.hidden) continue;
    if (o.type !== "fadeblack" && o.type !== "fade") continue;
    const start = o.start_sec ?? 0;
    const end = o.end_sec;
    if (t < start) continue;
    if (end != null && t > end) continue;

    const holdIn = o.hold_in ?? 2;
    const holdOut = o.hold_out ?? 2;
    const fi = Math.max(0.01, o.fade_in ?? 1.5);
    const fo = Math.max(0.01, o.fade_out ?? 1.5);
    color = o.color?.startsWith("#") ? o.color : "#000000";
    const rel = t - start;
    const len = Math.max(0.01, (end ?? t + 1) - start);

    let a = 0;
    if (rel <= holdIn) {
      a = 1;
    } else if (rel < holdIn + fi) {
      a = 1 - smootherstep((rel - holdIn) / fi);
    } else if (rel >= len - holdOut) {
      a = 1;
    } else if (rel > len - holdOut - fo) {
      a = smootherstep((rel - (len - holdOut - fo)) / fo);
    }
    alpha = Math.max(alpha, a);
  }
  return { alpha, color };
}
