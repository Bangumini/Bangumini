// 放送日期偏置偏好回归（零额外依赖）。
// 运行：node --experimental-strip-types scripts/test-airing-offset-settings.mjs
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const storageListeners = new Set();
const keyboardListeners = { capture: new Set(), bubble: new Set() };
const disk = new Map();
let failWrites = false;
let failReads = false;
const storage = {
	getItem(key) {
		if (failReads) throw new Error("denied read");
		return disk.get(key) ?? null;
	},
	setItem(key, value) {
		if (failWrites) throw new Error("quota exceeded");
		disk.set(key, String(value));
	},
};
globalThis.window = {
	localStorage: storage,
	addEventListener(type, listener, capture) {
		if (type === "storage") storageListeners.add(listener);
		if (type === "keydown") keyboardListeners[capture ? "capture" : "bubble"].add(listener);
	},
	removeEventListener(type, listener, capture) {
		if (type === "storage") storageListeners.delete(listener);
		if (type === "keydown") keyboardListeners[capture ? "capture" : "bubble"].delete(listener);
	},
};
let imports = 0;
const load = () => import(new URL(`src/api/airing-offset.ts?restart=${imports++}`, root));
const api = await load();
const legacyKey = api.AIRING_OFFSETS_STORAGE_KEY;
const key = api.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY;
const get = api.getAiringOffsetsSnapshot;
const set = api.setAiringOffsetDays;
const empty = get();
assert.deepEqual(empty, {});
assert.strictEqual(get(), empty, "重复读取必须返回稳定快照");
assert(Object.isFrozen(empty));
await api.setAiringOffsetAccount("alice");
let notifications = 0;
const unsubscribe = api.subscribeAiringOffsets(() => notifications++);
const state = () => JSON.parse(disk.get(key)).accounts["account:alice"];
const record = (days, revision = `external-${days}`) => ({ days, revision, updatedAt: 1 });
const canonical = records => JSON.stringify({ version: 1, legacyOwner: "alice", accounts: {
 "account:alice": { syncEnabled: false, records, bases: {}, syncedAt: {} },
} });

assert.equal(set(10, -1), undefined, "既有保存 API 必须仍同步返回 void");
assert.equal(state().records[10].days, -1, "同步返回前已确认落盘");
assert.equal(get()[10], -1, "允许提前 1 天，立即发布");
assert.equal(notifications, 1);
const beforeSameSave = get();
const beforeSameRevision = state().records[10].revision;
set(10, -1);
assert.strictEqual(get(), beforeSameSave, "保存相同值不重建快照");
assert.equal(state().records[10].revision, beforeSameRevision);
assert.equal(notifications, 1);
set(20, 1);
assert.deepEqual(get(), { 10: -1, 20: 1 }, "条目相互隔离，允许延后 1 天");
set(10, 0);
assert.deepEqual(get(), { 20: 1 });
assert.equal(state().records[10].days, 0, "恢复默认必须永久保留 tombstone，而非删同步记录");
const firstZero = state().records[10].revision;
const zeroMap = get();
set(10, 0);
assert.notEqual(state().records[10].revision, firstZero, "再次恢复默认是新的删除意图");
assert.strictEqual(get(), zeroMap, "重复恢复默认不重发展示映射");
set(10, 365);
set(20, -365);
assert.deepEqual(get(), { 10: 365, 20: -365 }, "允许边界整数天");
const restored = await load();
assert.deepEqual(restored.getAiringOffsetsSnapshot(), {}, "重启 guest 不泄露已登录账号");
await restored.setAiringOffsetAccount("alice");
assert.deepEqual(restored.getAiringOffsetsSnapshot(), get(), "账号数据从磁盘恢复，不依赖网络");

