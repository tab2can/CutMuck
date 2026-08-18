"use client";

import { useEffect } from "react";

function isChunkError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err || "");
  return /ChunkLoadError|Loading chunk [\d]+ failed|Failed to load chunk/i.test(msg);
}

async function hardRecover() {
  try {
    if (sessionStorage.getItem("cutmuck-chunk-reload") === "1") return;
    sessionStorage.setItem("cutmuck-chunk-reload", "1");
  } catch {
    // private mode
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // ignore
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    // ignore
  }
  window.location.reload();
}

export function ClientBoot() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    void navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update())
      .catch(() => undefined);

    const onReject = (e: PromiseRejectionEvent) => {
      if (isChunkError(e.reason)) {
        e.preventDefault();
        void hardRecover();
      }
    };
    const onError = (e: ErrorEvent) => {
      if (isChunkError(e.error) || isChunkError(e.message)) {
        void hardRecover();
      }
    };
    window.addEventListener("unhandledrejection", onReject);
    window.addEventListener("error", onError);
    const clearFlag = window.setTimeout(() => {
      try {
        sessionStorage.removeItem("cutmuck-chunk-reload");
      } catch {
        // ignore
      }
    }, 12000);
    return () => {
      window.clearTimeout(clearFlag);
      window.removeEventListener("unhandledrejection", onReject);
      window.removeEventListener("error", onError);
    };
  }, []);

  return null;
}
