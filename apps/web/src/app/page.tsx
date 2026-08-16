"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { api, type Channel } from "@/lib/api";
import { SidePanel } from "@/components/SidePanel";
import { SettingsModal } from "@/components/SettingsModal";
import { WelcomeGuide } from "@/components/WelcomeGuide";
import { ChannelDetail } from "@/components/ChannelDetail";
import { JobsLibrary } from "@/components/JobsLibrary";
import { useNativeContextBlock } from "@/components/ContextMenu";
import { useTheme } from "@/components/ThemeProvider";
import { useToast } from "@/components/Toast";
import { readStoredChannels, writeStoredChannels } from "@/lib/persist";
import { useAuth } from "@/components/AuthProvider";

const LIVE_POLL_MS = 45_000;

export default function HomePage() {
  useNativeContextBlock(true);
  const { refreshSettings } = useTheme();
  const { user } = useAuth();
  const { push } = useToast();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [youtubeNotice, setYoutubeNotice] = useState<string | null>(null);

  // Paint cached channels before first paint (no empty flash) — per user
  useLayoutEffect(() => {
    const cached = readStoredChannels(user?.email);
    if (cached.length) setChannels(cached);
    else setChannels([]);
    setSelectedSlug(null);
  }, [user?.email]);

  const commitChannels = useCallback(
    (list: Channel[]) => {
      setChannels(list);
      writeStoredChannels(list, user?.email);
    },
    [user?.email]
  );

  const loadChannels = useCallback(
    async (opts?: { refreshLive?: boolean }) => {
      try {
        const q = opts?.refreshLive ? "?refresh=1" : "";
        const list = await api<Channel[]>(`/channels${q}`);
        commitChannels(list);
        setBootError(null);
        return list;
      } catch (e) {
        setBootError(e instanceof Error ? e.message : "Worker’a bağlanılamadı");
        return null;
      }
    },
    [commitChannels]
  );

  useEffect(() => {
    // Instant: cached DB list first, Kick live status in background
    void (async () => {
      await loadChannels({ refreshLive: false });
      void loadChannels({ refreshLive: true });
    })();
  }, [loadChannels]);

  // Keep CANLI badges in sync with Kick
  useEffect(() => {
    const id = window.setInterval(() => {
      void loadChannels({ refreshLive: true });
    }, LIVE_POLL_MS);
    const onFocus = () => void loadChannels({ refreshLive: true });
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadChannels]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const yt = params.get("youtube");
    if (yt === "connected") {
      setSettingsOpen(true);
      setYoutubeNotice("YouTube hesabı bağlandı.");
      push("YouTube bağlandı — kapak yükleme için gerekirse yeniden bağlanın", "ok");
      void refreshSettings();
      window.history.replaceState({}, "", "/");
    } else if (yt === "error") {
      setSettingsOpen(true);
      const reason = params.get("reason") || "bilinmeyen hata";
      setYoutubeNotice(`YouTube bağlantısı başarısız: ${reason}. Ayarlardan tekrar deneyin.`);
      push(`YouTube hatası: ${reason}`, "error");
      window.history.replaceState({}, "", "/");
    }
  }, [refreshSettings, push]);

  const selected = channels.find((c) => c.slug === selectedSlug) || null;

  const patchChannel = useCallback(
    (ch: Channel) => {
      setChannels((prev) => {
        const idx = prev.findIndex((p) => p.slug === ch.slug);
        const next =
          idx < 0
            ? [...prev, ch]
            : (() => {
                const copy = [...prev];
                copy[idx] = { ...copy[idx], ...ch };
                return copy;
              })();
        writeStoredChannels(next, user?.email);
        return next;
      });
    },
    [user?.email]
  );

  return (
    <div className="app-shell">
      <SidePanel
        channels={channels}
        selectedSlug={selectedSlug}
        onSelect={setSelectedSlug}
        onGoHome={() => setSelectedSlug(null)}
        onAdded={(ch) => {
          patchChannel(ch);
          push(`${ch.display_name} eklendi`, "ok");
        }}
        onRemoved={(slug) => {
          setChannels((prev) => {
            const next = prev.filter((c) => c.slug !== slug);
            writeStoredChannels(next, user?.email);
            return next;
          });
          if (selectedSlug === slug) setSelectedSlug(null);
          push("Kanal silindi", "info");
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main-content">
        {bootError ? (
          <p className="form-message">
            {bootError} — Worker servisinin ayakta olduğundan emin olun (
            <code>docker compose ps</code> / <code>docker compose logs worker</code>).
          </p>
        ) : null}
        {youtubeNotice ? (
          <p className={youtubeNotice.includes("başarısız") ? "form-message" : "muted"}>
            {youtubeNotice}
          </p>
        ) : null}
        {selected ? (
          <ChannelDetail channel={selected} onChannelUpdate={patchChannel} />
        ) : (
          <>
            <WelcomeGuide />
            <JobsLibrary />
          </>
        )}
      </main>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
