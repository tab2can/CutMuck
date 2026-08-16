"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, formatDuration, type Channel, type Clip, type Job, type Vod } from "@/lib/api";
import { ContextSurface } from "@/components/ContextMenu";
import { useToast } from "@/components/Toast";

type Props = {
  channel: Channel;
  onChannelUpdate?: (channel: Channel) => void;
};

function isLiveFlag(v: Channel["is_live"]): boolean {
  return v === true || v === 1 || v === "1";
}

export function ChannelDetail({ channel, onChannelUpdate }: Props) {
  const router = useRouter();
  const { push } = useToast();
  const [tab, setTab] = useState<"vods" | "clips">("vods");
  const [vods, setVods] = useState<Vod[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [live, setLive] = useState(() => isLiveFlag(channel.is_live));

  useEffect(() => {
    setLive(isLiveFlag(channel.is_live));
  }, [channel.slug, channel.is_live]);

  useEffect(() => {
    let cancelled = false;
    async function refreshLive() {
      try {
        const fresh = await api<Channel>(`/channels/${channel.slug}`);
        if (cancelled) return;
        setLive(isLiveFlag(fresh.is_live));
        onChannelUpdate?.(fresh);
      } catch {
        // keep last known
      }
    }
    void refreshLive();
    const id = window.setInterval(() => void refreshLive(), 45_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [channel.slug, onChannelUpdate]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [v, c] = await Promise.all([
          api<Vod[]>(`/channels/${channel.slug}/vods`),
          api<Clip[]>(`/channels/${channel.slug}/clips`),
        ]);
        if (!cancelled) {
          setVods(v);
          setClips(c);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Yüklenemedi");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [channel.slug]);

  async function openEditor(vod: Vod) {
    if (vod.is_live) {
      await openLive();
      return;
    }
    if (!vod.url) {
      setError("Bu yayın için URL yok");
      return;
    }
    setOpening(vod.id);
    setError(null);
    try {
      const job = await api<Job>("/jobs/open", {
        method: "POST",
        body: JSON.stringify({
          kind: "vod",
          vod_url: vod.url,
          channel_slug: channel.slug,
          title: vod.title,
          thumbnail: vod.thumbnail,
          duration: vod.duration,
        }),
      });
      router.push(`/editor/${job.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Editör açılamadı");
      setOpening(null);
    }
  }

  async function openClip(clip: Clip) {
    setOpening(clip.id);
    setError(null);
    try {
      const job = await api<Job>("/jobs/open", {
        method: "POST",
        body: JSON.stringify({
          kind: "clip",
          clip_id: clip.id,
          vod_url: clip.url || "",
          channel_slug: channel.slug,
          title: clip.title,
          thumbnail: clip.thumbnail,
          duration: clip.duration,
        }),
      });
      router.push(`/editor/${job.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Klip açılamadı";
      setError(msg);
      push(msg, "error");
      setOpening(null);
    }
  }

  async function openLive() {
    setOpening("live");
    setError(null);
    try {
      const job = await api<Job>("/jobs/open-live", {
        method: "POST",
        body: JSON.stringify({
          channel_slug: channel.slug,
          title: `${channel.display_name} canlı`,
        }),
      });
      push("Canlı DVR açıldı — geçmişe sar / canlıya dön", "ok");
      router.push(`/editor/${job.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Canlı açılamadı";
      setError(msg);
      push(msg, "error");
      setOpening(null);
    }
  }

  return (
    <div className="channel-detail">
      <div className="channel-banner-wrap">
        <div
          className="channel-banner"
          style={{
            backgroundImage: channel.banner_url ? `url(${channel.banner_url})` : undefined,
          }}
        />
        <div className="channel-profile">
          <div className="profile-avatar">
            {channel.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={channel.avatar_url} alt="" />
            ) : (
              <span>{channel.display_name.slice(0, 1)}</span>
            )}
          </div>
          <div>
            <h1>{channel.display_name}</h1>
            <p className="muted">@{channel.slug}</p>
          </div>
          {live ? (
            <>
              <span className="live-badge lg">CANLI</span>
              <button
                type="button"
                className="btn primary"
                disabled={opening === "live"}
                onClick={() => void openLive()}
              >
                {opening === "live" ? "Açılıyor…" : "Canlı izle + kes"}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={tab === "vods" ? "active" : ""}
          onClick={() => setTab("vods")}
        >
          Yayınlar
        </button>
        <button
          type="button"
          className={tab === "clips" ? "active" : ""}
          onClick={() => setTab("clips")}
        >
          Klipler
        </button>
      </div>

      {error ? <p className="form-message">{error}</p> : null}
      {loading ? <p className="muted pad">Yükleniyor…</p> : null}

      {!loading && tab === "vods" ? (
        <div className="card-grid">
          {vods.length === 0 ? <p className="muted pad">VOD bulunamadı.</p> : null}
          {vods.map((vod, i) => (
            <ContextSurface
              key={vod.id}
              items={[
                {
                  id: "edit",
                  label: "Düzenle (Kick önizleme)",
                  onSelect: () => void openEditor(vod),
                },
                {
                  id: "open",
                  label: "Kick’te aç",
                  disabled: !vod.url,
                  onSelect: () => vod.url && window.open(vod.url, "_blank"),
                },
                {
                  id: "copy",
                  label: "Bağlantıyı kopyala",
                  disabled: !vod.url,
                  onSelect: () => {
                    if (vod.url) {
                      void navigator.clipboard.writeText(vod.url);
                      push("Bağlantı kopyalandı", "ok");
                    }
                  },
                },
              ]}
            >
              <motion.button
                type="button"
                className="media-card"
                onClick={() => void openEditor(vod)}
                disabled={opening === vod.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.3) }}
              >
                <div className="media-thumb">
                  {vod.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={vod.thumbnail} alt="" />
                  ) : (
                    <div className="thumb-fallback" />
                  )}
                  {vod.is_live ? <span className="live-badge abs">CANLI</span> : null}
                  <span className="duration-pill">{formatDuration(vod.duration)}</span>
                </div>
                <div className="media-info">
                  <h3>{vod.title}</h3>
                  <p className="muted">
                    {vod.views?.toLocaleString?.("tr-TR") ?? vod.views} izlenme
                    {opening === vod.id ? " · açılıyor…" : ""}
                  </p>
                </div>
              </motion.button>
            </ContextSurface>
          ))}
        </div>
      ) : null}

      {!loading && tab === "clips" ? (
        <div className="card-grid">
          {clips.length === 0 ? (
            <p className="muted pad">Klip bulunamadı.</p>
          ) : null}
          {clips.map((clip, i) => (
            <ContextSurface
              key={clip.id}
              items={[
                {
                  id: "edit",
                  label: "Editörde aç",
                  onSelect: () => void openClip(clip),
                },
                {
                  id: "open",
                  label: "Kick’te aç",
                  disabled: !clip.url,
                  onSelect: () => clip.url && window.open(clip.url, "_blank"),
                },
              ]}
            >
              <motion.button
                type="button"
                className="media-card"
                onClick={() => void openClip(clip)}
                disabled={opening === clip.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.3) }}
              >
                <div className="media-thumb">
                  {clip.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={clip.thumbnail} alt="" />
                  ) : (
                    <div className="thumb-fallback" />
                  )}
                  <span className="duration-pill">{formatDuration(clip.duration)}</span>
                </div>
                <div className="media-info">
                  <h3>{clip.title}</h3>
                  <p className="muted">
                    {clip.views} izlenme
                    {opening === clip.id ? " · açılıyor…" : ""}
                  </p>
                </div>
              </motion.button>
            </ContextSurface>
          ))}
        </div>
      ) : null}
    </div>
  );
}
