import { useState } from "react";
import { setToken } from "../api/oauth";
import { recordAuthEvent } from "../api/auth-diagnostics";
import ProxySettingsModal from "../components/ProxySettingsModal";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setTokenText] = useState("");
  const [loading, setLoading] = useState(false);
  const [showProxyModal, setShowProxyModal] = useState(false);

  function handleManualSubmit() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setToken(trimmed);
    onLogin();
  }

  async function handleOAuthLogin() {
    recordAuthEvent("oauth.started", {});
    setLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { state } = await invoke<{ state: string }>("start_oauth");

      // 等待浏览器回调，不记录包含凭据的完整响应。
      const result = await invoke<{
        success: boolean;
        error?: string;
        access_token?: string;
        refresh_token?: string;
        expires_at?: number;
      }>("wait_oauth_callback", { expectedState: state });

      recordAuthEvent("oauth.callback_received", {
        success: result.success,
        hasAccessToken: Boolean(result.access_token),
        hasRefreshToken: Boolean(result.refresh_token),
        hasExpiresAt: typeof result.expires_at === "number",
      });

      if (result.success && result.access_token) {
        setToken(result.access_token);
        if (result.refresh_token) {
          localStorage.setItem("bangumi_refresh_token", result.refresh_token);
        }
        if (result.expires_at) {
          // Rust OAuth 回调返回 Unix 秒，前端统一按毫秒保存。
          localStorage.setItem(
            "bangumi_expires_at",
            String(result.expires_at * 1000),
          );
        }
        recordAuthEvent("credentials.persisted", {
          hasToken: Boolean(localStorage.getItem("bangumi_token")),
          hasRefreshToken: Boolean(localStorage.getItem("bangumi_refresh_token")),
          hasExpiresAt: Boolean(localStorage.getItem("bangumi_expires_at")),
        });
        onLogin();
      } else {
        alert("授权失败: " + (result.error ?? "未知错误"));
      }
    } catch (e) {
      recordAuthEvent("oauth.failed", {});
      alert("OAuth 出错: " + String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="w-96 p-6 bg-panel/60 rounded-card border border-line space-y-4 shadow-pop">
        <div className="flex flex-col items-center gap-2.5 pb-1">
          <img src="/icon.png" className="w-11 h-11 rounded-xl" alt="" />
          <h1 className="text-[15px] font-semibold">登录 Bangumi</h1>
        </div>

        <button
          onClick={handleOAuthLogin}
          disabled={loading}
          className="w-full py-2.5 bg-accent hover:opacity-90 disabled:opacity-40 rounded-md text-[13px] font-medium text-accent-fg transition-opacity"
        >
          {loading ? "等待授权…" : "通过浏览器授权登录"}
        </button>

        <div className="flex items-center gap-2">
          <div className="flex-1 h-px bg-line" />
          <span className="text-[12px] text-fg-tertiary">或手动输入</span>
          <div className="flex-1 h-px bg-line" />
        </div>

        <p className="text-[12px] text-fg-secondary leading-relaxed">
          前往{" "}
          <a
            href="https://next.bgm.tv/demo/access-token"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            Bangumi 开发者工具
          </a>{" "}
          生成 Access Token
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setTokenText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
          placeholder="粘贴 Access Token…"
          className="w-full px-3 py-2 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
        />
        <button
          onClick={handleManualSubmit}
          disabled={!token.trim()}
          className="w-full py-2 bg-elevated hover:bg-hover disabled:opacity-40 rounded-md text-[13px] font-medium text-fg-secondary transition-colors"
        >
          手动登录
        </button>

        <div className="text-center pt-1">
          <button
            onClick={() => setShowProxyModal(true)}
            className="text-[12px] text-fg-tertiary hover:text-accent transition-colors"
          >
            代理设置
          </button>
        </div>
      </div>

      {showProxyModal && <ProxySettingsModal onClose={() => setShowProxyModal(false)} />}
    </div>
  );
}
