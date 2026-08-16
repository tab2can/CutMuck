"use client";

import { motion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { useAuth } from "@/components/AuthProvider";

export function AuthGate({ children }: { children: ReactNode }) {
  const { loading, user, loginError, loginWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="auth-screen">
        <p className="muted">Oturum kontrol ediliyor…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-screen">
        <motion.div
          className="auth-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 360, damping: 28 }}
        >
          <div className="brand auth-brand">
            <span className="brand-mark">CM</span>
            <span className="brand-name">CutMuck</span>
          </div>
          <h1>Giriş gerekli</h1>
          <p className="muted">
            Yalnızca yöneticinin eklediği Google hesapları giriş yapabilir.
          </p>
          {(loginError || localError) && (
            <p className="form-message">{loginError || localError}</p>
          )}
          <button
            type="button"
            className="btn primary block"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setLocalError(null);
              void loginWithGoogle().catch((e) => {
                setLocalError(e instanceof Error ? e.message : "Giriş başlatılamadı");
                setBusy(false);
              });
            }}
          >
            {busy ? "Yönlendiriliyor…" : "Google ile giriş yap"}
          </button>
        </motion.div>
      </div>
    );
  }

  return <>{children}</>;
}
