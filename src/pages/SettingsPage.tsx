import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { clearToken, setToken } from "../api/oauth";
import ShortcutRecorder from "../components/ShortcutRecorder";

type DistributionKind = "installer" | "portable";

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

const getPortableDownloadUrl = (version: string) => {
  const normalizedVersion = version.trim();

  if (!normalizedVersion) {
    return "https://github.com/Flartiny/Bangumini/releases/latest";
  }

  const plainVersion = normalizedVersion.replace(/^v/i, "");
  const tagVersion = `v${plainVersion}`;
  return `https://github.com/Flartiny/Bangumini/releases/download/${tagVersion}/Bangumini_${plainVersion}_portable.zip`;
};

export default function SettingsPage() {
  const [tokenText, setTokenText] = useState("");
  const [autostart, setAutostart] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(true);
  const [currentVersion, setCurrentVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error">("idle");
  const [latestVersion, setLatestVersion] = useState("");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [distributionKind, setDistributionKind] = useState<DistributionKind>("installer");
  const updateRef = useRef<Awaited<ReturnType<typeof check>>>(null);
  const [proxy, setProxy] = useState<ProxyConfig>(loadProxyConfig);
  const [proxySaved, setProxySaved] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_autostart")
      .then(setAutostart)
      .catch(() => setAutostart(false))
      .finally(() => setAutostartLoading(false));
    invoke<DistributionKind>("get_distribution_kind")
      .then(setDistributionKind)
      .catch(() => setDistributionKind("installer"));
    getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    try {
      const update = await check();
      updateRef.current = update;
      if (update) {
        setLatestVersion(update.version);
        setUpdateStatus("available");
      } else {
        setUpdateStatus("up-to-date");
      }
    } catch {
      setUpdateStatus("error");
    }
  };

  const handleDownloadUpdate = async () => {
    if (distributionKind === "portable") {
      await openUrl(getPortableDownloadUrl(latestVersion));
      return;
    }

    setUpdateStatus("downloading");
    try {
      const update = updateRef.current;
      if (update) {
        let total = 0;
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              total = event.data?.contentLength ?? 0;
              setDownloadProgress(0);
              break;
            case "Progress":
              setDownloadProgress((prev) => {
                if (!total) {
                  return prev;
                }
                const next = prev + ((event.data?.chunkLength ?? 0) / total) * 100;
                return Math.min(100, Math.round(next));
              });
              break;
            case "Finished":
              setUpdateStatus("ready");
              break;
          }
        });
      }
    } catch {
      setUpdateStatus("error");
    }
  };

  const handleRestart = async () => {
    await relaunch();
  };

  const toggleAutostart = async () => {
    const next = !autostart;
    try {
      await invoke("set_autostart", { enabled: next });
      setAutostart(next);
    } catch {
      // toggle failed, leave unchanged
    }
  };

  const handleSaveProxy = async () => {
    saveProxyConfig(proxy);
    try {
      await invoke("set_proxy_config", { config: proxyConfigToRust(proxy) });
      setProxySaved(true);
      setTimeout(() => setProxySaved(false), 2000);
    } catch {
      // save failed silently
    }
  };

  return (
    <div className="p-5 max-w-lg space-y-6">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">账户</h3>
        <label className="block text-[13px] text-fg-secondary mb-1.5">Access Token</label>
        <div className="flex gap-2">
          <input
            type="password"
            value={tokenText}
            onChange={(e) => setTokenText(e.target.value)}
            placeholder="更新 Access Token…"
            className="flex-1 px-3 py-2 text-[13px] bg-elevated rounded-md border border-line text-fg placeholder-fg-tertiary focus:border-accent focus:outline-none"
          />
          <button
            onClick={() => { setToken(tokenText.trim()); setTokenText(""); }}
            disabled={!tokenText.trim()}
            className="px-4 py-2 text-[13px] font-medium bg-accent text-accent-fg rounded-md hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            更新
          </button>
        </div>
        <p className="text-[12px] text-fg-tertiary mt-1.5">
          前往{" "}
          <a href="https://next.bgm.tv/demo/access-token" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            Bangumi 开发者工具
          </a>{" "}
          生成
        </p>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">全局快捷键</h3>
        <ShortcutRecorder />
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">代理</h3>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[13px] text-fg-secondary">启用代理</span>
          <button
            type="button"
            role="switch"
            aria-checked={proxy.enabled}
            onClick={() => setProxy((p) => ({ ...p, enabled: !p.enabled }))}
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
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">通用</h3>
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-fg-secondary">开机自启动</span>
          <button
            type="button"
            role="switch"
            aria-checked={autostart}
            disabled={autostartLoading}
            onClick={toggleAutostart}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
              autostartLoading ? "opacity-40" : ""
            } ${autostart ? "bg-accent" : "bg-line"}`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
                autostart ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">版本更新</h3>
        <p className="text-[13px] text-fg-secondary mb-3">
          当前版本 {currentVersion || "—"}
          {updateStatus === "up-to-date" && <span className="text-success ml-2">已是最新</span>}
          {updateStatus === "available" && <span className="text-accent ml-2">发现新版本 {latestVersion}</span>}
        </p>
        {updateStatus === "idle" && (
          <button onClick={handleCheckUpdate} className="px-4 py-1.5 text-[13px] font-medium bg-accent text-accent-fg rounded-md hover:opacity-90 transition-opacity">
            检查更新
          </button>
        )}
        {updateStatus === "checking" && (
          <span className="text-[13px] text-fg-tertiary animate-pulse">正在检查…</span>
        )}
        {updateStatus === "up-to-date" && (
          <button onClick={handleCheckUpdate} className="px-4 py-1.5 text-[13px] font-medium bg-elevated text-fg-secondary rounded-md border border-line hover:bg-hover transition-colors">
            重新检查
          </button>
        )}
        {updateStatus === "available" && (
          <div className="flex gap-2">
            <button onClick={handleDownloadUpdate} className="px-4 py-1.5 text-[13px] font-medium bg-accent text-accent-fg rounded-md hover:opacity-90 transition-opacity">
              {distributionKind === "portable" ? "下载便携版" : "下载更新"}
            </button>
            <button onClick={handleCheckUpdate} className="px-4 py-1.5 text-[13px] font-medium bg-elevated text-fg-secondary rounded-md border border-line hover:bg-hover transition-colors">
              重新检查
            </button>
          </div>
        )}
        {updateStatus === "downloading" && (
          <div className="space-y-2">
            <span className="text-[13px] text-fg-secondary">下载中 {downloadProgress}%</span>
            <div className="h-1.5 w-48 rounded-full bg-elevated overflow-hidden">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${downloadProgress}%` }} />
            </div>
          </div>
        )}
        {updateStatus === "ready" && (
          <button onClick={handleRestart} className="px-4 py-1.5 text-[13px] font-medium bg-success text-success-fg rounded-md hover:opacity-90 transition-opacity">
            安装并重启
          </button>
        )}
        {updateStatus === "error" && (
          <div className="space-y-2">
            <span className="text-[13px] text-danger">检查更新失败</span>
            <button onClick={handleCheckUpdate} className="block px-4 py-1.5 text-[13px] font-medium bg-elevated text-fg-secondary rounded-md border border-line hover:bg-hover transition-colors">
              重试
            </button>
          </div>
        )}
      </section>

      <div className="pt-2 border-t border-line">
        <button
          onClick={() => { clearToken(); window.location.reload(); }}
          className="px-4 py-2 text-[13px] font-medium bg-danger/15 hover:bg-danger/25 rounded-md text-danger transition-colors"
        >
          退出登录
        </button>
      </div>
    </div>
  );
}
