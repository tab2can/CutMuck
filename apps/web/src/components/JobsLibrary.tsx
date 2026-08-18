"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  api,
  formatBytes,
  formatDuration,
  jobStatusLabel,
  type Job,
} from "@/lib/api";
import { ContextSurface } from "@/components/ContextMenu";
import { useToast } from "@/components/Toast";
import { notifyDesktop } from "@/lib/notify";

const ACTIVE = new Set(["queued", "exporting", "cutting", "uploading"]);

function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function JobsLibrary() {
  const router = useRouter();
  const { push } = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const prevStatus = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const list = await api<Job[]>("/jobs?limit=24");
      for (const job of list) {
        const prev = prevStatus.current[job.id];
        if (prev && ACTIVE.has(prev) && job.status === "done") {
          void notifyDesktop("CutMuck", `${job.title || "Video"} YouTube’a yüklendi`);
          push("YouTube yüklemesi tamam", "ok");
        }
        if (prev && ACTIVE.has(prev) && job.status === "error") {
          push(job.error || "Yükleme başarısız", "error");
        }
        prevStatus.current[job.id] = job.status;
      }
      setJobs(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Job’lar yüklenemedi");
    }
  }, [push]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(t);
  }, [load]);

  async function remove(id: string) {
    try {
      await api(`/jobs/${id}`, { method: "DELETE" });
      setJobs((prev) => prev.filter((j) => j.id !== id));
      delete prevStatus.current[id];
      push("İş silindi", "ok");
    } catch (e) {
      push(e instanceof Error ? e.message : "Silinemedi", "error");
    }
  }

  async function removeAll() {
    if (jobs.length === 0 || deletingAll) return;
    const activeCount = jobs.filter((j) => ACTIVE.has(j.status)).length;
    const extra =
      activeCount > 0
        ? `\n\n${activeCount} iş hâlâ devam ediyor; silinirse yükleme kesilir.`
        : "";
    if (!window.confirm(`${jobs.length} işin tamamı silinsin mi?${extra}`)) return;

    setDeletingAll(true);
    const ids = jobs.map((j) => j.id);
    let ok = 0;
    let fail = 0;
    const failedIds = new Set<string>();
    for (const id of ids) {
      try {
        await api(`/jobs/${id}`, { method: "DELETE" });
        ok += 1;
        delete prevStatus.current[id];
      } catch {
        fail += 1;
        failedIds.add(id);
      }
    }
    setJobs((prev) => prev.filter((j) => failedIds.has(j.id)));
    if (fail === 0) {
      push(`${ok} iş silindi`, "ok");
    } else {
      push(`${ok} silindi, ${fail} silinemedi`, fail > ok ? "error" : "ok");
    }
    setDeletingAll(false);
  }

  function onDeleteClick(e: MouseEvent<HTMLButtonElement>, id: string) {
    e.preventDefault();
    e.stopPropagation();
    void remove(id);
  }

  function openJob(job: Job) {
    const start = Number(job.meta?.start_sec ?? 0);
    const end = Number(job.meta?.end_sec ?? 0);
    if (ACTIVE.has(job.status) || job.status === "done" || job.status === "cut" || job.cut_url) {
      const q = end > start ? `?start=${start}&end=${end}` : "";
      router.push(`/publish/${job.id}${q}`);
      return;
    }
    router.push(`/editor/${job.id}`);
  }

  const head = (
    <div className="jobs-library-head">
      <h2>Son işler</h2>
      <div className="jobs-library-actions">
        {jobs.length > 0 ? (
          <button
            type="button"
            className="btn ghost danger"
            disabled={deletingAll}
            onClick={() => void removeAll()}
          >
            Hepsini sil
          </button>
        ) : null}
        <button type="button" className="btn ghost" onClick={() => void load()}>
          Yenile
        </button>
      </div>
    </div>
  );

  if (error) {
    return (
      <section className="jobs-library">
        {head}
        <p className="form-message">{error}</p>
      </section>
    );
  }
  if (jobs.length === 0) {
    return (
      <section className="jobs-library">
        {head}
        <p className="muted">Henüz iş yok. Bir VOD veya klip açarak başlayın.</p>
      </section>
    );
  }

  return (
    <section className="jobs-library">
      {head}
      <div className="jobs-list">
        {jobs.map((job, i) => {
          const thumb = (job.meta?.thumbnail as string) || null;
          const dur = Number(job.meta?.duration || 0);
          const active = ACTIVE.has(job.status);
          return (
            <ContextSurface
              key={job.id}
              items={[
                {
                  id: "open",
                  label: "Aç",
                  onSelect: () => openJob(job),
                },
                {
                  id: "editor",
                  label: "Editörde aç",
                  onSelect: () => router.push(`/editor/${job.id}`),
                },
                {
                  id: "publish",
                  label: "Publish’e git",
                  onSelect: () => {
                    const start = Number(job.meta?.start_sec ?? 0);
                    const end = Number(job.meta?.end_sec ?? 60);
                    router.push(
                      `/publish/${job.id}?start=${start}&end=${Math.max(start + 1, end)}`
                    );
                  },
                },
                {
                  id: "copy",
                  label: "Job ID kopyala",
                  onSelect: () => {
                    void navigator.clipboard.writeText(job.id);
                    push("Job ID kopyalandı", "ok");
                  },
                },
                {
                  id: "del",
                  label: "Sil",
                  danger: true,
                  onSelect: () => void remove(job.id),
                },
              ]}
            >
              <motion.div
                className={`job-row ${active ? "job-row-active" : ""}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.25) }}
              >
                <button type="button" className="job-row-body" onClick={() => openJob(job)}>
                  <div className="job-thumb">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt="" />
                    ) : (
                      <div className="thumb-fallback" />
                    )}
                  </div>
                  <div className="job-meta">
                    <strong>{job.title || "İsimsiz iş"}</strong>
                    <span className="muted">
                      {job.channel_slug ? `@${job.channel_slug} · ` : ""}
                      {jobStatusLabel(job.status)}
                      {dur > 0 ? ` · ${formatDuration(dur)}` : ""}
                      {job.cut_size_bytes ? ` · ${formatBytes(job.cut_size_bytes)}` : ""}
                    </span>
                    {active ? (
                      <div className="job-mini-progress">
                        <div style={{ width: `${Math.min(100, job.progress || 0)}%` }} />
                      </div>
                    ) : null}
                    {job.error ? <span className="job-error">{job.error}</span> : null}
                  </div>
                  <span className={`job-pill status-${job.status}`}>
                    {Math.round(job.progress || 0)}%
                  </span>
                </button>
                <button
                  type="button"
                  className="job-delete-btn"
                  title="Sil"
                  aria-label="İşi sil"
                  onClick={(e) => onDeleteClick(e, job.id)}
                >
                  <IconTrash />
                </button>
              </motion.div>
            </ContextSurface>
          );
        })}
      </div>
    </section>
  );
}
