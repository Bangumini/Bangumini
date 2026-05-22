import { useState } from "react";
import { setToken } from "../api/oauth";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setTokenText] = useState("");
  const [loading, setLoading] = useState(false);

  function handleManualSubmit() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setToken(trimmed);
    onLogin();
  }

  async function handleOAuthLogin() {
    setLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");

      // Step 1: Get auth URL
      const { url, state } = await invoke<{ url: string; state: string }>("get_auth_url");

      // Step 2: Open browser via Tauri opener plugin
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);

      // Step 3: Wait for callback
      const result = await invoke<{
        success: boolean;
        error?: string;
        access_token?: string;
        refresh_token?: string;
        expires_at?: number;
      }>("wait_oauth_callback", { expectedState: state });

      if (result.success && result.access_token) {
        setToken(result.access_token);
        if (result.refresh_token) {
          localStorage.setItem("bangumi_refresh_token", result.refresh_token);
        }
        if (result.expires_at) {
          localStorage.setItem("bangumi_expires_at", String(result.expires_at));
        }
        onLogin();
      } else {
        alert("授权失败: " + (result.error ?? "未知错误"));
      }
    } catch (e) {
      alert("OAuth 出错: " + String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-[#1a1a2e]">
      <div className="w-96 p-6 bg-gray-800/50 rounded-xl border border-gray-700 space-y-4">
        <h1 className="text-xl font-semibold text-center">登录 Bangumi</h1>

        <button
          onClick={handleOAuthLogin}
          disabled={loading}
          className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-md text-sm font-medium transition-colors"
        >
          {loading ? "等待授权…" : "通过浏览器授权登录"}
        </button>

        <div className="flex items-center gap-2">
          <div className="flex-1 h-px bg-gray-600" />
          <span className="text-xs text-gray-500">或手动输入</span>
          <div className="flex-1 h-px bg-gray-600" />
        </div>

        <p className="text-xs text-gray-400">
          前往{" "}
          <a
            href="https://next.bgm.tv/demo/access-token"
            target="_blank"
            rel="noreferrer"
            className="text-indigo-400 hover:underline"
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
          className="w-full px-3 py-2 text-sm bg-gray-900 rounded-md border border-gray-600 text-gray-200 placeholder-gray-500 focus:border-indigo-500"
        />
        <button
          onClick={handleManualSubmit}
          disabled={!token.trim()}
          className="w-full py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded-md text-sm font-medium transition-colors"
        >
          手动登录
        </button>
      </div>
    </div>
  );
}
