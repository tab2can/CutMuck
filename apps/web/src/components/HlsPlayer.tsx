"use client";

import Hls from "hls.js";
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";

type Props = {
  src: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  hlsRef?: MutableRefObject<Hls | null>;
  live?: boolean;
  /** Native browser controls (publish preview, etc.) */
  controls?: boolean;
  /** Seek here after manifest is ready (clip In point) */
  startAt?: number;
  /** Loop back to startAt when reaching this time */
  clipEnd?: number;
  onReady?: (duration: number) => void;
  onTime?: (t: number) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onPlaying?: () => void;
  onError?: (message: string) => void;
  poster?: string | null;
};

const VOD_CONFIG: Partial<Hls["config"]> = {
  enableWorker: true,
  lowLatencyMode: false,
  backBufferLength: 12,
  maxBufferLength: 24,
  maxMaxBufferLength: 48,
  maxBufferSize: 40 * 1000 * 1000,
  maxBufferHole: 1.0,
  nudgeMaxRetry: 10,
  startLevel: -1,
  capLevelToPlayerSize: true,
  progressive: false,
  maxLoadingDelay: 6,
  maxStarvationDelay: 6,
  fragLoadingTimeOut: 30000,
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 800,
  manifestLoadingTimeOut: 30000,
  manifestLoadingMaxRetry: 4,
  levelLoadingTimeOut: 30000,
  levelLoadingMaxRetry: 4,
  startFragPrefetch: false,
  testBandwidth: false,
};

/** Kick live DVR: join near edge once; never auto-catchup when user scrubs history. */
const LIVE_CONFIG: Partial<Hls["config"]> = {
  enableWorker: true,
  lowLatencyMode: false,
  liveSyncDurationCount: 2,
  // Disable latency-forced seek-to-live (default ~12 segs jumps you out of DVR scrub)
  liveMaxLatencyDurationCount: Infinity,
  liveDurationInfinity: false,
  maxLiveSyncPlaybackRate: 1,
  backBufferLength: Infinity,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  maxBufferSize: 60 * 1000 * 1000,
  maxBufferHole: 1.0,
  nudgeMaxRetry: 10,
  startLevel: 0,
  capLevelToPlayerSize: true,
  progressive: false,
  fragLoadingTimeOut: 20000,
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 500,
  manifestLoadingTimeOut: 45000,
  manifestLoadingMaxRetry: 5,
  levelLoadingTimeOut: 45000,
  levelLoadingMaxRetry: 5,
  startFragPrefetch: true,
  testBandwidth: false,
};

function seekLiveEdge(hls: Hls, video: HTMLVideoElement) {
  const sync = hls.liveSyncPosition;
  if (sync != null && Number.isFinite(sync) && sync >= 0) {
    try {
      video.currentTime = sync;
      return;
    } catch {
      // fall through
    }
  }
  const d = video.duration;
  if (Number.isFinite(d) && d > 0) {
    try {
      video.currentTime = Math.max(0, d - 1.5);
    } catch {
      // ignore
    }
  }
}

