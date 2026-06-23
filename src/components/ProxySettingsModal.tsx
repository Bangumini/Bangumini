import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ProxyConfig {
  enabled: boolean;
  protocol: string;
  host: string;
  port: string;
  username: string;
  password: string;
}

const PROXY_STORAGE_KEY = "bangumini_proxy_config";

function loadProxyConfig(): ProxyConfig {
  try {
    const raw = localStorage.getItem(PROXY_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { enabled: false, protocol: "http", host: "", port: "", username: "", password: "" };
}

function saveProxyConfig(cfg: ProxyConfig) {
  localStorage.setItem(PROXY_STORAGE_KEY, JSON.stringify(cfg));
}

function proxyConfigToRust(cfg: ProxyConfig) {
  return {
    enabled: cfg.enabled,
    protocol: cfg.protocol,
    host: cfg.host,
    port: parseInt(cfg.port, 10) || 0,
    username: cfg.username || null,
    password: cfg.password || null,
  };
}

export default function ProxySettingsModal({ onClose }: { onClose: () => void }) {
  const [proxy, setProxy] = useState<ProxyConfig>(loadProxyConfig);
  const [proxySaved, setProxySaved] = useState(false);

  const persistProxy = async (cfg: ProxyConfig) => {
    saveProxyConfig(cfg);
    try {
      await invoke("set_proxy_config", { config: proxyConfigToRust(cfg) });
    } catch {
      // save failed silently
    }
  };

  const handleToggleProxy = () => {
    const next = { ...proxy, enabled: !proxy.enabled };
    setProxy(next);
    persistProxy(next);
  };

  const handleSaveProxy = async () => {
    await persistProxy(proxy);
    setProxySaved(true);
    setTimeout(() => setProxySaved(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-[380px] max-h-[90vh] overflow-y-auto bg-panel rounded-xl border border-line shadow-pop p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">代理设置</h2>
          <button
            onClick={onClose}
            className="text-fg-tertiary hover:text-fg transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[13px] text-fg-secondary">启用代理</span>
          <button
            type="button"
            role="switch"
            aria-checked={proxy.enabled}
            onClick={handleToggleProxy}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
              proxy.enabled ? "bg-accent" : "bg-line"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
                proxy.enabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {proxy.enabled && (
          <div className="space-y-3">
            <div>
              <label className="block text-[12px] text-fg-tertiary mb-1">协议</label>
              <select
                value={proxy.protocol}
                onChange={(e) => setProxy((p) => ({ ...p, protocol: e.target.value }))}
                className="w-full px-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg focus:border-accent focus:outline-none"
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-[12px] text-fg-tertiary mb-1">主机</label>
                <input
                  type="text"
                  value={proxy.host}
                  onChange={(e) => setProxy((p) => ({ ...p, host: e.target.value }))}
                  placeholder="127.0.0.1"
                  className="w-full px-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div className="w-24">
                <label className="block text-[12px] text-fg-tertiary mb-1">端口</label>
                <input
                  type="text"
                  value={proxy.port}
                  onChange={(e) => setProxy((p) => ({ ...p, port: e.target.value }))}
                  placeholder="8080"
                  className="w-full px-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-[12px] text-fg-tertiary mb-1">用户名 (可选)</label>
                <input
                  type="text"
                  value={proxy.username}
                  onChange={(e) => setProxy((p) => ({ ...p, username: e.target.value }))}
                  className="w-full px-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[12px] text-fg-tertiary mb-1">密码 (可选)</label>
                <input
                  type="password"
                  value={proxy.password}
                  onChange={(e) => setProxy((p) => ({ ...p, password: e.target.value }))}
                  className="w-full px-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
                />
              </div>
            </div>
            <button
              onClick={handleSaveProxy}
              className="px-4 py-1.5 text-[13px] font-medium bg-accent text-accent-fg rounded-md hover:opacity-90 transition-opacity"
            >
              {proxySaved ? "已保存" : "保存"}
            </button>
          </div>
        )}

        <p className="text-[11px] text-fg-tertiary leading-relaxed">
          如果 Bangumi / AniList API 无法直连，请在此配置代理。登录后可在设置页中随时修改。
        </p>
      </div>
    </div>
  );
}
