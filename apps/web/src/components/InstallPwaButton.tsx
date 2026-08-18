"use client";

import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallPwaButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => undefined);
    }

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    if (standalone) setInstalled(true);

    const ua = navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|Edg|Firefox|FxiOS/.test(ua);
    if (isIos && isSafari && !standalone) setIosHint(true);

    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  if (deferred) {
    return (
      <button
        type="button"
        className="btn ghost install-pwa-btn"
        onClick={() => {
          void (async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
          })();
        }}
      >
        Uygulamayı yükle
      </button>
    );
  }

  if (iosHint) {
    return (
      <button
        type="button"
        className="btn ghost install-pwa-btn"
        title="Safari → Paylaş → Ana Ekrana Ekle"
        onClick={() =>
          alert("Safari’de Paylaş (□↑) → “Ana Ekrana Ekle” ile CutMuck’u uygulama olarak ekleyin.")
        }
      >
        Uygulamayı yükle
      </button>
    );
  }

  // Firefox / others: still show — user can install via browser menu; click explains
  return (
    <button
      type="button"
      className="btn ghost install-pwa-btn"
      title="Tarayıcı menüsünden “Uygulamayı yükle / Ana ekrana ekle”"
      onClick={() =>
        alert(
          "Tarayıcı menüsünden “Uygulamayı yükle” veya “Ana ekrana ekle” seçeneğini kullanın.\n" +
            "Chrome/Edge: adres çubuğu veya ⋮ menü · Firefox: ⋮ → Uygulamayı yükle."
        )
      }
    >
      Uygulamayı yükle
    </button>
  );
}
