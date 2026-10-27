import { invoke } from "@tauri-apps/api/core";

type NativeReply = { status: number; headers: [string, string][]; bytes: number[] };
export type OffsetSyncInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
const MAX_BYTES = 2 * 1024 * 1024;
const abortError = () => new DOMException("同步请求已取消或超时", "AbortError");

/** 仅供个人偏置 SDK 使用；不修改 window.fetch，也不复用通用 fetch_proxy。 */
export function createOffsetSyncFetch(nativeInvoke: OffsetSyncInvoke = invoke): typeof fetch {
  return async (input, init) => {
    let request: Request;
    try { request = new Request(input, init); }
    catch { throw new Error("同步请求参数无效"); }
    if (request.signal.aborted) throw abortError();
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !["GET", "PUT", "MKCOL"].includes(request.method)) {
      throw new Error("同步请求地址或方法不受支持");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    const cancellation = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    let registered = false;
    const requestId = crypto.randomUUID();
    const cancelNative = () => { void nativeInvoke("offset_sync_cancel_request", { requestId }).catch(() => {}); };
    try {
      // SDK 的 FetchHttpHandler 传入 Request；不能只读取 init.body。
      const bytes = await Promise.race([
        request.arrayBuffer().then(buffer => new Uint8Array(buffer)),
        cancellation,
      ]);
      if (bytes.length > MAX_BYTES) throw new Error("同步文件超过 2 MiB，已停止读写");
      if (bytes.length) {
        try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new Error("同步上传内容必须为 UTF-8 JSON"); }
      }
      if (controller.signal.aborted) throw abortError();
      const registration = nativeInvoke("offset_sync_register_request", { requestId }).then(() => {
        registered = true;
        // IPC 回复晚于取消时仍清理原生注册，但不再等待它或启动 HTTP。
        if (controller.signal.aborted) cancelNative();
      });
      await Promise.race([registration, cancellation]);
      // 先注册再挂接取消；注册期间取消则绝不启动 HTTP。原生保留取消标记以处理 IPC 顺序竞态。
      controller.signal.addEventListener("abort", cancelNative, { once: true });
      if (controller.signal.aborted) throw abortError();
      const reply = await Promise.race([
        nativeInvoke<NativeReply>("offset_sync_fetch", {
          requestId, url: request.url, method: request.method,
          headers: Array.from(request.headers.entries()), bytes: Array.from(bytes),
        }),
        cancellation,
      ]);
      if (controller.signal.aborted) throw abortError();
      if (reply.bytes.length > MAX_BYTES) throw new Error("同步文件超过 2 MiB，已停止读写");
      return new Response([204, 205, 304].includes(reply.status) ? null : new Uint8Array(reply.bytes), {
        status: reply.status, headers: reply.headers,
      });
    } catch (error) {
      if (controller.signal.aborted) throw abortError();
      // IPC / SDK 原始错误可能包含签名 URL 或凭证，不向 UI 透传。
      if (error instanceof Error && ["同步文件超过 2 MiB，已停止读写", "同步上传内容必须为 UTF-8 JSON"].includes(error.message)) throw error;
      // eslint-disable-next-line preserve-caught-error -- cause 也可能含签名 URL / 密钥，必须在 IPC 边界丢弃。
      throw new Error("同步网络请求失败，请检查配置或网络");
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cancelNative);
      if (registered) cancelNative();
    }
  };
}

export const offsetSyncFetch = createOffsetSyncFetch();
