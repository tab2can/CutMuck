"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { api, mediaSrc } from "@/lib/api";
import { ColorSwatch } from "@/components/ColorSwatch";
import { loadImage, wrapText, YT_H, YT_W, fileToDataUrl, drawContained, drawContainedCentered } from "@/lib/ytThumb";
import {
  loadThumbPrefs,
  saveThumbPrefs,
  type FramePrefs,
  type ImagePrefs,
  type TextPrefs,
} from "@/lib/thumbPrefs";

export type ChannelAsset = {
  id: string;
  name: string;
  url: string;
  mime?: string;
};

type LayerKind = "text" | "image" | "shape";

type Layer = {
  id: string;
  kind: LayerKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotate: number;
  opacity: number;
  text: string;
  font: string;
  fontSize: number;
  color: string;
  stroke: string;
  strokeW: number;
  italic: boolean;
  bold: boolean;
  uppercase: boolean;
  letterSpacing: number;
  lineHeight: number;
  curve: number;
  shadowOn: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  src: string;
  shape: "rect" | "ellipse";
  fill: string;
  imgBorderOn: boolean;
  imgBorderColor: string;
  imgBorderW: number;
  imgGlowOn: boolean;
  imgGlowColor: string;
  imgGlowBlur: number;
};

export type ThumbProject = {
  bg: string | null;
  layers: Layer[];
  selectedId: string | null;
  frame: FramePrefs;
  brightness: number;
  contrast: number;
  saturate: number;
  flipH: boolean;
};

const FONTS = [
  { id: "impact", label: "Impact", value: 'Impact, Haettenschweiler, "Arial Black", sans-serif' },
  { id: "black", label: "Arial Black", value: '"Arial Black", Arial, sans-serif' },
  { id: "sora", label: "Sora", value: "var(--font-sora), Sora, sans-serif" },
  { id: "georgia", label: "Georgia", value: "Georgia, serif" },
];

function nid() {
  return crypto.randomUUID?.() || Math.random().toString(36).slice(2);
}

function hydrateLayer(raw: Partial<Layer> & { shadow?: boolean }): Layer {
  const kind = (raw.kind as LayerKind) || "text";
  const fallback = baseLayer(kind, { id: raw.id || nid() });
  const { shadow, ...rest } = raw;
  return {
    ...fallback,
    ...rest,
    id: raw.id || fallback.id,
    kind,
    shadowOn: raw.shadowOn ?? shadow ?? fallback.shadowOn,
  };
}

function cloneProject(p: ThumbProject): ThumbProject {
  return {
    ...p,
    layers: p.layers.map((l) => hydrateLayer(l)),
    frame: { ...loadThumbPrefs().frame, ...p.frame },
  };
}

function textFromLayer(l: Layer): TextPrefs {
  return {
    font: l.font,
    color: l.color,
    stroke: l.stroke,
    strokeW: l.strokeW,
    italic: l.italic,
    bold: l.bold,
    uppercase: l.uppercase,
    letterSpacing: l.letterSpacing,
    lineHeight: l.lineHeight,
    curve: l.curve,
    shadowOn: l.shadowOn,
    shadowColor: l.shadowColor,
    shadowBlur: l.shadowBlur,
    shadowX: l.shadowX,
    shadowY: l.shadowY,
  };
}

function imageFromLayer(l: Layer): ImagePrefs {
  return {
    imgBorderOn: l.imgBorderOn,
    imgBorderColor: l.imgBorderColor,
    imgBorderW: l.imgBorderW,
    imgGlowOn: l.imgGlowOn,
    imgGlowColor: l.imgGlowColor,
    imgGlowBlur: l.imgGlowBlur,
  };
}

function baseLayer(kind: LayerKind, patch: Partial<Layer> = {}): Layer {
  const prefs = loadThumbPrefs();
  return {
    id: nid(),
    kind,
    x: 0.5,
    y: 0.55,
    w: kind === "text" ? 0.5 : 0.32,
    h: kind === "text" ? 0.2 : 0.45,
    rotate: 0,
    opacity: 1,
    text: "ipsum",
    fontSize: 72,
    src: "",
    ...prefs.text,
    ...prefs.image,
    shape: prefs.shape.shape,
    fill: prefs.shape.fill,
    ...patch,
  };
}