for (const invalid of [-366, 366, 0.5, -1.5, NaN, Infinity, "1", null, undefined]) {
 const previous = get();
 assert.throws(() => set(10, invalid), RangeError);
 assert.strictEqual(get(), previous);
}
for (const invalidId of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
 assert.throws(() => set(invalidId, 1), RangeError);
}
function crossWindow(raw, eventKey = key, storageArea = storage) {
 if (eventKey === null) disk.clear();
 else if (storageArea === storage) {
  if (raw === null) disk.delete(eventKey);
  else disk.set(eventKey, raw);
 }
 for (const listener of storageListeners) listener({ key: eventKey, newValue: raw, storageArea });
}
crossWindow(canonical({ 10: record(-2), 20: record(3) }));
assert.deepEqual(get(), { 10: -2, 20: 3 }, "storage 事件刷新当前账号");
const crossSnapshot = get(), crossNotifications = notifications;
crossWindow(canonical({ 20: record(3), 10: record(-2) }));
assert.strictEqual(get(), crossSnapshot, "相同内容即使属性顺序变化也保持引用");
assert.equal(notifications, crossNotifications);
crossWindow(canonical({ 10: record(99) }), "unrelated_key");
assert.strictEqual(get(), crossSnapshot, "忽略无关存储键");
crossWindow(canonical({ 10: record(99) }), key, {});
assert.strictEqual(get(), crossSnapshot, "忽略其他存储区域");
crossWindow(canonical({ 10: record(-2, "metadata-only"), 20: record(3) }));
assert.strictEqual(get(), crossSnapshot, "纯 metadata 跨窗口更新也保持 offsetMap 引用");

// 旧 flat 库可容错迁移，但 canonical 必须整体拒绝，不能过滤后空覆盖。
const invalidLegacy = JSON.stringify({
 10: -1, 20: 2, 30: 0, 40: 366, 50: -366, 60: 0.25,
 70: "1", 80: null, 90: {}, 0: 1, "-1": 2, "1.5": 3,
 "001": 2, "9007199254740992": 1, ["__proto__"]: 3,
});
disk.delete(key); disk.set(legacyKey, invalidLegacy);
const migrated = await load();
await migrated.setAiringOffsetAccount("first");
assert.deepEqual(migrated.getAiringOffsetsSnapshot(), { 10: -1, 20: 2 }, "旧库逐条忽略损坏、非整数与越界记录");
assert.equal(disk.get(legacyKey), invalidLegacy, "保留原始旧库备份");
await migrated.setAiringOffsetAccount("second");
assert.deepEqual(migrated.getAiringOffsetsSnapshot(), {}, "旧库只迁入首次账号");
for (const corrupted of ["broken JSON", "[]", "null", "7", '"string"', canonical({ 10: record(366) })]) {
 crossWindow(corrupted);
 const previous = get();
 assert.throws(() => set(10, 1), undefined, `canonical 损坏时拒绝保存 ${corrupted}`);
 assert.equal(disk.get(key), corrupted, "损坏 canonical 不允许空覆盖");
 assert.strictEqual(get(), previous, "损坏事件保留最后确认快照");
 const restart = await load();
 assert.deepEqual(restart.getAiringOffsetsSnapshot(), {});
 assert.throws(() => restart.setAiringOffsetDays(10, 1));
}
crossWindow(canonical({ 10: record(-1) }));
const previous = get(), diskBeforeFailure = disk.get(key), notificationsBeforeFailure = notifications;
failWrites = true;
assert.throws(() => set(10, 2), /quota/);
assert.throws(() => set(10, 0), /quota/, "恢复默认失败同样保留旧设置");
assert.strictEqual(get(), previous);
assert.equal(disk.get(key), diskBeforeFailure);
assert.equal(notifications, notificationsBeforeFailure, "保存失败不能发布成功状态");
failWrites = false; failReads = true;
assert.throws(() => set(10, 1), /denied read/);
assert.strictEqual(get(), previous, "不可读时不覆盖磁盘或旧快照");
failReads = false;
set(10, 0); assert.deepEqual(get(), {});
set(10, 1); crossWindow(null, null);
assert.deepEqual(get(), {}, "其他窗口清空存储恢复默认");
unsubscribe(); const afterUnsubscribe = notifications;
set(10, 2); assert.equal(notifications, afterUnsubscribe);

