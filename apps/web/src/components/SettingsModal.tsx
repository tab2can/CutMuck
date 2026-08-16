"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { api, type AppSettings, type ThemeId } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { useTheme } from "@/components/ThemeProvider";

type Props = {
  open: boolean;
  onClose: () => void;
};

const THEMES: { id: ThemeId; label: string }[] = [
  { id: "black", label: "Siyah" },
  { id: "dark", label: "Koyu" },
  { id: "light", label: "Açık" },
];

function redirectUri() {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/auth/youtube/callback`;
  }
  return "http://localhost:3000/api/auth/youtube/callback";
}

function loginRedirectUri() {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/auth/login/callback`;
  }
  return "http://localhost:3000/api/auth/login/callback";
}

export function SettingsModal({ open, onClose }: Props) {
  const { theme, setTheme, settings, refreshSettings, updateSettings } = useTheme();
  const { user } = useAuth();
  if (!open) return null;

  return (
    <SettingsBody
      theme={theme}
      setTheme={setTheme}
      settings={settings}
      onClose={onClose}
      refreshSettings={refreshSettings}
      updateSettings={updateSettings}
      isAdmin={Boolean(user?.is_admin)}
      initialClientId={(settings?.youtube_client_id as string) || ""}
      initialPrivacy={
        (settings?.youtube_privacy_default as "public" | "unlisted" | "private") || "unlisted"
      }
      secretSaved={Boolean(settings?.youtube_client_secret_set)}
      connected={Boolean(settings?.youtube_refresh_token_set)}
    />
  );
}

