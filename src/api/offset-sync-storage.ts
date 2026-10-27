import { createClient, getPatcher } from "webdav/web";
import { offsetSyncFetch } from "./offset-sync-fetch";

// 只替换 WebDAV SDK 内部 fetch，不触及 Tauri IPC 使用的全局 fetch。
getPatcher().patch("fetch", async (...args: unknown[]) => {
  const [input, init] = args;
  if (!(typeof input === "string" || input instanceof URL || input instanceof Request)
      || (init !== undefined && (init === null || typeof init !== "object"))) {
    throw new Error("同步请求参数无效");
  }
  return offsetSyncFetch(input, init as RequestInit | undefined);
});
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { normalizeOffsetSyncConfig, offsetSyncObjectKey, type OffsetSyncConfig } from "../../shared/offset-sync-config";

export type OffsetSyncRemoteFile = { content: string; etag: string } | null;
export interface OffsetSyncStorage {
  read(signal?: AbortSignal): Promise<OffsetSyncRemoteFile>;
  write(content: string, expectedEtag: string | null, signal?: AbortSignal): Promise<void>;
}
export class OffsetSyncPreconditionError extends Error {
  constructor() { super("远端文件已变化，请重新读取后合并"); this.name = "OffsetSyncPreconditionError"; }
}

class StorageError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.name = "OffsetSyncStorageError"; this.status = status; }
}

const MAX_BYTES = 2 * 1024 * 1024;

function checkLength(length: number | string | null | undefined): void {
  if (length !== null && length !== undefined && Number(length) > MAX_BYTES) {
    throw new StorageError("同步文件超过 2 MiB，已停止读写");
  }
}

function checkedContent(content: string): string {
  let bytes = 0;
  // 不依赖 RN 未必提供的 TextEncoder；孤立 surrogate 按 UTF-8 replacement 的三个字节计算。
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length && content.charCodeAt(i + 1) >= 0xdc00 && content.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
    checkLength(bytes);
  }
  return content;
}

function strongEtag(value: string | null | undefined): string {
  if (!value || !/^"[\x21\x23-\x7e\x80-\xff]+"$/.test(value)) {
    throw new StorageError("远端未提供强 ETag，已停止同步以防止覆盖");
  }
  return value;
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: number; $metadata?: { httpStatusCode?: number } };
  const status = candidate.status ?? candidate.$metadata?.httpStatusCode;
  return typeof status === "number" && status >= 100 && status <= 599 ? status : undefined;
}

export function offsetSyncStorageErrorMessage(error: unknown): string {
  if (error instanceof OffsetSyncPreconditionError) return "远端文件已变化，请重试同步";
  if (error instanceof StorageError) return error.message;
  const status = statusOf(error);
  return status ? `远端存储请求失败（HTTP ${status}）` : "远端存储请求失败，请检查配置或网络后重试";
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StorageError("远端存储请求已取消或超时");
}

async function withDeadline<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  checkSignal(signal);
  const controller = new AbortController();
  let cancel!: () => void;
  const cancellation = new Promise<never>((_, reject) => {
    cancel = () => { reject(new StorageError("远端存储请求已取消或超时")); controller.abort(); };
  });
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 30_000);
  try {
    return await Promise.race([operation(controller.signal), cancellation]);
  } catch (error) {
    if (error instanceof OffsetSyncPreconditionError) throw error;
    throw new StorageError(offsetSyncStorageErrorMessage(error), statusOf(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    // 也终止因不合法 ETag / Content-Length 而提前退出的响应体。
    controller.abort();
  }
}

function boundedStorage(storage: OffsetSyncStorage): OffsetSyncStorage {
  return {
    read: signal => withDeadline(signal, activeSignal => storage.read(activeSignal)),
    write: (content, expectedEtag, signal) => withDeadline(signal, activeSignal => storage.write(content, expectedEtag, activeSignal)),
  };
}

export function createOffsetSyncStorage(input: OffsetSyncConfig, account: string): OffsetSyncStorage {
  const config = normalizeOffsetSyncConfig(input);
  const key = offsetSyncObjectKey(config.prefix, account);
  if (config.provider === "s3") {
    const client = new S3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, sessionToken: config.sessionToken },
      // deadline 包含完整响应体与目录创建，不只等到收到 headers；避免 SDK 的超时定时器在成功后残留。
      requestHandler: new FetchHttpHandler({ customFetch: offsetSyncFetch }),
      maxAttempts: 1,
      // R2 不需要 AWS 新版 SDK 默认附带的 CRC32 checksum。
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    });
    return boundedStorage({
      async read(signal) {
        try {
          const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: signal });
          checkLength(response.ContentLength);
          const etag = strongEtag(response.ETag);
          if (!response.Body) throw new StorageError("远端文件内容读取失败");
          return { content: checkedContent(new TextDecoder("utf-8", { fatal: true }).decode(await response.Body.transformToByteArray())), etag };
        } catch (error) {
          if (statusOf(error) === 404) return null;
          throw new StorageError(offsetSyncStorageErrorMessage(error), statusOf(error));
        }
      },
      async write(content, expectedEtag, signal) {
        checkedContent(content);
        const condition = expectedEtag === null ? { IfNoneMatch: "*" } : { IfMatch: strongEtag(expectedEtag) };
        try {
          await client.send(new PutObjectCommand({
            Bucket: config.bucket, Key: key, Body: content,
            ContentType: "application/json; charset=utf-8", ...condition,
          }), { abortSignal: signal });
        } catch (error) {
          if ([409, 412].includes(statusOf(error) ?? 0)) throw new OffsetSyncPreconditionError();
          throw new StorageError(offsetSyncStorageErrorMessage(error), statusOf(error));
        }
      },
    });
  }
  const client = createClient(config.url, { username: config.username, password: config.password });
  return boundedStorage({
    async read(signal) {
      try {
        const response = await client.customRequest(key, { method: "GET", signal, headers: { Accept: "application/json" } });
        checkLength(response.headers.get("content-length"));
        const etag = strongEtag(response.headers.get("etag"));
        return { content: checkedContent(new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer())), etag };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw new StorageError(offsetSyncStorageErrorMessage(error), statusOf(error));
      }
    },
    async write(content, expectedEtag, signal) {
      checkedContent(content);
      const headers: Record<string, string> = expectedEtag === null ? { "If-None-Match": "*" } : { "If-Match": strongEtag(expectedEtag) };
      try {
        const segments = key.split("/");
        // 逐级 MKCOL；405 表示路径已经存在。不能使用 SDK recursive 分支，其内部 stat 没有透传 signal。
        for (let i = 1; i < segments.length; i++) {
          checkSignal(signal);
          try { await client.createDirectory(segments.slice(0, i).join("/"), { signal }); }
          catch (error) { if (statusOf(error) !== 405) throw error; }
        }
        try {
          checkSignal(signal);
          await client.putFileContents(key, content, {
            signal, overwrite: true, contentLength: false,
            headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
          });
        } catch (error) {
          if ([409, 412].includes(statusOf(error) ?? 0)) throw new OffsetSyncPreconditionError();
          throw error;
        }
      } catch (error) {
        if (error instanceof OffsetSyncPreconditionError) throw error;
        throw new StorageError(offsetSyncStorageErrorMessage(error), statusOf(error));
      }
    },
  });
}
