"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  formatBytes,
  formatDuration,
  jobStatusLabel,
  type Job,
} from "@/lib/api";
import { ContextSurface } from "@/components/ContextMenu";
import { useToast } from "@/components/Toast";

export function JobsLibrary() {
  const router = useRouter();
  const { push } = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api<Job[]>("/jobs?limit=24");
      setJobs(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Job’lar yüklenemedi");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(t);
  }, [load]);

  async function remove(id: string) {
    try {
      await api(`/jobs/${id}`, { method: "DELETE" });
      setJobs((prev) => prev.filter((j) => j.id !== id));
      push("İş silindi", "ok");
    } catch (e) {
      push(e instanceof Error ? e.message : "Silinemedi", "error");
    }
  }

  function openJob(job: Job) {
    const start = Number(job.meta?.start_sec ?? 0);
    const end = Number(job.meta?.end_sec ?? 0);
    if (job.status === "done" || job.status === "cut" || job.cut_url) {
      const q =
        end > start
          ? `?start=${start}&end=${end}`
          : "";
      router.push(`/publish/${job.id}${q}`);
      return;
    }
    router.push(`/editor/${job.id}`);
  }

  if (error) {
    return <p className="form-message">{error}</p>;
  }
  if (jobs.length === 0) {
    return (
      <section className="jobs-library">
        <h2>Son işler</h2>
        <p className="muted">Henüz iş yok. Bir VOD veya klip açarak başlayın.</p>
      </section>
    );
  }

  return (
    <section className="jobs-library">
      <div className="jobs-library-head">
        <h2>Son işler</h2>
        <button type="button" className="btn ghost" onClick={() => void load()}>
          Yenile
        </button>
      </div>
      <div className="jobs-list">
        {jobs.map((job, i) => {
          const thumb = (job.meta?.thumbnail as string) || null;
          const dur = Number(job.meta?.duration || 0);
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
              <motion.button
                type="button"
                className="job-row"
                onClick={() => openJob(job)}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.25) }}
              >
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
                  {job.error ? <span className="job-error">{job.error}</span> : null}
                </div>
                <span className={`job-pill status-${job.status}`}>
                  {Math.round(job.progress || 0)}%
                </span>
              </motion.button>
            </ContextSurface>
          );
        })}
      </div>
    </section>
  );
}
