import { useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { setToken } from "../api/oauth";
import { recordAuthEvent } from "../api/auth-diagnostics";
import { isTauri } from "../api/tauri-fetch";
import { RefreshIcon, SettingsIcon } from "../components/icons";
import ProxySettingsModal from "../components/ProxySettingsModal";

type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "error";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setTokenText] = useState("");
  const [loading, setLoading] = useState(false);
  const [showProxyModal, setShowProxyModal] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [latestVersion, setLatestVersion] = useState("");

  function handleManualSubmit() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setToken(trimmed);
    onLogin();
  }

  async function handleCheckUpdate() {
    if (!isTauri()) {
      setUpdateStatus("error");
      return;
    }

    setUpdateStatus("checking");
    setLatestVersion("");
    try {
      const update = await check();
      if (update) {
        setLatestVersion(update.version);
        setUpdateStatus("available");
      } else {
        setUpdateStatus("up-to-date");
      }
    } catch {
      setUpdateStatus("error");
    }
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

        <div className="border-t border-line pt-4 space-y-2.5">
          <p className="text-[12px] font-medium text-fg-secondary">网络与更新</p>
          <button
            type="button"
            onClick={() => setShowProxyModal(true)}
            className="w-full flex items-center justify-between gap-3 rounded-lg border border-line bg-elevated/50 px-3 py-2.5 text-left transition-colors hover:bg-hover"
          >
            <span className="flex items-center gap-2.5">
              <SettingsIcon size={16} className="shrink-0 text-accent" />
              <span>
                <span className="block text-[13px] font-medium text-fg">
                  代理设置
                </span>
                <span className="block mt-0.5 text-[11px] text-fg-tertiary">
                  登录或联网异常时配置代理
                </span>
              </span>
            </span>
            <span className="text-[11px] text-fg-tertiary">打开</span>
          </button>
          <button
            type="button"
            onClick={() => void handleCheckUpdate()}
            disabled={updateStatus === "checking"}
            className="w-full flex items-center justify-between gap-3 rounded-lg border border-line bg-elevated/50 px-3 py-2.5 text-left transition-colors hover:bg-hover disabled:cursor-wait disabled:opacity-60"
          >
            <span className="flex items-center gap-2.5">
              <RefreshIcon size={16} className="shrink-0 text-accent" />
              <span>
                <span className="block text-[13px] font-medium text-fg">
                  {updateStatus === "checking" ? "正在检查更新…" : "检查更新"}
                </span>
                <span
                  className={`block mt-0.5 text-[11px] ${
                    updateStatus === "available"
                      ? "text-accent"
                      : updateStatus === "error"
                        ? "text-danger"
                        : "text-fg-tertiary"
                  }`}
                >
                  {updateStatus === "idle" && "无需登录即可检查新版本"}
                  {updateStatus === "checking" && "正在连接更新服务器…"}
                  {updateStatus === "up-to-date" && "当前已是最新版本"}
                  {updateStatus === "available" &&
                    `发现新版本 v${latestVersion}，登录后可安装`}
                  {updateStatus === "error" && "检查失败，点击重试"}
                </span>
              </span>
            </span>
          </button>
        </div>
      </div>

      {showProxyModal && <ProxySettingsModal onClose={() => setShowProxyModal(false)} />}
    </div>
  );
}
