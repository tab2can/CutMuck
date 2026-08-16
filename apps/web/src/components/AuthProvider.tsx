"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";

export type AuthUser = {
  email: string;
  role: "admin" | "user";
  is_admin: boolean;
  name?: string;
  picture?: string;
};

type AuthContextValue = {
  loading: boolean;
  user: AuthUser | null;
  loginError: string | null;
  refreshAuth: () => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function loginReasonMessage(reason: string | null): string | null {
  if (!reason) return null;
  const map: Record<string, string> = {
    denied: "Bu Google hesabının CutMuck erişimi yok. Yönetici eklemeli.",
    state_mismatch: "Oturum doğrulaması başarısız. Tekrar deneyin.",
    missing_code: "Google’dan kod gelmedi.",
    missing_credentials: "Sunucuda Google Client ID/Secret eksik.",
  };
  return map[reason] || decodeURIComponent(reason);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  const refreshAuth = useCallback(async () => {
    try {
      const me = await api<{
        authenticated: boolean;
        email?: string;
        role?: "admin" | "user";
        is_admin?: boolean;
        name?: string;
        picture?: string;
        reason?: string;
      }>("/auth/me");
      if (me.authenticated && me.email && me.role) {
        setUser({
          email: me.email,
          role: me.role,
          is_admin: Boolean(me.is_admin ?? me.role === "admin"),
          name: me.name,
          picture: me.picture,
        });
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const login = params.get("login");
      if (login === "denied") setLoginError(loginReasonMessage("denied"));
      else if (login === "error") setLoginError(loginReasonMessage(params.get("reason")));
      else if (login === "ok") setLoginError(null);
      if (login) {
        const url = new URL(window.location.href);
        url.searchParams.delete("login");
        url.searchParams.delete("reason");
        window.history.replaceState({}, "", url.pathname + url.search);
      }
    }
    void refreshAuth();
  }, [refreshAuth]);

  const loginWithGoogle = useCallback(async () => {
    setLoginError(null);
    const { auth_url } = await api<{ auth_url: string }>("/auth/login/start");
    if (!auth_url) throw new Error("Google giriş URL’si alınamadı");
    window.location.href = auth_url;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ loading, user, loginError, refreshAuth, loginWithGoogle, logout }),
    [loading, user, loginError, refreshAuth, loginWithGoogle, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
