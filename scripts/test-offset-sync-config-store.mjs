import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
import { createHash } from "node:crypto";

async function moduleURL(file) {
  let source = ts.transpileModule(await fs.readFile(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const match of [...source.matchAll(/from\s+["']([^"']+)["']/g)]) {
    const specifier = match[1];
    const resolved = specifier.startsWith(".") ? await moduleURL(new URL(specifier + ".ts", file)) : import.meta.resolve(specifier);
    source = source.replace(JSON.stringify(specifier), JSON.stringify(resolved));
  }
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const { createOffsetSyncConfigStore, offsetSyncConfigStore } = await import(await moduleURL(new URL("../src/api/offset-sync-config-store.ts", import.meta.url)));
const entries = new Map();
const hash = value => createHash("sha256").update(value).digest("hex");
let generation = 0, failKey = () => false;
let concurrent = 0, maxConcurrent = 0;
const deps = {
  async getItem(key) { return entries.get(key) ?? null; },
  async setItem(key, value) {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (failKey(key)) throw new Error("sensitive native error");
      assert.ok(Buffer.byteLength(value, "utf8") <= 2000, "必须低于 Windows CredentialBlob 安全上限");
      entries.set(key, value);
    } finally { concurrent--; }
  },
  async deleteItem(key) { entries.delete(key); },
  async hash(value) { return hash(value); },
  randomId: () => `generation-${++generation}`,
};
const config = { provider: "s3", autoSync: false, prefix: "bangumini", endpoint: "https://s3.example.test", bucket: "bucket", region: "auto", forcePathStyle: true, accessKeyId: "access", secretAccessKey: "秘密", sessionToken: "临时😀".repeat(1500) };
const store = createOffsetSyncConfigStore(deps);
assert.equal(await store.get("alice"), null);
await store.set("alice", config);
assert.equal((await store.get("alice")).sessionToken, config.sessionToken);
assert.ok(entries.size > 10, "大 sessionToken 必须分块而不截断");
assert.ok([...entries.keys()].every(key => !key.includes("alice")));
assert.equal(await store.get("bob"), null);
const oldHead = entries.get(`bangumini_offset_sync.${hash("alice")}.head`);
for (const fail of [key => key.includes(".generation-2.2"), key => key.endsWith(".head")]) {
  failKey = fail;
  await assert.rejects(store.set("alice", { ...config, secretAccessKey: "new" }), error => !error.message.includes("sensitive"));
  assert.equal(entries.get(`bangumini_offset_sync.${hash("alice")}.head`), oldHead);
  assert.equal((await store.get("alice")).secretAccessKey, "秘密");
}
failKey = () => false;
await assert.rejects(store.set("alice", { ...config, sessionToken: "x".repeat(30_000) }));
assert.equal((await store.get("alice")).secretAccessKey, "秘密");
await Promise.all([store.set("bob", { ...config, sessionToken: "b" }), store.set("alice", { ...config, sessionToken: "a" })]);
assert.equal(maxConcurrent, 1, "同 store 保存必须串行");
assert.equal((await store.get("alice")).sessionToken, "a");
assert.equal((await store.get("bob")).sessionToken, "b");
await store.delete("alice");
assert.equal(await store.get("alice"), null);
assert.ok(await store.get("bob"));
const headKey = `bangumini_offset_sync.${hash("bob")}.head`;
const head = JSON.parse(entries.get(headKey));
entries.delete(`bangumini_offset_sync.${hash("bob")}.${head.generation}.0`);
await assert.rejects(store.get("bob"), /无法读取安全存储/);
await store.delete("bob");
assert.equal(await store.get("bob"), null);
// 默认实例只能调用原生安全存储；没有 browser localStorage fallback。
globalThis.window = { __TAURI_INTERNALS__: { invoke: async () => { throw new Error("native unavailable secret"); } } };
await assert.rejects(offsetSyncConfigStore.get("alice"), error => /安全存储/.test(error.message) && !error.message.includes("secret"));
console.log("offset-sync-config-store: large UTF-8 credentials, atomic manifest, failure preservation, isolation, serial writes and no fallback passed");
