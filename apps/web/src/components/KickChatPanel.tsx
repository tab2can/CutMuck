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
  cover_from?: number;
  cover_to?: number;
  degraded?: boolean;
  messages: ChatMsg[];
};

const DISPLAY_BEHIND = 90;
const PREFETCH_MARGIN = 12;
const MIN_FETCH_GAP_MS = 3500;
const LIVE_POLL_MS = 7000;
const SEEK_DEBOUNCE_MS = 500;
const BACKOFF_MS = 25000;

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
  const [allMsgs, setAllMsgs] = useState<ChatMsg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const currentRef = useRef(current);
  currentRef.current = current;
  const coverRef = useRef<{ from: number; to: number }[]>([]);
  const msgsRef = useRef<Map<string, ChatMsg>>(new Map());
  const fetchingRef = useRef(false);
  const lastFetchAt = useRef(0);
  const backoffUntil = useRef(0);
  const lastCurrentRef = useRef(current);
  const loadRef = useRef<(reason: string) => Promise<void>>(async () => undefined);

  const needFetch = (t: number) => {
    const ranges = coverRef.current;
    if (ranges.length === 0) return true;
    return !ranges.some((r) => t >= r.from - 0.8 && t <= r.to - PREFETCH_MARGIN);
  };

  const addRange = (from: number, to: number) => {
    const next = [...coverRef.current, { from, to }].sort((a, b) => a.from - b.from);
    const merged: { from: number; to: number }[] = [];
    for (const r of next) {
      const last = merged[merged.length - 1];
      if (last && r.from <= last.to + 8) last.to = Math.max(last.to, r.to);
      else merged.push({ ...r });
    }
    coverRef.current = merged;
  };

  loadRef.current = async (reason: string) => {
    if (fetchingRef.current) return;
    const now = Date.now();
    if (now < backoffUntil.current) return;
    if (reason !== "boot" && reason !== "seek" && now - lastFetchAt.current < MIN_FETCH_GAP_MS) {
      return;
    }
    if (reason !== "boot" && reason !== "live" && reason !== "seek" && !needFetch(currentRef.current)) {
      return;
    }
    if (reason === "live" && now - lastFetchAt.current < LIVE_POLL_MS - 400) return;

    fetchingRef.current = true;
    lastFetchAt.current = now;
    const t = currentRef.current;
    try {
      const next = await api<ChatPayload>(`/jobs/${jobId}/chat?t=${t.toFixed(2)}`);
      const map = msgsRef.current;
      for (const msg of next.messages || []) map.set(msg.id, msg);
      if (map.size > 800) {
        const ordered = [...map.values()].sort(
          (a, b) => (a.offset_sec ?? 0) - (b.offset_sec ?? 0)
        );
        map.clear();
        for (const msg of ordered.slice(-500)) map.set(msg.id, msg);
      }
      if ((next.messages || []).length === 0) {
        addRange(t, t + 12);
      } else {
        addRange(next.cover_from ?? t, next.cover_to ?? t);
      }
      stickRef.current = true;
      setAllMsgs([...map.values()].sort((a, b) => (a.offset_sec ?? 0) - (b.offset_sec ?? 0)));
      setDegraded(Boolean(next.degraded));
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Sohbet yüklenemedi";
      const limited = /403|429|limit/i.test(message);
      backoffUntil.current = Date.now() + (limited ? BACKOFF_MS : 8000);
      if (msgsRef.current.size === 0) setError(message);
      else setDegraded(true);
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    msgsRef.current.clear();
    coverRef.current = [];
    setAllMsgs([]);
    setLoading(true);
    const boot = window.setTimeout(() => void loadRef.current("boot"), 200);
    const pollMs = live && atLiveEdge ? LIVE_POLL_MS : 1000;
    const timer = window.setInterval(() => {
      const t = currentRef.current;
      if (live && atLiveEdge) void loadRef.current("live");
      else if (needFetch(t)) void loadRef.current("play");
    }, pollMs);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(timer);
    };
  }, [jobId, live, atLiveEdge]);

  useEffect(() => {
    const jumped = Math.abs(current - lastCurrentRef.current) > 2.4;
    lastCurrentRef.current = current;
    if (!jumped) return;
    const handle = window.setTimeout(() => {
      if (needFetch(currentRef.current)) void loadRef.current("seek");
    }, SEEK_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [current]);

  const visible = useMemo(() => {
    const lo = current - DISPLAY_BEHIND;
    return allMsgs.filter((m) => {
      const offset = m.offset_sec ?? 0;
      return offset <= current + 0.2 && offset >= lo;
    });
  }, [allMsgs, current]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visible]);

  return (
    <div className="kick-chat">
      <div className="kick-chat-head">
        <strong>
          {live ? (atLiveEdge ? "Canlı sohbet" : "Yayın geçmişi") : "Kayıt sohbeti"}
        </strong>
        <span className="muted">{formatDuration(current)}</span>
      </div>
      {error ? <p className="form-message">{error}</p> : null}
      {degraded && !error ? (
        <p className="muted fx-side-hint">Kick limiti — önbellekteki sohbet gösteriliyor.</p>
      ) : null}
      {loading && visible.length === 0 && !error ? (
        <p className="muted fx-side-hint">Sohbet yükleniyor…</p>
      ) : null}
      <div
        className="kick-chat-list"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
        }}
      >
        {visible.length === 0 && !loading && !error ? (
          <p className="muted fx-side-hint">Bu saniyede sohbet yok.</p>
        ) : (
          visible.map((m) => (
            <div key={m.id} className="kick-chat-row">
              <span className="kick-chat-time">{formatDuration(m.offset_sec ?? 0)}</span>
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
