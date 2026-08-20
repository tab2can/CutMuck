"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { api, mediaSrc } from "@/lib/api";
import { ColorSwatch } from "@/components/ColorSwatch";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { loadImage, YT_H, YT_W, fileToDataUrl, drawContained, drawContainedCentered } from "@/lib/ytThumb";
import {
  loadThumbPrefs,
  saveThumbPrefs,
  DEFAULT_FRAME_PREFS,
  DEFAULT_TEXT_PREFS,
  DEFAULT_IMAGE_PREFS,
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

type LayerKind = "text" | "image" | "shape" | "frame";

type Layer = {
  id: string;
  kind: LayerKind;
  name: string;
  visible: boolean;
  locked: boolean;
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
  autoBox?: boolean;
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
  let fontSize = rest.fontSize ?? fallback.fontSize;
  if (kind === "text" && raw.autoBox !== true) {
    fontSize = Math.max(12, (rest.h ?? fallback.h) * YT_H * (Math.abs(rest.curve ?? 0) > 0.04 ? 0.52 : 0.68));
  }
  const layer: Layer = {
    ...fallback,
    ...rest,
    id: raw.id || fallback.id,
    kind,
    fontSize,
    autoBox: kind === "text" ? true : rest.autoBox,
    shadowOn: raw.shadowOn ?? shadow ?? fallback.shadowOn,
    visible: rest.visible !== false,
    locked: kind === "frame" ? rest.locked !== false : !!rest.locked,
    name: rest.name || fallback.name,
  };
  if (kind === "frame") {
    layer.x = 0.5;
    layer.y = 0.5;
    layer.w = 1;
    layer.h = 1;
  }
  return kind === "text" ? fitTextLayer(layer) : layer;
}

const KIND_LABEL: Record<LayerKind, string> = {
  text: "Metin",
  image: "Görsel",
  shape: "Şekil",
  frame: "Çerçeve",
};

function nextLayerName(kind: LayerKind, layers: Layer[]) {
  const n = layers.filter((l) => l.kind === kind).length + 1;
  return `${KIND_LABEL[kind]} ${n}`;
}

function moveById<T extends { id: string }>(items: T[], id: string, where: "front" | "back" | "up" | "down") {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return items;
  const next = [...items];
  const [item] = next.splice(i, 1);
  if (where === "front") next.push(item);
  else if (where === "back") next.unshift(item);
  else if (where === "up") next.splice(Math.min(i + 1, next.length), 0, item);
  else next.splice(Math.max(i - 1, 0), 0, item);
  return next;
}

function isTypingTarget(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!t.closest("[contenteditable='true']");
}

function cloneProject(p: ThumbProject): ThumbProject {
  const layers = p.layers.map((l) => hydrateLayer(l));
  const frame = { ...loadThumbPrefs().frame, ...p.frame };
  if (frame.on && !layers.some((l) => l.kind === "frame")) {
    layers.unshift(
      baseLayer("frame", { name: "Çerçeve", x: 0.5, y: 0.5, w: 1, h: 1, locked: true })
    );
  }
  return { ...p, layers, frame };
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
    name: KIND_LABEL[kind],
    visible: true,
    locked: false,
    x: 0.5,
    y: 0.55,
    w: kind === "text" ? 0.5 : kind === "frame" ? 1 : 0.32,
    h: kind === "text" ? 0.2 : kind === "frame" ? 1 : 0.45,
    rotate: 0,
    opacity: 1,
    text: "ipsum",
    fontSize: kind === "text" ? Math.round(0.2 * YT_H * 0.68) : 72,
    autoBox: kind === "text",
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

function resolveFontFamily(font: string) {
  if (!font.includes("var(")) return font;
  const probe = document.createElement("span");
  probe.style.fontFamily = font;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).fontFamily;
  probe.remove();
  return resolved || font;
}

function measureCtx() {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  return c.getContext("2d");
}

function shownText(layer: Layer) {
  const raw = layer.text || "";
  return layer.uppercase ? raw.toUpperCase() : raw;
}

function applyLayerFont(ctx: CanvasRenderingContext2D, layer: Layer, letterSpacing: number) {
  const fontSize = Math.max(12, layer.fontSize || 72);
  const family = resolveFontFamily(layer.font);
  ctx.font = `${layer.italic ? "italic " : ""}${layer.bold ? 800 : 600} ${fontSize}px ${family}`;
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${letterSpacing}px`;
  return fontSize;
}

function linePixelWidth(ctx: CanvasRenderingContext2D, line: string) {
  const m = ctx.measureText(line || " ");
  const left = Math.max(0, m.actualBoundingBoxLeft ?? 0);
  const right = Math.max(m.width, m.actualBoundingBoxRight ?? m.width);
  return Math.max(m.width, left + right);
}

function measureTextNorm(layer: Layer): { w: number; h: number } {
  const ctx = measureCtx();
  if (!ctx) return { w: layer.w, h: layer.h };
  const fontSize = applyLayerFont(ctx, layer, layer.letterSpacing);
  const strokeW = (layer.strokeW / 72) * fontSize;
  const shadowX = layer.shadowOn ? Math.abs((layer.shadowX / 72) * fontSize) : 0;
  const shadowY = layer.shadowOn ? Math.abs((layer.shadowY / 72) * fontSize) : 0;
  const shadowB = layer.shadowOn ? (layer.shadowBlur / 72) * fontSize : 0;
  const padX = strokeW + shadowX + shadowB * 0.3 + (layer.italic ? fontSize * 0.22 : fontSize * 0.05) + 4;
  const padY = strokeW + shadowY + shadowB * 0.3 + fontSize * 0.08 + 4;
  if (Math.abs(layer.curve) > 0.04) {
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
    const chars = [...shownText(layer).replace(/\n/g, " ")];
    const ls = layer.letterSpacing;
    const total =
      chars.reduce((sum, ch) => sum + ctx.measureText(ch === " " ? " " : ch).width, 0) +
      ls * Math.max(0, chars.length - 1);
    const extraY = Math.abs(layer.curve) * 40 + fontSize * 0.35;
    return {
      w: Math.min(2.8, Math.max(0.04, (total + padX * 2) / YT_W)),
      h: Math.min(2.8, Math.max(0.04, (fontSize + extraY + padY * 2) / YT_H)),
    };
  }
  const lines = shownText(layer).split("\n");
  let maxW = 0;
  for (const line of lines) maxW = Math.max(maxW, linePixelWidth(ctx, line));
  const lh = fontSize * (layer.lineHeight || 1.05);
  return {
    w: Math.min(2.8, Math.max(0.04, (maxW + padX * 2) / YT_W)),
    h: Math.min(2.8, Math.max(0.04, (lines.length * lh + padY * 2) / YT_H)),
  };
}

function fitTextLayer(layer: Layer): Layer {
  if (layer.kind !== "text") return layer;
  const box = measureTextNorm(layer);
  if (Math.abs(layer.w - box.w) < 0.0005 && Math.abs(layer.h - box.h) < 0.0005) return layer;
  return { ...layer, w: box.w, h: box.h };
}

function paintCanvasText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, strokeW: number) {
  const shadowOn = ctx.shadowBlur > 0 || ctx.shadowOffsetX !== 0 || ctx.shadowOffsetY !== 0;
  if (shadowOn) {
    ctx.fillText(text, x, y);
    const color = ctx.shadowColor;
    const blur = ctx.shadowBlur;
    const ox = ctx.shadowOffsetX;
    const oy = ctx.shadowOffsetY;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    if (strokeW > 0.25) ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = ox;
    ctx.shadowOffsetY = oy;
    return;
  }
  if (strokeW > 0.25) ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

function drawTextLayer(ctx: CanvasRenderingContext2D, layer: Layer) {
  const curved = Math.abs(layer.curve) > 0.04;
  const shown = shownText(layer);
  const fontSize = applyLayerFont(ctx, layer, curved ? 0 : layer.letterSpacing);
  const strokeW = (layer.strokeW / 72) * fontSize;
  ctx.textAlign = "center";
  ctx.fillStyle = layer.color;
  ctx.strokeStyle = layer.stroke;
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = strokeW;
  if (layer.shadowOn) {
    ctx.shadowColor = layer.shadowColor;
    ctx.shadowBlur = (layer.shadowBlur / 72) * fontSize;
    ctx.shadowOffsetX = (layer.shadowX / 72) * fontSize;
    ctx.shadowOffsetY = (layer.shadowY / 72) * fontSize;
  } else {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  if (curved) {
    ctx.textBaseline = "bottom";
    const chars = [...shown.replace(/\n/g, " ")];
    const ls = layer.letterSpacing;
    const widths = chars.map((ch) => ctx.measureText(ch === " " ? " " : ch).width);
    const total = widths.reduce((a, b) => a + b, 0) + ls * Math.max(0, chars.length - 1);
    let cx = -total / 2;
    for (let i = 0; i < chars.length; i++) {
      const t = chars.length <= 1 ? 0 : i / (chars.length - 1) - 0.5;
      const cw = widths[i];
      ctx.save();
      ctx.translate(cx + cw / 2, Math.abs(t) * layer.curve * 40);
      ctx.rotate((t * layer.curve * 55 * Math.PI) / 180);
      paintCanvasText(ctx, chars[i] === " " ? " " : chars[i], 0, 0, strokeW);
      ctx.restore();
      cx += cw + ls;
    }
    return;
  }

  ctx.textBaseline = "alphabetic";
  const lines = shown.split("\n");
  const lh = fontSize * (layer.lineHeight || 1.05);
  let yTop = -(lines.length * lh) / 2;
  for (const line of lines) {
    const m = ctx.measureText(line || " ");
    const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? fontSize * 0.8;
    const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? fontSize * 0.2;
    const baseline = yTop + (lh - (ascent + descent)) / 2 + ascent;
    paintCanvasText(ctx, line, 0, baseline, strokeW);
    yTop += lh;
  }
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
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const dragLayerId = useRef<string | null>(null);
  const [stageH, setStageH] = useState(YT_H);
  const drag = useRef<{
    id: string;
    mode: "move" | "resize" | "rotate";
    dx: number;
    dy: number;
    startW: number;
    startH: number;
    startDist: number;
    startFont: number;
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
    const el = stageRef.current;
    if (!el) return;
    const sync = () => setStageH(el.clientHeight || YT_H);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let gone = false;
    const refit = () => {
      if (gone) return;
      setLayers((prev) => {
        const next = prev.map((l) => (l.kind === "text" ? fitTextLayer(l) : l));
        return next.some((l, i) => l !== prev[i]) ? next : prev;
      });
    };
    refit();
    void (document.fonts?.ready ?? Promise.resolve()).then(refit);
    return () => {
      gone = true;
    };
  }, []);

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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || editingId) return;
      if (!selectedId) return;
      const meta = e.ctrlKey || e.metaKey;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeLayer(selectedId);
        return;
      }
      if (meta && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateLayer(selectedId);
        return;
      }
      if (e.key === "]") {
        e.preventDefault();
        moveLayer(selectedId, meta ? "front" : "up");
        return;
      }
      if (e.key === "[") {
        e.preventDefault();
        moveLayer(selectedId, meta ? "back" : "down");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, editingId]);

  function snapshot(): ThumbProject {
    return { bg, layers, selectedId, frame, brightness, contrast, saturate, flipH };
  }

  function patchLayer(id: string, patch: Partial<Layer>) {
    setLayers((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const next = { ...l, ...patch };
        return next.kind === "text" ? fitTextLayer(next) : next;
      })
    );
  }

  function addText() {
    setLayers((prev) => {
      const layer = fitTextLayer(
        baseLayer("text", { y: 0.62, x: 0.5, name: nextLayerName("text", prev) })
      );
      setSelectedId(layer.id);
      return [...prev, layer];
    });
  }

  function addShape() {
    setLayers((prev) => {
      const layer = baseLayer("shape", {
        x: 0.5,
        y: 0.5,
        w: 0.4,
        h: 0.12,
        opacity: 0.55,
        name: nextLayerName("shape", prev),
      });
      setSelectedId(layer.id);
      return [...prev, layer];
    });
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
    setLayers((prev) => {
      const layer = baseLayer("image", { src, x: 0.5, y: 0.5, w, h, name: nextLayerName("image", prev) });
      setSelectedId(layer.id);
      return [...prev, layer];
    });
  }

  function moveLayer(id: string, where: "front" | "back" | "up" | "down") {
    setLayers((prev) => moveById(prev, id, where));
  }

  function duplicateLayer(id: string) {
    setLayers((prev) => {
      const i = prev.findIndex((l) => l.id === id);
      if (i < 0) return prev;
      const src = prev[i];
      const copy: Layer = {
        ...src,
        id: nid(),
        x: src.x + 0.03,
        y: src.y + 0.03,
        name: `${src.name} kopya`,
        locked: false,
      };
      const next = [...prev];
      next.splice(i + 1, 0, copy);
      setSelectedId(copy.id);
      return next;
    });
  }

  function removeLayer(id: string) {
    setLayers((prev) => {
      const next = prev.filter((l) => l.id !== id);
      if (!next.some((l) => l.kind === "frame" && l.visible)) setFrame((f) => ({ ...f, on: false }));
      return next;
    });
    setSelectedId((cur) => (cur === id ? null : cur));
    if (editingId === id) setEditingId(null);
  }

  function toggleFrame() {
    const existing = layers.find((l) => l.kind === "frame");
    if (existing) {
      const vis = !existing.visible;
      patchLayer(existing.id, { visible: vis });
      setFrame((f) => ({ ...f, on: vis }));
      setSelectedId(vis ? existing.id : null);
      return;
    }
    const layer = baseLayer("frame", { name: "Çerçeve", x: 0.5, y: 0.5, w: 1, h: 1, locked: true });
    setLayers((prev) => [layer, ...prev]);
    setFrame((f) => ({ ...f, on: true }));
    setSelectedId(layer.id);
  }

  function reorderVisual(fromId: string, toId: string) {
    if (fromId === toId) return;
    setLayers((prev) => {
      const visual = [...prev].reverse();
      const from = visual.findIndex((l) => l.id === fromId);
      const to = visual.findIndex((l) => l.id === toId);
      if (from < 0 || to < 0) return prev;
      const next = [...visual];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next.reverse();
    });
  }

  function openLayerMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(id);
    setCtxMenu({ x: e.clientX, y: e.clientY, id });
  }

  function layerMenuItems(id: string): MenuItem[] {
    const layer = layers.find((l) => l.id === id);
    if (!layer) return [];
    const i = layers.findIndex((l) => l.id === id);
    const last = layers.length - 1;
    const noop = () => undefined;
    return [
      { id: "front", label: "Üste taşı", disabled: i === last, onSelect: () => moveLayer(id, "front") },
      { id: "back", label: "Alta taşı", disabled: i === 0, onSelect: () => moveLayer(id, "back") },
      { id: "up", label: "Bir üste", disabled: i === last, onSelect: () => moveLayer(id, "up") },
      { id: "down", label: "Bir alta", disabled: i === 0, onSelect: () => moveLayer(id, "down") },
      { id: "sep1", label: "", separator: true, onSelect: noop },
      {
        id: "vis",
        label: layer.visible ? "Gizle" : "Göster",
        onSelect: () => {
          const vis = !layer.visible;
          patchLayer(id, { visible: vis });
          if (layer.kind === "frame") setFrame((f) => ({ ...f, on: vis }));
        },
      },
      {
        id: "lock",
        label: layer.locked ? "Kilidi aç" : "Kilitle",
        onSelect: () => patchLayer(id, { locked: !layer.locked }),
      },
      {
        id: "center",
        label: "Ortala",
        disabled: layer.kind === "frame",
        onSelect: () => patchLayer(id, { x: 0.5, y: 0.5 }),
      },
      { id: "sep2", label: "", separator: true, onSelect: noop },
      { id: "dup", label: "Kopyala", disabled: layer.kind === "frame", onSelect: () => duplicateLayer(id) },
      { id: "del", label: "Sil", danger: true, onSelect: () => removeLayer(id) },
    ];
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
    const layer = layers.find((l) => l.id === id);
    setSelectedId(id);
    if (layer?.locked) return;
    if (layer?.kind === "frame") return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const { x, y } = toNorm(e.clientX, e.clientY);
    const lx = layer?.x ?? 0.5;
    const ly = layer?.y ?? 0.5;
    const startW = layer?.w ?? 0.3;
    const startH = layer?.h ?? 0.3;
    const startDist = Math.max(0.04, Math.hypot((x - lx) * 2, (y - ly) * 2));
    if (mode === "rotate") {
      const ang = (Math.atan2(y - ly, x - lx) * 180) / Math.PI;
      drag.current = {
        id,
        mode,
        dx: ang - (layer?.rotate ?? 0),
        dy: 0,
        startW,
        startH,
        startDist,
        startFont: layer?.fontSize ?? 72,
      };
    } else {
      drag.current = {
        id,
        mode,
        dx: x - lx,
        dy: y - ly,
        startW,
        startH,
        startDist,
        startFont: layer?.fontSize ?? 72,
      };
    }
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
    if (layer.kind === "text") {
      const dist = Math.max(0.04, Math.hypot((x - layer.x) * 2, (y - layer.y) * 2));
      const s = dist / d.startDist;
      patchLayer(d.id, { fontSize: Math.min(420, Math.max(14, d.startFont * s)) });
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
        if (!layer.visible) continue;
        if (layer.kind === "frame") {
          drawSoftFrame(ctx, { ...frame, on: true });
          continue;
        }
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
          if (document.fonts?.ready) await document.fonts.ready;
          drawTextLayer(ctx, layer);
        }
        ctx.restore();
      }
      onApply(canvas.toDataURL("image/jpeg", 0.9), snapshot());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dışa aktarılamadı");
    } finally {
      setBusy(false);
    }
  }

  const frameGlow = frame.glow ? Math.max(10, frame.glowBlur) : 0;
  const stageK = stageH / YT_H;
  const hasFrame = layers.some((l) => l.kind === "frame" && l.visible);

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
          <aside className="thumb-editor-layers">
            <div className="thumb-side-heading">
              <h3>Katmanlar</h3>
              <span className="muted">{layers.length}</span>
            </div>
            {layers.length === 0 ? (
              <p className="muted thumb-layers-hint">Sahneye metin, görsel veya şekil ekleyin.</p>
            ) : (
              <ul className="thumb-layer-list">
                {[...layers].reverse().map((layer) => (
                  <li
                    key={layer.id}
                    draggable={!layer.locked && renameId !== layer.id}
                    className={`thumb-layer-row${selectedId === layer.id ? " selected" : ""}${layer.visible ? "" : " is-hidden"}${layer.locked ? " is-locked" : ""}`}
                    onClick={() => setSelectedId(layer.id)}
                    onContextMenu={(e) => openLayerMenu(e, layer.id)}
                    onDragStart={() => {
                      dragLayerId.current = layer.id;
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragLayerId.current;
                      dragLayerId.current = null;
                      if (from) reorderVisual(from, layer.id);
                    }}
                  >
                    <button
                      type="button"
                      className="thumb-layer-icon"
                      title={layer.visible ? "Gizle" : "Göster"}
                      aria-label={layer.visible ? "Gizle" : "Göster"}
                      onClick={(e) => {
                        e.stopPropagation();
                        const vis = !layer.visible;
                        patchLayer(layer.id, { visible: vis });
                        if (layer.kind === "frame") setFrame((f) => ({ ...f, on: vis }));
                      }}
                    >
                      {layer.visible ? (
                        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                          <path
                            fill="currentColor"
                            d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"
                          />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                          <path
                            fill="currentColor"
                            d="M3 4.3 4.3 3 21 19.7 19.7 21l-3.1-3.1A12.6 12.6 0 0 1 12 19c-5 0-9-4.5-10-7a13.8 13.8 0 0 1 4.4-5.3L3 4.3zm6.2 6.2A3 3 0 0 0 12 15a3 3 0 0 0 2.8-1.9l-4.6-2.6zM12 5c5 0 9 4.5 10 7a13.4 13.4 0 0 1-3.2 4.3l-1.5-1.5A11 11 0 0 0 20 12c-1-2.2-4.2-6-8-6-1 0-1.9.2-2.8.6L7.7 5.1A12.5 12.5 0 0 1 12 5z"
                          />
                        </svg>
                      )}
                    </button>
                    {layer.kind === "image" && layer.src ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="thumb-layer-thumb" src={layer.src} alt="" draggable={false} />
                    ) : (
                      <span className={`thumb-layer-kind ${layer.kind}`} />
                    )}
                    <span className="thumb-layer-meta">
                      {renameId === layer.id ? (
                        <input
                          className="thumb-layer-rename"
                          value={layer.name}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => patchLayer(layer.id, { name: e.target.value })}
                          onBlur={() => setRenameId(null)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Escape") (e.currentTarget as HTMLInputElement).blur();
                          }}
                        />
                      ) : (
                        <strong
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setRenameId(layer.id);
                          }}
                        >
                          {layer.name}
                        </strong>
                      )}
                      <span>{KIND_LABEL[layer.kind]}</span>
                    </span>
                    <button
                      type="button"
                      className="thumb-layer-icon"
                      title={layer.locked ? "Kilidi aç" : "Kilitle"}
                      aria-label={layer.locked ? "Kilidi aç" : "Kilitle"}
                      onClick={(e) => {
                        e.stopPropagation();
                        patchLayer(layer.id, { locked: !layer.locked });
                      }}
                    >
                      {layer.locked ? "🔒" : "↕"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted thumb-layers-hint">Sürükle · sağ tık · [ ] sıra · Del sil · Ctrl+D kopya</p>
          </aside>
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
                {layers.map((layer, index) => {
                  if (!layer.visible) return null;
                  if (layer.kind === "frame") {
                    return (
                      <div
                        key={layer.id}
                        className={`thumb-layer kind-frame${selectedId === layer.id ? " selected" : ""}`}
                        style={{
                          left: "50%",
                          top: "50%",
                          width: "100%",
                          height: "100%",
                          zIndex: 10 + index,
                          transform: "translate(-50%, -50%)",
                          opacity: layer.opacity,
                        }}
                        onContextMenu={(e) => openLayerMenu(e, layer.id)}
                      >
                        <div
                          className="thumb-frame"
                          style={{
                            boxShadow: `inset 0 0 ${frame.width + frame.feather}px ${frame.color}, inset 0 0 ${frame.feather * 2}px ${frame.color}99, 0 0 ${frameGlow}px ${frame.color}aa, 0 0 ${frameGlow * 1.8}px ${frame.color}55`,
                            border: `${Math.max(2, frame.width / 5)}px solid ${frame.color}`,
                            filter: `blur(${Math.max(0, frame.feather / 18)}px)`,
                          }}
                        />
                      </div>
                    );
                  }
                  const shown = layer.uppercase ? layer.text.toUpperCase() : layer.text;
                  const chars = [...shown.replace(/\n/g, " ")];
                  const fontPx = layer.fontSize * stageK;
                  return (
                    <div
                      key={layer.id}
                      className={`thumb-layer${selectedId === layer.id ? " selected" : ""}${layer.locked ? " locked" : ""}`}
                      style={{
                        left: `${layer.x * 100}%`,
                        top: `${layer.y * 100}%`,
                        width: `${layer.w * 100}%`,
                        height: `${layer.h * 100}%`,
                        zIndex: selectedId === layer.id ? 900 : 10 + index,
                        opacity: layer.opacity,
                        transform: `translate(-50%, -50%) rotate(${layer.rotate}deg)`,
                        cursor: layer.locked ? "default" : "move",
                        fontSize: layer.kind === "text" ? `${fontPx}px` : undefined,
                      }}
                      onPointerDown={(e) => onLayerDown(e, layer.id, "move")}
                      onContextMenu={(e) => openLayerMenu(e, layer.id)}
                      onDoubleClick={(e) => {
                        if (layer.kind !== "text" || layer.locked) return;
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
                              letterSpacing: `${layer.letterSpacing * stageK}px`,
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
                                    transform: `rotate(${t * layer.curve * 55}deg) translateY(${Math.abs(t) * layer.curve * 40 * stageK}px)`,
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
                              letterSpacing: `${layer.letterSpacing * stageK}px`,
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
                      {selectedId === layer.id && editingId !== layer.id && !layer.locked ? (
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
            <div className="thumb-side-scroll">
            <section className="thumb-side-block">
              <h3>Ekle</h3>
              <div className="thumb-tools">
                <button type="button" className="thumb-tool" onClick={addText}>
                  <span className="thumb-tool-ico" aria-hidden>Aa</span>
                  <span>Metin</span>
                </button>
                <button type="button" className="thumb-tool" onClick={addShape}>
                  <span className="thumb-tool-ico" aria-hidden>□</span>
                  <span>Şekil</span>
                </button>
                <button type="button" className={`thumb-tool${hasFrame ? " active" : ""}`} onClick={toggleFrame}>
                  <span className="thumb-tool-ico" aria-hidden>▣</span>
                  <span>Çerçeve</span>
                </button>
                <button type="button" className={`thumb-tool${flipH ? " active" : ""}`} onClick={() => setFlipH((v) => !v)}>
                  <span className="thumb-tool-ico" aria-hidden>⇄</span>
                  <span>Çevir</span>
                </button>
              </div>
            </section>

            {selected ? (
              <section className="thumb-side-block thumb-props">
                <div className="thumb-side-heading">
                  <h3>
                    {selected.kind === "text"
                      ? "Metin"
                      : selected.kind === "image"
                        ? "Görsel"
                        : selected.kind === "frame"
                          ? "Çerçeve"
                          : "Şekil"}
                  </h3>
                  <button type="button" className="thumb-reset" onClick={() => { setSelectedId(null); setEditingId(null); }}>
                    Sahne
                  </button>
                </div>

                {selected.kind === "text" ? (
                  <>
                    <label className="field thumb-prop-field">
                      <span>Yazı</span>
                      <textarea rows={2} value={selected.text} onChange={(e) => patchLayer(selected.id, { text: e.target.value })} />
                    </label>

                    <div className="thumb-prop-group">
                      <p className="thumb-prop-label">Stil</p>
                      <label className="field thumb-prop-field">
                        <span>Font</span>
                        <select value={selected.font} onChange={(e) => patchLayer(selected.id, { font: e.target.value })}>
                          {FONTS.map((f) => (
                            <option key={f.id} value={f.value}>
                              {f.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="thumb-color-row">
                        <ColorSwatch label="Dolgu" value={selected.color} onChange={(color) => patchLayer(selected.id, { color })} />
                        <ColorSwatch label="Kontur" value={selected.stroke} onChange={(stroke) => patchLayer(selected.id, { stroke })} />
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
                      </div>
                    </div>

                    <div className="thumb-prop-group">
                      <p className="thumb-prop-label">Boyut</p>
                      <div className="thumb-slider-stack">
                        <label className="thumb-slider">
                          <span>
                            Punto <em>{Math.round(selected.fontSize)}</em>
                          </span>
                          <input
                            type="range"
                            min={18}
                            max={360}
                            value={Math.round(selected.fontSize)}
                            title="Çift tık: varsayılan"
                            onChange={(e) => patchLayer(selected.id, { fontSize: Number(e.target.value) })}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              patchLayer(selected.id, { fontSize: Math.round(0.2 * YT_H * 0.68) });
                            }}
                          />
                        </label>
                        <label className="thumb-slider">
                          <span>
                            Kontur <em>{selected.strokeW}px</em>
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={28}
                            value={selected.strokeW}
                            title="Çift tık: varsayılan"
                            onChange={(e) => patchLayer(selected.id, { strokeW: Number(e.target.value) })}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              patchLayer(selected.id, { strokeW: DEFAULT_TEXT_PREFS.strokeW });
                            }}
                          />
                        </label>
                        <label className="thumb-slider">
                          <span>
                            Harf aralığı <em>{selected.letterSpacing}</em>
                          </span>
                          <input
                            type="range"
                            min={-6}
                            max={24}
                            value={selected.letterSpacing}
                            title="Çift tık: varsayılan"
                            onChange={(e) => patchLayer(selected.id, { letterSpacing: Number(e.target.value) })}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              patchLayer(selected.id, { letterSpacing: DEFAULT_TEXT_PREFS.letterSpacing });
                            }}
                          />
                        </label>
                        <label className="thumb-slider">
                          <span>
                            Satır <em>{selected.lineHeight.toFixed(2)}</em>
                          </span>
                          <input
                            type="range"
                            min={70}
                            max={160}
                            value={Math.round(selected.lineHeight * 100)}
                            title="Çift tık: varsayılan"
                            onChange={(e) => patchLayer(selected.id, { lineHeight: Number(e.target.value) / 100 })}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              patchLayer(selected.id, { lineHeight: DEFAULT_TEXT_PREFS.lineHeight });
                            }}
                          />
                        </label>
                        <label className="thumb-slider">
                          <span>
                            Eğri <em>{Math.round(selected.curve * 100)}</em>
                          </span>
                          <input
                            type="range"
                            min={-100}
                            max={100}
                            value={Math.round(selected.curve * 100)}
                            title="Çift tık: varsayılan"
                            onChange={(e) => patchLayer(selected.id, { curve: Number(e.target.value) / 100 })}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              patchLayer(selected.id, { curve: DEFAULT_TEXT_PREFS.curve });
                            }}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="thumb-prop-group">
                      <div className="thumb-side-heading">
                        <p className="thumb-prop-label">Gölge</p>
                        <label className="thumb-chip compact">
                          <input type="checkbox" checked={selected.shadowOn} onChange={(e) => patchLayer(selected.id, { shadowOn: e.target.checked })} />
                          Açık
                        </label>
                      </div>
                      {selected.shadowOn ? (
                        <>
                          <div className="thumb-color-row">
                            <ColorSwatch label="Renk" value={selected.shadowColor} onChange={(shadowColor) => patchLayer(selected.id, { shadowColor, shadowOn: true })} />
                          </div>
                          <div className="thumb-slider-stack">
                            <label className="thumb-slider">
                              <span>
                                Yumuşaklık <em>{selected.shadowBlur}</em>
                              </span>
                              <input
                                type="range"
                                min={0}
                                max={40}
                                value={selected.shadowBlur}
                                title="Çift tık: varsayılan"
                                onChange={(e) => patchLayer(selected.id, { shadowBlur: Number(e.target.value), shadowOn: true })}
                                onDoubleClick={(e) => {
                                  e.preventDefault();
                                  patchLayer(selected.id, { shadowBlur: DEFAULT_TEXT_PREFS.shadowBlur });
                                }}
                              />
                            </label>
                            <label className="thumb-slider">
                              <span>
                                X <em>{selected.shadowX}</em>
                              </span>
                              <input
                                type="range"
                                min={-20}
                                max={20}
                                value={selected.shadowX}
                                title="Çift tık: varsayılan"
                                onChange={(e) => patchLayer(selected.id, { shadowX: Number(e.target.value) })}
                                onDoubleClick={(e) => {
                                  e.preventDefault();
                                  patchLayer(selected.id, { shadowX: DEFAULT_TEXT_PREFS.shadowX });
                                }}
                              />
                            </label>
                            <label className="thumb-slider">
                              <span>
                                Y <em>{selected.shadowY}</em>
                              </span>
                              <input
                                type="range"
                                min={-20}
                                max={20}
                                value={selected.shadowY}
                                title="Çift tık: varsayılan"
                                onChange={(e) => patchLayer(selected.id, { shadowY: Number(e.target.value) })}
                                onDoubleClick={(e) => {
                                  e.preventDefault();
                                  patchLayer(selected.id, { shadowY: DEFAULT_TEXT_PREFS.shadowY });
                                }}
                              />
                            </label>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </>
                ) : null}

                {selected.kind === "image" ? (
                  <>
                    <div className="thumb-prop-group">
                      <p className="thumb-prop-label">Kenar</p>
                      <label className="thumb-chip">
                        <input type="checkbox" checked={selected.imgBorderOn} onChange={(e) => patchLayer(selected.id, { imgBorderOn: e.target.checked })} />
                        PNG çerçeve
                      </label>
                      {selected.imgBorderOn ? (
                        <>
                          <div className="thumb-color-row">
                            <ColorSwatch label="Renk" value={selected.imgBorderColor} onChange={(imgBorderColor) => patchLayer(selected.id, { imgBorderColor })} />
                          </div>
                          <div className="thumb-slider-stack">
                            <label className="thumb-slider">
                              <span>
                                Kalınlık <em>{selected.imgBorderW}px</em>
                              </span>
                              <input
                                type="range"
                                min={0}
                                max={28}
                                value={selected.imgBorderW}
                                title="Çift tık: varsayılan"
                                onChange={(e) => patchLayer(selected.id, { imgBorderW: Number(e.target.value), imgBorderOn: true })}
                                onDoubleClick={(e) => {
                                  e.preventDefault();
                                  patchLayer(selected.id, { imgBorderW: DEFAULT_IMAGE_PREFS.imgBorderW });
                                }}
                              />
                            </label>
                          </div>
                        </>
                      ) : null}
                    </div>
                    <div className="thumb-prop-group">
                      <p className="thumb-prop-label">Parıltı</p>
                      <label className="thumb-chip">
                        <input type="checkbox" checked={selected.imgGlowOn} onChange={(e) => patchLayer(selected.id, { imgGlowOn: e.target.checked })} />
                        Parıltı açık
                      </label>
                      {selected.imgGlowOn ? (
                        <>
                          <div className="thumb-color-row">
                            <ColorSwatch label="Renk" value={selected.imgGlowColor} onChange={(imgGlowColor) => patchLayer(selected.id, { imgGlowColor })} />
                          </div>
                          <div className="thumb-slider-stack">
                            <label className="thumb-slider">
                              <span>
                                Yumuşaklık <em>{selected.imgGlowBlur}</em>
                              </span>
                              <input
                                type="range"
                                min={4}
                                max={80}
                                value={selected.imgGlowBlur}
                                title="Çift tık: varsayılan"
                                onChange={(e) => patchLayer(selected.id, { imgGlowBlur: Number(e.target.value), imgGlowOn: true })}
                                onDoubleClick={(e) => {
                                  e.preventDefault();
                                  patchLayer(selected.id, { imgGlowBlur: DEFAULT_IMAGE_PREFS.imgGlowBlur });
                                }}
                              />
                            </label>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </>
                ) : null}

                {selected.kind === "shape" ? (
                  <div className="thumb-prop-group">
                    <p className="thumb-prop-label">Şekil</p>
                    <label className="field thumb-prop-field">
                      <span>Tür</span>
                      <select value={selected.shape} onChange={(e) => patchLayer(selected.id, { shape: e.target.value as "rect" | "ellipse" })}>
                        <option value="rect">Dikdörtgen</option>
                        <option value="ellipse">Elips</option>
                      </select>
                    </label>
                    <div className="thumb-color-row">
                      <ColorSwatch label="Dolgu" value={selected.fill.slice(0, 7)} onChange={(fill) => patchLayer(selected.id, { fill })} />
                    </div>
                  </div>
                ) : null}

                {selected.kind === "frame" ? (
                  <>
                    <div className="thumb-color-row">
                      <ColorSwatch label="Renk" value={frame.color} onChange={(color) => setFrame((f) => ({ ...f, color }))} />
                    </div>
                    <div className="thumb-slider-stack">
                      <label className="thumb-slider">
                        <span>
                          Kalınlık <em>{frame.width}px</em>
                        </span>
                        <input
                          type="range"
                          min={4}
                          max={64}
                          value={frame.width}
                          title="Çift tık: varsayılan"
                          onChange={(e) => setFrame((f) => ({ ...f, width: Number(e.target.value) }))}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            setFrame((f) => ({ ...f, width: DEFAULT_FRAME_PREFS.width }));
                          }}
                        />
                      </label>
                      <label className="thumb-slider">
                        <span>
                          Yumuşaklık <em>{frame.feather}</em>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={80}
                          value={frame.feather}
                          title="Çift tık: varsayılan"
                          onChange={(e) => setFrame((f) => ({ ...f, feather: Number(e.target.value) }))}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            setFrame((f) => ({ ...f, feather: DEFAULT_FRAME_PREFS.feather }));
                          }}
                        />
                      </label>
                      {frame.glow ? (
                        <label className="thumb-slider">
                          <span>
                            Parıltı <em>{frame.glowBlur}</em>
                          </span>
                          <input
                            type="range"
                            min={8}
                            max={90}
                            value={frame.glowBlur}
                            title="Çift tık: varsayılan"
                            onChange={(e) => setFrame((f) => ({ ...f, glowBlur: Number(e.target.value) }))}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              setFrame((f) => ({ ...f, glowBlur: DEFAULT_FRAME_PREFS.glowBlur }));
                            }}
                          />
                        </label>
                      ) : null}
                    </div>
                    <label className="thumb-chip">
                      <input type="checkbox" checked={frame.glow} onChange={(e) => setFrame((f) => ({ ...f, glow: e.target.checked }))} />
                      Parıltı açık
                    </label>
                  </>
                ) : null}

                {selected.kind !== "frame" ? (
                  <div className="thumb-prop-group">
                    <p className="thumb-prop-label">Konum</p>
                    <div className="thumb-slider-stack">
                      <label className="thumb-slider">
                        <span>
                          Döndür <em>{selected.rotate}°</em>
                        </span>
                        <input
                          type="range"
                          min={-180}
                          max={180}
                          value={selected.rotate}
                          title="Çift tık: varsayılan"
                          onChange={(e) => patchLayer(selected.id, { rotate: Number(e.target.value) })}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            patchLayer(selected.id, { rotate: 0 });
                          }}
                        />
                      </label>
                      <label className="thumb-slider">
                        <span>
                          Opaklık <em>{Math.round(selected.opacity * 100)}%</em>
                        </span>
                        <input
                          type="range"
                          min={20}
                          max={100}
                          value={Math.round(selected.opacity * 100)}
                          title="Çift tık: varsayılan"
                          onChange={(e) => patchLayer(selected.id, { opacity: Number(e.target.value) / 100 })}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            patchLayer(selected.id, { opacity: 1 });
                          }}
                        />
                      </label>
                    </div>
                  </div>
                ) : null}

                <div className="thumb-action-row">
                  <button type="button" className="btn ghost" onClick={() => moveLayer(selected.id, "front")}>
                    Üste
                  </button>
                  <button type="button" className="btn ghost" onClick={() => moveLayer(selected.id, "back")}>
                    Alta
                  </button>
                  {selected.kind !== "frame" ? (
                    <button type="button" className="btn ghost" onClick={() => duplicateLayer(selected.id)}>
                      Kopyala
                    </button>
                  ) : null}
                  <button type="button" className="btn ghost danger" onClick={() => removeLayer(selected.id)}>
                    Sil
                  </button>
                </div>
                {error ? <p className="form-message">{error}</p> : null}
              </section>
            ) : (
              <>
                <section className="thumb-side-block">
                  <div className="thumb-side-heading">
                    <h3>Sahne</h3>
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
                  <div className="thumb-slider-stack">
                    <label className="thumb-slider">
                      <span>
                        Parlaklık <em>{brightness}%</em>
                      </span>
                      <input
                        type="range"
                        min={40}
                        max={160}
                        value={brightness}
                        title="Çift tık: varsayılan"
                        onChange={(e) => setBrightness(Number(e.target.value))}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          setBrightness(100);
                        }}
                      />
                    </label>
                    <label className="thumb-slider">
                      <span>
                        Kontrast <em>{contrast}%</em>
                      </span>
                      <input
                        type="range"
                        min={40}
                        max={180}
                        value={contrast}
                        title="Çift tık: varsayılan"
                        onChange={(e) => setContrast(Number(e.target.value))}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          setContrast(100);
                        }}
                      />
                    </label>
                    <label className="thumb-slider">
                      <span>
                        Doygunluk <em>{saturate}%</em>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={220}
                        value={saturate}
                        title="Çift tık: varsayılan"
                        onChange={(e) => setSaturate(Number(e.target.value))}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          setSaturate(100);
                        }}
                      />
                    </label>
                  </div>
                </section>

                {hasFrame ? (
                  <section className="thumb-side-block">
                    <div className="thumb-side-heading">
                      <h3>Çerçeve</h3>
                      <ColorSwatch label="Renk" value={frame.color} onChange={(color) => setFrame((f) => ({ ...f, color }))} />
                    </div>
                    <div className="thumb-slider-stack">
                      <label className="thumb-slider">
                        <span>
                          Kalınlık <em>{frame.width}px</em>
                        </span>
                        <input
                          type="range"
                          min={4}
                          max={64}
                          value={frame.width}
                          title="Çift tık: varsayılan"
                          onChange={(e) => setFrame((f) => ({ ...f, width: Number(e.target.value) }))}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            setFrame((f) => ({ ...f, width: DEFAULT_FRAME_PREFS.width }));
                          }}
                        />
                      </label>
                      <label className="thumb-slider">
                        <span>
                          Yumuşaklık <em>{frame.feather}</em>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={80}
                          value={frame.feather}
                          title="Çift tık: varsayılan"
                          onChange={(e) => setFrame((f) => ({ ...f, feather: Number(e.target.value) }))}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            setFrame((f) => ({ ...f, feather: DEFAULT_FRAME_PREFS.feather }));
                          }}
                        />
                      </label>
                      {frame.glow ? (
                        <label className="thumb-slider">
                          <span>
                            Parıltı <em>{frame.glowBlur}</em>
                          </span>
                          <input
                            type="range"
                            min={8}
                            max={90}
                            value={frame.glowBlur}
                            title="Çift tık: varsayılan"
                            onChange={(e) => setFrame((f) => ({ ...f, glowBlur: Number(e.target.value) }))}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              setFrame((f) => ({ ...f, glowBlur: DEFAULT_FRAME_PREFS.glowBlur }));
                            }}
                          />
                        </label>
                      ) : null}
                    </div>
                    <label className="thumb-chip">
                      <input type="checkbox" checked={frame.glow} onChange={(e) => setFrame((f) => ({ ...f, glow: e.target.checked }))} />
                      Parıltı açık
                    </label>
                  </section>
                ) : null}

                <section className="thumb-side-block thumb-props-empty">
                  <p className="muted thumb-pane-hint">Katman seçince burada ayarları görünür. Boş alana tıklayınca sahne ayarları geri gelir.</p>
                  {error ? <p className="form-message">{error}</p> : null}
                </section>
              </>
            )}
            </div>
          </aside>
        </div>
        <ContextMenu
          open={!!ctxMenu}
          x={ctxMenu?.x ?? 0}
          y={ctxMenu?.y ?? 0}
          items={ctxMenu ? layerMenuItems(ctxMenu.id) : []}
          onClose={() => setCtxMenu(null)}
        />
      </div>
    </div>
  );
}