function pngHaloFilter(l: Layer) {
  const parts: string[] = [];
  if (l.imgGlowOn && l.imgGlowBlur > 0) {
    const c = l.imgGlowColor;
    parts.push(`drop-shadow(0 0 ${l.imgGlowBlur * 0.4}px ${c})`);
    parts.push(`drop-shadow(0 0 ${l.imgGlowBlur * 0.9}px ${c})`);
    parts.push(`drop-shadow(0 0 ${l.imgGlowBlur * 1.85}px ${c})`);
  }
  if (l.imgBorderOn && l.imgBorderW > 0) {
    const t = Math.max(1, l.imgBorderW * 0.45);
    const c = l.imgBorderColor;
    parts.push(`drop-shadow(${t}px 0 0.6px ${c})`);
    parts.push(`drop-shadow(-${t}px 0 0.6px ${c})`);
    parts.push(`drop-shadow(0 ${t}px 0.6px ${c})`);
    parts.push(`drop-shadow(0 -${t}px 0.6px ${c})`);
    parts.push(`drop-shadow(${t * 0.7}px ${t * 0.7}px 0.8px ${c})`);
    parts.push(`drop-shadow(${-t * 0.7}px ${t * 0.7}px 0.8px ${c})`);
    parts.push(`drop-shadow(${t * 0.7}px ${-t * 0.7}px 0.8px ${c})`);
    parts.push(`drop-shadow(${-t * 0.7}px ${-t * 0.7}px 0.8px ${c})`);
    parts.push(`drop-shadow(0 0 ${l.imgBorderW * 1.1}px ${c})`);
  }
  return parts.join(" ");
}

function textShadowFilter(l: Layer) {
  if (!l.shadowOn) return "none";
  return `drop-shadow(${l.shadowX / 72}em ${l.shadowY / 72}em ${l.shadowBlur / 72}em ${l.shadowColor})`;
}

function drawSoftFrame(ctx: CanvasRenderingContext2D, frame: FramePrefs) {
  if (!frame.on) return;
  const w = Math.max(4, frame.width);
  const feather = Math.max(0, frame.feather);
  const glow = frame.glow ? Math.max(8, frame.glowBlur) : 0;
  ctx.save();
  for (let i = 5; i >= 1; i--) {
    ctx.globalAlpha = 0.1 + i * 0.08;
    ctx.strokeStyle = frame.color;
    ctx.lineWidth = w + feather * i * 0.35;
    ctx.shadowColor = frame.color;
    ctx.shadowBlur = feather * 0.8 + glow * (i / 5);
    ctx.strokeRect(w / 2, w / 2, YT_W - w, YT_H - w);
  }
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = w;
  ctx.shadowBlur = glow;
  ctx.strokeRect(w / 2, w / 2, YT_W - w, YT_H - w);
  ctx.restore();
}

type Props = {
  channelSlug: string;
  baseSrc: string | null;
  initial?: ThumbProject | null;
  onClose: (draft: ThumbProject) => void;
  onApply: (dataUrl: string, draft: ThumbProject) => void;
};

