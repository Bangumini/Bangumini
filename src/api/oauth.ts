import { tauriFetch, isTauri } from "./tauri-fetch";

const TOKEN_KEY = "bangumi_token";
const REFRESH_KEY = "bangumi_refresh_token";
const EXPIRY_KEY = "bangumi_expires_at";
const USERNAME_KEY = "bangumi_username";

const CLIENT_ID = "bgm61886a103fe0672c1";
const CLIENT_SECRET = "32468c5f6ba84e3528d11bd4905f1726";
const TOKEN_URL = "https://bgm.tv/oauth/access_token";

// Use tauriFetch in Tauri, native fetch in browser
const fetchFn = isTauri() ? tauriFetch : fetch;

export function isLoggedIn(): boolean {
  return !!localStorage.getItem(TOKEN_KEY);
}

export async function getAccessToken(): Promise<string> {
  // Check if token is expired and try to refresh
  const expiry = localStorage.getItem(EXPIRY_KEY);
  if (expiry && Date.now() > Number(expiry)) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return refreshed;
    // Refresh failed — token may still work, return it anyway
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
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

export async function fetchAndCacheUsername(): Promise<string> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return "";
  try {
    const res = await fetchFn("https://api.bgm.tv/v0/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Bangumini/0.1",
      },
    });
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
