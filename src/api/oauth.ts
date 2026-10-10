import { tauriFetch, isTauri } from "./tauri-fetch";
import { recordAuthEvent } from "./auth-diagnostics";

const TOKEN_KEY = "bangumi_token";
const REFRESH_KEY = "bangumi_refresh_token";
const EXPIRY_KEY = "bangumi_expires_at";
const USERNAME_KEY = "bangumi_username";

export const AUTH_INVALIDATED_EVENT = "bangumini:auth-invalidated";
export const AUTH_REFRESH_REDIRECT_URI = "http://localhost:19840/callback";

const CLIENT_ID = "bgm61886a103fe0672c1";
const CLIENT_SECRET = "32468c5f6ba84e3528d11bd4905f1726";
const TOKEN_URL = "https://bgm.tv/oauth/access_token";

export type RefreshFailureReason =
  | "missing-refresh-token"
  | "network"
  | "rate-limited"
  | "server"
  | "invalid-grant"
  | "invalid-client"
  | "invalid-response";

type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: RefreshFailureReason };

type CredentialSnapshot = {
  revision: number;
  token: string | null;
  refreshToken: string | null;
  expiry: string | null;
};

type RefreshFlight = {
  revision: number;
  refreshToken: string;
  promise: Promise<RefreshResult>;
};

export type AuthFailureKind = "temporary" | "reauth-required" | "configuration";

export class AuthenticationError extends Error {
  readonly kind: AuthFailureKind;
  readonly reason: RefreshFailureReason;

  constructor(kind: AuthFailureKind, reason: RefreshFailureReason, message: string) {
    super(message);
    this.name = "AuthenticationError";
    this.kind = kind;
    this.reason = reason;
  }
}

// Use tauriFetch in Tauri, native fetch in browser
const fetchFn = isTauri() ? tauriFetch : fetch;
let authSessionRevision = 0;
let refreshInFlight: RefreshFlight | null = null;

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

function readCredentialSnapshot(): CredentialSnapshot {
  return {
    revision: authSessionRevision,
    token: localStorage.getItem(TOKEN_KEY),
    refreshToken: localStorage.getItem(REFRESH_KEY),
    expiry: localStorage.getItem(EXPIRY_KEY),
  };
}

function requiresReauthentication(reason: RefreshFailureReason): boolean {
  return reason === "missing-refresh-token" || reason === "invalid-grant";
}

function toAuthenticationError(result: Extract<RefreshResult, { ok: false }>) {
  const kind = requiresReauthentication(result.reason)
    ? "reauth-required"
    : result.reason === "invalid-client"
      ? "configuration"
      : "temporary";
  return new AuthenticationError(
    kind,
    result.reason,
    kind === "reauth-required"
      ? "Authentication expired; reauthorization required"
      : "Authentication temporarily unavailable",
  );
}

export async function getAccessToken(): Promise<string> {
  const snapshot = readCredentialSnapshot();
  const expiry = getExpiryTimestampMs(snapshot.expiry);
  if (expiry !== null && Date.now() >= expiry) {
    recordAuthEvent("credentials.expired", {
      hasRefreshToken: Boolean(snapshot.refreshToken),
      expiresAtMs: expiry,
    });
    const refreshed = await refreshAccessToken(snapshot.revision);
    if (refreshed.ok) return refreshed.accessToken;

    const error = toAuthenticationError(refreshed);
    if (
      error.kind === "reauth-required" &&
      authSessionRevision === snapshot.revision
    ) {
      clearToken(snapshot.token ?? undefined);
    }
    throw error;
  }

  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) throw new Error("Not authenticated");
  return token;
}

export function getUsername(): string {
  return localStorage.getItem(USERNAME_KEY) ?? "";
}

export function setToken(token: string) {
  authSessionRevision += 1;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(USERNAME_KEY);
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(expectedToken?: string): boolean {
  if (expectedToken && localStorage.getItem(TOKEN_KEY) !== expectedToken) {
    recordAuthEvent("session.clear_skipped", {});
    return false;
  }

  authSessionRevision += 1;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(USERNAME_KEY);
  recordAuthEvent("session.cleared", { hasExpectedToken: Boolean(expectedToken) });
  notifyAuthInvalidated();
  return true;
}

async function requestUsername(token: string): Promise<Response> {
  return fetchFn("https://api.bgm.tv/v0/me", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Bangumini/0.1",
    },
  });
}

export async function fetchAndCacheUsername(): Promise<string> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return "";
  }

  try {
    let res = await requestUsername(token);
    if (res.status === 401) {
      recordAuthEvent("profile.unauthorized", {});
      const recovered = await handleAuthInvalidated(token);
      if (!recovered) return "";

      token = await getAccessToken();
      res = await requestUsername(token);
      if (res.status === 401) {
        clearToken(token);
        return "";
      }
    }
    if (res.ok) {
      recordAuthEvent("profile.succeeded", {});
      const data = (await res.json()) as { username: string };
      if (data.username) {
        localStorage.setItem(USERNAME_KEY, data.username);
        return data.username;
      }
    }
  } catch { /* */ }
  return "";
}