// 未通知的其他账号、基线、开关与条目更新必须在下一次写入时一起保留。
const externalDatabase = JSON.parse(canonical({ 30: record(-3) }));
externalDatabase.accounts["account:alice"].syncEnabled = true;
externalDatabase.accounts["account:alice"].bases.target = { 30: record(-3) };
externalDatabase.accounts["account:bob"] = { syncEnabled: false, records: { 40: record(4) }, bases: {}, syncedAt: {} };
disk.set(key, JSON.stringify(externalDatabase));
set(10, 1);
assert.deepEqual(get(), { 10: 1, 30: -3 });
assert.equal(state().syncEnabled, true);
assert.deepEqual(state().bases, externalDatabase.accounts["account:alice"].bases);
assert.deepEqual(JSON.parse(disk.get(key)).accounts["account:bob"], externalDatabase.accounts["account:bob"]);
for (const listener of storageListeners) listener({ key, newValue: canonical({ 30: record(-3) }), storageArea: storage });
assert.deepEqual(get(), { 10: 1, 30: -3 }, "旧 storage 事件不能回滚本窗口刚保存的值");
// manager 包装排队期间，同步本地编辑也不能被旧状态覆盖。
const pending = api.updateAiringOffsetAccountState("alice", current => ({ ...current, syncedAt: { target: 42 } }));
set(50, 5);
await pending;
assert.equal(state().records[50].days, 5);
assert.equal(state().syncedAt.target, 42);

// 运行真实快捷键分发器和详情页的捕获守卫，确认不 preventDefault。
const detail = readFileSync(new URL("src/pages/SubjectDetailPage.tsx", root), "utf8");
const control = readFileSync(new URL("src/components/AiringOffsetControl.tsx", root), "utf8");
const hook = readFileSync(new URL("src/hooks/useAiringOffsets.ts", root), "utf8");
assert.match(hook, /useSyncExternalStore\(/);
assert.match(control, /step=\{1\}/);
assert.match(control, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
const guardStart = detail.indexOf('when: ({ target }) => Boolean(target?.closest("[data-airing-offset-control]"))');
assert(guardStart >= 0, "详情页必须在 capture 阶段排除控件");
const guardSource = detail.slice(guardStart, detail.indexOf("\n\t\t\t},", guardStart));
assert.match(guardSource, /preventDefault: false/);
const guard = Function(`return ({${guardSource}});`)();
class FakeHTMLElement {
	constructor(tag, inControl) { this.tagName = tag; this.inControl = inControl; }
	closest(selector) { return selector === "[data-airing-offset-control]" && this.inControl ? this : null; }
}
globalThis.HTMLElement = FakeHTMLElement;
const tmp = mkdtempSync(join(tmpdir(), "bangumini-airing-offset-"));
try {
	const source = readFileSync(new URL("src/hooks/useKeyboardShortcuts.ts", root), "utf8");
	writeFileSync(join(tmp, "package.json"), '{"type":"module"}');
	writeFileSync(join(tmp, "react-stub.mjs"), "export const useRef = current => ({current}); export const useLayoutEffect = effect => effect();");
	writeFileSync(join(tmp, "keyboard.ts"), source.replace('from "react"', 'from "./react-stub.mjs"'));
	const { useKeyboardShortcuts } = await import(pathToFileURL(join(tmp, "keyboard.ts")));
	let globalActions = 0;
	useKeyboardShortcuts([guard, { handler: () => globalActions++ }], { capture: true, priority: 10 });
	for (const tag of ["INPUT", "BUTTON"]) {
		for (const eventKey of ["Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab", "Escape"]) {
			let prevented = false;
			const event = {
				key: eventKey, target: new FakeHTMLElement(tag, true),
				ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
				preventDefault() { prevented = true; },
			};
			for (const listener of keyboardListeners.capture) listener(event);
			assert.equal(globalActions, 0, `${tag} ${eventKey} 不触发详情全局动作`);
			assert.equal(prevented, false, `${tag} ${eventKey} 保留原生行为`);
		}
	}
	for (const listener of keyboardListeners.capture) listener({ key: "Enter", target: new FakeHTMLElement("BODY", false), preventDefault() {} });
	assert.equal(globalActions, 1, "控件外快捷键不受影响");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
console.log("放送日期偏置偏好与键盘隔离测试全部通过 ✓");
