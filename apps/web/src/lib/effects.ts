/** Shared effect catalog for editor UI + labels */

export const FX_LABELS: Record<string, string> = {
  text: "Metin",
  rect: "Şekil",
  fadeblack: "Siyah fade",
  fade: "Fade",
  speed: "Hız",
  brightness: "Parlaklık",
  contrast: "Kontrast",
  vignette: "Vinyet",
  blur: "Bulanıklık",
  saturate: "Doygunluk",
  grayscale: "Siyah-beyaz",
  sepia: "Sepya",
  sharpen: "Keskinlik",
  noise: "Gren",
  letterbox: "Letterbox",
  mirror: "Ayna",
  tint: "Renk tonu",
};

export type FxType = keyof typeof FX_LABELS;

/** Types that stack (multiple allowed) */
export const FX_STACKABLE = new Set(["text", "rect"]);

export const FX_PALETTE: {
  type: FxType;
  label: string;
  hint: string;
  group: "overlay" | "transition" | "color" | "lens" | "motion";
}[] = [
  { type: "fadeblack", label: "Siyah fade", hint: "2sn siyah → yumuşak aç/kapa", group: "transition" },
  { type: "text", label: "Metin", hint: "Video üstüne sürükle", group: "overlay" },
  { type: "rect", label: "Şekil", hint: "Highlight / kutu", group: "overlay" },
  { type: "speed", label: "Hız", hint: "0.5x–2x", group: "motion" },
  { type: "brightness", label: "Parlaklık", hint: "Aydınlık / karanlık", group: "color" },
  { type: "contrast", label: "Kontrast", hint: "Kontrast ayarı", group: "color" },
  { type: "saturate", label: "Doygunluk", hint: "Renk yoğunluğu", group: "color" },
  { type: "tint", label: "Renk tonu", hint: "Warm / cool cast", group: "color" },
  { type: "grayscale", label: "Siyah-beyaz", hint: "Desatüre", group: "color" },
  { type: "sepia", label: "Sepya", hint: "Vintage ton", group: "color" },
  { type: "vignette", label: "Vinyet", hint: "Kenar karartma", group: "lens" },
  { type: "blur", label: "Bulanıklık", hint: "Gaussian blur", group: "lens" },
  { type: "sharpen", label: "Keskinlik", hint: "Unsharp", group: "lens" },
  { type: "noise", label: "Gren", hint: "Film grain", group: "lens" },
  { type: "letterbox", label: "Letterbox", hint: "Sinema şeritleri", group: "overlay" },
  { type: "mirror", label: "Ayna", hint: "Yatay çevir", group: "motion" },
];
