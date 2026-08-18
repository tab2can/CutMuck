"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { api, mediaSrc } from "@/lib/api";
import { loadImage, wrapText, YT_H, YT_W, fileToDataUrl } from "@/lib/ytThumb";

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
  shadow: boolean;
  italic: boolean;
  bold: boolean;
  src: string;
  shape: "rect" | "ellipse";
  fill: string;
};

type Frame = { on: boolean; color: string; width: number; glow: boolean };

const FONTS = [
  { id: "impact", label: "Impact", value: 'Impact, Haettenschweiler, "Arial Black", sans-serif' },
  { id: "black", label: "Arial Black", value: '"Arial Black", Arial, sans-serif' },
  { id: "sora", label: "Sora", value: "var(--font-sora), Sora, sans-serif" },
  { id: "georgia", label: "Georgia", value: "Georgia, serif" },
];

function nid() {
  return crypto.randomUUID?.() || Math.random().toString(36).slice(2);
}

function baseLayer(kind: LayerKind, patch: Partial<Layer> = {}): Layer {
  return {
    id: nid(),
    kind,
    x: 0.5,
    y: 0.55,
    w: kind === "text" ? 0.55 : 0.32,
    h: kind === "text" ? 0.18 : 0.45,
    rotate: 0,
    opacity: 1,
    text: "CESARET\nTESTİ",
    font: FONTS[0].value,
    fontSize: 72,
    color: "#ffe14a",
    stroke: "#111111",
    strokeW: 8,
    shadow: true,
    italic: true,
    bold: true,
    src: "",
    shape: "rect",
    fill: "#ffe14a",
    ...patch,
  };
}

type Props = {
  channelSlug: string;
  baseSrc: string | null;
  onClose: () => void;
  onApply: (dataUrl: string) => void;
};

