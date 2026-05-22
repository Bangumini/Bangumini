import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { tauriFetch, isTauri } from "./api/tauri-fetch";
import { setFetchFunction } from "@shared/api/client";
import App from "./App";
import "./index.css";

// Set fetch function for API client
if (isTauri()) {
  setFetchFunction(tauriFetch as typeof fetch);
}

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
