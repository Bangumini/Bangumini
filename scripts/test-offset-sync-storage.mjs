import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

async function moduleURL(file) {
  let source = ts.transpileModule(await fs.readFile(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const match of [...source.matchAll(/from\s+["']([^"']+)["']/g)]) {
    const specifier = match[1];
    const resolved = specifier.startsWith(".") ? await moduleURL(new URL(specifier + ".ts", file)) : import.meta.resolve(specifier);
    source = source.replace(JSON.stringify(specifier), JSON.stringify(resolved));
  }
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
// 若 SDK 绕过专用 bridge 而落到 Node 默认 fetch，测试必须立即失败。
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("FORBIDDEN_GLOBAL_FETCH"); };
const calls = [], registrations = new Set();
let remote = null, etag = '"v1"', forcedStatus = null, weak = false, overlong = false, invalidUtf8 = false, onMkcol = () => {};
const body = text => Array.from(new TextEncoder().encode(text));
globalThis.window = { fetch: globalThis.fetch, Headers, Request, Response, __TAURI_INTERNALS__: { invoke: async (command, args) => {
  if (command === "offset_sync_register_request") { registrations.add(args.requestId); return; }
  if (command === "offset_sync_cancel_request") { registrations.delete(args.requestId); return; }
  assert.equal(command, "offset_sync_fetch");
  assert.ok(registrations.has(args.requestId), "必须经原生预注册 seam");
  calls.push(args);
  const headers = new Headers(args.headers);
  const reply = (status, content = "", extra = []) => ({ status, headers: extra, bytes: body(content) });
  if (args.method === "MKCOL") { onMkcol(); return reply(405); }
  if (forcedStatus) return reply(forcedStatus, "");
  if (args.method === "GET") {
    if (remote === null) return reply(404);
    return { status: 200, headers: [["content-type", "application/json"], ["etag", weak ? 'W/"v1"' : etag], ...(overlong ? [["content-length", "2097153"]] : [])], bytes: invalidUtf8 ? [255] : body(remote) };
  }
  assert.equal(args.method, "PUT");
  assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
  const condition = headers.get("if-match");
  if (remote === null ? headers.get("if-none-match") !== "*" : condition !== etag) return reply(412);
  remote = new TextDecoder().decode(new Uint8Array(args.bytes));
  etag = '"v2"';
  return reply(200, "", [["etag", etag]]);
} } };
const { createOffsetSyncStorage, OffsetSyncPreconditionError, offsetSyncStorageErrorMessage } = await import(await moduleURL(new URL("../src/api/offset-sync-storage.ts", import.meta.url)));
const configs = [
  { provider: "webdav", autoSync: false, prefix: "bangumini", url: "https://webdav.example.test/root", username: "user", password: "secret" },
  { provider: "s3", autoSync: false, prefix: "bangumini", endpoint: "https://s3.example.test", region: "auto", bucket: "bucket", forcePathStyle: true, accessKeyId: "test-access", secretAccessKey: "test-secret", sessionToken: "test-token" },
];
try {
  for (const config of configs) {
    remote = null; etag = '"v1"'; calls.length = 0;
    const storage = createOffsetSyncStorage(config, "中文%alice");
    assert.equal(await storage.read(), null);
    const content = JSON.stringify({ account: "中文%alice", records: { 1: { days: 7 } } });
    await storage.write(content, null);
    const loaded = await storage.read();
    assert.equal(loaded.content, content); assert.equal(loaded.etag, '"v2"');
    await storage.write(content, loaded.etag);
    await assert.rejects(storage.write(content, '"old"'), OffsetSyncPreconditionError);
    for (const status of [401, 403, 500]) {
      forcedStatus = status;
      await assert.rejects(storage.read(), error => offsetSyncStorageErrorMessage(error).includes(String(status)));
    }
    for (const status of [409, 412]) {
      forcedStatus = status;
      await assert.rejects(storage.write(content, '"v2"'), OffsetSyncPreconditionError);
    }
    forcedStatus = null; weak = true;
    await assert.rejects(storage.read(), /ETag/); weak = false;
    overlong = true; await assert.rejects(storage.read(), /2 MiB/); overlong = false;
    invalidUtf8 = true; await assert.rejects(storage.read()); invalidUtf8 = false;
    await assert.rejects(storage.write(JSON.stringify("😀".repeat(600_000)), '"v2"'), /2 MiB/);
    const before = calls.length;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(storage.write(content, '"v2"', controller.signal));
    assert.equal(calls.length, before);
    for (const call of calls.filter(call => call.method !== "MKCOL")) assert.ok(decodeURIComponent(new URL(call.url).pathname).includes("accounts/%E4%B8%AD%E6%96%87%25alice/airing-offsets.v1.json"), "不得重复解释账号编码");
    if (config.provider === "s3") {
      const signed = calls.find(call => call.method === "PUT");
      assert.match(new Headers(signed.headers).get("authorization"), /^AWS4-HMAC-SHA256 /);
      assert.equal(new Headers(signed.headers).get("x-amz-security-token"), "test-token");
    } else {
      assert.ok(calls.some(call => call.method === "MKCOL"));
      assert.match(new Headers(calls[0].headers).get("authorization"), /^Basic /);
      const controller = new AbortController(); onMkcol = () => controller.abort();
      const before = calls.filter(call => call.method === "PUT").length;
      await assert.rejects(storage.write(content, '"v2"', controller.signal));
      assert.equal(calls.filter(call => call.method === "PUT").length, before, "目录创建后切账号必须停止 PUT");
      onMkcol = () => {};
    }
  }
  assert.ok(!offsetSyncStorageErrorMessage(new Error("https://user:secret@example.test")).includes("secret"));
  console.log("offset-sync-storage: real WebDAV/browser + S3 SDK → custom fetch → Rust IPC seam, signing, CAS, ETag, UTF-8, limits, MKCOL cancellation passed");
} finally { globalThis.fetch = originalFetch; }
