import { useState } from "react";
import { setToken } from "../api/oauth";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setTokenText] = useState("");

  function handleSubmit() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setToken(trimmed);
    onLogin();
  }

  return (
    <div className="flex items-center justify-center h-screen bg-[#1a1a2e]">
      <div className="w-96 p-6 bg-gray-800/50 rounded-xl border border-gray-700">
        <h1 className="text-xl font-semibold text-center mb-2">登录 Bangumi</h1>
        <p className="text-sm text-gray-400 text-center mb-4">
          前往{" "}
          <a
            href="https://next.bgm.tv/demo/access-token"
            target="_blank"
            rel="noreferrer"
            className="text-indigo-400 hover:underline"
          >
            Bangumi 开发者工具
          </a>{" "}
          生成 Access Token，粘贴到下方
        </p>
        <input
          autoFocus
          type="password"
          value={token}
          onChange={(e) => setTokenText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="粘贴 Access Token…"
          className="w-full px-3 py-2 text-sm bg-gray-900 rounded-md border border-gray-600 text-gray-200 placeholder-gray-500 focus:border-indigo-500 mb-3"
        />
        <button
          onClick={handleSubmit}
          disabled={!token.trim()}
          className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-md text-sm font-medium transition-colors"
        >
          登录
        </button>
      </div>
    </div>
  );
}
