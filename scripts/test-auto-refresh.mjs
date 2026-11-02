// 自动刷新触发闸门与生命周期回归。
// 运行：node --experimental-strip-types scripts/test-auto-refresh.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUTO_REFRESH_MIN_INTERVAL,
	consumeCollectionsAutoRefreshRequest,
	createAutoRefreshGate,
	hasCollectionsAutoRefreshRequest,
	notifyNativeWindowVisibility,
	requestCollectionsAutoRefresh,
	startCollectionsAutoRefreshLifecycle,
	subscribeCollectionsAutoRefresh,
} from "../src/api/auto-refresh.ts";

const NOW = 1_800_000_000_000;

test("自动刷新按范围冷却，边界与跨范围互不影响", () => {
	const gate = createAutoRefreshGate();
	assert.equal(gate.canAutoRefresh("user:3", NOW), true, "从未刷新过可以立即跑");
	gate.markStarted("user:3", NOW);
	assert.equal(gate.canAutoRefresh("user:3", NOW + AUTO_REFRESH_MIN_INTERVAL - 1), false);
	assert.equal(gate.canAutoRefresh("user:3", NOW + AUTO_REFRESH_MIN_INTERVAL), true);
	assert.equal(gate.canAutoRefresh("user:1", NOW), true, "其它分类不继承冷却");
	gate.markStarted("user:3", NOW + AUTO_REFRESH_MIN_INTERVAL);
	assert.equal(gate.canAutoRefresh("user:3", NOW + AUTO_REFRESH_MIN_INTERVAL + 1), false,
		"新一轮会刷新冷却起点");
});

test("手动刷新也计入冷却：手动刚跑完，自动刷新不再重复请求", () => {
	const gate = createAutoRefreshGate();
	gate.markStarted("user:3", NOW);
	assert.equal(gate.canAutoRefresh("user:3", NOW + 1000), false);
});

test("整批刷新独占：手动与自动共用同一把锁，结束后可再次进入", () => {
	const gate = createAutoRefreshGate();
	assert.equal(gate.tryBegin(), true);
	assert.equal(gate.inFlight, true);
	assert.equal(gate.tryBegin(), false, "同一时间只能有一轮刷新在写缓存");
	gate.end();
	assert.equal(gate.inFlight, false);
	assert.equal(gate.tryBegin(), true);
	gate.end();
});

test("去重范围按账号细分：切换账号不会沿用上一个账号的冷却", () => {
	const gate = createAutoRefreshGate();
	gate.markStarted("alice:3", NOW);
	assert.equal(gate.canAutoRefresh("alice:3", NOW + 1000), false);
	assert.equal(gate.canAutoRefresh("bob:3", NOW + 1000), true);
});

/** 最小 DOM 替身：只提供自动刷新生命周期用到的事件接口。 */
function installDom({ hidden = false, focused = true } = {}) {
	const previous = new Map(["window", "document"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
	const windowListeners = new Map();
	const documentListeners = new Map();
	const add = (target) => (type, fn) => target.set(type, [...(target.get(type) ?? []), fn]);
	const remove = (target) => (type, fn) => target.set(type, (target.get(type) ?? []).filter((item) => item !== fn));
	const fire = (target) => (type) => { for (const fn of target.get(type) ?? []) fn({ type }); };
	const state = { hidden, focused };
	const windowStub = { addEventListener: add(windowListeners), removeEventListener: remove(windowListeners) };
	const documentStub = {
		addEventListener: add(documentListeners),
		removeEventListener: remove(documentListeners),
		get hidden() { return state.hidden; },
		get visibilityState() { return state.hidden ? "hidden" : "visible"; },
		hasFocus: () => state.focused,
	};
	Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: windowStub });
	Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: documentStub });
	return {
		setHidden(next) { state.hidden = next; fire(documentListeners)("visibilitychange"); },
		fireFocus() { state.focused = true; fire(windowListeners)("focus"); },
		fireBlur() { state.focused = false; fire(windowListeners)("blur"); },
		restore() {
			for (const [name, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else delete globalThis[name];
			}
		},
	};
}

