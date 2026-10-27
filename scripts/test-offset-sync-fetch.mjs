import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

async function load(relative) {
  const file = new URL(relative, import.meta.url);
  let source = ts.transpileModule(await fs.readFile(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const match of [...source.matchAll(/from\s+["']([^"']+)["']/g)]) {
    const specifier = match[1];
    const resolved = specifier.startsWith(".") ? await loadURL(new URL(specifier + ".ts", file)) : import.meta.resolve(specifier);
    source = source.replace(JSON.stringify(specifier), JSON.stringify(resolved));
  }
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
async function loadURL(file) {
  const source = ts.transpileModule(await fs.readFile(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const { createOffsetSyncFetch } = await load("../src/api/offset-sync-fetch.ts");
const calls = [];
let reply = { status: 200, headers: [["etag", '"v1"']], bytes: Array.from(new TextEncoder().encode('{"中文":1}')) };
let onRegister = () => {};
let onFetch = () => reply;
const bridge = createOffsetSyncFetch(async (command, args) => {
  calls.push([command, args]);
  if (command === "offset_sync_register_request") { onRegister(); return; }
  if (command === "offset_sync_fetch") return onFetch(args);
});
const response = await bridge(new Request("https://example.test/sync", { method: "PUT", body: new Blob(['{"中文":1}']), headers: { "If-Match": '"old"' } }));
assert.equal(await response.text(), '{"中文":1}');
assert.equal(response.headers.get("etag"), '"v1"');
const sent = calls.find(([command]) => command === "offset_sync_fetch")[1];
assert.equal(new TextDecoder().decode(new Uint8Array(sent.bytes)), '{"中文":1}');
assert.equal(sent.headers.find(([name]) => name === "if-match")[1], '"old"');
assert.match(sent.requestId, /^[a-f0-9-]{36}$/);
for (const body of [new Uint8Array([123, 125]), new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{}")); c.close(); } })]) {
  await bridge(new Request("https://example.test/sync", { method: "PUT", body, duplex: "half" }));
}
let controller = new AbortController(); controller.abort();
let before = calls.length;
await assert.rejects(bridge("https://example.test", { signal: controller.signal }), { name: "AbortError" });
assert.equal(calls.length, before, "预先取消不得注册或启动 HTTP");
controller = new AbortController(); onRegister = () => controller.abort();
before = calls.filter(([command]) => command === "offset_sync_fetch").length;
await assert.rejects(bridge("https://example.test", { signal: controller.signal }), { name: "AbortError" });
assert.equal(calls.filter(([command]) => command === "offset_sync_fetch").length, before, "预注册期间取消不得启动 PUT");
onRegister = () => {}; controller = new AbortController();
onFetch = () => new Promise(() => { controller.abort(); });
await assert.rejects(bridge("https://example.test", { signal: controller.signal }), { name: "AbortError" });
assert.ok(calls.some(([command]) => command === "offset_sync_cancel_request"));
onFetch = () => { throw new Error("secret-key-in-url"); };
await assert.rejects(bridge("https://example.test"), error => !error.message.includes("secret"));
for (const url of ["http://example.test", "https://user:pass@example.test", "https://example.test/#fragment"]) await assert.rejects(bridge(url));
await assert.rejects(bridge("https://example.test", { method: "DELETE" }));
for (const body of ["not-json", new Uint8Array([255]), JSON.stringify("x".repeat(2 * 1024 * 1024))]) await assert.rejects(bridge("https://example.test", { method: "PUT", body }));
// 注册 IPC 本身挂起时也要及时取消；晚到注册只能清理，不能启动 PUT。
let registerStarted, releaseRegister;
const started = new Promise(resolve => { registerStarted = resolve; });
const registrationGate = new Promise(resolve => { releaseRegister = resolve; });
const registrationCalls = [];
const delayed = createOffsetSyncFetch(async command => {
  registrationCalls.push(command);
  if (command === "offset_sync_register_request") { registerStarted(); await registrationGate; }
});
const delayedController = new AbortController();
const waiting = delayed("https://example.test", { signal: delayedController.signal }).then(() => "unexpected-success", error => error.name);
await started;
delayedController.abort();
const outcome = await Promise.race([waiting, new Promise(resolve => setTimeout(() => resolve("stalled"), 100))]);
releaseRegister();
await waiting;
await new Promise(resolve => setImmediate(resolve));
assert.equal(outcome, "AbortError", "不能等待已取消的注册 IPC 才返回");
assert(registrationCalls.includes("offset_sync_cancel_request"), "晚到的注册必须清理");
assert(!registrationCalls.includes("offset_sync_fetch"), "已取消注册不得发送 HTTP");
console.log("offset-sync-fetch: Request/Blob/bytes/stream, ETag, native seam, cancellation race and redaction passed");
