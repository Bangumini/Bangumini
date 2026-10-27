// 构建并执行实际 Vite browser 入口；不能用 Node SDK 入口或默认 fetch 掩盖 WebView 兼容问题。
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = "virtual:offset-sync-browser-test";
const result = await build({
  root, logLevel: "error",
  plugins: [{ name: "offset-sync-browser-fixture", enforce: "pre", resolveId: id => id === entry || id.endsWith("/" + entry) ? "\0" + entry : null,
    load: id => id === "\0" + entry ? `
      export { createOffsetSyncStorage, offsetSyncStorageErrorMessage } from ${JSON.stringify(root + "src/api/offset-sync-storage.ts")};
      export { parseOffsetSyncDocument, createOffsetSyncDocument, mergeOffsetSyncRecords } from ${JSON.stringify(root + "shared/airing-offset-sync.ts")};
      export { offsetSyncObjectKey } from ${JSON.stringify(root + "shared/offset-sync-config.ts")};
    ` : null }],
  build: { write: false, emptyOutDir: false, minify: false, target: "es2022", sourcemap: false,
    lib: { entry, formats: ["iife"], name: "DesktopOffsetRuntime" } },
});
const outputs = Array.isArray(result) ? result : [result];
const code = outputs.flatMap(item => item.output).filter(item => item.type === "chunk").map(item => item.code).join("\n");
assert(code.includes("DesktopOffsetRuntime"));
let fetches = 0, version = 1, forcedStatus = null;
const requests = [], registered = new Set(), remote = new Map();
const encoder = new TextEncoder();
const reply = (status, content = "", headers = []) => ({ status, bytes: Array.from(encoder.encode(content)), headers });
const context = vm.createContext({
  console: { ...console, warn: () => {} },
  URL, URLSearchParams, Headers, Request, Response, Blob, ReadableStream, WritableStream, TransformStream,
  TextEncoder, TextDecoder, AbortController, AbortSignal, DOMException,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  crypto: webcrypto, performance,
  navigator: { userAgent: "Mozilla/5.0 Chrome/130.0.0.0", platform: "Win32", language: "zh-CN" },
  location: new URL("https://tauri.localhost"),
  fetch: async () => { fetches++; throw Error("SDK 不得绕过 Tauri transport"); },
  __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === "offset_sync_register_request") { registered.add(args.requestId); return; }
    if (command === "offset_sync_cancel_request") { registered.delete(args.requestId); return; }
    assert.equal(command, "offset_sync_fetch");
    assert(registered.has(args.requestId), "实际 browser bundle 也必须先注册再发送 HTTP");
    assert(new URL(args.url).protocol === "https:");
    requests.push(args);
    const headers = new Headers(args.headers);
    const key = decodeURIComponent(new URL(args.url).pathname).split("bangumini/")[1];
    if (args.method === "MKCOL") return reply(405);
    if (forcedStatus) return reply(forcedStatus);
    const current = remote.get(key);
    if (args.method === "GET") return current
      ? reply(200, current.content, [["etag", current.etag], ["content-type", "application/json; charset=utf-8"]])
      : reply(404);
    assert.equal(args.method, "PUT");
    assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
    if (current ? headers.get("if-match") !== current.etag : headers.get("if-none-match") !== "*") return reply(412);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(args.bytes));
    const next = { content, etag: `"browser-${version++}"` };
    remote.set(key, next);
    return reply(200, "", [["etag", next.etag]]);
  } },
});
vm.runInContext("globalThis.window = globalThis; globalThis.self = globalThis;", context);
vm.runInContext(code, context, { timeout: 20_000 });
const api = context.DesktopOffsetRuntime;
assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
assert.equal(vm.runInContext("typeof process", context), "undefined");
const account = "Alice";
const config = {
  webdav: { provider: "webdav", autoSync: false, prefix: "bangumini", url: "https://dav.test/root", username: "fake-user", password: "fake-password" },
  s3: { provider: "s3", autoSync: false, prefix: "bangumini", endpoint: "https://r2.test", region: "auto", bucket: "fake-bucket",
    accessKeyId: "fake-access", secretAccessKey: "fake-secret", sessionToken: "fake-session", forcePathStyle: true },
};
const document = records => JSON.stringify({ schemaVersion: 1, kind: "bangumini-airing-offsets", account, records });
const record = (days, revision) => ({ days, revision, updatedAt: 1 });
const records = text => api.parseOffsetSyncDocument(text, account).records;
// 与手机协议完全相同的记录，包含恢复默认 tombstone，而不是展示层的稀疏 offsetMap。
const phoneDocument = document({ 1: record(-7, "phone-edit"), 2: record(0, "phone-reset") });
for (const provider of ["webdav", "s3"]) {
  remote.clear(); requests.length = 0;
  const storage = api.createOffsetSyncStorage(config[provider], account);
  assert.equal(await storage.read(), null);
  await storage.write(phoneDocument, null);
  const first = await storage.read();
  assert.equal(first.content, phoneDocument);
  assert.equal(api.parseOffsetSyncDocument(first.content, account).records[2].days, 0);
  const local = records(document({ 1: record(-7, "phone-edit"), 2: record(0, "phone-reset"), 3: record(2, "desktop-edit") }));
  const merged = api.mergeOffsetSyncRecords(records(phoneDocument), local, records(first.content));
  assert.equal(merged.conflicts.length, 0);
  const upload = JSON.stringify(api.createOffsetSyncDocument(account, merged.remote));
  await storage.write(upload, first.etag);
  const second = await storage.read();
  assert.equal(api.parseOffsetSyncDocument(second.content, account).records[3].days, 2);
  assert.equal(api.parseOffsetSyncDocument(second.content, account).records[2].revision, "phone-reset");
  await assert.rejects(storage.write(upload, first.etag), /远端文件已变化/);
  if (provider === "s3") {
    const put = requests.find(request => request.method === "PUT");
    const headers = new Headers(put.headers);
    assert.match(headers.get("authorization"), /^AWS4-HMAC-SHA256 /);
    assert.equal(headers.get("x-amz-security-token"), "fake-session");
    assert.equal(headers.get("x-amz-content-sha256"), createHash("sha256").update(new Uint8Array(put.bytes)).digest("hex"));
  } else {
    assert(requests.some(request => request.method === "MKCOL"));
    assert.match(new Headers(requests.find(request => request.method === "GET").headers).get("authorization"), /^Basic /);
  }
  forcedStatus = 403;
  await assert.rejects(storage.read(), error => api.offsetSyncStorageErrorMessage(error).includes("403"));
  forcedStatus = null;
  const stopped = new AbortController(); stopped.abort();
  const count = requests.length;
  await assert.rejects(storage.write(upload, second.etag, stopped.signal));
  assert.equal(requests.length, count);
}
// 同一真实云端对象可被两个不同 SDK adapter 读取，账号编码不能在 transport 中再次解释。
remote.clear();
const dav = api.createOffsetSyncStorage(config.webdav, account), s3 = api.createOffsetSyncStorage(config.s3, account);
await dav.write(phoneDocument, null);
assert.equal((await s3.read()).content, phoneDocument);
const special = "中文%账户";
assert.equal(api.offsetSyncObjectKey("bangumini", special), `bangumini/accounts/${encodeURIComponent(special)}/airing-offsets.v1.json`);
const escaped = api.createOffsetSyncStorage(config.s3, special);
await escaped.write(JSON.stringify({ note: "UTF-8 读回检查" }), null);
assert.equal((await escaped.read()).content, JSON.stringify({ note: "UTF-8 读回检查" }));
assert.equal(fetches, 0);
assert.equal(registered.size, 0);
console.log("desktop offset runtime: 实际 Vite browser bundle / 无 Node 全局 / WebDAV / S3 签名 / CAS / 手机协议与 tombstone / 自定义 Tauri bridge 通过 ✓");