test("生命周期：启动排队一次，窗口重新显示时再排队，持续可见时不重复", () => {
	const dom = installDom({ hidden: false, focused: true });
	consumeCollectionsAutoRefreshRequest();
	let stop = () => {};
	let unsubscribe = () => {};
	try {
		const seen = [];
		unsubscribe = subscribeCollectionsAutoRefresh(() => {
			seen.push(hasCollectionsAutoRefreshRequest());
		});
		stop = startCollectionsAutoRefreshLifecycle();
		assert.equal(hasCollectionsAutoRefreshRequest(), true, "每次打开软件都要排队一次刷新");
		const startupAt = consumeCollectionsAutoRefreshRequest();
		assert.ok(startupAt > 0, "消费时会返回请求时刻，供“已被自己刷过”判定");
		assert.equal(hasCollectionsAutoRefreshRequest(), false);

		// 持续可见期间的 focus 事件不算“重新显示”，不重复排队。
		dom.fireFocus();
		assert.equal(hasCollectionsAutoRefreshRequest(), false);

		dom.fireBlur();
		dom.fireFocus();
		assert.equal(hasCollectionsAutoRefreshRequest(), true, "失焦后重新聚焦要刷新");
		assert.ok(consumeCollectionsAutoRefreshRequest() > 0);

		dom.setHidden(true);
		assert.equal(hasCollectionsAutoRefreshRequest(), false, "隐藏时不排队");
		dom.setHidden(false);
		assert.equal(hasCollectionsAutoRefreshRequest(), true, "重新可见要刷新");
		assert.ok(consumeCollectionsAutoRefreshRequest());

		// Tauri 全局快捷键/托盘强制 show 走原生焦点桥接。
		notifyNativeWindowVisibility(false);
		notifyNativeWindowVisibility(true);
		assert.equal(hasCollectionsAutoRefreshRequest(), true, "原生窗口重新显示也要刷新");
		assert.ok(consumeCollectionsAutoRefreshRequest());

		// 重复调用不会重复注册监听，也不会额外排队。
		const second = startCollectionsAutoRefreshLifecycle();
		assert.equal(hasCollectionsAutoRefreshRequest(), false);
		second();
		assert.ok(seen.length > 0, "排队时会通知订阅者");
	} finally {
		unsubscribe();
		stop();
		dom.restore();
	}
});

test("启动时窗口不可见：仍然排队一次，重新可见后再排队一次", () => {
	const dom = installDom({ hidden: true, focused: false });
	consumeCollectionsAutoRefreshRequest();
	const stop = startCollectionsAutoRefreshLifecycle();
	try {
		// 隐藏启动时仍然排队一次：应用冷启动必须刷新，即使窗口是在后台拉起的。
		assert.equal(hasCollectionsAutoRefreshRequest(), true);
		assert.ok(consumeCollectionsAutoRefreshRequest());
		dom.setHidden(false);
		assert.equal(hasCollectionsAutoRefreshRequest(), true);
		assert.ok(consumeCollectionsAutoRefreshRequest());
	} finally {
		stop();
		dom.restore();
	}
});

test("排队请求保留最早时刻：同一轮多次请求不会被无限推迟", () => {
	consumeCollectionsAutoRefreshRequest();
	assert.equal(consumeCollectionsAutoRefreshRequest(), 0);
	const first = requestCollectionsAutoRefresh(1000);
	assert.equal(first, 1000);
	assert.equal(requestCollectionsAutoRefresh(5000), 1000, "已有排队请求时保留最早时刻");
	assert.equal(consumeCollectionsAutoRefreshRequest(), 1000);
	assert.equal(consumeCollectionsAutoRefreshRequest(), 0);
});
