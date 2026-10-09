import { tauriFetch, isTauri } from "./tauri-fetch";

const TOKEN_KEY = "bangumi_token";
const REFRESH_KEY = "bangumi_refresh_token";
const EXPIRY_KEY = "bangumi_expires_at";
const USERNAME_KEY = "bangumi_username";

export const AUTH_INVALIDATED_EVENT = "bangumini:auth-invalidated";

const CLIENT_ID = "bgm61886a103fe0672c1";
const CLIENT_SECRET = "32468c5f6ba84e3528d11bd4905f1726";
const TOKEN_URL = "https://bgm.tv/oauth/access_token";

// Use tauriFetch in Tauri, native fetch in browser
const fetchFn = isTauri() ? tauriFetch : fetch;

export function isLoggedIn(): boolean {
  return !!localStorage.getItem(TOKEN_KEY);
}

function getExpiryTimestampMs(rawExpiry: string | null): number | null {
  if (!rawExpiry) return null;
  const expiry = Number(rawExpiry);
  if (!Number.isFinite(expiry) || expiry <= 0) return null;

  // OAuth 回调返回 Unix 秒，刷新接口返回的 expires_at 使用毫秒；兼容两种格式。
  return expiry < 1_000_000_000_000 ? expiry * 1000 : expiry;
}

function notifyAuthInvalidated() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT));
  }
}

export async function getAccessToken(): Promise<string> {
  const expiry = getExpiryTimestampMs(localStorage.getItem(EXPIRY_KEY));
  if (expiry !== null && Date.now() >= expiry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return refreshed;

    // 已知 token 过期且刷新失败时，不能继续发送旧 token。
    clearToken();
    throw new Error("Authentication expired");
  }

  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) throw new Error("Not authenticated");
  return token;
}

export function getUsername(): string {
  return localStorage.getItem(USERNAME_KEY) ?? "";
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
  // 手动替换 token 时不能沿用旧 OAuth token 的刷新信息。
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(USERNAME_KEY);
  notifyAuthInvalidated();
}

export async function fetchAndCacheUsername(): Promise<string> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return "";
  }

  try {
    const res = await fetchFn("https://api.bgm.tv/v0/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Bangumini/0.1",
      },
    });
    if (res.status === 401) {
      clearToken();
      return "";
    }
    if (res.ok) {
      const data = (await res.json()) as { username: string };
      if (data.username) {
        localStorage.setItem(USERNAME_KEY, data.username);
        return data.username;
      }
    }
  } catch { /* */ }
  return "";
}

export async function refreshAccessToken(): Promise<string | null> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) return null;

  try {
    const body = new URLSearchParams();
    body.append("grant_type", "refresh_token");
    body.append("client_id", CLIENT_ID);
    body.append("client_secret", CLIENT_SECRET);
    body.append("refresh_token", refresh);

    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    localStorage.setItem(TOKEN_KEY, data.access_token);
    if (data.refresh_token) {
      localStorage.setItem(REFRESH_KEY, data.refresh_token);
    }
    if (data.expires_in) {
      localStorage.setItem(EXPIRY_KEY, String(Date.now() + data.expires_in * 1000));
    }
    return data.access_token;
  } catch {
    return null;
  }
}
