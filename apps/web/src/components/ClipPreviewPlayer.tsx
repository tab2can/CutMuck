"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { formatDuration } from "@/lib/api";
import { HlsPlayer } from "@/components/HlsPlayer";

type Props = {
  src: string;
  /** Cut file (mp4) vs HLS stream of full source */
  isCutFile?: boolean;
  startSec: number;
  endSec: number;
  videoRef: RefObject<HTMLVideoElement | null>;
  disabled?: boolean;
};

/**
 * Preview that behaves like a standalone clip: timeline 0 → clipLen,
 * even when the underlying source is a long live DVR / VOD.
 */
export function ClipPreviewPlayer({
  src,
  isCutFile = false,
  startSec,
  endSec,
  videoRef,
  disabled = false,
}: Props) {
  const clipLen = Math.max(0.1, endSec - startSec);
  const [rel, setRel] = useState(0);
  const [playing, setPlaying] = useState(false);
  const scrubbing = useRef(false);

  useEffect(() => {
    if (!isCutFile) return;
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      try {
        v.currentTime = 0;
      } catch {
        // ignore
      }
      void v.play().catch(() => {
        v.muted = true;
        void v.play().catch(() => undefined);
      });
    };
    if (v.readyState >= 1) onMeta();
    else v.addEventListener("loadedmetadata", onMeta, { once: true });
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [isCutFile, src, videoRef]);

  function syncFromVideo(t: number) {
    if (scrubbing.current) return;
    if (isCutFile) {
      setRel(Math.min(clipLen, Math.max(0, t)));
      return;
    }
    setRel(Math.min(clipLen, Math.max(0, t - startSec)));
  }

  function seekRel(next: number) {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.min(clipLen, Math.max(0, next));
    setRel(clamped);
    try {
      v.currentTime = isCutFile ? clamped : startSec + clamped;
    } catch {
      // ignore
    }
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v || disabled) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }

  return (
    <div className="clip-preview">
      <div className="clip-preview-stage">
        {isCutFile ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            ref={videoRef}
            className="player-video"
            src={src}
            playsInline
            preload="auto"
            crossOrigin="anonymous"
            onTimeUpdate={(e) => syncFromVideo(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              seekRel(0);
              setPlaying(false);
            }}
          />
        ) : (
          <HlsPlayer
            src={src}
            videoRef={videoRef}
            controls={false}
            startAt={startSec}
            clipEnd={endSec}
            onTime={syncFromVideo}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        )}
      </div>

      <div className={`clip-preview-controls ${disabled ? "disabled" : ""}`}>
        <button
          type="button"
          className="clip-preview-play"
          disabled={disabled}
          onClick={togglePlay}
          aria-label={playing ? "Duraklat" : "Oynat"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="clip-preview-time">
          {formatDuration(rel)} / {formatDuration(clipLen)}
        </span>
        <input
          type="range"
          className="clip-preview-scrub"
          min={0}
          max={clipLen}
          step={0.05}
          value={Math.min(clipLen, rel)}
          disabled={disabled}
          onPointerDown={() => {
            scrubbing.current = true;
          }}
          onPointerUp={() => {
            scrubbing.current = false;
          }}
          onChange={(e) => seekRel(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
