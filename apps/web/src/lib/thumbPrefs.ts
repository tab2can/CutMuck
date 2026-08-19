export type TextPrefs = {
  font: string;
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
};

export type FramePrefs = {
  on: boolean;
  color: string;
  width: number;
  feather: number;
  glow: boolean;
  glowBlur: number;
};

export type ImagePrefs = {
  imgBorderOn: boolean;
  imgBorderColor: string;
  imgBorderW: number;
  imgGlowOn: boolean;
  imgGlowColor: string;
  imgGlowBlur: number;
};

export type ShapePrefs = {
  shape: "rect" | "ellipse";
  fill: string;
};

export type ThumbToolPrefs = {
  text: TextPrefs;
  frame: FramePrefs;
  image: ImagePrefs;
  shape: ShapePrefs;
};

const KEY = "cutmuck.thumbTools.v1";

export const DEFAULT_TEXT_PREFS: TextPrefs = {
  font: 'Impact, Haettenschweiler, "Arial Black", sans-serif',
  color: "#ffe14a",
  stroke: "#111111",
  strokeW: 8,
  italic: true,
  bold: true,
  uppercase: false,
  letterSpacing: 0,
  lineHeight: 1.05,
  curve: 0,
  shadowOn: true,
  shadowColor: "#000000",
  shadowBlur: 14,
  shadowX: 3,
  shadowY: 4,
};

export const DEFAULT_FRAME_PREFS: FramePrefs = {
  on: false,
  color: "#ffe14a",
  width: 18,
  feather: 22,
  glow: true,
  glowBlur: 36,
};

export const DEFAULT_IMAGE_PREFS: ImagePrefs = {
  imgBorderOn: false,
  imgBorderColor: "#ffe14a",
  imgBorderW: 6,
  imgGlowOn: false,
  imgGlowColor: "#ffe14a",
  imgGlowBlur: 28,
};

export const DEFAULT_SHAPE_PREFS: ShapePrefs = {
  shape: "rect",
  fill: "#000000",
};

export function loadThumbPrefs(): ThumbToolPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return {
        text: { ...DEFAULT_TEXT_PREFS },
        frame: { ...DEFAULT_FRAME_PREFS },
        image: { ...DEFAULT_IMAGE_PREFS },
        shape: { ...DEFAULT_SHAPE_PREFS },
      };
    }
    const p = JSON.parse(raw) as Partial<ThumbToolPrefs>;
    return {
      text: { ...DEFAULT_TEXT_PREFS, ...p.text },
      frame: { ...DEFAULT_FRAME_PREFS, ...p.frame },
      image: { ...DEFAULT_IMAGE_PREFS, ...p.image },
      shape: { ...DEFAULT_SHAPE_PREFS, ...p.shape },
    };
  } catch {
    return {
      text: { ...DEFAULT_TEXT_PREFS },
      frame: { ...DEFAULT_FRAME_PREFS },
      image: { ...DEFAULT_IMAGE_PREFS },
      shape: { ...DEFAULT_SHAPE_PREFS },
    };
  }
}

export function saveThumbPrefs(patch: Partial<ThumbToolPrefs>) {
  try {
    const cur = loadThumbPrefs();
    const next: ThumbToolPrefs = {
      text: { ...cur.text, ...patch.text },
      frame: { ...cur.frame, ...patch.frame },
      image: { ...cur.image, ...patch.image },
      shape: { ...cur.shape, ...patch.shape },
    };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}
