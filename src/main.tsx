import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// In Tauri: replace native fetch with Tauri HTTP plugin's fetch
// (bypasses WebView network restrictions)
(async () => {
  try {
    const mod = await import("@tauri-apps/plugin-http");
    if (mod.fetch) {
      (globalThis as Record<string, unknown>).fetch = mod.fetch;
    }
  } catch {
    // Not in Tauri environment, use native fetch
  }
})().then(() => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 1000 * 60 * 5, retry: 1 },
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
});
