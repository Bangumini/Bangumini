import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fetchAndCacheUsername, getUsername } from "../api/oauth";
import { offsetSync } from "../api/airing-offset-sync";
import type { AiringOffsetSyncManager } from "../api/airing-offset-sync-types";
import { isTauri } from "../api/tauri-fetch";
import { useAiringOffsetSync } from "../hooks/useAiringOffsetSync";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

type Props = {
  children: ReactNode;
  authenticated: boolean;
  username: string;
  sessionRevision: number;
  manager?: AiringOffsetSyncManager;
};

/** 本地恢复不等待网络；遮挡旧账号内容，但不卸载路由或正在处理登录的页面。 */
export default function AiringOffsetSyncBootstrap({
  children, authenticated, username, sessionRevision, manager = offsetSync,
}: Props) {
  const status = useAiringOffsetSync(manager);
  const account = authenticated && username ? username : null;
  const [attempt, setAttempt] = useState(0);
  const [lookup, setLookup] = useState<{ revision: number; attempt: number; failed: boolean } | null>(null);
  useEffect(() => {
    let mounted = true;
    if (authenticated) {
      void fetchAndCacheUsername().then(value => {
        if (mounted) setLookup({ revision: sessionRevision, attempt, failed: !value && !getUsername() });
      }).catch(() => {
        if (mounted) setLookup({ revision: sessionRevision, attempt, failed: true });
      });
    }
    return () => { mounted = false; };
  }, [authenticated, sessionRevision, attempt]);
  useEffect(() => {
    void manager.setAccount(account).catch(() => {});
  }, [account, manager]);
  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    const activate = (active: boolean) => { if (!stopped) manager.setAppActive(active); };
    const focus = () => activate(document.visibilityState !== "hidden");
    const blur = () => activate(false);
    const visibility = () => activate(document.visibilityState !== "hidden" && document.hasFocus());
    visibility();
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    if (isTauri()) {
      void getCurrentWindow().onFocusChanged(({ payload }) => activate(payload)).then(remove => {
        if (stopped) remove();
        else unlisten = remove;
      }).catch(() => {});
    }
    return () => {
      stopped = true;
      unlisten?.();
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      manager.setAppActive(false);
    };
  }, [manager]);
  const missingAccount = authenticated && !username;
  const blocked = missingAccount || !status.ready || status.account !== account;
  const lookupFailed = missingAccount && lookup?.revision === sessionRevision && lookup.attempt === attempt && lookup.failed;
  const localFailed = !missingAccount && status.account === account && status.phase === "error";
  // inert 阻止 DOM 交互，同时接住两阶段全局快捷键，避免遮罩后仍能改旧账号的条目。
  useKeyboardShortcuts([{ preventDefault: false, handler: () => {} }], { enabled: blocked, capture: true, priority: 1000 });
  useKeyboardShortcuts([{ preventDefault: false, handler: () => {} }], { enabled: blocked, priority: 1000 });
  return <div className="relative flex min-h-0 flex-1 flex-col">
    <div data-offset-sync-content="" className="flex min-h-0 flex-1 flex-col" inert={blocked} aria-hidden={blocked}
      style={blocked ? { opacity: 0, pointerEvents: "none" } : undefined}>
      {children}
    </div>
    {blocked ? <div role="status" aria-live="polite" className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-app p-5 text-[13px] text-fg-secondary">
      <p>{lookupFailed ? "无法确认当前 Bangumi 账号，请检查网络后重试。" : localFailed ? status.error ?? "无法恢复本账号的偏置设置" : "恢复本账号的偏置设置…"}</p>
      {lookupFailed || localFailed ? <button type="button" className="rounded-md border border-line px-3 py-1.5 text-accent focus-visible:outline-2 focus-visible:outline-accent"
        onClick={() => {
          if (lookupFailed) setAttempt(value => value + 1);
          else void manager.setAccount(account).catch(() => {});
        }}>重试</button> : null}
    </div> : null}
  </div>;
}
