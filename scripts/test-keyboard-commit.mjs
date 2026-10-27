// 使用真实 React commit 时序，防止 DOM 已变而快捷键仍引用旧条目。
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement, startTransition, StrictMode, Suspense, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { useKeyboardShortcuts } from "../src/hooks/useKeyboardShortcuts.ts";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://app.example.test" });
const { window } = dom;
const { document, KeyboardEvent } = window;
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const calls = [];
const pending = new Promise(() => {});
const enter = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
function Content({ subjectId, suspend }) {
  if (suspend) throw pending;
  return createElement("div", { id: "subject" }, String(subjectId));
}
function Harness({ subjectId, enabled = true, dispatchOnCommit = false, suspend = false }) {
  useKeyboardShortcuts([{ key: "Enter", handler: () => calls.push(subjectId) }], { enabled });
  // 模拟筛选结果已提交、普通 useEffect 尚未运行时立即按 Enter。
  useLayoutEffect(() => { if (dispatchOnCommit) enter(); }, [subjectId, enabled, dispatchOnCommit]);
  return createElement(Content, { subjectId, suspend });
}
const root = createRoot(document.getElementById("root"));
const view = props => createElement(StrictMode, null,
  createElement(Suspense, { fallback: createElement("p", null, "加载中") }, createElement(Harness, props)));
try {
  await act(async () => root.render(view({ subjectId: 8 })));
  await act(async () => root.render(view({ subjectId: 616808, dispatchOnCommit: true })));
  assert.equal(document.getElementById("subject").textContent, "616808");
  assert.deepEqual(calls, [616808], "筛选结果已显示时，Enter 不能打开上个已提交版本的条目");

  await act(async () => root.render(view({ subjectId: 616808, enabled: false, dispatchOnCommit: true })));
  assert.equal(calls.length, 1, "关闭快捷键的同次 commit 不能继续执行旧注册");
  await act(async () => root.render(view({ subjectId: 616808, enabled: true, dispatchOnCommit: true })));
  assert.deepEqual(calls, [616808, 616808], "重新启用后，同次 commit 应使用新注册");

  await act(async () => {
    startTransition(() => root.render(view({ subjectId: 9, suspend: true })));
  });
  assert.equal(document.getElementById("subject").textContent, "616808");
  enter();
  assert.deepEqual(calls, [616808, 616808, 616808], "未提交的并发渲染不能泄露到已显示页面的快捷键");
  await act(async () => root.unmount());
  enter();
  assert.equal(calls.length, 3, "卸载后不能残留键盘注册");
  console.log("keyboard commit: 同帧筛选、开关、未提交的并发渲染、StrictMode 与卸载通过 ✓");
} finally {
  await act(async () => root.unmount());
  dom.window.close();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