export function ThumbnailEditor({ channelSlug, baseSrc, initial, onClose, onApply }: Props) {
  const prefs = loadThumbPrefs();
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const start = initial ? cloneProject(initial) : null;
  const [bg, setBg] = useState(start?.bg ?? baseSrc);
  const [layers, setLayers] = useState<Layer[]>(start?.layers ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(start?.selectedId ?? null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [assets, setAssets] = useState<ChannelAsset[]>([]);
  const [frame, setFrame] = useState<FramePrefs>(start?.frame ?? { ...prefs.frame });
  const [brightness, setBrightness] = useState(start?.brightness ?? 100);
  const [contrast, setContrast] = useState(start?.contrast ?? 100);
  const [saturate, setSaturate] = useState(start?.saturate ?? 100);
  const [flipH, setFlipH] = useState(start?.flipH ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{
    id: string;
    mode: "move" | "resize" | "rotate";
    dx: number;
    dy: number;
    startW: number;
    startH: number;
    startDist: number;
  } | null>(null);

  const selected = layers.find((l) => l.id === selectedId) || null;
  const slug = channelSlug || "_genel";

  const loadAssets = useCallback(async () => {
    try {
      const rows = await api<ChannelAsset[]>(`/channels/${encodeURIComponent(slug)}/assets`);
      setAssets(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Görseller yüklenemedi");
    }
  }, [slug]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el?.closest("textarea, input, [contenteditable='true']")) return;
      const items = e.clipboardData?.items;
      let file: File | null = null;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            file = item.getAsFile();
            break;
          }
        }
      }
      if (!file && e.clipboardData?.files?.length) {
        const f = e.clipboardData.files[0];
        if (f?.type.startsWith("image/")) file = f;
      }
      if (!file) return;
      e.preventDefault();
      void fileToDataUrl(file).then((src) => void addImageFromSrc(src));
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    if (!initial) setBg(baseSrc);
  }, [baseSrc, initial]);

  useEffect(() => {
    saveThumbPrefs({ frame });
  }, [frame]);

  useEffect(() => {
    if (!selected) return;
    if (selected.kind === "text") saveThumbPrefs({ text: textFromLayer(selected) });
    if (selected.kind === "image") saveThumbPrefs({ image: imageFromLayer(selected) });
    if (selected.kind === "shape") saveThumbPrefs({ shape: { shape: selected.shape, fill: selected.fill } });
  }, [selected]);

  function snapshot(): ThumbProject {
    return { bg, layers, selectedId, frame, brightness, contrast, saturate, flipH };
  }

  function patchLayer(id: string, patch: Partial<Layer>) {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function addText() {
    const layer = baseLayer("text", { y: 0.62, x: 0.5 });
    setLayers((prev) => [...prev, layer]);
    setSelectedId(layer.id);
  }

  function addShape() {
    const layer = baseLayer("shape", { x: 0.5, y: 0.5, w: 0.4, h: 0.12, opacity: 0.55 });
    setLayers((prev) => [...prev, layer]);
    setSelectedId(layer.id);
  }

  async function addImageFromSrc(src: string) {
    let w = 0.28;
    let h = 0.42;
    try {
      const img = await loadImage(src);
      const pixelAR = (img.naturalWidth || 1) / (img.naturalHeight || 1);
      h = 0.42;
      w = Math.min(1.4, Math.max(0.08, h * pixelAR * (YT_H / YT_W)));
    } catch {
      /* keep default */
    }
    const layer = baseLayer("image", { src, x: 0.5, y: 0.5, w, h });
    setLayers((prev) => [...prev, layer]);
    setSelectedId(layer.id);
  }

  async function addAssetToCanvas(asset: ChannelAsset) {
    await addImageFromSrc(mediaSrc(asset.url) || asset.url);
  }

  async function uploadAsset(file: File) {
    setBusy(true);
    setError(null);
    try {
      const data_url = await fileToDataUrl(file);
      const row = await api<ChannelAsset>(`/channels/${encodeURIComponent(slug)}/assets`, {
        method: "POST",
        body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, ""), data_url }),
      });
      setAssets((prev) => [row, ...prev]);
      void addAssetToCanvas(row);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Görsel eklenemedi");
    } finally {
      setBusy(false);
    }
  }

  async function removeAsset(id: string) {
    try {
      await api(`/channels/${encodeURIComponent(slug)}/assets/${id}`, { method: "DELETE" });
      setAssets((prev) => prev.filter((a) => a.id !== id));
      setLayers((prev) => prev.filter((l) => !l.src.includes(id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Silinemedi");
    }
  }

  function toNorm(clientX: number, clientY: number) {
    const el = stageRef.current;
    if (!el) return { x: 0.5, y: 0.5 };
    const r = el.getBoundingClientRect();
    return {
      x: (clientX - r.left) / r.width,
      y: (clientY - r.top) / r.height,
    };
  }

  function onLayerDown(e: PointerEvent, id: string, mode: "move" | "resize" | "rotate") {
    e.stopPropagation();
    e.preventDefault();
    if (editingId === id && mode === "move") return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const layer = layers.find((l) => l.id === id);
    const { x, y } = toNorm(e.clientX, e.clientY);
    const lx = layer?.x ?? 0.5;
    const ly = layer?.y ?? 0.5;
    const startW = layer?.w ?? 0.3;
    const startH = layer?.h ?? 0.3;
    const startDist = Math.max(0.04, Math.hypot((x - lx) * 2, (y - ly) * 2));
    if (mode === "rotate") {
      const ang = (Math.atan2(y - ly, x - lx) * 180) / Math.PI;
      drag.current = { id, mode, dx: ang - (layer?.rotate ?? 0), dy: 0, startW, startH, startDist };
    } else {
      drag.current = { id, mode, dx: x - lx, dy: y - ly, startW, startH, startDist };
    }
    setSelectedId(id);
  }

  function onPointerMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const { x, y } = toNorm(e.clientX, e.clientY);
    const layer = layers.find((l) => l.id === d.id);
    if (!layer) return;
    if (d.mode === "move") {
      patchLayer(d.id, { x: x - d.dx, y: y - d.dy });
      return;
    }
    if (d.mode === "rotate") {
      const ang = (Math.atan2(y - layer.y, x - layer.x) * 180) / Math.PI;
      patchLayer(d.id, { rotate: Math.round(ang - d.dx) });
      return;
    }
    const w = Math.min(2.8, Math.max(0.04, Math.abs(x - layer.x) * 2));
    const h = Math.min(2.8, Math.max(0.04, Math.abs(y - layer.y) * 2));
    if (layer.kind === "image") {
      const dist = Math.max(0.04, Math.hypot((x - layer.x) * 2, (y - layer.y) * 2));
      const s = dist / d.startDist;
      patchLayer(d.id, {
        w: Math.min(2.8, Math.max(0.04, d.startW * s)),
        h: Math.min(2.8, Math.max(0.04, d.startH * s)),
      });
      return;
    }
    patchLayer(d.id, { w, h });
  }

  function onPointerUp() {
    drag.current = null;
  }

  const filterCss = useMemo(
    () => `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`,
    [brightness, contrast, saturate]
  );

  async function exportThumb() {
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = YT_W;
      canvas.height = YT_H;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas yok");
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, YT_W, YT_H);
      if (bg) {
        try {
          const img = await loadImage(bg);
          ctx.save();
          ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`;
          if (flipH) {
            ctx.translate(YT_W, 0);
            ctx.scale(-1, 1);
          }
          drawContained(ctx, img, img.naturalWidth, img.naturalHeight);
          ctx.restore();
        } catch {
          /* keep fill */
        }
      }
      for (const layer of layers) {
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        const cx = layer.x * YT_W;
        const cy = layer.y * YT_H;
        const w = layer.w * YT_W;
        const h = layer.h * YT_H;
        ctx.translate(cx, cy);
        ctx.rotate((layer.rotate * Math.PI) / 180);
        if (layer.kind === "shape") {
          ctx.fillStyle = layer.fill;
          ctx.strokeStyle = layer.stroke;
          ctx.lineWidth = layer.strokeW;
          if (layer.shape === "ellipse") {
            ctx.beginPath();
            ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillRect(-w / 2, -h / 2, w, h);
          }
        } else if (layer.kind === "image" && layer.src) {
          try {
            const img = await loadImage(layer.src);
            const halo = pngHaloFilter(layer);
            if (halo) ctx.filter = halo;
            drawContainedCentered(ctx, img, img.naturalWidth, img.naturalHeight, w, h);
            ctx.filter = "none";
          } catch {
            /* skip */
          }
        } else if (layer.kind === "text") {
          const fontSize = Math.max(12, h * 0.68);
          const weight = layer.bold ? "800" : "600";
          const style = layer.italic ? "italic" : "normal";
          ctx.font = `${style} ${weight} ${fontSize}px ${layer.font}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const raw = layer.uppercase ? (layer.text || "").toUpperCase() : layer.text || "";
          const paint = (ch: string, x: number, y: number) => {
            if (layer.shadowOn) {
              const k = fontSize / 72;
              ctx.shadowColor = layer.shadowColor;
              ctx.shadowBlur = layer.shadowBlur * k;
              ctx.shadowOffsetX = layer.shadowX * k;
              ctx.shadowOffsetY = layer.shadowY * k;
            }
            if (layer.strokeW > 0) {
              ctx.lineWidth = Math.max(1, layer.strokeW * (fontSize / 72));
              ctx.strokeStyle = layer.stroke;
              ctx.lineJoin = "round";
              ctx.strokeText(ch, x, y);
            }
            ctx.fillStyle = layer.color;
            ctx.fillText(ch, x, y);
            ctx.shadowColor = "transparent";
          };
          if (Math.abs(layer.curve) > 0.04) {
            const chars = [...raw.replace(/\n/g, " ")];
            const total = Math.max(1, chars.length - 1);
            chars.forEach((ch, i) => {
              const t = i / total - 0.5;
              const ang = t * layer.curve * 1.8;
              ctx.save();
              ctx.rotate(ang);
              ctx.translate(0, Math.abs(t) * h * Math.abs(layer.curve) * 0.9);
              paint(ch, 0, 0);
              ctx.restore();
            });
          } else {
            const lines = wrapText(ctx, raw, w);
            const lh = fontSize * (layer.lineHeight || 1.05);
            const top = -((lines.length - 1) * lh) / 2;
            lines.forEach((line, i) => paint(line, 0, top + i * lh));
          }
        }
        ctx.restore();
      }
      drawSoftFrame(ctx, frame);
      onApply(canvas.toDataURL("image/jpeg", 0.9), snapshot());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dışa aktarılamadı");
    } finally {
      setBusy(false);
    }
  }

  const frameGlow = frame.glow ? Math.max(10, frame.glowBlur) : 0;

  return (
    <div className="thumb-editor-backdrop" onClick={() => onClose(snapshot())}>
      <div
        className="thumb-editor"
        onClick={(e) => e.stopPropagation()}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <header className="thumb-editor-bar">
          <div>
            <h2>Kapak editörü</h2>
            <p className="muted">
              1920×1080 · 16:9 · kanal: <strong>{slug === "_genel" ? "genel" : slug}</strong>
            </p>
          </div>
          <div className="effect-row">
            <button type="button" className="btn ghost" onClick={() => onClose(snapshot())}>
              Kapat
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void exportThumb()}>
              {busy ? "İşleniyor…" : "Kapağı uygula"}
            </button>
          </div>
        </header>

        <div className="thumb-editor-body">
          <div className="thumb-editor-main">
            <div className="thumb-stage-wrap">
              <div className="thumb-stage" ref={stageRef} onPointerDown={() => { setSelectedId(null); setEditingId(null); }}>
                {bg ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="thumb-stage-bg"
                    src={bg}
                    alt=""
                    style={{ filter: filterCss, transform: flipH ? "scaleX(-1)" : undefined }}
                  />
                ) : (
                  <div className="thumb-stage-empty">Arka plan yok — kare yakalayın veya görsel ekleyin</div>
                )}
                {frame.on ? (
                  <div
                    className="thumb-frame"
                    style={{
                      boxShadow: `inset 0 0 ${frame.width + frame.feather}px ${frame.color}, inset 0 0 ${frame.feather * 2}px ${frame.color}99, 0 0 ${frameGlow}px ${frame.color}aa, 0 0 ${frameGlow * 1.8}px ${frame.color}55`,
                      border: `${Math.max(2, frame.width / 5)}px solid ${frame.color}`,
                      filter: `blur(${Math.max(0, frame.feather / 18)}px)`,
                    }}
                  />
                ) : null}
                {layers.map((layer) => {
                  const shown = layer.uppercase ? layer.text.toUpperCase() : layer.text;
                  const chars = [...shown.replace(/\n/g, " ")];
                  return (
                    <div
                      key={layer.id}
                      className={`thumb-layer${selectedId === layer.id ? " selected" : ""}`}
                      style={{
                        left: `${layer.x * 100}%`,
                        top: `${layer.y * 100}%`,
                        width: `${layer.w * 100}%`,
                        height: `${layer.h * 100}%`,
                        zIndex: selectedId === layer.id ? 5 : 3,
                        opacity: layer.opacity,
                        transform: `translate(-50%, -50%) rotate(${layer.rotate}deg)`,
                      }}
                      onPointerDown={(e) => onLayerDown(e, layer.id, "move")}
                      onDoubleClick={(e) => {
                        if (layer.kind !== "text") return;
                        e.stopPropagation();
                        setSelectedId(layer.id);
                        setEditingId(layer.id);
                      }}
                    >
                      {layer.kind === "text" ? (
                        editingId === layer.id ? (
                          <textarea
                            className="thumb-layer-edit"
                            value={layer.text}
                            autoFocus
                            onPointerDown={(e) => e.stopPropagation()}
                            onChange={(e) => patchLayer(layer.id, { text: e.target.value })}
                            onBlur={() => setEditingId(null)}
                          />
                        ) : Math.abs(layer.curve) > 0.04 ? (
                          <div
                            className="thumb-layer-text curved"
                            style={{
                              color: layer.color,
                              fontFamily: layer.font,
                              fontStyle: layer.italic ? "italic" : "normal",
                              fontWeight: layer.bold ? 800 : 600,
                              letterSpacing: `${layer.letterSpacing}px`,
                              WebkitTextStroke: `${(layer.strokeW / 72).toFixed(3)}em ${layer.stroke}`,
                              filter: textShadowFilter(layer),
                            }}
                          >
                            {chars.map((ch, i) => {
                              const t = chars.length <= 1 ? 0 : i / (chars.length - 1) - 0.5;
                              return (
                                <span
                                  key={`${i}-${ch}`}
                                  style={{
                                    transform: `rotate(${t * layer.curve * 55}deg) translateY(${Math.abs(t) * layer.curve * 40}px)`,
                                  }}
                                >
                                  {ch === " " ? "\u00a0" : ch}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <div
                            className="thumb-layer-text"
                            style={{
                              color: layer.color,
                              fontFamily: layer.font,
                              fontStyle: layer.italic ? "italic" : "normal",
                              fontWeight: layer.bold ? 800 : 600,
                              letterSpacing: `${layer.letterSpacing}px`,
                              lineHeight: layer.lineHeight,
                              WebkitTextStroke: `${(layer.strokeW / 72).toFixed(3)}em ${layer.stroke}`,
                              filter: textShadowFilter(layer),
                            }}
                          >
                            {shown}
                          </div>
                        )
                      ) : layer.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={layer.src} alt="" draggable={false} style={{ filter: pngHaloFilter(layer) }} />
                      ) : (
                        <div
                          className="thumb-layer-shape"
                          style={{
                            background: layer.fill,
                            borderRadius: layer.shape === "ellipse" ? "50%" : 8,
                          }}
                        />
                      )}
                      {selectedId === layer.id && editingId !== layer.id ? (
                        <>
                          <button
                            type="button"
                            className="thumb-rotate"
                            aria-label="Döndür"
                            onPointerDown={(e) => onLayerDown(e, layer.id, "rotate")}
                          />
                          <button
                            type="button"
                            className="thumb-resize"
                            aria-label="Boyut"
                            onPointerDown={(e) => onLayerDown(e, layer.id, "resize")}
                          />
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="thumb-assets">
              <button type="button" className="thumb-asset-add" disabled={busy} onClick={() => fileRef.current?.click()}>
                + Görsel ekle
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadAsset(file);
                }}
              />
              {assets.length === 0 ? (
                <p className="muted thumb-assets-hint">Kanal görselleri burada kalır.</p>
              ) : (
                assets.map((asset) => (
                  <div key={asset.id} className="thumb-asset">
                    <button type="button" onClick={() => void addAssetToCanvas(asset)} title={asset.name}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={mediaSrc(asset.url) || asset.url} alt={asset.name} />
                    </button>
                    <button type="button" className="thumb-asset-del" onClick={() => void removeAsset(asset.id)} aria-label="Sil">
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
            <p className="muted thumb-assets-hint">Ctrl+V panodaki ekran görüntüsünü sahneye ekler; alta kaydedilmez.</p>
          </div>

          <aside className="thumb-editor-side">
            <div className="thumb-side-block">
              <h3>Araçlar</h3>
              <div className="thumb-tools">
                <button type="button" className="btn" onClick={addText}>
                  Metin
                </button>
                <button type="button" className="btn" onClick={addShape}>
                  Şekil
                </button>
                <button type="button" className={`btn${frame.on ? "" : " ghost"}`} onClick={() => setFrame((f) => ({ ...f, on: !f.on }))}>
                  Çerçeve
                </button>
                <button type="button" className={`btn${flipH ? "" : " ghost"}`} onClick={() => setFlipH((v) => !v)}>
                  Çevir
                </button>
              </div>
            </div>

            <div className="thumb-side-block">
              <div className="thumb-side-heading">
                <h3>Efekt</h3>
                <button
                  type="button"
                  className="thumb-reset"
                  onClick={() => {
                    setBrightness(100);
                    setContrast(100);
                    setSaturate(100);
                    setFlipH(false);
                  }}
                >
                  Sıfırla
                </button>
              </div>
              <div className="thumb-fx-grid">
                <label className="field">
                  <span>Parlaklık {brightness}%</span>
                  <input type="range" min={40} max={160} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Kontrast {contrast}%</span>
                  <input type="range" min={40} max={180} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Doygunluk {saturate}%</span>
                  <input type="range" min={0} max={220} value={saturate} onChange={(e) => setSaturate(Number(e.target.value))} />
                </label>
                {frame.on ? (
                  <label className="field">
                    <span>Çerçeve {frame.width}px</span>
                    <input type="range" min={4} max={64} value={frame.width} onChange={(e) => setFrame((f) => ({ ...f, width: Number(e.target.value) }))} />
                  </label>
                ) : (
                  <p className="muted thumb-fx-hint">Çerçeve kapalı</p>
                )}
              </div>
              {frame.on ? (
                <>
                  <div className="thumb-inline-row">
                    <ColorSwatch label="Renk" value={frame.color} onChange={(color) => setFrame((f) => ({ ...f, color }))} />
                    <label className="check-row">
                      <input type="checkbox" checked={frame.glow} onChange={(e) => setFrame((f) => ({ ...f, glow: e.target.checked }))} />
                      Parıltı
                    </label>
                  </div>
                  <div className="thumb-fx-grid">
                    <label className="field">
                      <span>Yumuşaklık {frame.feather}</span>
                      <input type="range" min={0} max={80} value={frame.feather} onChange={(e) => setFrame((f) => ({ ...f, feather: Number(e.target.value) }))} />
                    </label>
                    {frame.glow ? (
                      <label className="field">
                        <span>Parıltı {frame.glowBlur}</span>
                        <input type="range" min={8} max={90} value={frame.glowBlur} onChange={(e) => setFrame((f) => ({ ...f, glowBlur: Number(e.target.value) }))} />
                      </label>
                    ) : (
                      <span />
                    )}
                  </div>
                </>
              ) : null}
            </div>

            <div className="thumb-layer-pane">
              {selected ? (
                <>
                  <h3>{selected.kind === "text" ? "Metin" : selected.kind === "image" ? "Görsel" : "Şekil"}</h3>
                  {selected.kind === "text" ? (
                    <>
                      <label className="field">
                        <span>Yazı · çift tıkla sahneye</span>
                        <textarea rows={2} value={selected.text} onChange={(e) => patchLayer(selected.id, { text: e.target.value })} />
                      </label>
                      <div className="thumb-fx-grid">
                        <label className="field">
                          <span>Font</span>
                          <select value={selected.font} onChange={(e) => patchLayer(selected.id, { font: e.target.value })}>
                            {FONTS.map((f) => (
                              <option key={f.id} value={f.value}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span>Oval {Math.round(selected.curve * 100)}</span>
                          <input type="range" min={-100} max={100} value={Math.round(selected.curve * 100)} onChange={(e) => patchLayer(selected.id, { curve: Number(e.target.value) / 100 })} />
                        </label>
                        <label className="field">
                          <span>Kontur {selected.strokeW}px</span>
                          <input type="range" min={0} max={28} value={selected.strokeW} onChange={(e) => patchLayer(selected.id, { strokeW: Number(e.target.value) })} />
                        </label>
                        <label className="field">
                          <span>Aralık {selected.letterSpacing}</span>
                          <input type="range" min={-6} max={24} value={selected.letterSpacing} onChange={(e) => patchLayer(selected.id, { letterSpacing: Number(e.target.value) })} />
                        </label>
                        <label className="field">
                          <span>Satır {selected.lineHeight.toFixed(2)}</span>
                          <input type="range" min={70} max={160} value={Math.round(selected.lineHeight * 100)} onChange={(e) => patchLayer(selected.id, { lineHeight: Number(e.target.value) / 100 })} />
                        </label>
                        <label className="field">
                          <span>Gölge yumuşak {selected.shadowBlur}</span>
                          <input type="range" min={0} max={40} value={selected.shadowBlur} onChange={(e) => patchLayer(selected.id, { shadowBlur: Number(e.target.value), shadowOn: true })} />
                        </label>
                      </div>
                      <div className="thumb-inline-row">
                        <ColorSwatch label="Dolgu" value={selected.color} onChange={(color) => patchLayer(selected.id, { color })} />
                        <ColorSwatch label="Kontur" value={selected.stroke} onChange={(stroke) => patchLayer(selected.id, { stroke })} />
                        <ColorSwatch label="Gölge" value={selected.shadowColor} onChange={(shadowColor) => patchLayer(selected.id, { shadowColor, shadowOn: true })} />
                      </div>
                      <div className="thumb-fx-grid">
                        <label className="field">
                          <span>Gölge X {selected.shadowX}</span>
                          <input type="range" min={-20} max={20} value={selected.shadowX} onChange={(e) => patchLayer(selected.id, { shadowX: Number(e.target.value) })} />
                        </label>
                        <label className="field">
                          <span>Gölge Y {selected.shadowY}</span>
                          <input type="range" min={-20} max={20} value={selected.shadowY} onChange={(e) => patchLayer(selected.id, { shadowY: Number(e.target.value) })} />
                        </label>
                      </div>
                      <div className="thumb-checks">
                        <label className="check-row">
                          <input type="checkbox" checked={selected.bold} onChange={(e) => patchLayer(selected.id, { bold: e.target.checked })} />
                          Kalın
                        </label>
                        <label className="check-row">
                          <input type="checkbox" checked={selected.italic} onChange={(e) => patchLayer(selected.id, { italic: e.target.checked })} />
                          İtalik
                        </label>
                        <label className="check-row">
                          <input type="checkbox" checked={selected.uppercase} onChange={(e) => patchLayer(selected.id, { uppercase: e.target.checked })} />
                          BÜYÜK
                        </label>
                        <label className="check-row">
                          <input type="checkbox" checked={selected.shadowOn} onChange={(e) => patchLayer(selected.id, { shadowOn: e.target.checked })} />
                          Gölge
                        </label>
                      </div>
                    </>
                  ) : null}
                  {selected.kind === "image" ? (
                    <>
                      <div className="thumb-checks">
                        <label className="check-row">
                          <input type="checkbox" checked={selected.imgBorderOn} onChange={(e) => patchLayer(selected.id, { imgBorderOn: e.target.checked })} />
                          PNG çerçeve
                        </label>
                        <label className="check-row">
                          <input type="checkbox" checked={selected.imgGlowOn} onChange={(e) => patchLayer(selected.id, { imgGlowOn: e.target.checked })} />
                          Parıltı
                        </label>
                      </div>
                      <div className="thumb-inline-row">
                        <ColorSwatch label="Çerçeve" value={selected.imgBorderColor} onChange={(imgBorderColor) => patchLayer(selected.id, { imgBorderColor })} />
                        <ColorSwatch label="Parıltı" value={selected.imgGlowColor} onChange={(imgGlowColor) => patchLayer(selected.id, { imgGlowColor })} />
                      </div>
                      <div className="thumb-fx-grid">
                        <label className="field">
                          <span>Kenar {selected.imgBorderW}px</span>
                          <input type="range" min={0} max={28} value={selected.imgBorderW} onChange={(e) => patchLayer(selected.id, { imgBorderW: Number(e.target.value), imgBorderOn: true })} />
                        </label>
                        <label className="field">
                          <span>Yumuşak parıltı {selected.imgGlowBlur}</span>
                          <input type="range" min={4} max={80} value={selected.imgGlowBlur} onChange={(e) => patchLayer(selected.id, { imgGlowBlur: Number(e.target.value), imgGlowOn: true })} />
                        </label>
                      </div>
                    </>
                  ) : null}
                  {selected.kind === "shape" ? (
                    <div className="thumb-fx-grid">
                      <label className="field">
                        <span>Şekil</span>
                        <select value={selected.shape} onChange={(e) => patchLayer(selected.id, { shape: e.target.value as "rect" | "ellipse" })}>
                          <option value="rect">Dikdörtgen</option>
                          <option value="ellipse">Elips</option>
                        </select>
                      </label>
                      <ColorSwatch label="Dolgu" value={selected.fill.slice(0, 7)} onChange={(fill) => patchLayer(selected.id, { fill })} />
                    </div>
                  ) : null}
                  <div className="thumb-fx-grid">
                    <label className="field">
                      <span>Döndür {selected.rotate}°</span>
                      <input type="range" min={-180} max={180} value={selected.rotate} onChange={(e) => patchLayer(selected.id, { rotate: Number(e.target.value) })} />
                    </label>
                    <label className="field">
                      <span>Opaklık {Math.round(selected.opacity * 100)}%</span>
                      <input type="range" min={20} max={100} value={Math.round(selected.opacity * 100)} onChange={(e) => patchLayer(selected.id, { opacity: Number(e.target.value) / 100 })} />
                    </label>
                  </div>
                  <div className="effect-row">
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        const copy = { ...selected, id: nid(), x: selected.x + 0.04 };
                        setLayers((prev) => [...prev, copy]);
                        setSelectedId(copy.id);
                      }}
                    >
                      Kopyala
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        setLayers((prev) => prev.filter((l) => l.id !== selected.id));
                        setSelectedId(null);
                      }}
                    >
                      Sil
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted fx-side-hint">Katman seçin. Kapatınca taslak kalır; kapak yalnızca uygula ile değişir. Yazı/çerçeve ayarları sonraki videoda da hatırlanır.</p>
              )}
              {error ? <p className="form-message">{error}</p> : null}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