async function performRefresh(
  refreshRevision: number,
  refreshToken: string,
): Promise<RefreshResult> {
  const body = new URLSearchParams();
  body.append("grant_type", "refresh_token");
  body.append("client_id", CLIENT_ID);
  body.append("client_secret", CLIENT_SECRET);
  body.append("refresh_token", refreshToken);
  body.append("redirect_uri", AUTH_REFRESH_REDIRECT_URI);

  recordAuthEvent("refresh.started", {});
  let res: Response;
  try {
    res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    recordAuthEvent("refresh.failed", { reason: "network" });
    return { ok: false, reason: "network" };
  }

  if (!res.ok) {
    let errorCode = "";
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === "string") errorCode = data.error;
    } catch { /* 非 JSON 错误响应按状态码分类 */ }

    if (errorCode === "invalid_client") {
      recordAuthEvent("refresh.failed", { reason: "invalid-client", status: res.status });
      return { ok: false, reason: "invalid-client" };
    }
    if (errorCode === "invalid_grant" || res.status === 401 || res.status === 403) {
      recordAuthEvent("refresh.failed", { reason: "invalid-grant", status: res.status });
      return { ok: false, reason: "invalid-grant" };
    }
    if (res.status === 429) {
      recordAuthEvent("refresh.failed", { reason: "rate-limited", status: res.status });
      return { ok: false, reason: "rate-limited" };
    }
    if (res.status >= 500) {
      recordAuthEvent("refresh.failed", { reason: "server", status: res.status });
      return { ok: false, reason: "server" };
    }
    recordAuthEvent("refresh.failed", { reason: "invalid-response", status: res.status });
    return { ok: false, reason: "invalid-response" };
  }

  let data: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    recordAuthEvent("refresh.failed", { reason: "invalid-response" });
    return { ok: false, reason: "invalid-response" };
  }

  if (
    !data ||
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    recordAuthEvent("refresh.failed", { reason: "invalid-response" });
    return { ok: false, reason: "invalid-response" };
  }

  // 新登录或退出登录已经开始时，旧 refresh 响应不能覆盖当前会话。
  if (
    authSessionRevision !== refreshRevision ||
    localStorage.getItem(REFRESH_KEY) !== refreshToken
  ) {
    recordAuthEvent("refresh.discarded", {});
    const currentToken = localStorage.getItem(TOKEN_KEY);
    return currentToken
      ? { ok: true, accessToken: currentToken }
      : { ok: false, reason: "missing-refresh-token" };
  }

  localStorage.setItem(TOKEN_KEY, data.access_token);
  if (typeof data.refresh_token === "string" && data.refresh_token) {
    localStorage.setItem(REFRESH_KEY, data.refresh_token);
  }
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + data.expires_in * 1000));
  recordAuthEvent("refresh.succeeded", {
    expiresIn: data.expires_in,
    hasRefreshToken: Boolean(localStorage.getItem(REFRESH_KEY)),
  });
  return { ok: true, accessToken: data.access_token };
}

export async function refreshAccessToken(
  expectedRevision?: number,
): Promise<RefreshResult> {
  const snapshot = readCredentialSnapshot();
  if (
    expectedRevision !== undefined &&
    snapshot.revision !== expectedRevision
  ) {
    return snapshot.token
      ? { ok: true, accessToken: snapshot.token }
      : { ok: false, reason: "missing-refresh-token" };
  }
  if (!snapshot.refreshToken) {
    recordAuthEvent("refresh.failed", { reason: "missing-refresh-token" });
    return { ok: false, reason: "missing-refresh-token" };
  }

  let currentRefresh = refreshInFlight;
  if (
    !currentRefresh ||
    currentRefresh.revision !== snapshot.revision ||
    currentRefresh.refreshToken !== snapshot.refreshToken
  ) {
    currentRefresh = {
      revision: snapshot.revision,
      refreshToken: snapshot.refreshToken,
      promise: performRefresh(snapshot.revision, snapshot.refreshToken),
    };
    refreshInFlight = currentRefresh;
  }

  try {
    return await currentRefresh.promise;
  } finally {
    if (refreshInFlight === currentRefresh) {
      refreshInFlight = null;
    }
  }
}

export async function handleAuthInvalidated(
  rejectedToken?: string,
): Promise<boolean> {
  recordAuthEvent("api.unauthorized", { hasRejectedToken: Boolean(rejectedToken) });
  const currentToken = localStorage.getItem(TOKEN_KEY);
  if (rejectedToken && currentToken !== rejectedToken) {
    // 401 属于旧会话，当前会话已经换过 token，只需让请求重试。
    return Boolean(currentToken);
  }

  const snapshot = readCredentialSnapshot();
  const refreshed = await refreshAccessToken(snapshot.revision);
  if (refreshed.ok) return true;

  if (
    requiresReauthentication(refreshed.reason) &&
    authSessionRevision === snapshot.revision
  ) {
    clearToken(rejectedToken ?? snapshot.token ?? undefined);
  }
  return false;
}