export function HlsPlayer({
  src,
  videoRef,
  hlsRef: externalHlsRef,
  live = false,
  controls = false,
  startAt,
  clipEnd,
  onReady,
  onTime,
  onPlay,
  onPause,
  onWaiting,
  onPlaying,
  onError,
  poster,
}: Props) {
  const localHlsRef = useRef<Hls | null>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const startAtRef = useRef(startAt);
  const clipEndRef = useRef(clipEnd);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  startAtRef.current = startAt;
  clipEndRef.current = clipEnd;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let destroyed = false;
    let joinedLive = false;
    let followLive = true; // false after user scrubs into DVR history
    let startApplied = false;
    const clipPreview = startAt != null && Number.isFinite(startAt) && startAt >= 0;
    const isHls = src.includes(".m3u8") || src.includes("stream.m3u8");

    const emitReady = (explicit?: number) => {
      if (explicit != null && Number.isFinite(explicit) && explicit > 0) {
        onReadyRef.current?.(explicit);
        return;
      }
      const d = video.duration;
      if (d && Number.isFinite(d) && d > 0) onReadyRef.current?.(d);
      else if (live) onReadyRef.current?.(0);
    };

    const assignHls = (h: Hls | null) => {
      localHlsRef.current = h;
      if (externalHlsRef) externalHlsRef.current = h;
    };

    const applyStartAt = () => {
      const t = startAtRef.current;
      if (startApplied || t == null || !Number.isFinite(t) || t < 0) return;
      try {
        video.currentTime = t;
        startApplied = true;
        followLive = false;
        joinedLive = true;
      } catch {
        // ignore
      }
    };

    const joinLiveOnce = (hls: Hls) => {
      if (!live || clipPreview || joinedLive || !followLive) return;
      seekLiveEdge(hls, video);
      joinedLive = true;
      void video.play().catch(() => undefined);
    };

    const onSeeking = () => {
      if (!live || !followLive || clipPreview) return;
      const hls = localHlsRef.current;
      const sync = hls?.liveSyncPosition;
      if (sync != null && Number.isFinite(sync) && video.currentTime < sync - 3) {
        followLive = false;
      }
    };

    const onTimeLoop = () => {
      const end = clipEndRef.current;
      const start = startAtRef.current;
      if (end == null || start == null || !(end > start)) return;
      if (video.currentTime >= end - 0.05) {
        try {
          video.currentTime = start;
        } catch {
          // ignore
        }
      }
    };

    video.addEventListener("seeking", onSeeking);
    if (clipPreview) video.addEventListener("timeupdate", onTimeLoop);

    if (isHls && Hls.isSupported()) {
      // Clip preview on publish uses VOD-friendly config even for live DVR sources
      const hls = new Hls(live && !clipPreview ? LIVE_CONFIG : VOD_CONFIG);
      assignHls(hls);
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (destroyed) return;
        emitReady();
        if (!live && data.levels?.length > 1) {
          const idx = data.levels.findIndex(
            (l) => (l.height || 0) > 0 && (l.height || 0) <= 720
          );
          hls.currentLevel = idx >= 0 ? idx : Math.min(1, data.levels.length - 1);
        }
        if (clipPreview) {
          applyStartAt();
          void video.play().catch(() => {
            video.muted = true;
            void video.play().catch(() => undefined);
          });
        } else {
          joinLiveOnce(hls);
        }
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
        if (destroyed) return;
        const total = data.details?.totalduration;
        const edge = data.details?.edge;
        const liveSync = hls.liveSyncPosition;
        const best =
          [total, edge, liveSync, video.duration].find(
            (v) => v != null && Number.isFinite(v) && (v as number) > 0
          ) ?? 0;
        if (live && best) emitReady(Number(best));
        else emitReady();
        if (clipPreview) applyStartAt();
        else joinLiveOnce(hls);
      });
      hls.on(Hls.Events.LEVEL_UPDATED, (_e, data) => {
        if (destroyed || !live || clipPreview) return;
        const total = data.details?.totalduration;
        if (total != null && Number.isFinite(total) && total > 0) {
          emitReady(total);
        }
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (destroyed) return;
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          window.setTimeout(() => {
            if (!destroyed) hls.startLoad();
          }, 400);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }
        onErrorRef.current?.(data.details || "HLS oynatma hatası");
      });

      return () => {
        destroyed = true;
        video.removeEventListener("seeking", onSeeking);
        video.removeEventListener("timeupdate", onTimeLoop);
        try {
          hls.stopLoad();
          hls.detachMedia();
          hls.destroy();
        } catch {
          // ignore
        }
        assignHls(null);
      };
    }

    if (isHls && video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      if (clipPreview) {
        const onMeta = () => {
          applyStartAt();
          void video.play().catch(() => {
            video.muted = true;
            void video.play().catch(() => undefined);
          });
        };
        video.addEventListener("loadedmetadata", onMeta, { once: true });
      } else if (live) {
        void video.play().catch(() => undefined);
      }
      return () => {
        destroyed = true;
        video.removeEventListener("seeking", onSeeking);
        video.removeEventListener("timeupdate", onTimeLoop);
        video.removeAttribute("src");
        video.load();
      };
    }

    video.src = src;
    if (clipPreview) {
      const onMeta = () => {
        applyStartAt();
        void video.play().catch(() => {
          video.muted = true;
          void video.play().catch(() => undefined);
        });
      };
      video.addEventListener("loadedmetadata", onMeta, { once: true });
    }
    return () => {
      destroyed = true;
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("timeupdate", onTimeLoop);
      video.removeAttribute("src");
      video.load();
    };
  }, [src, videoRef, externalHlsRef, live, startAt]);

  return (
    <video
      ref={videoRef}
      className="player-video"
      controls={controls}
      playsInline
      muted={live && !controls}
      autoPlay={live && !controls}
      preload="auto"
      poster={poster || undefined}
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        if (d && Number.isFinite(d) && d > 0) onReady?.(d);
        else if (live) onReady?.(0);
      }}
      onDurationChange={(e) => {
        const d = e.currentTarget.duration;
        if (d && Number.isFinite(d) && d > 0) onReady?.(d);
      }}
      onTimeUpdate={(e) => onTime?.(e.currentTarget.currentTime)}
      onPlay={() => onPlay?.()}
      onPause={() => onPause?.()}
      onWaiting={() => onWaiting?.()}
      onPlaying={() => onPlaying?.()}
    />
  );
}

export function seekHlsLiveEdge(hls: Hls | null, video: HTMLVideoElement | null) {
  if (!video) return;
  if (hls) {
    seekLiveEdge(hls, video);
    return;
  }
  const d = video.duration;
  if (Number.isFinite(d) && d > 0) {
    try {
      video.currentTime = Math.max(0, d - 1.5);
    } catch {
      // ignore
    }
  }
}
