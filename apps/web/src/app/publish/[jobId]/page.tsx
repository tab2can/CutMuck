"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  formatBytes,
  formatDuration,
  jobStatusLabel,
  mediaSrc,
  type Job,
} from "@/lib/api";
import { ClipPreviewPlayer } from "@/components/ClipPreviewPlayer";
import { ThumbnailEditor, type ThumbProject } from "@/components/ThumbnailEditor";
import { useNativeContextBlock } from "@/components/ContextMenu";
import { useTheme } from "@/components/ThemeProvider";
import { useToast } from "@/components/Toast";
import { ensureNotifyPermission, notifyDesktop } from "@/lib/notify";
import { fileToYtThumb, videoFrameToYtThumb } from "@/lib/ytThumb";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForYoutube(jobId: string, onTick: (job: Job) => void): Promise<Job> {
  for (;;) {
    const job = await api<Job>(`/jobs/${jobId}`);
    onTick(job);
    if (job.status === "done") return job;
    if (job.status === "error") {
      throw new Error(job.error || "Yükleme başarısız");
    }
    await sleep(1200);
  }
}

function PublishInner() {
  useNativeContextBlock(true);
  const params = useParams<{ jobId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { settings } = useTheme();
  const { push } = useToast();
  const jobId = params.jobId;
  const videoRef = useRef<HTMLVideoElement>(null);

  const startSec = Number(search.get("start") || 0);
  const endSec = Number(search.get("end") || 0);

  const [job, setJob] = useState<Job | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [privacy, setPrivacy] = useState<"public" | "unlisted" | "private">("unlisted");
  const [busy, setBusy] = useState(false);
  const [backgrounded, setBackgrounded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ytUrl, setYtUrl] = useState<string | null>(null);
  const [thumbDataUrl, setThumbDataUrl] = useState<string | null>(null);
  const [thumbProject, setThumbProject] = useState<ThumbProject | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const thumbFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<Job>(`/jobs/${jobId}`).then((data) => {
      setJob(data);
      setTitle(data.title || "CutMuck export");
      const def = (settings?.youtube_privacy_default as typeof privacy) || "unlisted";
      setPrivacy(def);
      const t = (data.meta?.thumbnail as string) || null;
      if (t) setThumbDataUrl(t);
      if (["queued", "exporting", "cutting", "uploading"].includes(data.status)) {
        setBusy(true);
        setBackgrounded(true);
        setMessage(`${jobStatusLabel(data.status)} (%${Math.round(data.progress || 0)})`);
        void waitForYoutube(jobId, (j) => {
          setJob(j);
          setMessage(`${jobStatusLabel(j.status)} (%${Math.round(j.progress || 0)})`);
        })
          .then((result) => {
            setJob(result);
            const url = (result.meta?.youtube as { url?: string } | undefined)?.url || null;
            setYtUrl(url);
            setMessage(url ? "YouTube’a yüklendi" : "Yükleme tamam");
            void notifyDesktop("CutMuck", "YouTube yüklemesi tamamlandı");
            push("YouTube yüklemesi tamam", "ok");
          })
          .catch((e) => {
            const msg = e instanceof Error ? e.message : "Yükleme başarısız";
            setMessage(msg);
            push(msg, "error");
          })
          .finally(() => {
            setBusy(false);
            setBackgrounded(false);
          });
      }
    });
  }, [jobId, settings?.youtube_privacy_default, push]);

  useEffect(() => {
    if (!busy) return;
    const el = videoRef.current;
    if (el) {
      el.pause();
    }
  }, [busy]);

  const preview = useMemo(() => {
    if (job?.cut_url) return mediaSrc(job.cut_url);
    if (job?.stream_url) return mediaSrc(job.stream_url);
    return mediaSrc(job?.media_url);
  }, [job]);

  const clipLen = endSec > startSec ? endSec - startSec : 0;
  const hasCut = Boolean(job?.cut_url);

  function captureFrame() {
    const v = videoRef.current;
    if (!v || v.readyState < 2) {
      push("Önce videoyu oynatın / yükleyin", "error");
      return;
    }
    const url = videoFrameToYtThumb(v);
    setThumbDataUrl(url);
    setThumbProject((p) => (p ? { ...p, bg: url } : null));
    push("Kare yakalandı", "ok");
  }

  async function onThumbFile(file: File) {
    try {
      const dataUrl = await fileToYtThumb(file);
      setThumbDataUrl(dataUrl);
      setThumbProject((p) => (p ? { ...p, bg: dataUrl } : null));
      push("Kapak 1920×1080 · 16:9 olarak ayarlandı", "ok");
    } catch (e) {
      push(e instanceof Error ? e.message : "Kapak yüklenemedi", "error");
    }
  }

  async function upload() {
    if (!(endSec > startSec)) {
      setMessage("Geçerli bir kesit aralığı yok — editöre dönüp In/Out ayarlayın");
      return;
    }
    await ensureNotifyPermission();
    setBusy(true);
    setBackgrounded(false);
    setMessage(
      hasCut
        ? "Mevcut kesit kullanılıyor — YouTube’a yükleniyor…"
        : "Kesit hazırlanıyor… (sekme kapatılabilir, Son işler’den takip edin)"
    );
    setYtUrl(null);
    try {
      await api<Job>(`/jobs/${jobId}/youtube`, {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          privacy,
          start_sec: startSec,
          end_sec: endSec,
          thumbnail_data_url: thumbDataUrl?.startsWith("data:") ? thumbDataUrl : null,
        }),
      });
      setBackgrounded(true);
      push("Yükleme arka planda başladı — ana menüden takip edebilirsiniz", "info");
      const result = await waitForYoutube(jobId, (j) => {
        setJob(j);
        const pct = Math.round(j.progress || 0);
        const size = j.cut_size_bytes ? ` · ${formatBytes(j.cut_size_bytes)}` : "";
        setMessage(`${jobStatusLabel(j.status)} (%${pct})${size}`);
      });
      setJob(result);
      const url = (result.meta?.youtube as { url?: string } | undefined)?.url || null;
      setYtUrl(url);
      setMessage(url ? "YouTube’a yüklendi" : "Yükleme tamam");
      void notifyDesktop("CutMuck", url ? "YouTube yüklemesi tamamlandı" : "Yükleme tamam");
      push("YouTube yüklemesi tamam", "ok");
      if (result.meta?.thumb_error) {
        const thumbMsg = String(result.meta.thumb_error);
        push(
          thumbMsg,
          thumbMsg.includes("doğrulayın") || thumbMsg.includes("Studio") ? "info" : "error"
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Yükleme başarısız";
      setMessage(msg);
      push(msg, "error");
    } finally {
      setBusy(false);
      setBackgrounded(false);
    }
  }

  return (
    <div className="publish-shell">
      <div className="publish-main">
        <div className="titlebar-left" style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={() => router.push(`/editor/${jobId}`)}>
            ← Editör
          </button>
          <button type="button" className="btn ghost" onClick={() => router.push("/")}>
            Ana menü
          </button>
        </div>
        <div className="publish-preview">
          {preview && endSec > startSec ? (
            <ClipPreviewPlayer
              src={preview}
              isCutFile={Boolean(job?.cut_url)}
              startSec={startSec}
              endSec={endSec}
              videoRef={videoRef}
              disabled={busy}
              autoPlay={false}
            />
          ) : (
            <p className="muted" style={{ padding: 24 }}>
              {endSec > startSec ? "Önizleme yok" : "Geçerli kesit yok — editörde In/Out ayarlayın"}
            </p>
          )}
        </div>
        <section className="settings-section publish-meta">
          <h3>YouTube ince ayarlar</h3>
          <p className="muted">
            Kesit: {formatDuration(startSec)} → {formatDuration(endSec)} ({formatDuration(clipLen)})
            {hasCut ? ` · hazır dosya ${formatBytes(job?.cut_size_bytes)}` : ""}
          </p>
          {busy && job ? (
            <div className="upload-progress">
              <div className="upload-bar">
                <div style={{ width: `${Math.min(100, job.progress || 0)}%` }} />
              </div>
              <p className="muted">{message}</p>
              {backgrounded ? (
                <p className="muted" style={{ fontSize: "0.85rem" }}>
                  Sekmeyi kapatabilirsiniz — ilerleme Ana menü → Son işler’de görünür.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      <aside className="publish-side">
        <h2>YouTube yayını</h2>
        <div className="thumb-placeholder">
          {thumbDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbDataUrl} alt="" />
          ) : (
            <span>Kapak yok</span>
          )}
          <div className="thumb-hover">
            <button type="button" disabled={busy} onClick={() => thumbFileRef.current?.click()}>
              Dosya yükle
              <span>PNG / JPEG · 16:9 otomatik</span>
            </button>
            <button type="button" disabled={busy} onClick={() => setEditorOpen(true)}>
              Editör ile düzenle
              <span>Yazı, çerçeve, görseller</span>
            </button>
          </div>
          <input
            ref={thumbFileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void onThumbFile(file);
            }}
          />
        </div>
        <div className="effect-row">
          <button type="button" className="btn" disabled={busy} onClick={captureFrame}>
            Kareyi kapak yap
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy || !(job?.meta?.thumbnail as string)}
            onClick={() => {
              const t = (job?.meta?.thumbnail as string) || null;
              setThumbDataUrl(t);
              setThumbProject((p) => (p ? { ...p, bg: t } : null));
            }}
          >
            Kick thumb
          </button>
        </div>
        <label className="field">
          <span>Başlık</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
        </label>
        <label className="field">
          <span>Açıklama</span>
          <textarea
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Video açıklaması"
          />
        </label>
        <label className="field">
          <span>Gizlilik</span>
          <select
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as typeof privacy)}
          >
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </label>
        {message ? (
          <p className={ytUrl ? "muted" : "form-message"}>
            {message}{" "}
            {ytUrl ? (
              <a href={ytUrl} target="_blank" rel="noreferrer">
                YouTube’da aç
              </a>
            ) : null}
          </p>
        ) : null}
        <button
          type="button"
          className="btn primary block"
          disabled={busy || !title.trim() || !(endSec > startSec)}
          onClick={() => void upload()}
        >
          {busy ? "Yükleniyor…" : hasCut ? "YouTube’a yükle (retry)" : "Kesit indir + yükle"}
        </button>
        {busy ? (
          <button type="button" className="btn ghost block" onClick={() => router.push("/")}>
            Ana menüye dön (arka planda sürer)
          </button>
        ) : null}
      </aside>
      {editorOpen ? (
        <ThumbnailEditor
          channelSlug={job?.channel_slug || "_genel"}
          baseSrc={thumbDataUrl}
          initial={thumbProject}
          onClose={(draft) => {
            setThumbProject(draft);
            setEditorOpen(false);
          }}
          onApply={(dataUrl, draft) => {
            setThumbDataUrl(dataUrl);
            setThumbProject(draft);
            setEditorOpen(false);
            push("Kapak güncellendi", "ok");
          }}
        />
      ) : null}
    </div>
  );
}

export default function PublishPage() {
  return (
    <Suspense fallback={<p className="muted pad">Yükleniyor…</p>}>
      <PublishInner />
    </Suspense>
  );
}
