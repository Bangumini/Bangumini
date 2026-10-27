import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 仅隔离平台 singleton，组件、订阅 hook、配置校验和 React DOM 都运行真实实现。
const require = createRequire(import.meta.url);
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://bangumini.test/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "MouseEvent", "KeyboardEvent"]) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const project = fileURLToPath(new URL("../", import.meta.url));
const modules = new Map();
function load(relative) {
	const path = resolve(project, relative);
	if (modules.has(path)) return modules.get(path).exports;
	const mod = { exports: {} };
	modules.set(path, mod);
	const source = readFileSync(path, "utf8");
	const result = ts.transpileModule(source, { fileName: path, compilerOptions: {
		target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
	} });
	function localRequire(id) {
		if (id === "../api/airing-offset-sync") return { offsetSync: null };
		if (id.startsWith("@shared/")) return load(`shared/${id.slice(8)}.ts`);
		if (id.startsWith(".")) {
			const target = resolve(dirname(path), id);
			return load(target.endsWith(".ts") ? target : `${target}.ts`);
		}
		return require(id);
	}
	new Function("require", "module", "exports", result.outputText)(localRequire, mod, mod.exports);
	return mod.exports;
}
const Settings = load("src/components/AiringOffsetSyncSettings.tsx").default;
const page = readFileSync(resolve(project, "src/pages/SettingsPage.tsx"), "utf8");
assert.match(page, /<AiringOffsetSyncSettings\s*\/>/);
assert.ok(page.indexOf("<AiringOffsetSyncSettings") > page.indexOf("Access Token"));
assert.ok(page.indexOf("<AiringOffsetSyncSettings") < page.indexOf("全局快捷键"));

