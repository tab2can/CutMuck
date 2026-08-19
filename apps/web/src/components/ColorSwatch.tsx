"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

function hexToRgb(hex: string) {
  const h = hex.replace("#", "").slice(0, 6);
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  if (Number.isNaN(n)) return { r: 255, g: 225, b: 74 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r: number, g: number, b: number) {
  return (
    "#" +
    [r, g, b]
      .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

function rgbToHsv(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max ? d / max : 0;
  return { h, s, v: max };
}

function hsvToRgb(h: number, s: number, v: number) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

const PRESETS = [
  "#ffe14a",
  "#ffffff",
  "#111111",
  "#ff3b3b",
  "#3b82f6",
  "#22c55e",
  "#a855f7",
  "#fb923c",
];

type Props = {
  value: string;
  onChange: (hex: string) => void;
  label?: string;
};

export function ColorSwatch({ value, onChange, label }: Props) {
  const hex = value.slice(0, 7);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const rgb = hexToRgb(hex);
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function setHsv(h: number, s: number, v: number) {
    const { r, g, b } = hsvToRgb(h, s, v);
    onChange(rgbToHex(r, g, b));
  }

  function onBox(e: PointerEvent<HTMLDivElement>) {
    const el = box.current;
    if (!el) return;
    el.setPointerCapture?.(e.pointerId);
    const r = el.getBoundingClientRect();
    const s = clamp((e.clientX - r.left) / r.width, 0, 1);
    const v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    setHsv(hsv.h, s, v);
  }

  const hueRgb = hsvToRgb(hsv.h, 1, 1);
  const hueColor = rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b);

  return (
    <div className="cm-color" ref={root}>
      {label ? <span>{label}</span> : null}
      <button
        type="button"
        className="cm-color-btn"
        style={{ background: hex }}
        aria-label={label || "Renk"}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({
            top: Math.min(r.bottom + 8, window.innerHeight - 260),
            left: Math.max(8, Math.min(r.left, window.innerWidth - 228)),
          });
          setOpen((v) => !v);
        }}
      />
      {open ? (
        <div className="cm-color-pop" style={{ top: pos.top, left: pos.left }} onPointerDown={(e) => e.stopPropagation()}>
          <div
            ref={box}
            className="cm-color-sv"
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
            onPointerDown={onBox}
            onPointerMove={(e) => {
              if (e.buttons) onBox(e);
            }}
          >
            <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
          </div>
          <input
            className="cm-color-hue"
            type="range"
            min={0}
            max={360}
            value={Math.round(hsv.h)}
            onChange={(e) => setHsv(Number(e.target.value), hsv.s, hsv.v)}
          />
          <div className="cm-color-presets">
            {PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                style={{ background: c }}
                onClick={() => onChange(c)}
                aria-label={c}
              />
            ))}
          </div>
          <input
            className="cm-color-hex"
            value={hex}
            onChange={(e) => {
              const v = e.target.value;
              if (/^#?[0-9a-fA-F]{6}$/.test(v)) onChange(v.startsWith("#") ? v : `#${v}`);
            }}
            spellCheck={false}
          />
        </div>
      ) : null}
    </div>
  );
}
