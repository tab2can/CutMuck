import type { Channel, ThemeId } from "@/lib/api";

const THEME_KEY = "cutmuck.theme";
const CHANNELS_KEY = "cutmuck.channels";

const THEMES: ThemeId[] = ["dark", "black", "light"];

function channelsKey(ownerEmail?: string | null): string {
  const email = (ownerEmail || "").trim().toLowerCase();
  return email ? `${CHANNELS_KEY}.${email}` : CHANNELS_KEY;
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEMES as string[]).includes(value);
}

export function readStoredTheme(): ThemeId | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return isThemeId(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredTheme(theme: ThemeId) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore quota / private mode
  }
}

export function readStoredChannels(ownerEmail?: string | null): Channel[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(channelsKey(ownerEmail));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is Channel =>
        !!c &&
        typeof c === "object" &&
        typeof (c as Channel).slug === "string" &&
        typeof (c as Channel).display_name === "string"
    );
  } catch {
    return [];
  }
}

export function writeStoredChannels(channels: Channel[], ownerEmail?: string | null) {
  if (typeof window === "undefined") return;
  try {
    const slim = channels.map((c) => ({
      slug: c.slug,
      display_name: c.display_name,
      avatar_url: c.avatar_url ?? null,
      banner_url: c.banner_url ?? null,
      is_live: c.is_live ? 1 : 0,
    }));
    localStorage.setItem(channelsKey(ownerEmail), JSON.stringify(slim));
  } catch {
    // ignore
  }
}