const secret = "private-password-never-render";
const savedConfig = (account = "alice") => ({ provider: "webdav", autoSync: true, prefix: "bangumini", url: `https://${account}.example/dav`, username: `${account}-private-user`, password: secret });
function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function manager(initial = {}, config = null) {
	let state = { account: "alice", ready: true, enabled: false, configured: Boolean(config), autoSync: config?.autoSync ?? true, phase: "idle", conflicts: [], lastSyncedAt: null, error: null, ...initial };
	const listeners = new Set();
	const calls = [];
	const handlers = {};
	const api = {
		calls, handlers,
		getSnapshot: () => state,
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		publish(patch) { state = { ...state, ...patch }; for (const listener of listeners) listener(); },
		setAccount: async account => api.publish({ account }), setAppActive() {},
		async setEnabled(enabled) {
			calls.push(["enabled", enabled]);
			if (handlers.enabled) return handlers.enabled(enabled);
			api.publish({ enabled, phase: "idle", error: null });
		},
		async getConfig() { calls.push(["get"]); return handlers.get ? handlers.get() : config; },
		async saveConfig(value) {
			calls.push(["save", value]);
			if (handlers.save) await handlers.save(value);
			config = value; api.publish({ configured: true, autoSync: value.autoSync });
		},
		async testConnection(value) { calls.push(["test", value]); return handlers.test ? handlers.test(value) : { exists: true }; },
		async syncNow() { calls.push(["sync"]); if (handlers.sync) await handlers.sync(); },
		async disconnect() { calls.push(["disconnect"]); config = null; api.publish({ configured: false }); },
		async resolveConflict(id, choice) { calls.push(["resolve", id, choice]); if (handlers.resolve) await handlers.resolve(id, choice); },
	};
	return api;
}
let host, root;
async function render(api) {
	if (!host) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
	await act(async () => { root.render(React.createElement(Settings, { manager: api })); });
}
async function reset() {
	if (root) await act(async () => root.unmount());
	host?.remove(); host = null; root = null;
}
const text = () => host.textContent;
function name(element) {
	return element.getAttribute("aria-label") ?? (element.getAttribute("aria-labelledby")?.split(" ").map(id => document.getElementById(id)?.textContent).join(" ")) ?? element.textContent;
}
function button(label) {
	const found = [...host.querySelectorAll("button")].find(element => name(element) === label);
	assert.ok(found, `缺少按钮 ${label}`); return found;
}
function field(label) {
	const found = [...host.querySelectorAll("label")].find(element => element.textContent === label);
	assert.ok(found, `缺少字段 ${label}`); return document.getElementById(found.htmlFor);
}
function disabled(label) { return button(label).matches(":disabled"); }
async function click(label, repeat = 1) {
	const element = button(label);
	assert.equal(element.matches(":disabled"), false, `${label} 不应禁用`);
	await act(async () => { for (let i = 0; i < repeat; i++) element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
async function input(label, value) {
	const element = field(label);
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function publish(api, patch) { await act(async () => api.publish(patch)); }
async function settle(task, value) { await act(async () => task.resolve(value)); }
function noSecrets(...values) { for (const value of [secret, ...values]) assert.ok(!text().includes(value), "凭证不能进入可见文本"); }
let passed = 0;
async function test(label, work) {
	try { await work(); passed++; console.log(`✓ ${label}`); }
	finally { await reset(); }
}

await test("默认关闭不读凭证，开启才恢复；字段掩码、键盘隔离、独立自动同步", async () => {
	const api = manager({}, savedConfig());
	await render(api);
	assert.equal(button("同步").getAttribute("role"), "switch");
	assert.equal(button("同步").getAttribute("aria-checked"), "false");
	assert.equal(host.querySelectorAll("input").length, 0);
	assert.deepEqual(api.calls, []);
	await click("同步");
	assert.equal(field("WebDAV 地址").value, savedConfig().url);
	assert.equal(field("WebDAV 用户名").type, "password");
	assert.equal(field("WebDAV 密码").type, "password");
	assert.equal(disabled("保存配置"), true);
	let escaped = false;
	const listener = () => { escaped = true; };
	window.addEventListener("keydown", listener);
	field("WebDAV 地址").dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
	window.removeEventListener("keydown", listener);
	assert.equal(escaped, false);
	await click("自动同步");
	assert.equal(button("同步").getAttribute("aria-checked"), "true");
	assert.equal(disabled("立即同步"), true);
	await click("保存配置");
	assert.equal(api.calls.find(call => call[0] === "save")[1].autoSync, false);
	assert.equal(api.calls.filter(call => call[0] === "enabled").length, 1);
	noSecrets(savedConfig().username);
});

await test("未登录或恢复未完成禁止操作与挂载", async () => {
	const api = manager({ account: null, enabled: true, ready: false }, savedConfig());
	await render(api); assert.equal(disabled("同步"), true); assert.equal(host.querySelector("input"), null);
	await publish(api, { account: "alice" }); assert.equal(disabled("同步"), true); assert.equal(host.querySelector("input"), null);
	assert.deepEqual(api.calls, []);
	await publish(api, { ready: true }); assert.equal(field("WebDAV 密码").value, secret);
	await publish(api, { ready: false }); assert.equal(host.querySelector("input"), null);
});

await test("配置验证、HTTPS、防重复保存与只读连接测试", async () => {
	const api = manager({ enabled: true });
	await render(api); assert.equal(disabled("保存配置"), true); assert.equal(disabled("测试读取连接（只读）"), true);
	await input("WebDAV 地址", "http://insecure.example/dav");
	await input("WebDAV 用户名", "private-login"); await input("WebDAV 密码", secret);
	assert.equal(disabled("保存配置"), true);
	await input("WebDAV 地址", "https://private:password@example.test/dav"); assert.equal(disabled("保存配置"), true);
	await input("WebDAV 地址", "https://example.test/dav/");
	await input("存储目录前缀", "../invalid"); assert.equal(disabled("保存配置"), true);
	await input("存储目录前缀", " bangumini/subdir ");
	const saving = deferred(); api.handlers.save = () => saving.promise;
	await click("保存配置", 2);
	assert.equal(api.calls.filter(call => call[0] === "save").length, 1);
	assert.equal(disabled("测试读取连接（只读）"), true);
	assert.equal(field("WebDAV 地址").matches(":disabled"), true);
	assert.equal(disabled("同步"), false);
	await settle(saving);
	const stored = api.calls.find(call => call[0] === "save")[1];
	assert.equal(stored.url, "https://example.test/dav"); assert.equal(stored.prefix, "bangumini/subdir");
	assert.equal(disabled("保存配置"), true);
	await click("测试读取连接（只读）"); assert.match(text(), /已读取偏置文件；未验证写权限/);
	assert.equal(api.calls.filter(call => call[0] === "sync").length, 0);
	api.handlers.test = async () => ({ exists: false });
	await click("测试读取连接（只读）"); assert.match(text(), /未找到偏置文件；未验证写权限/);
	noSecrets("private-login");
});

await test("协议切换、S3/R2 字段、可选临时凭证、path-style 与保存", async () => {
	const api = manager({ enabled: true }, savedConfig()); await render(api);
	await click("S3 / R2");
	assert.equal(host.querySelectorAll("input[type=password]").length, 3);
	assert.equal(host.querySelector("label")?.textContent, "S3 Endpoint");
	assert.equal(field("S3 Region").value, "auto");
	assert.equal(button("S3 forcePathStyle").getAttribute("aria-checked"), "true");
	await input("S3 Endpoint", "https://test-account.r2.cloudflarestorage.com");
	await input("S3 Bucket", "private-bucket");
	await input("S3 Access Key ID", "private-key-id");
	await input("S3 Secret Access Key", secret); await input("S3 Session Token（可选）", "private-session");
	await click("S3 forcePathStyle"); await click("保存配置");
	const stored = api.calls.find(call => call[0] === "save")[1];
	assert.equal(stored.provider, "s3"); assert.equal(stored.region, "auto"); assert.equal(stored.forcePathStyle, false);
	assert.equal(stored.sessionToken, "private-session"); assert.ok(!("password" in stored));
	await click("立即同步"); assert.equal(api.calls.filter(call => call[0] === "sync").length, 1);
	await click("WebDAV"); assert.equal(field("WebDAV 密码").value, "");
	await click("S3 / R2"); assert.equal(field("S3 Secret Access Key").value, "");
	noSecrets("private-key-id", "private-session");
});

await test("逐条冲突选择与断开同步", async () => {
	const record = days => ({ days, revision: `rev-${days}`, updatedAt: 1 });
	const api = manager({ enabled: true, phase: "conflict", conflicts: [
		{ subjectId: 1, local: record(0), remote: record(7) }, { subjectId: 2, local: record(-1), remote: record(1) },
	] }, savedConfig());
	await render(api); assert.match(text(), /冲突：2 条/); assert.match(text(), /0 天/);
	await click("条目 1：保留本机"); await click("条目 2：采用远端");
	assert.deepEqual(api.calls.filter(call => call[0] === "resolve"), [["resolve", 1, "local"], ["resolve", 2, "remote"]]);
	await click("断开同步"); assert.equal(field("WebDAV 密码").value, "");
	assert.equal(disabled("立即同步"), true); assert.match(text(), /本地偏置和远端文件均保留/);
});

await test("同步中仍可关闭，关闭立即卸载表单、保留配置且拒绝迟到反馈", async () => {
	const api = manager({ enabled: true }, savedConfig()); const syncing = deferred();
	api.handlers.sync = () => { api.publish({ phase: "syncing" }); return syncing.promise; };
	await render(api); await click("立即同步"); assert.match(text(), /同步中/);
	assert.equal(disabled("保存配置"), true); assert.equal(disabled("同步"), false);
	await click("同步"); assert.equal(host.querySelector("input"), null);
	assert.equal(button("同步").getAttribute("aria-checked"), "false");
	await settle(syncing); assert.ok(!text().includes("同步请求已完成"));
	await click("同步"); assert.equal(field("WebDAV 密码").value, secret);
	assert.ok(!text().includes("同步请求已完成"));
});

await test("关闭取消挂载及只读操作；重新开启不接受旧凭证与反馈", async () => {
	const api = manager({ enabled: true }, savedConfig()); const oldRead = deferred();
	api.handlers.get = () => oldRead.promise; await render(api);
	await click("同步"); assert.equal(host.querySelector("input"), null);
	api.handlers.get = async () => savedConfig("fresh"); await click("同步");
	await settle(oldRead, savedConfig("stale"));
	assert.equal(field("WebDAV 地址").value, savedConfig("fresh").url);
	const reading = deferred(); api.handlers.test = () => reading.promise;
	await click("测试读取连接（只读）"); assert.equal(disabled("同步"), false);
	await click("同步"); assert.equal(host.querySelector("input"), null);
	await settle(reading, { exists: true }); assert.ok(!text().includes("已读取偏置文件"));
	assert.deepEqual(api.calls.filter(call => call[0] === "enabled"), [["enabled", false], ["enabled", true], ["enabled", false]]);
});

await test("账号切换、迟到凭证与旧账号操作反馈不能泄露", async () => {
	const api = manager({ enabled: true }, savedConfig()); const oldRead = deferred();
	api.handlers.get = () => oldRead.promise; await render(api); assert.match(text(), /正在读取/);
	api.handlers.get = async () => savedConfig("bob");
	await publish(api, { account: "bob" }); assert.equal(field("WebDAV 地址").value, savedConfig("bob").url);
	await settle(oldRead, savedConfig("alice")); assert.equal(field("WebDAV 地址").value, savedConfig("bob").url);
	const oldTest = deferred(); api.handlers.test = () => oldTest.promise;
	await click("测试读取连接（只读）");
	await publish(api, { account: "carol" });
	await act(async () => oldTest.reject(new Error(`Authorization ${secret}`)));
	assert.ok(!text().includes("读取连接失败")); noSecrets("alice-private-user");
});

await test("同账号更换 manager 立即卸载旧凭证、旧锁与迟到反馈", async () => {
	const first = manager({ enabled: true }, savedConfig("alice")); const late = deferred();
	first.handlers.get = () => late.promise; await render(first);
	const second = manager({ enabled: true }, savedConfig("second")); await render(second);
	assert.equal(field("WebDAV 地址").value, savedConfig("second").url);
	await settle(late, savedConfig("alice")); assert.equal(field("WebDAV 地址").value, savedConfig("second").url);
	const oldToggle = deferred(); second.handlers.enabled = () => oldToggle.promise;
	await click("同步"); assert.equal(disabled("同步"), true);
	const third = manager({}, savedConfig("third")); await render(third); assert.equal(disabled("同步"), false);
	await act(async () => oldToggle.reject(new Error(secret)));
	assert.ok(!text().includes("开关保存失败")); assert.equal(host.querySelector("input"), null);
});

await test("配置读取失败可重试、开关保存失败与保存期间锁", async () => {
	const api = manager({ enabled: true }, savedConfig()); api.handlers.get = async () => { throw new Error(secret); };
	await render(api); assert.match(text(), /读取安全配置失败/); assert.equal(host.querySelector("input"), null); noSecrets();
	api.handlers.get = async () => savedConfig(); await click("重试读取配置"); assert.equal(field("WebDAV 密码").value, secret);
	const toggling = deferred(); api.handlers.enabled = () => toggling.promise;
	await click("同步", 2); assert.equal(api.calls.filter(call => call[0] === "enabled").length, 1);
	assert.equal(disabled("同步"), true);
	await act(async () => toggling.reject(new Error(secret))); assert.equal(disabled("同步"), false);
	assert.match(text(), /同步开关保存失败，请重试/); noSecrets();
	delete api.handlers.enabled; await click("同步"); assert.equal(host.querySelector("input"), null); assert.ok(!text().includes("保存失败"));
	api.handlers.enabled = async () => { throw new Error(secret); }; await click("同步");
	assert.equal(host.querySelector("input"), null); assert.equal(button("同步").getAttribute("aria-checked"), "false"); noSecrets();
});

await test("公开状态与操作异常均不渲染秘密；失败后可以重试", async () => {
	const api = manager({ enabled: true, error: `https://user:${secret}@example.test?token=private-session`, phase: "error" }, savedConfig());
	await render(api); assert.match(text(), /同步未完成/); noSecrets("private-session");
	for (const [label, method] of [["测试读取连接（只读）", "test"], ["立即同步", "sync"]]) {
		api.handlers[method] = async () => { throw new Error(secret); };
		await click(label); assert.match(text(), /失败，请检查配置或网络后重试/); noSecrets(); delete api.handlers[method];
	}
	await input("WebDAV 密码", "new-private-secret");
	api.handlers.save = async () => { throw new Error("new-private-secret"); }; await click("保存配置");
	assert.match(text(), /保存配置失败/); noSecrets("new-private-secret");
	delete api.handlers.save; await click("保存配置"); assert.match(text(), /配置已保存/);
});

console.log(`通过 ${passed} 项真实 React DOM 同步设置回归。`);
dom.window.close();
