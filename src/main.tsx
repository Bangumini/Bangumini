import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { tauriFetch, isTauri } from "./api/tauri-fetch";
import { setFetchFunction as setBangumiFetchFunction } from "@shared/api/client";
import { setFetchFunction as setAniListFetchFunction } from "@shared/api/anilist";
import { notifyNativeWindowVisibility } from "./api/auto-refresh";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import "./index.css";

// Set fetch function for API client
if (isTauri()) {
  setBangumiFetchFunction(tauriFetch as typeof fetch);
  setAniListFetchFunction(tauriFetch as typeof fetch);
}

// Restore proxy config from localStorage on startup
if (isTauri()) {
  try {
    const raw = localStorage.getItem("bangumini_proxy_config");
    if (raw) {
      const cfg = JSON.parse(raw);
      invoke("set_proxy_config", {
        config: {
          enabled: cfg.enabled ?? false,
          protocol: cfg.protocol ?? "http",
          host: cfg.host ?? "",
          port: parseInt(cfg.port, 10) || 0,
          username: cfg.username || null,
          password: cfg.password || null,
        },
      }).catch(() => { /* ignore */ });
    }
  } catch { /* ignore */ }
}

// Disable right-click context menu
document.addEventListener("contextmenu", (e) => e.preventDefault());

// Bridge Tauri window focus events to React Query's focusManager AND to the
// auto-refresh trigger gate. React Query's default focus listener relies on
// browser `focus`/`visibilitychange` events, which Tauri doesn't fire when the
// window is programmatically shown/hidden (e.g. via global shortcut or tray).
// 自动刷新需要知道“窗口重新显示”，因此同一个事件也通知触发闸门。
if (isTauri()) {
  getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    focusManager.setFocused(focused);
    notifyNativeWindowVisibility(focused);
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1000 * 60 * 5, retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
