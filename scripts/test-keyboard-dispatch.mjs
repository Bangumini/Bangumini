// 键盘快捷键分发回归测试（零依赖，需要 Node ≥ 22.6，通过 --experimental-strip-types 运行真实 TS 模块）
//
// 背景：SyncQueueDock 在队列展开时注册的 Esc 快捷键，曾因 priority(0) 低于 Layout 的全局
// Esc(20) 而永远无法生效——按 Esc 只会清空搜索框/隐藏窗口，队列收不起来。
// 本测试锁定的正是这个优先级遮蔽 bug 模式。
//
// 运行：node --experimental-strip-types scripts/test-keyboard-dispatch.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const REACT_STUB = `// React 最小 stub（仅用于测试键盘分发逻辑）
export function useRef(initial) {
  return { current: initial };
}
export function useEffect(effect, _deps) {
  effect();
}
`;

// ---------- 1. 加载真实 dispatch 模块（替换 react 导入为 stub） ----------
const REACT_IMPORT = 'import { useEffect, useRef } from "react";';
const shortcutsSrc = readFileSync(
	join(ROOT, "src/hooks/useKeyboardShortcuts.ts"),
	"utf8",
);
if (!shortcutsSrc.includes(REACT_IMPORT)) {
	throw new Error(
		"useKeyboardShortcuts.ts 的 react 导入格式变了，请同步更新本脚本",
	);
}
const moduleSrc = shortcutsSrc.replace(
	REACT_IMPORT,
	'import { useEffect, useRef } from "./_react-stub.ts";',
);
const tmpDir = join(ROOT, "scripts/.kb-test-tmp");
mkdirSync(tmpDir, { recursive: true });
writeFileSync(join(tmpDir, "_react-stub.ts"), REACT_STUB);
writeFileSync(join(tmpDir, "useKeyboardShortcuts.ts"), moduleSrc);

// ---------- 2. 从源码解析 SyncQueueDock 的 Esc priority ----------
const dockSrc = readFileSync(
	join(ROOT, "src/components/SyncQueueDock.tsx"),
	"utf8",
);
const dockCall = dockSrc.slice(dockSrc.lastIndexOf("useKeyboardShortcuts"));
const dockPrioMatch = dockCall.match(/priority:\s*(\d+)/);
const dockPriority = dockPrioMatch ? parseInt(dockPrioMatch[1], 10) : 0;

// ---------- 3. DOM 最小假实现 ----------
class FakeHTMLElement {
	constructor(tagName = "BODY", value = "") {
		this.tagName = tagName;
		this.value = value;
		this.isContentEditable = false;
	}
}
globalThis.HTMLElement = FakeHTMLElement;
const listeners = { capture: [], bubble: [] };
globalThis.window = {
	addEventListener: (type, fn, capture) => {
		if (type === "keydown") listeners[capture ? "capture" : "bubble"].push(fn);
	},
	removeEventListener: (type, fn, capture) => {
		if (type !== "keydown") return;
		const arr = listeners[capture ? "capture" : "bubble"];
		const i = arr.indexOf(fn);
		if (i >= 0) arr.splice(i, 1);
	},
};

const { useKeyboardShortcuts } = await import(
	join(tmpDir, "useKeyboardShortcuts.ts")
);

// ---------- 4. 注册与真实组件一致的快捷键 ----------
// Layout.tsx 的全局 Esc：priority 20，无条件匹配（清空搜索框 / 隐藏窗口）
const LAYOUT_ESCAPE_PRIORITY = 20;
const layoutEffects = { clearInput: 0, hideWindow: 0 };
useKeyboardShortcuts(
	[
		{
			key: "Escape",
			mod: false,
			alt: false,
			handler: ({ target, isTextInput }) => {
				if (isTextInput && target instanceof HTMLElement && target.value) {
					layoutEffects.clearInput++;
				} else {
					layoutEffects.hideWindow++;
				}
			},
		},
	],
	{ priority: LAYOUT_ESCAPE_PRIORITY },
);

// SyncQueueDock.tsx 的 Esc：when=expanded，priority 取自源码（应为 30）
const dockEffects = { collapseQueue: 0 };
let expanded = true;
useKeyboardShortcuts(
	[
		{
			key: "Escape",
			when: () => expanded,
			stopPropagation: true,
			handler: () => {
				dockEffects.collapseQueue++;
			},
		},
	],
	{ priority: dockPriority },
);

// ---------- 5. 场景断言 ----------
function makeEvent(key, target) {
	return {
		key,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		target,
		preventDefault() {},
		stopPropagation() {},
		stopImmediatePropagation() {},
	};
}

function dispatchKey(key, target) {
	const ev = makeEvent(key, target);
	for (const fn of [...listeners.capture]) fn(ev);
	for (const fn of [...listeners.bubble]) fn(ev);
}

let failures = 0;

function scenario(name, target, expect) {
	layoutEffects.clearInput = 0;
	layoutEffects.hideWindow = 0;
	dockEffects.collapseQueue = 0;
	dispatchKey("Escape", target);
	const got = {
		dockCollapse: dockEffects.collapseQueue,
		layoutClear: layoutEffects.clearInput,
		layoutHide: layoutEffects.hideWindow,
	};
	const pass = Object.keys(expect).every((k) => got[k] === expect[k]);
	if (!pass) failures++;
	console.log(
		`  ${pass ? "PASS" : "FAIL"} [${name}] ` +
			`dockCollapse=${got.dockCollapse} layoutClear=${got.layoutClear} layoutHide=${got.layoutHide}`,
	);
}

console.log(
	`SyncQueueDock Esc priority = ${dockPriority}（需高于 Layout 的 ${LAYOUT_ESCAPE_PRIORITY}）`,
);
console.log("=== 队列展开时按 Esc（应：仅收起队列）===");
scenario("焦点在有文字的搜索框", new FakeHTMLElement("INPUT", "fate"), {
	dockCollapse: 1,
	layoutClear: 0,
	layoutHide: 0,
});
scenario("焦点在正文", new FakeHTMLElement("BODY", ""), {
	dockCollapse: 1,
	layoutClear: 0,
	layoutHide: 0,
});
console.log("=== 队列收起时按 Esc（应：正常触发主窗口 Esc）===");
expanded = false;
scenario("焦点在有文字的搜索框", new FakeHTMLElement("INPUT", "fate"), {
	dockCollapse: 0,
	layoutClear: 1,
	layoutHide: 0,
});
scenario("焦点在正文", new FakeHTMLElement("BODY", ""), {
	dockCollapse: 0,
	layoutClear: 0,
	layoutHide: 1,
});

// 清理临时目录
rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} 个场景失败 ✗`);
	process.exit(1);
}
console.log("\n全部通过 ✓");