export function ThumbnailEditor({ channelSlug, baseSrc, onClose, onApply }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [bg, setBg] = useState(baseSrc);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assets, setAssets] = useState<ChannelAsset[]>([]);
  const [frame, setFrame] = useState<Frame>({ on: true, color: "#ffe14a", width: 18, glow: true });
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturate, setSaturate] = useState(110);
  const [flipH, setFlipH] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ id: string; mode: "move" | "resize"; dx: number; dy: number } | null>(null);

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
    setBg(baseSrc);
  }, [baseSrc]);

  function patchLayer(id: string, patch: Partial<Layer>) {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function addText() {
    const layer = baseLayer("text", { y: 0.72, x: 0.38 });
    setLayers((prev) => [...prev, layer]);
    setSelectedId(layer.id);
  }

  function addShape() {
    const layer = baseLayer("shape", {
      x: 0.5,
      y: 0.5,
      w: 0.4,
      h: 0.12,
      fill: "#000000aa",
      opacity: 0.55,
    });
    setLayers((prev) => [...prev, layer]);
    setSelectedId(layer.id);
  }

  function addAssetToCanvas(asset: ChannelAsset) {
    const src = mediaSrc(asset.url) || asset.url;
    const layer = baseLayer("image", { src, x: 0.78, y: 0.5, w: 0.38, h: 0.78 });
    setLayers((prev) => [...prev, layer]);
    setSelectedId(layer.id);
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
      addAssetToCanvas(row);
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
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    };
  }

  function onLayerDown(e: PointerEvent, id: string, mode: "move" | "resize") {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const layer = layers.find((l) => l.id === id);
    const { x, y } = toNorm(e.clientX, e.clientY);
    drag.current = { id, mode, dx: x - (layer?.x ?? 0.5), dy: y - (layer?.y ?? 0.5) };
    setSelectedId(id);
  }

  function onPointerMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const { x, y } = toNorm(e.clientX, e.clientY);
    const layer = layers.find((l) => l.id === d.id);
    if (!layer) return;
    if (d.mode === "move") {
      patchLayer(d.id, {
        x: Math.min(1, Math.max(0, x - d.dx)),
        y: Math.min(1, Math.max(0, y - d.dy)),
      });
      return;
    }
    const w = Math.min(0.95, Math.max(0.06, Math.abs(x - layer.x) * 2));
    const h = Math.min(0.95, Math.max(0.05, Math.abs(y - layer.y) * 2));
    patchLayer(d.id, {
      w,
      h,
      fontSize: layer.kind === "text" ? Math.round(18 + h * 220) : layer.fontSize,
    });
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
          ctx.drawImage(img, 0, 0, YT_W, YT_H);
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
            if (layer.strokeW) ctx.stroke();
          } else {
            ctx.fillRect(-w / 2, -h / 2, w, h);
            if (layer.strokeW) ctx.strokeRect(-w / 2, -h / 2, w, h);
          }
        } else if (layer.kind === "image" && layer.src) {
          try {
            const img = await loadImage(layer.src);
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
          } catch {
            /* skip */
          }
        } else if (layer.kind === "text") {
          const weight = layer.bold ? "800" : "600";
          const style = layer.italic ? "italic" : "normal";
          ctx.font = `${style} ${weight} ${layer.fontSize}px ${layer.font}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const lines = wrapText(ctx, layer.text || "", w);
          const lh = layer.fontSize * 1.05;
          const top = -((lines.length - 1) * lh) / 2;
          lines.forEach((line, i) => {
            const yy = top + i * lh;
            if (layer.shadow) {
              ctx.shadowColor = "rgba(0,0,0,0.85)";
              ctx.shadowBlur = 12;
              ctx.shadowOffsetX = 4;
              ctx.shadowOffsetY = 4;
            }
            if (layer.strokeW > 0) {
              ctx.lineWidth = layer.strokeW;
              ctx.strokeStyle = layer.stroke;
              ctx.lineJoin = "round";
              ctx.miterLimit = 2;
              ctx.strokeText(line, 0, yy);
            }
            ctx.fillStyle = layer.color;
            ctx.fillText(line, 0, yy);
            ctx.shadowColor = "transparent";
          });
        }
        ctx.restore();
      }
      if (frame.on) {
        ctx.save();
        const t = Math.max(6, frame.width);
        ctx.strokeStyle = frame.color;
        ctx.lineWidth = t;
        if (frame.glow) {
          ctx.shadowColor = frame.color;
          ctx.shadowBlur = 22;
        }
        ctx.strokeRect(t / 2, t / 2, YT_W - t, YT_H - t);
        ctx.restore();
      }
      onApply(canvas.toDataURL("image/jpeg", 0.92));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dışa aktarılamadı");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="thumb-editor-backdrop" onClick={onClose}>
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
              1280×720 · kanal görselleri: <strong>{slug === "_genel" ? "genel" : slug}</strong>
            </p>
          </div>
          <div className="effect-row">
            <button type="button" className="btn ghost" onClick={onClose}>
              İptal
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void exportThumb()}>
              {busy ? "İşleniyor…" : "Kapağı uygula"}
            </button>
          </div>
        </header>

        <div className="thumb-editor-body">
          <div className="thumb-editor-main">
            <div
              className="thumb-stage"
              ref={stageRef}
              onPointerDown={() => setSelectedId(null)}
            >
              {bg ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="thumb-stage-bg"
                  src={bg}
                  alt=""
                  style={{ filter: filterCss, transform: flipH ? "scaleX(-1)" : undefined }}
                />
              ) : (
                <div className="thumb-stage-empty">Arka plan yok — soldan görsel ekleyin veya kare yakalayın</div>
              )}
              {frame.on ? (
                <div
                  className={`thumb-frame${frame.glow ? " glow" : ""}`}
                  style={{
                    borderColor: frame.color,
                    borderWidth: Math.max(4, frame.width / 3),
                    boxShadow: frame.glow ? `0 0 18px ${frame.color}` : "none",
                  }}
                />
              ) : null}
              {layers.map((layer) => (
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
                >
                  {layer.kind === "text" ? (
                    <div
                      className="thumb-layer-text"
                      style={{
                        color: layer.color,
                        fontFamily: layer.font,
                        fontSize: `clamp(12px, ${layer.fontSize / 18}cqw, 64px)`,
                        fontStyle: layer.italic ? "italic" : "normal",
                        fontWeight: layer.bold ? 800 : 600,
                        WebkitTextStroke: `${Math.max(1, layer.strokeW / 6)}px ${layer.stroke}`,
                        textShadow: layer.shadow ? "3px 3px 0 #000" : "none",
                      }}
                    >
                      {layer.text}
                    </div>
                  ) : layer.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={layer.src} alt="" draggable={false} />
                  ) : (
                    <div
                      className="thumb-layer-shape"
                      style={{
                        background: layer.fill,
                        borderRadius: layer.shape === "ellipse" ? "50%" : 8,
                        border: layer.strokeW ? `${layer.strokeW / 4}px solid ${layer.stroke}` : "none",
                      }}
                    />
                  )}
                  {selectedId === layer.id ? (
                    <button
                      type="button"
                      className="thumb-resize"
                      aria-label="Boyut"
                      onPointerDown={(e) => onLayerDown(e, layer.id, "resize")}
                    />
                  ) : null}
                </div>
              ))}
            </div>

            <div className="thumb-assets">
              <button
                type="button"
                className="thumb-asset-add"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
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
                <p className="muted thumb-assets-hint">
                  Bu kanala eklenen PNG/JPEG’ler burada kalır. Başka kanalda görünmez.
                </p>
              ) : (
                assets.map((asset) => (
                  <div key={asset.id} className="thumb-asset">
                    <button type="button" onClick={() => addAssetToCanvas(asset)} title={asset.name}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={mediaSrc(asset.url) || asset.url} alt={asset.name} />
                    </button>
                    <button
                      type="button"
                      className="thumb-asset-del"
                      onClick={() => void removeAsset(asset.id)}
                      aria-label="Sil"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <aside className="thumb-editor-side">
            <h3>Araçlar</h3>
            <div className="thumb-tools">
              <button type="button" className="btn" onClick={addText}>
                Metin
              </button>
              <button type="button" className="btn" onClick={addShape}>
                Şekil
              </button>
              <button
                type="button"
                className={`btn${frame.on ? "" : " ghost"}`}
                onClick={() => setFrame((f) => ({ ...f, on: !f.on }))}
              >
                Çerçeve
              </button>
              <button type="button" className="btn ghost" onClick={() => setFlipH((v) => !v)}>
                Yatay çevir
              </button>
            </div>

            <div className="thumb-settings">
              <h4>Arka plan</h4>
              <label className="field">
                <span>Parlaklık {brightness}%</span>
                <input
                  type="range"
                  min={40}
                  max={160}
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Kontrast {contrast}%</span>
                <input
                  type="range"
                  min={40}
                  max={180}
                  value={contrast}
                  onChange={(e) => setContrast(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Doygunluk {saturate}%</span>
                <input
                  type="range"
                  min={0}
                  max={220}
                  value={saturate}
                  onChange={(e) => setSaturate(Number(e.target.value))}
                />
              </label>
              {frame.on ? (
                <>
                  <h4>Çerçeve</h4>
                  <label className="field">
                    <span>Renk</span>
                    <input
                      type="color"
                      value={frame.color}
                      onChange={(e) => setFrame((f) => ({ ...f, color: e.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span>Kalınlık {frame.width}px</span>
                    <input
                      type="range"
                      min={6}
                      max={48}
                      value={frame.width}
                      onChange={(e) => setFrame((f) => ({ ...f, width: Number(e.target.value) }))}
                    />
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={frame.glow}
                      onChange={(e) => setFrame((f) => ({ ...f, glow: e.target.checked }))}
                    />
                    Parıltı
                  </label>
                </>
              ) : null}

              {selected ? (
                <>
                  <h4>
                    {selected.kind === "text" ? "Metin" : selected.kind === "image" ? "Görsel" : "Şekil"}{" "}
                    ayarları
                  </h4>
                  {selected.kind === "text" ? (
                    <>
                      <label className="field">
                        <span>Yazı</span>
                        <textarea
                          rows={3}
                          value={selected.text}
                          onChange={(e) => patchLayer(selected.id, { text: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>Font</span>
                        <select
                          value={selected.font}
                          onChange={(e) => patchLayer(selected.id, { font: e.target.value })}
                        >
                          {FONTS.map((f) => (
                            <option key={f.id} value={f.value}>
                              {f.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Dolgu</span>
                        <input
                          type="color"
                          value={selected.color}
                          onChange={(e) => patchLayer(selected.id, { color: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>Kontur</span>
                        <input
                          type="color"
                          value={selected.stroke}
                          onChange={(e) => patchLayer(selected.id, { stroke: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>Kontur {selected.strokeW}px</span>
                        <input
                          type="range"
                          min={0}
                          max={24}
                          value={selected.strokeW}
                          onChange={(e) => patchLayer(selected.id, { strokeW: Number(e.target.value) })}
                        />
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={selected.bold}
                          onChange={(e) => patchLayer(selected.id, { bold: e.target.checked })}
                        />
                        Kalın
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={selected.italic}
                          onChange={(e) => patchLayer(selected.id, { italic: e.target.checked })}
                        />
                        İtalik
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={selected.shadow}
                          onChange={(e) => patchLayer(selected.id, { shadow: e.target.checked })}
                        />
                        Gölge
                      </label>
                    </>
                  ) : selected.kind === "shape" ? (
                    <>
                      <label className="field">
                        <span>Şekil</span>
                        <select
                          value={selected.shape}
                          onChange={(e) =>
                            patchLayer(selected.id, { shape: e.target.value as "rect" | "ellipse" })
                          }
                        >
                          <option value="rect">Dikdörtgen</option>
                          <option value="ellipse">Elips</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>Dolgu</span>
                        <input
                          type="color"
                          value={selected.fill.slice(0, 7)}
                          onChange={(e) => patchLayer(selected.id, { fill: e.target.value })}
                        />
                      </label>
                    </>
                  ) : null}
                  <label className="field">
                    <span>Döndür {selected.rotate}°</span>
                    <input
                      type="range"
                      min={-40}
                      max={40}
                      value={selected.rotate}
                      onChange={(e) => patchLayer(selected.id, { rotate: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    <span>Opaklık {Math.round(selected.opacity * 100)}%</span>
                    <input
                      type="range"
                      min={20}
                      max={100}
                      value={Math.round(selected.opacity * 100)}
                      onChange={(e) => patchLayer(selected.id, { opacity: Number(e.target.value) / 100 })}
                    />
                  </label>
                  <div className="effect-row">
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        const copy = { ...selected, id: nid(), x: Math.min(0.9, selected.x + 0.04) };
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
                <p className="muted fx-side-hint">Bir katman seçin veya metin / görsel ekleyin.</p>
              )}
            </div>
            {error ? <p className="form-message">{error}</p> : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
