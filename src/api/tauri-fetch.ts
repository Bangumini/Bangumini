// HTTP proxy via Tauri Rust command (bypasses WebView CORS)
export async function tauriFetch(
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

  // 204 No Content and other null body statuses cannot have a body
  const hasBody = result.status !== 204 && result.status !== 205 && result.status !== 304;
  return new Response(hasBody ? result.body : null, {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}

// Check if running inside Tauri
export function isTauri(): boolean {
  return !!(globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
}

// DO NOT override global fetch - it breaks Tauri IPC
export async function initTauriFetch() {
  // No-op: we export tauriFetch directly instead of overriding global fetch
}
