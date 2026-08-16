"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, type AppSettings, type ThemeId } from "@/lib/api";
import { isThemeId, readStoredTheme, writeStoredTheme } from "@/lib/persist";

type ThemeContextValue = {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  settings: AppSettings | null;
  refreshSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function paintTheme(t: ThemeId) {
  document.documentElement.setAttribute("data-theme", t);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>("dark");
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const applyTheme = useCallback((t: ThemeId) => {
    setThemeState(t);
    writeStoredTheme(t);
    if (typeof document !== "undefined") {
      paintTheme(t);
    }
  }, []);

  // Apply cached theme before paint (avoids flash to default)
  useLayoutEffect(() => {
    const stored = readStoredTheme();
    if (stored) {
      setThemeState(stored);
      paintTheme(stored);
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const data = await api<AppSettings>("/settings");
      setSettings(data);
      const t = isThemeId(data.theme) ? data.theme : readStoredTheme() || "dark";
      applyTheme(t);
    } catch {
      const stored = readStoredTheme();
      if (stored) applyTheme(stored);
    }
  }, [applyTheme]);

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const data = await api<AppSettings>("/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      setSettings(data);
      if (patch.theme && isThemeId(patch.theme)) applyTheme(patch.theme);
    },
    [applyTheme]
  );

  const setTheme = useCallback(
    (t: ThemeId) => {
      applyTheme(t);
      void updateSettings({ theme: t });
    },
    [applyTheme, updateSettings]
  );

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const value = useMemo(
    () => ({ theme, setTheme, settings, refreshSettings, updateSettings }),
    [theme, setTheme, settings, refreshSettings, updateSettings]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
