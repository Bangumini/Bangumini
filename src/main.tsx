import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { tauriFetch, isTauri } from "./api/tauri-fetch";
import { setFetchFunction as setBangumiFetchFunction } from "@shared/api/client";
import { setFetchFunction as setAniListFetchFunction } from "@shared/api/anilist";
import App from "./App";
import "./index.css";

// Set fetch function for API client
if (isTauri()) {
  setBangumiFetchFunction(tauriFetch as typeof fetch);
  setAniListFetchFunction(tauriFetch as typeof fetch);
}

// Disable right-click context menu
document.addEventListener("contextmenu", (e) => e.preventDefault());

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
