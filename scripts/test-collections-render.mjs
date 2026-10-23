// 直接渲染实际收藏页，验证列表成员变化时首帧不会丢失已有排期而重新跳组。
// 仅替换外部 IO 和 query 订阅；保留 React、页面、分组和排期计算代码。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { GROUP_LABEL } from "../shared/sort-collections.ts";
import { readCachedQueryMap } from "../src/api/query-map-cache.ts";
import { setAiringOffsetDays } from "../src/api/airing-offset.ts";
import { shiftAiringDate } from "../shared/airing-offset.ts";
import { getTokyoDateKey } from "../shared/airing-schedule.ts";

const root = new URL("../", import.meta.url);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const globals = new Map(["sessionStorage", "localStorage", "window", "document"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let directory;

try {
	directory = await mkdtemp(join(tmpdir(), "bangumini-collections-render-"));
	const mocksUrl = pathToFileURL(join(directory, "mocks.mjs")).href;
	const source = await readFile(new URL("src/pages/CollectionsPage.tsx", root), "utf8");
	const mockExports = new Set();
	const sourceFile = ts.createSourceFile("CollectionsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	let isolated = source;
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const specifier = statement.moduleSpecifier.text;
		if (statement.importClause?.isTypeOnly) continue;
		let replacement;
		if (specifier === "react") replacement = mocksUrl;
		else if (specifier === "../api/query-map-cache") replacement = new URL("src/api/query-map-cache.ts", root).href;
		else if (specifier === "../hooks/useAiringOffsets") replacement = new URL("src/hooks/useAiringOffsets.ts", root).href;
		else if (specifier.startsWith("@shared/") && !["@shared/api/client", "@shared/api/anilist", "@shared/storage/sqlite-cache"].includes(specifier)) {
			replacement = new URL(specifier.replace("@shared/", "shared/") + ".ts", root).href;
		} else {
			replacement = mocksUrl;
			for (const binding of statement.importClause?.namedBindings?.elements ?? []) {
				if (!binding.isTypeOnly) mockExports.add(binding.propertyName?.text ?? binding.name.text);
			}
		}
		isolated = isolated.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
	}
	const implemented = new Set(["useQuery", "useQueryClient", "useNavigate", "useLocation", "useSearchParams", "getUsername", "SubjectRow", "Rating", "Meta", "Tag"]);
	await writeFile(join(directory, "mocks.mjs"), `
import React from ${JSON.stringify(import.meta.resolve("react"))};
import { QueryObserver } from ${JSON.stringify(import.meta.resolve("@tanstack/react-query"))};
export { Fragment, useMemo, useRef, useCallback } from ${JSON.stringify(import.meta.resolve("react"))};
let client;
let cachedSnapshot;
let injectedCommitted;
let committedInjected = false;
let snapshotIndex = 0;
let io = {};
let locationState = null;
const effects = [];
export function useEffect(effect, deps) { effects.push(effect); React.useEffect(effect, deps); }
export const configureLocation = (state) => { locationState = state; effects.length = 0; };
export const getReturnEffect = () => effects.find((effect) => effect.toString().includes("fromSubject") && effect.toString().includes("getCollectionTaskQueue"));
const queries = new Map();
export const configureIO = (handlers) => { io = handlers; };
export const getQueryOptions = (key) => queries.get(JSON.stringify(key));
function callIO(name, args) {
  if (name === "useKeyboardShortcuts") return;
  if (name === "useCacheRefreshPending") return false;
  if (Object.hasOwn(io, name)) return io[name](...args);
  throw new Error("不应调用 IO: " + name);
}
export function configure(value, snapshot, committed) { client = value; cachedSnapshot = snapshot; injectedCommitted = committed; committedInjected = false; snapshotIndex = 0; }
export function useState(initial) {
  if (initial === null && !committedInjected) {
    committedInjected = true;
    if (injectedCommitted) initial = injectedCommitted;
  }
  if (initial?.key === "" && initial?.complete === false && snapshotIndex++ === 0 && cachedSnapshot) initial = cachedSnapshot;
  return React.useState(initial);
}
export const useQueryClient = () => client;
export function useQuery(options) {
  queries.set(JSON.stringify(options.queryKey), options);
  const defaults = client.defaultQueryOptions(options);
  return new QueryObserver(client, defaults).getOptimisticResult(defaults);
}
export const useNavigate = () => () => {};
export const useLocation = () => ({ state: locationState });
export const useSearchParams = () => [new URLSearchParams("type=3")];
export const getUsername = () => "fixture-user";
export const SubjectRow = ({ subjectId, title, accessories }) => React.createElement("article", { "data-subject-id": subjectId }, title, accessories);
export const Rating = () => null;
export const Meta = ({ children }) => React.createElement("span", null, children);
export const Tag = Meta;
${[...mockExports].filter((name) => !implemented.has(name)).map((name) => `export const ${name} = (...args) => callIO(${JSON.stringify(name)}, args);`).join("\n")}
`);
	const compiled = ts.transpileModule(isolated, {
		compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
	}).outputText.replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")));
	await writeFile(join(directory, "CollectionsPage.mjs"), compiled);
	const { configure, configureIO, getQueryOptions, configureLocation, getReturnEffect } = await import(mocksUrl);
	configure(client);
	const { default: CollectionsPage } = await import(pathToFileURL(join(directory, "CollectionsPage.mjs")).href);
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => null } });
	const preferences = new Map();
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
		getItem: (key) => preferences.get(key) ?? null,
		setItem: (key, value) => preferences.set(key, String(value)),
		removeItem: (key) => preferences.delete(key),
	} });
	Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), { localStorage: globalThis.localStorage }) });

	const subject = (id) => ({ id, type: 2, name: `Subject ${id}`, name_cn: `条目 ${id}`, date: "2000-01-01", eps: 12, total_episodes: 12 });
	const collection = (id) => ({ subject_id: id, type: 3, ep_status: 1, subject: subject(id) });
	const episodes = [1, 2, 3].map((ep) => ({ id: ep, ep, sort: ep, type: 0, airdate: "2000-01-01" }));
	const collectionsKey = ["collections", "3", "fixture-user"];
	const page = (data) => ({ data, total: data.length, limit: 100, offset: 0 });
	const seedSchedule = (ids) => {
		const records = new Map(ids.map((id) => [id, { status: "no_schedule", fetchedAt: Date.now() }]));
		client.setQueryData(["anilist-airing-times-cache-v2", ids.join(",")], records);
		client.setQueryData(["anilist-airing-times-v2", ids.join(",")], records);
		client.setQueryData(["episodes-schedule-v2", ids.join(",")], new Map(ids.map((id) => [id, episodes])));
	};
	const renderGroups = (snapshot, committed) => {
		configure(client, snapshot, committed);
		const html = renderToStaticMarkup(React.createElement(CollectionsPage));
		assert.match(html, /data-subject-id="8"/, "应保留未修改条目");
		return Object.entries(GROUP_LABEL).filter(([, label]) => html.includes(label)).map(([key]) => key);
	};
	client.setQueryData(["calendar"], [{ weekday: { id: 5 }, items: [subject(7), subject(8)] }]);
	client.setQueryData(collectionsKey, page([collection(7), collection(8)]));
	seedSchedule([7, 8]);
	const before = renderGroups();
	client.setQueryData(collectionsKey, page([collection(8), collection(7)]));
	assert.deepEqual(renderGroups(), before, "API 只改变原始顺序也不应丢失已有排期");
	// 第一个条目乐观移出「在看」；所有组合 query key 随成员集合改变。
	client.setQueryData(collectionsKey, page([collection(8)]));
	const optimistic = renderGroups();
	seedSchedule([8]);
	const settled = renderGroups();
	console.log("列表成员变化的分组帧：", { before, optimistic, settled });
	assert.deepEqual(before, ["airing_not_caught"]);
	assert.deepEqual(settled, ["airing_not_caught"]);
	client.setQueryData(collectionsKey, page([{ ...collection(8), ep_status: 3 }]));
	const staleDiskSnapshot = renderGroups({
		key: "collections-3-fixture-user", value: page([collection(8)]), version: 1, complete: true,
	});
	console.log("内存进度已追平、SQLite 快照仍旧时：", staleDiskSnapshot);
	assert.deepEqual(staleDiskSnapshot, ["airing_caught"], "内存已有乐观进度时不能再选择旧 SQLite 收藏快照");
	assert.deepEqual(optimistic, settled, "乐观更新首帧应复用条目 8 已知排期，不能先追平、再回到未追平");

	// BGM 日历没有收录的条目，还必须复用 AniList 在播信号，不能降级成完结作品。
	client.clear();
	client.setQueryData(["calendar"], [{ weekday: { id: 5 }, items: [subject(7)] }]);
	client.setQueryData(collectionsKey, page([collection(7), collection(8)]));
	seedSchedule([7, 8]);
	const records = new Map([[8, { status: "scheduled", airingAt: Date.now() / 1000 + 86400, episode: 4, fetchedAt: Date.now() }]]);
	client.setQueryData(["anilist-airing-times-v2", "7,8"], records);
	assert.deepEqual(renderGroups(), ["airing_not_caught"]);
	client.setQueryData(collectionsKey, page([collection(8)]));
	assert.deepEqual(renderGroups(), ["airing_not_caught"], "成员变化不能丢失 AniList 在播信号");

	// 跨组合复用时仅取所需条目；重复记录取最近版本，且不能回写或污染原缓存。
	client.setQueryData(["map-fixture", "7,8"], new Map([[7, "old"], [8, "untouched"]]), { updatedAt: 1 });
	client.setQueryData(["map-fixture", "7"], new Map([[7, "new"]]), { updatedAt: 2 });
	assert.deepEqual(readCachedQueryMap(client, [["map-fixture"]], [7]), new Map([[7, "new"]]));
	assert.equal(readCachedQueryMap(client, [["map-fixture"]], [9]), undefined);
	assert.equal(readCachedQueryMap(client, [["different-scope"]], [7]), undefined);
	assert.deepEqual(client.getQueryData(["map-fixture", "7,8"]), new Map([[7, "old"], [8, "untouched"]]));
	// 直接通过实际页面固定 AniList 深夜观测：+1 天不能被 dayOffset 从1变0抵消。
	const originalNow = Date.now;
	try {
		Date.now = () => Date.parse("2026-07-13T03:00:00+09:00");
		client.clear();
		client.setQueryData(["calendar"], [{ weekday: { id: 7 }, items: [subject(8)] }]);
		client.setQueryData(collectionsKey, page([{ ...collection(8), ep_status: 0 }]));
		const lateRecords = new Map([[8, { status: "scheduled", airingAt: Date.parse("2026-07-13T01:00:00+09:00") / 1000, episode: 1, fetchedAt: Date.now() }]]);
		client.setQueryData(["anilist-airing-times-cache-v2", "8"], lateRecords);
		client.setQueryData(["anilist-airing-times-v2", "8"], lateRecords);
		client.setQueryData(["episodes-schedule-v2", "8"], new Map([[8, [{ ep: 1, type: 0, airdate: "2026-07-12" }]]]));
		assert.deepEqual(renderGroups(), ["airing_not_caught"]);
		setAiringOffsetDays(8, 1);
		assert.deepEqual(renderGroups(), ["airing_caught"], "实际页面必须延后到7月14日01:00，而非仍在7月13日01:00");
		setAiringOffsetDays(8, 0);
		assert.deepEqual(renderGroups(), ["airing_not_caught"]);
	} finally { Date.now = originalNow; }

	// 实际页面使用持久化偏置：无网络/无 AniList 精确时间时，缓存首帧也必须修正。
	client.clear();
	client.setQueryData(["calendar"], [{ weekday: { id: 5 }, items: [subject(8)] }]);
	client.setQueryData(collectionsKey, page([collection(8)]));
	seedSchedule([8]);
	const rawSchedule = [
		{ ep: 1, sort: 1, type: 0, airdate: shiftAiringDate(getTokyoDateKey(Date.now()), -10) },
		{ ep: 2, sort: 2, type: 0, airdate: shiftAiringDate(getTokyoDateKey(Date.now()), 3) },
	];
	client.setQueryData(["episodes-schedule-v2", "8"], new Map([[8, rawSchedule]]));
	assert.deepEqual(renderGroups(), ["airing_caught"]);
	const oldNetworkSnapshot = {
		scopeKey: "fixture-user:3", version: "old-network", airingOffsetsVersion: "{}", source: "network",
		sorted: [{ collection: collection(8), group: "airing_caught", weekday: 5, airedEp: 1 }],
		displayLabelMap: new Map([[8, "旧快照"]]), justUpdatedSubjectIds: new Set(),
	};
	let releaseNetwork;
	const networkPending = client.fetchQuery({ queryKey: collectionsKey, staleTime: 0, queryFn: () => new Promise((resolve) => { releaseNetwork = resolve; }) });
	setAiringOffsetDays(8, -7);
	assert.deepEqual(renderGroups(undefined, oldNetworkSnapshot), ["airing_not_caught"], "保存后不能因网络旧快照而延迟应用偏置");
	configure(client, undefined, oldNetworkSnapshot);
	const correctedHtml = renderToStaticMarkup(React.createElement(CollectionsPage));
	assert.match(correctedHtml, /手动提前7天/);
	assert.doesNotMatch(correctedHtml, /旧快照/);
	assert.equal(rawSchedule[1].airdate, shiftAiringDate(getTokyoDateKey(Date.now()), 3));
	client.setQueryData(["episodes-schedule-v2", "8"], new Map([[8, structuredClone(rawSchedule)]]));
	assert.deepEqual(renderGroups(), ["airing_not_caught"], "新的原始网络数据不能抹掉本地修正");
	// 模拟切换走再返回（React 树每次重新挂载），并恢复默认。
	assert.deepEqual(renderGroups(), ["airing_not_caught"]);
	setAiringOffsetDays(8, 0);
	assert.deepEqual(renderGroups(), ["airing_caught"]);
	releaseNetwork(page([collection(8)]));
	await networkPending;
	client.clear();
	client.setQueryData(["calendar"], [{ weekday: { id: 5 }, items: [subject(8)] }]);
	seedSchedule([8]);
	// 真正执行页面的 queryFn：SQLite 读取被挂起时，worker 已提交更新且队列已清空。
	client.setQueryData(collectionsKey, page([{ ...collection(8), ep_status: 3 }]));
	renderGroups();
	let finishRead;
	const cachedRead = new Promise((resolve) => { finishRead = resolve; });
	configureIO({
		readCachedValueEntryAllowStale: () => cachedRead,
		getCollectionTaskQueue: async () => [],
		refreshQueryDataIfChanged: () => null,
	});
	const refetch = client.fetchQuery({ ...getQueryOptions(collectionsKey), staleTime: 0 });
	client.setQueryData(collectionsKey, page([{ ...collection(8), ep_status: 4 }]));
	finishRead({ payload: page([collection(8)]), updatedAt: 1, isStale: true });
	await refetch;
	assert.equal(client.getQueryData(collectionsKey).data[0].ep_status, 4, "迟到的 SQLite queryFn 结果不能覆盖 worker 已确认的进度");
	// 执行实际返回 effect：队列读取期间 worker 已更新单条和列表、并移除任务。
	client.setQueryData(["collection", 8], collection(8));
	client.setQueryData(collectionsKey, page([collection(8)]));
	configureLocation({ fromSubject: true, subjectId: 8 });
	configure(client);
	renderToStaticMarkup(React.createElement(CollectionsPage));
	let finishQueueRead;
	const queueRead = new Promise((resolve) => { finishQueueRead = resolve; });
	let reconciled = false;
	configureIO({
		getCollectionTaskQueue: () => queueRead,
		getOptimisticCollectionPatchForSubject: (_id, tasks) => { assert.deepEqual(tasks, []); return null; },
		writeCachedValue: async () => {},
	});
	Object.defineProperty(globalThis, "window", { configurable: true, value: { history: { replaceState: () => { reconciled = true; } } } });
	Object.defineProperty(globalThis, "document", { configurable: true, value: { title: "test" } });
	const effect = getReturnEffect();
	assert.ok(effect, "应执行实际返回详情页 effect");
	const cleanup = effect();
	client.setQueryData(["collection", 8], { ...collection(8), type: 2, ep_status: 2 });
	client.setQueryData(collectionsKey, page([]));
	finishQueueRead([]);
	for (let turn = 0; turn < 100 && !reconciled; turn++) await Promise.resolve();
	cleanup();
	assert.ok(reconciled, "reconciliation 应在确定性 microtask 屏障内完成");
	assert.equal(client.getQueryData(collectionsKey).data.length, 0, "返回 effect 不能将已看过的条目按捕获的旧 patch 插回在看列表");
	const freshRecord = { fetchedAt: 200, episode: 5 };
	const oldRecord = { fetchedAt: 100, episode: 4 };
	client.setQueryData(["record-fixture", "8"], new Map([[8, freshRecord]]), { updatedAt: 200 });
	client.setQueryData(["record-fixture", "7,8"], new Map([[8, oldRecord]]), { updatedAt: 300 });
	assert.equal(readCachedQueryMap(client, [["record-fixture"]], [8], (record) => record.fetchedAt).get(8), freshRecord,
		"慢组合查询晚完成，也不能用其中更旧的条目记录覆盖新排期");
	console.log("collections render: 全部通过 ✓");
} finally {
	client.clear();
	for (const [name, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else delete globalThis[name];
	}
	if (directory) await rm(directory, { recursive: true, force: true });
}