function SettingsBody({
  theme,
  setTheme,
  settings,
  onClose,
  refreshSettings,
  updateSettings,
  isAdmin,
  initialClientId,
  initialPrivacy,
  secretSaved,
  connected,
}: {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  settings: AppSettings | null;
  onClose: () => void;
  refreshSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  isAdmin: boolean;
  initialClientId: string;
  initialPrivacy: "public" | "unlisted" | "private";
  secretSaved: boolean;
  connected: boolean;
}) {
  const [clientId, setClientId] = useState(initialClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [privacy, setPrivacy] = useState(initialPrivacy);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [manualAuthUrl, setManualAuthUrl] = useState<string | null>(null);

  const hasSecret = Boolean(clientSecret.trim() || secretSaved);
  const canConnect = Boolean(clientId.trim() && hasSecret);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const patch: Partial<AppSettings> = {
        theme,
        youtube_client_id: clientId.trim(),
        youtube_privacy_default: privacy,
      };
      if (clientSecret.trim()) patch.youtube_client_secret = clientSecret.trim();
      await updateSettings(patch);
      setMessage("Ayarlar kaydedildi");
      setClientSecret("");
      await refreshSettings();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Kayıt başarısız");
    } finally {
      setSaving(false);
    }
  }

  async function connectYoutube() {
    if (!clientId.trim()) {
      setMessage("Önce Client ID girin");
      return;
    }
    if (!hasSecret) {
      setMessage("Client Secret girin (ilk bağlantıda zorunlu)");
      return;
    }

    setConnecting(true);
    setMessage(null);
    setManualAuthUrl(null);

    try {
      // 1) Persist credentials (no refreshSettings — avoids modal remount races)
      const patch: Partial<AppSettings> = {
        youtube_client_id: clientId.trim(),
        youtube_privacy_default: privacy,
      };
      if (clientSecret.trim()) patch.youtube_client_secret = clientSecret.trim();
      await updateSettings(patch);

      // 2) Ask worker for Google auth URL
      const { auth_url } = await api<{ auth_url: string }>("/auth/youtube/start");
      if (!auth_url || !auth_url.includes("accounts.google.com")) {
        throw new Error(`Geçersiz Google URL: ${auth_url || "(boş)"}`);
      }

      setManualAuthUrl(auth_url);
      setMessage("Google açılmazsa aşağıdaki linke tıklayın.");

      // 3) Navigate — hard redirect
      window.location.href = auth_url;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "OAuth başlatılamadı");
      setConnecting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 28 }}
      >
        <div className="modal-header">
          <h2>Ayarlar</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Kapat">
            ✕
          </button>
        </div>

        <section className="settings-section">
          <h3>Tema</h3>
          <div className="theme-row">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`theme-chip ${theme === t.id ? "active" : ""}`}
                onClick={() => setTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>YouTube API (bu hesap)</h3>
          <p className="muted">
            Client ID / Secret ve bağlantı yalnızca sizin Google hesabınıza aittir;
            diğer kullanıcılarla paylaşılmaz. Google Cloud → Authorized redirect URIs:
          </p>
          <div className="uri-box">
            <code>{loginRedirectUri()}</code>
            <button
              type="button"
              className="btn ghost"
              onClick={() => void navigator.clipboard.writeText(loginRedirectUri())}
            >
              Kopyala
            </button>
          </div>
          <div className="uri-box">
            <code>{redirectUri()}</code>
            <button
              type="button"
              className="btn ghost"
              onClick={() => void navigator.clipboard.writeText(redirectUri())}
            >
              Kopyala
            </button>
          </div>

          <label className="field">
            <span>Client ID</span>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="xxxxx.apps.googleusercontent.com"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Client Secret {secretSaved ? "(kayıtlı)" : ""}</span>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={secretSaved ? "Kayıtlı — değiştirmek için yazın" : "Client secret"}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Varsayılan gizlilik</span>
            <select
              value={privacy}
              onChange={(e) => setPrivacy(e.target.value as typeof privacy)}
            >
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </label>

          <div className="yt-connect-block">
            <button
              type="button"
              className="btn primary block"
              disabled={connecting || !canConnect}
              onClick={() => void connectYoutube()}
            >
              {connecting
                ? "Google’a gidiliyor…"
                : connected
                  ? "YouTube’u yeniden bağla"
                  : "YouTube’a bağlan"}
            </button>
            <span className={`status-dot ${connected ? "ok" : ""}`}>
              {connected ? "Bağlı" : "Bağlı değil"}
            </span>
            <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
              Yükleme hatası (invalid_scope) alırsanız «YouTube’u yeniden bağla» ile tekrar
              yetkilendirin. Google Cloud’da YouTube Data API v3 açık olmalı.
            </p>

            {manualAuthUrl ? (
              <a className="btn primary block" href={manualAuthUrl} style={{ textAlign: "center" }}>
                Google oturum sayfasını aç (manuel)
              </a>
            ) : null}

            {!canConnect ? (
              <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
                Client ID + Secret gerekli.
              </p>
            ) : null}
          </div>
        </section>

        {isAdmin ? <AllowedUsersAdmin /> : null}

        {message ? (
          <p
            className={
              message.includes("kaydedildi") || message.includes("link")
                ? "muted"
                : "form-message"
            }
          >
            {message}
          </p>
        ) : null}

        <div className="modal-footer">
          <button type="button" className="btn ghost" onClick={onClose}>
            Kapat
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={saving || connecting}
            onClick={() => void save()}
          >
            {saving ? "Kaydediliyor…" : "Kaydet"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

type AllowedUser = {
  email: string;
  role: string;
  display_name?: string | null;
  created_at?: string;
};

function AllowedUsersAdmin() {
  const [users, setUsers] = useState<AllowedUser[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      const list = await api<AllowedUser[]>("/auth/users");
      setUsers(list);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Liste alınamadı");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/auth/users", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role: "user" }),
      });
      setEmail("");
      await load();
      setMsg("Kullanıcı eklendi");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Eklenemedi");
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: string) {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/auth/users/${encodeURIComponent(target)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Silinemedi");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>İzinli kullanıcılar</h3>
      <p className="muted">
        Yalnızca buraya eklenen Google hesapları giriş yapabilir. Siz yönetici olarak
        her zaman erişebilirsiniz.
      </p>
      <div className="allowed-add-row">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="ornek@gmail.com"
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <button
          type="button"
          className="btn primary"
          disabled={busy || !email.trim()}
          onClick={() => void add()}
        >
          Ekle
        </button>
      </div>
      <ul className="allowed-list">
        {users.map((u) => (
          <li key={u.email}>
            <div>
              <strong>{u.email}</strong>
              <span className="muted"> · {u.role === "admin" ? "yönetici" : "kullanıcı"}</span>
            </div>
            {u.role === "admin" ? null : (
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() => void remove(u.email)}
              >
                Kaldır
              </button>
            )}
          </li>
        ))}
      </ul>
      {msg ? <p className="muted">{msg}</p> : null}
    </section>
  );
}
