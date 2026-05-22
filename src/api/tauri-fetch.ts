// HTTP proxy via Tauri Rust command (bypasses WebView CORS)
async function tauriFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init?.headers) {
    const h = init.headers;
    if (h instanceof Headers) {
      h.forEach((v, k) => { headers[k] = v; });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) { headers[k] = v; }
    } else {
      Object.assign(headers, h);
    }
  }

  const { invoke } = await import("@tauri-apps/api/core");

  const result = await invoke<{ status: number; body: string }>("fetch_proxy", {
    req: {
      url,
      method,
      headers,
      body: init?.body?.toString() ?? null,
    },
  });

  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}

// Check if running inside Tauri
export function isTauri(): boolean {
  return !!(globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
}

export async function initTauriFetch() {
  if (isTauri()) {
    (globalThis as Record<string, unknown>).fetch = tauriFetch;
  }
}
