"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatDuration } from "@/lib/api";

type ChatMsg = {
  id: string;
  user: string;
  color: string;
  text: string;
  ts: number;
  offset_sec?: number;
};

type ChatPayload = {
  live: boolean;
  behind: boolean;
  t: number;
  wall_ts: number;
  messages: ChatMsg[];
};

function ChatBody({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(\[emote:\d+:[^\]]*\])/g), [text]);
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^\[emote:(\d+):([^\]]*)\]$/);
        if (!m) return <span key={i}>{part}</span>;
        const name = m[2] || "emote";
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            className="kick-chat-emote"
            src={`https://files.kick.com/emotes/${m[1]}/fullsize`}
            alt={name}
            title={name}
          />
        );
      })}
    </>
  );
}

type Props = {
  jobId: string;
  current: number;
  live: boolean;
  atLiveEdge: boolean;
};

export function KickChatPanel({ jobId, current, live, atLiveEdge }: Props) {
  const [data, setData] = useState<ChatPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const currentRef = useRef(current);
  currentRef.current = current;
  const tBucket = live && atLiveEdge ? -1 : Math.round(current * 2) / 2;

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function load() {
      try {
        const t = currentRef.current;
        const next = await api<ChatPayload>(`/jobs/${jobId}/chat?t=${t.toFixed(2)}`);
        if (cancelled) return;
        stickRef.current = true;
        setData(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Sohbet yüklenemedi");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    if (live && atLiveEdge) {
      timer = window.setInterval(() => void load(), 1800);
    }
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [jobId, live, atLiveEdge, tBucket]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [data?.messages, data?.t]);

  const msgs = data?.messages || [];

  return (
    <div className="kick-chat">
      <div className="kick-chat-head">
        <strong>{live ? (atLiveEdge ? "Canlı sohbet" : "Yayın geçmişi") : "Kayıt sohbeti"}</strong>
        <span className="muted">{formatDuration(current)}</span>
      </div>
      {error ? <p className="form-message">{error}</p> : null}
      {loading && !data ? <p className="muted fx-side-hint">Sohbet yükleniyor…</p> : null}
      <div
        className="kick-chat-list"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
        }}
      >
        {msgs.length === 0 && !loading && !error ? (
          <p className="muted fx-side-hint">Bu saniyede sohbet yok.</p>
        ) : (
          msgs.map((m) => (
            <div key={m.id} className="kick-chat-row">
              <span className="kick-chat-time">
                {formatDuration(m.offset_sec ?? 0)}
              </span>
              <span className="kick-chat-user" style={{ color: m.color }}>
                {m.user}
              </span>
              <span className="kick-chat-text">
                <ChatBody text={m.text} />
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
