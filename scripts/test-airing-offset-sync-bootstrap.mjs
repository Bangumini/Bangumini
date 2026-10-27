// 真实 React DOM：恢复屏障不卸载路由、不等待远端，并覆盖桌面焦点生命周期。
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createMemoryRouter, RouterProvider, useLocation } = require("react-router-dom");
const { JSDOM } = require("jsdom");
const ts = require("typescript");
const { act } = React;
const dom = new JSDOM('<div id="root"></div>', { url: "https://desktop.test", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Event", "KeyboardEvent", "localStorage"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(document, "hasFocus", { value: () => true });
const dir = await mkdtemp(join(tmpdir(), "desktop-offset-bootstrap-"));
const root = new URL("../", import.meta.url);
const url = name => pathToFileURL(join(dir, name)).href;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const profile = deferred();
let cachedName = "Alice", profileCalls = 0, mounts = 0, unmounts = 0, oldShortcuts = 0;
let nativeFocus = null, removed = 0, tauried = false;
const registration = deferred();
globalThis.__offsetBootstrap = {
  fetchProfile: () => { profileCalls++; return profile.promise; },
  getName: () => cachedName,
  isTauri: () => tauried,
  window: { onFocusChanged: callback => { nativeFocus = callback; return registration.promise; } },
};
await writeFile(join(dir, "stubs.mjs"), `
export const fetchAndCacheUsername = () => globalThis.__offsetBootstrap.fetchProfile();
export const getUsername = () => globalThis.__offsetBootstrap.getName();
export const getCurrentWindow = () => globalThis.__offsetBootstrap.window;
export const isTauri = () => globalThis.__offsetBootstrap.isTauri();
export const offsetSync = null;
`);
async function compile(path, name, modules = {}) {
  let source = await readFile(new URL(path, root), "utf8");
  for (const [from, to] of Object.entries({ react: pathToFileURL(require.resolve("react")).href, ...modules })) {
    source = source.replaceAll(JSON.stringify(from), JSON.stringify(to));
  }
  await writeFile(join(dir, name), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText.replaceAll("React.createElement", "globalThis.__bootstrapReact.createElement"));
}
globalThis.__bootstrapReact = React;
await compile("src/hooks/useKeyboardShortcuts.ts", "keyboard.mjs");
await compile("src/hooks/useAiringOffsetSync.ts", "hook.mjs", { "../api/airing-offset-sync": url("stubs.mjs") });
await compile("src/components/AiringOffsetSyncBootstrap.tsx", "bootstrap.mjs", {
  "@tauri-apps/api/window": url("stubs.mjs"), "../api/oauth": url("stubs.mjs"),
  "../api/airing-offset-sync": url("stubs.mjs"), "../api/tauri-fetch": url("stubs.mjs"),
  "../hooks/useAiringOffsetSync": url("hook.mjs"), "../hooks/useKeyboardShortcuts": url("keyboard.mjs"),
});
const { default: Bootstrap } = await import(url("bootstrap.mjs"));
const { useKeyboardShortcuts } = await import(url("keyboard.mjs"));
class Manager {
  listeners = new Set();
  gates = new Map();
  calls = [];
  version = 0;
  status = { account: null, ready: false, enabled: false, configured: false, autoSync: false, phase: "idle", conflicts: [], lastSyncedAt: null, error: null };
  getSnapshot = () => this.status;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  publish(patch) { this.status = { ...this.status, ...patch }; this.listeners.forEach(listener => listener()); }
  async setAccount(account) {
    this.calls.push(["account", account]);
    const version = ++this.version;
    this.publish({ account, ready: false });
    await this.gates.get(account)?.promise;
    if (version === this.version) this.publish({ ready: true, phase: "idle", error: null });
  }
  setAppActive(active) { this.calls.push(["active", active]); }
}
const manager = new Manager();
const initial = deferred();
manager.gates.set("Alice", initial);
function Page() {
  const location = useLocation();
  React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
  useKeyboardShortcuts([{ handler: () => { oldShortcuts++; } }], { priority: 10 });
  useKeyboardShortcuts([{ handler: () => { oldShortcuts++; } }], { priority: 10, capture: true });
  return React.createElement("p", { "data-route": "" }, location.pathname);
}
const router = createMemoryRouter([{ path: "*", element: React.createElement(Page) }], { initialEntries: ["/collections"] });
let props = { authenticated: true, username: "Alice", sessionRevision: 1, manager };
const renderer = createRoot(document.getElementById("root"));
const render = async changes => {
  props = { ...props, ...changes };
  await act(async () => renderer.render(React.createElement(Bootstrap, props, React.createElement(RouterProvider, { router }))));
};
const content = () => document.querySelector("[data-offset-sync-content]");
const keyboard = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
await render();
assert.equal(mounts, 1);
assert.equal(content().getAttribute("aria-hidden"), "true");
assert(content().hasAttribute("inert"));
keyboard();
assert.equal(oldShortcuts, 0, "屏障必须挡住旧页面的 capture/bubble 快捷键");
await act(async () => router.navigate("/subject/123"));
assert.equal(document.querySelector("[data-route]").textContent, "/subject/123", "被遮挡期间导航仍然工作");
await act(async () => initial.resolve());
assert.equal(content().getAttribute("aria-hidden"), "false", "账号本地恢复不等待挂起的 /me");
assert(!content().hasAttribute("inert"));
await act(async () => manager.publish({ phase: "syncing" }));
assert.equal(document.querySelector('[role="status"]'), null, "后台同步不阻塞首屏");
keyboard();
assert.equal(oldShortcuts, 2);
assert.equal(mounts, 1); assert.equal(unmounts, 0);
const bob = deferred(); manager.gates.set("Bob", bob);
await render({ username: "Bob", sessionRevision: 2 });
assert.equal(content().getAttribute("aria-hidden"), "true");
keyboard(); assert.equal(oldShortcuts, 2);
await act(async () => bob.resolve());
assert.equal(content().getAttribute("aria-hidden"), "false");
assert.equal(mounts, 1); assert.equal(unmounts, 0);
await act(async () => window.dispatchEvent(new Event("blur")));
assert.deepEqual(manager.calls.at(-1), ["active", false]);
await act(async () => window.dispatchEvent(new Event("focus")));
assert.deepEqual(manager.calls.at(-1), ["active", true]);
await render({ authenticated: false, username: "", sessionRevision: 3 });
assert.equal(manager.status.account, null);
assert.equal(mounts, 1); assert.equal(unmounts, 0);
await act(async () => renderer.unmount());
assert.equal(unmounts, 1);

// 没有缓存用户名时失败可重试；等待用户名时仍只遮挡、不卸载路由。
cachedName = "";
let unknown = deferred();
globalThis.__offsetBootstrap.fetchProfile = () => unknown.promise;
const identityManager = new Manager();
const identityRoot = createRoot(document.getElementById("root"));
const identityElement = () => React.createElement(Bootstrap, {
  manager: identityManager, authenticated: true, username: cachedName, sessionRevision: 4,
}, React.createElement("p", null, "稳定子页面"));
await act(async () => identityRoot.render(identityElement()));
assert.equal(content().getAttribute("aria-hidden"), "true");
await act(async () => unknown.resolve(""));
assert.match(document.body.textContent, /无法确认当前 Bangumi 账号/);
unknown = deferred();
await act(async () => document.querySelector("button").click());
assert.doesNotMatch(document.body.textContent, /无法确认当前/);
cachedName = "Carol";
await act(async () => { unknown.resolve("Carol"); identityRoot.render(identityElement()); });
assert.equal(content().getAttribute("aria-hidden"), "false");
await act(async () => identityManager.publish({ ready: false, phase: "error", error: "本地读取失败" }));
assert.match(document.body.textContent, /本地读取失败/);
await act(async () => document.querySelector("button").click());
assert.equal(content().getAttribute("aria-hidden"), "false");
await act(async () => identityRoot.unmount());

// 原生焦点订阅晚于卸载返回也要移除；隐藏窗口取消自动活动状态。
tauried = true;
globalThis.__offsetBootstrap.fetchProfile = async () => "Carol";
const native = new Manager();
const nativeRoot = createRoot(document.getElementById("root"));
await act(async () => nativeRoot.render(React.createElement(Bootstrap, {
  manager: native, authenticated: true, username: "Carol", sessionRevision: 5,
}, React.createElement("p", null, "原生窗口"))));
await act(async () => nativeFocus({ payload: false }));
assert.deepEqual(native.calls.at(-1), ["active", false]);
await act(async () => nativeFocus({ payload: true }));
assert.deepEqual(native.calls.at(-1), ["active", true]);
await act(async () => nativeRoot.unmount());
await act(async () => registration.resolve(() => { removed++; }));
assert.equal(removed, 1);
assert.deepEqual(native.calls.at(-1), ["active", false]);
assert(profileCalls >= 1);
dom.window.close();
console.log("desktop offset bootstrap: 稳定导航、本地恢复、快捷键屏障、账号重试及桌面焦点通过 ✓");
