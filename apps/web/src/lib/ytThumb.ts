export const YT_W = 1280;
export const YT_H = 720;

export async function loadImage(src: string): Promise<HTMLImageElement> {
  let url = src;
  if (src.startsWith("/") && !src.startsWith("//")) {
    const path = src.startsWith("/api") ? src : `/api${src}`;
    const res = await fetch(path, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error("Görsel yüklenemedi");
    url = URL.createObjectURL(await res.blob());
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (url.startsWith("http")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Görsel yüklenemedi"));
    img.src = url;
  });
}

/** Letterbox into 1280×720 (true 16:9). Never crop. Caller fills the canvas. */
export function drawContained(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  iw: number,
  ih: number,
  dw = YT_W,
  dh = YT_H
) {
  if (!iw || !ih) return;
  const scale = Math.min(dw / iw, dh / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(img, 0, 0, iw, ih, (dw - w) / 2, (dh - h) / 2, w, h);
}

export function fitToYtThumb(img: CanvasImageSource, iw: number, ih: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = YT_W;
  canvas.height = YT_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas.toDataURL("image/jpeg", 0.92);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, YT_W, YT_H);
  drawContained(ctx, img, iw, ih);
  return canvas.toDataURL("image/jpeg", 0.92);
}

export async function fileToYtThumb(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Görsel dosyası seçin");
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return fitToYtThumb(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function videoFrameToYtThumb(video: HTMLVideoElement): string {
  return fitToYtThumb(
    video,
    video.videoWidth || YT_W,
    video.videoHeight || YT_H
  );
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Dosya okunamadı"));
    reader.readAsDataURL(file);
  });
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const words = raw.split(" ");
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}
