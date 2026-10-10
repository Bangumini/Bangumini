import { invoke } from "@tauri-apps/api/core";
import type { RefreshFailureReason } from "./oauth";

declare const __APP_VERSION__: string;

type CredentialPresence = {
  hasToken: boolean;
  hasRefreshToken: boolean;
  hasExpiresAt: boolean;
};

/** auth 域的前端事件；新增事件时必须同步 Rust 白名单。 */
type AuthEventDetails = {
  "session.started": CredentialPresence;
  "credentials.persisted": CredentialPresence;
  "credentials.expired": { hasRefreshToken: boolean; expiresAtMs: number };
  "api.unauthorized": { hasRejectedToken: boolean };
  "oauth.started": Record<string, never>;
  "oauth.failed": Record<string, never>;
  "oauth.callback_received": {
    success: boolean;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    hasExpiresAt: boolean;
  };
  "profile.succeeded": Record<string, never>;
  "profile.unauthorized": Record<string, never>;
  "session.clear_skipped": Record<string, never>;
  "session.cleared": { hasExpectedToken: boolean };
  "refresh.started": Record<string, never>;
  "refresh.discarded": Record<string, never>;
  "refresh.succeeded": { expiresIn: number; hasRefreshToken: boolean };
  "refresh.failed": { reason: RefreshFailureReason; status?: number };
};

let sessionId: number | undefined;
let sequence = 0;

/** 最佳努力记录；禁止凭据、URL 和原始错误，Rust 再按事件验证字段。 */
export function recordAuthEvent<E extends keyof AuthEventDetails>(
  event: E,
  details: AuthEventDetails[E],
): void {
  try {
    // 每次加载前端生成新会话，不写 localStorage，也不从用户数据派生。
    sessionId ??= crypto.getRandomValues(new Uint32Array(1))[0];
    const version = typeof __APP_VERSION__ === "string"
      ? /^(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/.exec(__APP_VERSION__)
      : null;
    void invoke("record_auth_diagnostic", {
      event,
      details: {
        ...details,
        sessionId,
        sequence: ++sequence,
        frontendVersionMajor: version ? Number(version[1]) : undefined,
        frontendVersionMinor: version ? Number(version[2]) : undefined,
        frontendVersionPatch: version ? Number(version[3]) : undefined,
        buildMode: import.meta.env.DEV ? "development" : "production",
      },
    }).catch(() => { /* 日志失败不影响认证，也不输出原始异常。 */ });
  } catch { /* 浏览器预览、序列化或 IPC 同步异常同样忽略。 */ }
}
