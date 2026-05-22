import { useState } from "react";
import { clearToken, setToken } from "../api/oauth";

export default function SettingsPage() {
  const [tokenText, setTokenText] = useState("");

  return (
    <div className="p-4 max-w-md">
      <h2 className="text-lg font-medium mb-4">设置</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Access Token</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={tokenText}
              onChange={(e) => setTokenText(e.target.value)}
              placeholder="更新 Access Token…"
              className="flex-1 px-3 py-2 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 placeholder-gray-500"
            />
            <button
              onClick={() => { setToken(tokenText.trim()); setTokenText(""); }}
              disabled={!tokenText.trim()}
              className="px-4 py-2 text-sm bg-indigo-600 rounded-md hover:bg-indigo-500 disabled:opacity-40"
            >
              更新
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-1">
            前往{" "}
            <a href="https://next.bgm.tv/demo/access-token" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
              Bangumi 开发者工具
            </a>{" "}
            生成
          </p>
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1">开机自启动</label>
          <p className="text-xs text-gray-600">（Tauri 实现后可用）</p>
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1">全局快捷键</label>
          <p className="text-xs text-gray-600">（Tauri 实现后可用）</p>
        </div>

        <button
          onClick={() => { clearToken(); window.location.reload(); }}
          className="px-4 py-2 text-sm bg-red-800/50 hover:bg-red-800 rounded-md text-red-300"
        >
          退出登录
        </button>
      </div>
    </div>
  );
}
