// OAuth 刷新回归测试（零网络、零依赖，需要 Node ≥ 22.6）
// 运行：node --experimental-strip-types scripts/test-oauth-refresh.mjs
// 只验证实际模块的认证逻辑；内存存储不模拟 WebView2 / LevelDB 损坏。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN_URL = "https://bgm.tv/oauth/access_token";
const ME_URL = "https://api.bgm.tv/v0/me";
const keys = ["bangumi_token", "bangumi_refresh_token", "bangumi_expires_at", "bangumi_username"];
const globalNames = ["localStorage", "window", "fetch", "__APP_VERSION__"];
// 只保存属性描述符，不访问宿主的 localStorage 或实际凭据。
const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let tempDir;
let passed = 0;

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function refreshed(accessToken = "test-access-rotated", refreshToken = "test-refresh-rotated") {
  return jsonResponse({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

try {
  tempDir = await mkdtemp(join(tmpdir(), "bangumini-oauth-test-"));
  const [oauthSource, clientSource] = await Promise.all([
    readFile(new URL("../src/api/oauth.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/api/client.ts", import.meta.url), "utf8"),
  ]);
  let isolatedOAuth = oauthSource;
  for (const dependency of ["tauri-fetch", "auth-diagnostics"]) {
    const specifier = `"./${dependency}"`;
    assert.equal(isolatedOAuth.split(specifier).length, 2, `应找到唯一 ${dependency} 导入`);
    isolatedOAuth = isolatedOAuth.replace(specifier, '"./stubs.mjs"');
  }
  await Promise.all([
    writeFile(join(tempDir, "package.json"), '{"type":"module"}\n'),
    writeFile(join(tempDir, "oauth.ts"), isolatedOAuth),
    // 原样保留 type 导入；Node strip-types 应擦除它，无需复制 types.ts。
    writeFile(join(tempDir, "client.ts"), clientSource),
    writeFile(join(tempDir, "stubs.mjs"), `
export const isTauri = () => true;
export const tauriFetch = (...args) => globalThis.fetch(...args);
export const recordAuthEvent = () => {};
`),
  ]);

  async function test(name, run) {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    };
    const events = new EventTarget();
    const calls = [];
    const queue = [];
    const unexpected = [];
    let invalidations = 0;
    setGlobal("localStorage", storage);
    setGlobal("window", events);
    setGlobal("__APP_VERSION__", "oauth-regression-test");
    // 所有请求都只消耗显式 stub；不存在回退到真实 fetch 的路径。
    const fetchStub = async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (!next || next.url !== url) {
        unexpected.push(String(url));
        throw new Error(`未预期的测试请求：${url}`);
      }
      return typeof next.reply === "function" ? next.reply(init) : next.reply;
    };
    setGlobal("fetch", fetchStub);
    // 每个用例使用独立模块状态，避免 refreshInFlight 等单例互相影响。
    const suffix = `?case=${passed}`;
    const oauth = await import(pathToFileURL(join(tempDir, "oauth.ts")).href + suffix);
    const client = await import(pathToFileURL(join(tempDir, "client.ts")).href + suffix);
    client.setFetchFunction(fetchStub);
    client.setTokenProvider(oauth.getAccessToken);
    client.setAuthInvalidationHandler(oauth.handleAuthInvalidated);
    events.addEventListener(oauth.AUTH_INVALIDATED_EVENT, () => { invalidations += 1; });
    const snapshot = () => keys.map((key) => storage.getItem(key));
    const seed = ({ token = "test-access-old", refresh = "test-refresh-old", expiry = Date.now() - 1000 } = {}) => {
      oauth.setToken(token);
      if (refresh !== null) storage.setItem(keys[1], refresh);
      if (expiry !== null) storage.setItem(keys[2], expiry);
      storage.setItem(keys[3], "test-user");
    };
    try {
      await run({
        oauth, client, storage, calls, seed, snapshot,
        expect: (url, reply) => queue.push({ url, reply }),
        invalidations: () => invalidations,
      });
      assert.deepEqual(unexpected, [], "不应发出未预期请求");
      assert.equal(queue.length, 0, "应消耗全部预期请求");
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (error) {
      throw new Error(`OAuth 回归失败：${name}`, { cause: error });
    }
  }

  await test("refresh URI、表单、token 轮换及有效期持久化", async ({ oauth, seed, expect, calls, snapshot }) => {
    seed();
    expect(TOKEN_URL, refreshed());
    const before = Date.now();
    assert.equal(await oauth.getAccessToken(), "test-access-rotated");
    const after = Date.now();
    const { init } = calls[0];
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/x-www-form-urlencoded");
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "test-refresh-old");
    assert.equal(body.get("redirect_uri"), "http://localhost:19840/callback");
    assert.equal(oauth.AUTH_REFRESH_REDIRECT_URI, body.get("redirect_uri"));
    assert.ok(body.get("client_id"));
    assert.ok(body.get("client_secret"));
    const [token, refresh, expiry, username] = snapshot();
    assert.equal(token, "test-access-rotated");
    assert.equal(refresh, "test-refresh-rotated");
    assert.ok(Number(expiry) >= before + 3600000 && Number(expiry) <= after + 3600000);
    assert.equal(username, "test-user");
    assert.equal(await oauth.getAccessToken(), token);
    // 下一次刷新必须使用已经轮换的 refresh token。
    expect(TOKEN_URL, refreshed("test-access-next", undefined));
    assert.equal((await oauth.refreshAccessToken()).accessToken, "test-access-next");
    assert.equal(new URLSearchParams(calls[1].init.body).get("refresh_token"), refresh);
  });

  await test("响应省略 refresh token 时保留旧值", async ({ oauth, seed, expect, snapshot }) => {
    seed();
    expect(TOKEN_URL, jsonResponse({ access_token: "test-access-new", expires_in: 60 }));
    assert.equal(await oauth.getAccessToken(), "test-access-new");
    assert.equal(snapshot()[1], "test-refresh-old");
  });

  for (const unit of ["seconds", "milliseconds"]) {
    await test(`兼容 ${unit} 有效期，过期才刷新`, async ({ oauth, seed, expect, calls }) => {
      const scale = unit === "seconds" ? 1000 : 1;
      seed({ expiry: Math.floor((Date.now() + 3600000) / scale) });
      assert.equal(await oauth.getAccessToken(), "test-access-old");
      assert.equal(calls.length, 0);
      seed({ expiry: Math.floor((Date.now() - 10000) / scale) });
      expect(TOKEN_URL, refreshed());
      assert.equal(await oauth.getAccessToken(), "test-access-rotated");
    });
  }

  await test("并发过期检查、主动刷新和 401 共用 singleflight", async ({ oauth, seed, expect, calls }) => {
    seed();
    const response = deferred();
    expect(TOKEN_URL, response.promise);
    const pending = [oauth.getAccessToken(), oauth.getAccessToken(), oauth.refreshAccessToken(), oauth.handleAuthInvalidated("test-access-old")];
    assert.equal(calls.length, 1);
    response.resolve(refreshed());
    assert.deepEqual(await Promise.all(pending), [
      "test-access-rotated", "test-access-rotated",
      { ok: true, accessToken: "test-access-rotated" }, true,
    ]);
    assert.equal(calls.length, 1);
  });

  const failures = [
    ["网络错误", "network", "temporary", () => { throw new TypeError("测试断网"); }],
    ["HTTP 503", "server", "temporary", () => new Response("unavailable", { status: 503 })],
    ["HTTP 429", "rate-limited", "temporary", () => jsonResponse({}, 429)],
    ["invalid_client", "invalid-client", "configuration", () => jsonResponse({ error: "invalid_client" }, 401)],
    ["无效 JSON", "invalid-response", "temporary", () => new Response("not json")],
    ["空 JSON", "invalid-response", "temporary", () => jsonResponse(null)],
    ["无效 token 数据", "invalid-response", "temporary", () => jsonResponse({ access_token: "", expires_in: 60 })],
    ["无效有效期", "invalid-response", "temporary", () => jsonResponse({ access_token: "test-new", expires_in: 0 })],
  ];
  for (const [label, reason, kind, reply] of failures) {
    await test(`${label} 保留凭据，失败后允许重新刷新`, async ({ oauth, seed, expect, snapshot, invalidations }) => {
      seed();
      const before = snapshot();
      expect(TOKEN_URL, reply);
      await assert.rejects(oauth.getAccessToken(), (error) => {
        assert.ok(error instanceof oauth.AuthenticationError);
        assert.equal(error.reason, reason);
        assert.equal(error.kind, kind);
        return true;
      });
      assert.deepEqual(snapshot(), before);
      assert.equal(invalidations(), 0);
      expect(TOKEN_URL, refreshed());
      assert.equal(await oauth.getAccessToken(), "test-access-rotated");
    });
  }

  for (const entry of ["expiry", "401"]) {
    await test(`invalid_grant 经 ${entry} 路径清除凭据并通知`, async ({ oauth, seed, expect, snapshot, invalidations }) => {
      seed();
      expect(TOKEN_URL, jsonResponse({ error: "invalid_grant" }, 400));
      if (entry === "expiry") {
        await assert.rejects(oauth.getAccessToken(), { kind: "reauth-required", reason: "invalid-grant" });
      } else {
        assert.equal(await oauth.handleAuthInvalidated("test-access-old"), false);
      }
      assert.deepEqual(snapshot(), [null, null, null, null]);
      assert.equal(invalidations(), 1);
    });
  }

  await test("缺少 refresh token 的过期会话要求重新登录", async ({ oauth, seed, snapshot, calls, invalidations }) => {
    seed({ refresh: null });
    await assert.rejects(oauth.getAccessToken(), { kind: "reauth-required", reason: "missing-refresh-token" });
    assert.deepEqual(snapshot(), [null, null, null, null]);
    assert.equal(calls.length, 0);
    assert.equal(invalidations(), 1);
  });

  await test("迟到 401 和旧 token 清理不能清除新会话", async ({ oauth, seed, snapshot, calls, invalidations }) => {
    seed({ token: "test-new-login", expiry: Date.now() + 3600000 });
    const before = snapshot();
    assert.equal(await oauth.handleAuthInvalidated("test-access-old"), true);
    assert.equal(oauth.clearToken("test-access-old"), false);
    assert.deepEqual(snapshot(), before);
    assert.equal(calls.length, 0);
    assert.equal(invalidations(), 0);
  });

  for (const outcome of ["success", "invalid_grant"]) {
    await test(`迟到 refresh ${outcome} 不覆盖或清除新登录`, async ({ oauth, seed, expect, snapshot, invalidations }) => {
      seed();
      const response = deferred();
      expect(TOKEN_URL, response.promise);
      const pending = oauth.handleAuthInvalidated("test-access-old");
      seed({ token: "test-new-login", refresh: "test-new-login-refresh", expiry: Date.now() + 3600000 });
      const before = snapshot();
      response.resolve(outcome === "success" ? refreshed() : jsonResponse({ error: "invalid_grant" }, 400));
      assert.equal(await pending, outcome === "success");
      assert.deepEqual(snapshot(), before);
      assert.equal(invalidations(), 0);
    });
  }

  await test("退出登录后迟到 refresh 不复活会话", async ({ oauth, seed, expect, snapshot, invalidations }) => {
    seed();
    const response = deferred();
    expect(TOKEN_URL, response.promise);
    const pending = oauth.getAccessToken();
    const rejected = assert.rejects(pending, { kind: "reauth-required" });
    oauth.clearToken();
    response.resolve(refreshed());
    await rejected;
    assert.deepEqual(snapshot(), [null, null, null, null]);
    assert.equal(invalidations(), 1);
  });

  await test("旧 refresh 完成不能移除新会话的 singleflight", async ({ oauth, seed, expect, calls }) => {
    seed();
    const oldResponse = deferred();
    const newResponse = deferred();
    expect(TOKEN_URL, oldResponse.promise);
    const oldPending = oauth.refreshAccessToken();
    seed({ token: "test-new-login", refresh: "test-new-refresh" });
    expect(TOKEN_URL, newResponse.promise);
    const newPending = oauth.refreshAccessToken();
    assert.equal(calls.length, 2);
    oldResponse.resolve(refreshed("test-stale-response"));
    assert.deepEqual(await oldPending, { ok: true, accessToken: "test-new-login" });
    const joined = oauth.refreshAccessToken();
    assert.equal(calls.length, 2);
    newResponse.resolve(refreshed("test-new-rotated"));
    for (const result of await Promise.all([newPending, joined])) {
      assert.deepEqual(result, { ok: true, accessToken: "test-new-rotated" });
    }
  });

  await test("API 401 刷新后使用新 Authorization 重试", async ({ client, seed, expect, calls }) => {
    seed({ expiry: Date.now() + 3600000 });
    expect(ME_URL, jsonResponse({}, 401));
    expect(TOKEN_URL, refreshed());
    expect(ME_URL, jsonResponse({ id: 1, username: "test-user" }));
    assert.deepEqual(await client.getMyself(), { id: 1, username: "test-user" });
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-access-old");
    assert.equal(calls[2].init.headers.Authorization, "Bearer test-access-rotated");
    assert.equal(calls[2].init.headers["User-Agent"], "Bangumini/oauth-regression-test");
  });

  await test("API 迟到 401 直接使用新登录 token 重试", async ({ client, seed, expect, snapshot, calls, invalidations }) => {
    seed({ expiry: Date.now() + 3600000 });
    const started = deferred();
    const response = deferred();
    expect(ME_URL, () => { started.resolve(); return response.promise; });
    const pending = client.getMyself();
    await started.promise;
    seed({ token: "test-new-login", expiry: Date.now() + 3600000 });
    const before = snapshot();
    expect(ME_URL, jsonResponse({ username: "test-user" }));
    response.resolve(jsonResponse({}, 401));
    assert.deepEqual(await pending, { username: "test-user" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.headers.Authorization, "Bearer test-new-login");
    assert.deepEqual(snapshot(), before);
    assert.equal(invalidations(), 0);
  });

  for (const failure of ["network", "503", "invalid_grant"]) {
    await test(`API 401 刷新失败 ${failure} 保留原始 API 错误`, async ({ client, seed, expect, snapshot, calls, invalidations }) => {
      seed({ expiry: Date.now() + 3600000 });
      const before = snapshot();
      expect(ME_URL, new Response("test unauthorized", { status: 401 }));
      expect(TOKEN_URL, () => {
        if (failure === "network") throw new TypeError("测试断网");
        return failure === "503" ? jsonResponse({}, 503) : jsonResponse({ error: "invalid_grant" }, 400);
      });
      await assert.rejects(client.getMyself(), /Bangumi API error 401: test unauthorized/);
      assert.equal(calls.length, 2);
      assert.deepEqual(snapshot(), failure === "invalid_grant" ? [null, null, null, null] : before);
      assert.equal(invalidations(), failure === "invalid_grant" ? 1 : 0);
    });
  }

  await test("API 重试仍为 401 时停止，避免刷新循环", async ({ client, seed, expect, calls }) => {
    seed({ expiry: Date.now() + 3600000 });
    expect(ME_URL, jsonResponse({}, 401));
    expect(TOKEN_URL, refreshed());
    expect(ME_URL, new Response("still unauthorized", { status: 401 }));
    await assert.rejects(client.getMyself(), /Bangumi API error 401: still unauthorized/);
    assert.equal(calls.length, 3);
  });

  await test("API 非 401 错误不触发认证刷新", async ({ client, seed, expect, snapshot, calls, invalidations }) => {
    seed({ expiry: Date.now() + 3600000 });
    const before = snapshot();
    expect(ME_URL, new Response("unavailable", { status: 503 }));
    await assert.rejects(client.getMyself(), /Bangumi API error 503: unavailable/);
    assert.equal(calls.length, 1);
    assert.deepEqual(snapshot(), before);
    assert.equal(invalidations(), 0);
  });

  console.log(`OAuth refresh: ${passed} 项回归测试全部通过 ✓`);
} finally {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
