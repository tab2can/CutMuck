export type ThemeId = "black" | "dark" | "light";

export type Channel = {
  slug: string;
  display_name: string;
  avatar_url?: string | null;
  banner_url?: string | null;
  is_live: number | boolean | string;
};

export type Vod = {
  id: string;
  uuid?: string;
  title: string;
  duration: number;
  views: number;
  created_at?: string;
  thumbnail?: string;
  is_live?: boolean;
  url?: string | null;
};

export type Clip = {
  id: string;
  title: string;
  views: number;
  duration: number;
  thumbnail?: string;
  url?: string | null;
  video_url?: string | null;
};

export type AppSettings = {
  theme?: ThemeId | string;
  youtube_client_id?: string;
  youtube_client_secret?: string;
  youtube_client_secret_set?: boolean;
  youtube_refresh_token_set?: boolean;
  youtube_privacy_default?: "public" | "unlisted" | "private";
  worker_public_url?: string;
  [key: string]: unknown;
};

export type TimelineOverlay = {
  id: string;
  type:
    | "text"
    | "rect"
    | "fade"
    | "fadeblack"
    | "speed"
    | "brightness"
    | "contrast"
    | "vignette"
    | "blur"
    | "saturate"
    | "grayscale"
    | "sepia"
    | "sharpen"
    | "noise"
    | "letterbox"
    | "mirror"
    | "tint";
  text?: string;
  start_sec?: number;
  end_sec?: number | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  font_size?: number;
  color?: string;
  bg?: string;
  opacity?: number;
  fade_in?: number;
  fade_out?: number;
  /** Solid black hold before fade-in starts */
  hold_in?: number;
  /** Solid black hold after fade-out ends */
  hold_out?: number;
  speed?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  blur?: number;
  amount?: number;
  rotation?: number;
  hidden?: boolean;
  locked?: boolean;
};

export type Job = {
  id: string;
  kind: string;
  status: string;
  progress: number;
  channel_slug?: string | null;
  source_url?: string | null;
  title?: string | null;
  local_path?: string | null;
  cut_path?: string | null;
  error?: string | null;
  meta?: Record<string, unknown>;
  media_url?: string | null;
  cut_url?: string | null;
  stream_url?: string | null;
  cut_size_bytes?: number | null;
  updated_at?: string | null;
};

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
    if (Array.isArray(data?.detail))
      return data.detail.map((d: { msg?: string }) => d.msg || "").join(", ");
    return JSON.stringify(data);
  } catch {
    return res.statusText || "İstek başarısız";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(await parseError(res));
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function mediaSrc(pathOrUrl?: string | null): string | null {
  if (!pathOrUrl) return null;
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  return `/api${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

export function formatDuration(seconds?: number): string {
  if (seconds == null || seconds < 0 || Number.isNaN(seconds)) return "—";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes == null || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1)} MB`;
}

export function jobStatusLabel(status: string): string {
  const map: Record<string, string> = {
    ready: "Hazır",
    cut: "Kesildi",
    done: "YouTube’da",
    error: "Hata",
    queued: "Sırada",
    exporting: "Dışa aktarılıyor",
    uploading: "Yükleniyor",
    cutting: "Kesiliyor",
  };
  return map[status] || status;
}
