"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { api, type Channel } from "@/lib/api";
import { ContextSurface } from "@/components/ContextMenu";

type Props = {
  channels: Channel[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onGoHome: () => void;
  onAdded: (channel: Channel) => void;
  onRemoved: (slug: string) => void;
  onOpenSettings: () => void;
};

function isLiveFlag(v: Channel["is_live"]): boolean {
  return v === true || v === 1 || v === "1";
}

export function SidePanel({
  channels,
  selectedSlug,
  onSelect,
  onGoHome,
  onAdded,
  onRemoved,
  onOpenSettings,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addChannel() {
    setBusy(true);
    setError(null);
    try {
      const channel = await api<Channel>("/channels", {
        method: "POST",
        body: JSON.stringify({ input }),
      });
      onAdded(channel);
      setInput("");
      setAddOpen(false);
      onSelect(channel.slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Eklenemedi");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="side-panel">
      <div className="side-top">
        <div className="brand-row">
          <button type="button" className="brand" onClick={onGoHome} title="Ana sayfa">
            <span className="brand-mark">CM</span>
            <span className="brand-name">CutMuck</span>
          </button>
          <button
            type="button"
            className="icon-btn settings-btn"
            onClick={onOpenSettings}
            aria-label="Ayarlar"
            title="Ayarlar"
          >
            ⚙
          </button>
        </div>
      </div>

      <div className="channel-scroll">
        {channels.length === 0 ? (
          <p className="empty-hint">Henüz kanal yok. Alttan ekleyin.</p>
        ) : (
          channels.map((ch, i) => (
            <ContextSurface
              key={ch.slug}
              items={[
                {
                  id: "open",
                  label: "Kanalı aç",
                  onSelect: () => onSelect(ch.slug),
                },
                {
                  id: "remove",
                  label: "Kanalı kaldır",
                  danger: true,
                  onSelect: async () => {
                    await api(`/channels/${ch.slug}`, { method: "DELETE" });
                    onRemoved(ch.slug);
                  },
                },
              ]}
            >
              <motion.button
                type="button"
                className={`channel-card ${selectedSlug === ch.slug ? "active" : ""}`}
                onClick={() => onSelect(ch.slug)}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <div className="channel-avatar">
                  {ch.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={ch.avatar_url} alt="" />
                  ) : (
                    <span>{ch.display_name.slice(0, 1).toUpperCase()}</span>
                  )}
                </div>
                <div className="channel-meta">
                  <span className="channel-name">{ch.display_name}</span>
                  <span className="channel-slug">@{ch.slug}</span>
                </div>
                {isLiveFlag(ch.is_live) ? <span className="live-badge">CANLI</span> : null}
              </motion.button>
            </ContextSurface>
          ))
        )}
      </div>

      <div className="side-bottom">
        {addOpen ? (
          <div className="add-form">
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Kick adı veya URL"
              onKeyDown={(e) => {
                if (e.key === "Enter") void addChannel();
              }}
            />
            {error ? <p className="form-message">{error}</p> : null}
            <div className="row-actions">
              <button type="button" className="btn ghost" onClick={() => setAddOpen(false)}>
                İptal
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !input.trim()}
                onClick={() => void addChannel()}
              >
                Ekle
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn primary block" onClick={() => setAddOpen(true)}>
            + Kanal Ekle
          </button>
        )}
      </div>
    </aside>
  );
}
