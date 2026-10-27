// Ctrl+R 增量刷新回归：直接测试页面使用的真实缓存函数，无网络、Tauri 或第三方依赖。
// 运行：node --experimental-strip-types scripts/test-manual-sync.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffCollectionList } from "../shared/collection-cache.ts";
import { diffCalendar } from "../shared/calendar-cache.ts";
import {
	FORCE_WINDOW_MS,
	createForceWindow,
	getForcedRoundStart,
} from "../shared/cache-force.ts";
import {
	AIRING_NEGATIVE_CACHE_MAX_AGE,
	AIRING_REFRESH_MIN_INTERVAL,
	airingForceWindow,
	isSameAiringSchedule,
	mergeAiringRecordMaps,
	shouldRefreshAiringRecord,
} from "../shared/airing-cache.ts";
import {
	EPISODES_CACHE_MAX_AGE,
	episodesForceWindow,
	shouldRefreshEpisodeRecord,
} from "../shared/episodes-cache.ts";
import { readCachedQueryMap } from "../src/api/query-map-cache.ts";

const NOW = 1_800_000_000_000;
const clone = (value) => JSON.parse(JSON.stringify(value));

function subject(id) {
	return { id, name: `Subject ${id}`, name_cn: `条目 ${id}`, eps: 12 };
}

function collection(id, epStatus = 2) {
	return { subject_id: id, type: 3, ep_status: epStatus, subject: subject(id) };
}

function page(data, total = data.length) {
	return { data, total, limit: 100, offset: 0 };
}

function day(id, items) {
	return { weekday: { id, en: `Day ${id}`, cn: `星期${id}`, ja: `${id}` }, items };
}

function assertNoCollectionWrites(diff) {
	assert.deepEqual(diff.addedIds, []);
	assert.deepEqual(diff.changedIds, []);
	assert.deepEqual(diff.removedIds, []);
	assert.deepEqual(diff.changedItems, []);
}

function scheduled(overrides = {}) {
	return {
		status: "scheduled",
		airingAt: (NOW - 60_000) / 1000,
		episode: 3,
		fetchedAt: NOW - 1000,
		...overrides,
	};
}

test("收藏：相同内容保留整页和条目引用，不产生增量写入", () => {
	const current = page([collection(1), collection(2)]);
	const incoming = clone(current);
	const diff = diffCollectionList(current, incoming);
	assert.equal(diff.changed, false);
	assert.strictEqual(diff.data, current);
	assert.strictEqual(diff.data.data[0], current.data[0]);
	assertNoCollectionWrites(diff);
	assert.deepEqual(incoming, current, "对比不能修改网络响应或当前缓存");
});

test("收藏：冷缓存报告新增成员，空列表无需写行", () => {
	const incoming = page([collection(1), collection(2)]);
	const diff = diffCollectionList(undefined, incoming);
	assert.strictEqual(diff.data, incoming);
	assert.equal(diff.changed, true);
	assert.deepEqual(diff.addedIds, [1, 2]);
	assert.deepEqual(diff.changedItems, incoming.data);
	assert.deepEqual(diff.changedIds, []);
	assert.deepEqual(diff.removedIds, []);
	const empty = diffCollectionList(undefined, page([]));
	assert.equal(empty.changed, false);
	assertNoCollectionWrites(empty);
});

test("收藏：全量响应区分新增、进度更新和移出，只返回需写入的条目", () => {
	const current = page([collection(1), collection(2), collection(3)]);
	const before = clone(current);
	const incoming = page([clone(current.data[0]), collection(2, 5), collection(4)]);
	const diff = diffCollectionList(current, incoming);
	assert.equal(diff.changed, true);
	assert.deepEqual(diff.addedIds, [4]);
	assert.deepEqual(diff.changedIds, [2]);
	assert.deepEqual(diff.removedIds, [3]);
	assert.deepEqual(diff.changedItems, [incoming.data[1], incoming.data[2]]);
	assert.strictEqual(diff.data.data[0], current.data[0]);
	assert.strictEqual(diff.data.data[1], incoming.data[1]);
	assert.equal(diff.data.total, 3);
	assert.deepEqual(current, before, "刷新不能原地污染旧快照");
	const repeated = diffCollectionList(diff.data, clone(incoming));
	assert.equal(repeated.changed, false, "同一响应再次到达不能重复写盘");
	assert.strictEqual(repeated.data, diff.data);
	assertNoCollectionWrites(repeated);
});

test("收藏：仅条目元数据或收藏分类变化也必须识别", () => {
	const current = page([collection(1), collection(2), collection(3)]);
	const incoming = clone(current);
	incoming.data[0].subject.name_cn = "远端修改标题";
	incoming.data[1].type = 2;
	const diff = diffCollectionList(current, incoming);
	assert.deepEqual(diff.changedIds, [1, 2]);
	assert.deepEqual(diff.changedItems, incoming.data.slice(0, 2));
	assert.deepEqual(diff.addedIds, []);
	assert.deepEqual(diff.removedIds, []);
	assert.strictEqual(diff.data.data[2], current.data[2]);
});

test("收藏：complete=false 首页不能把未返回的本地成员视为删除", () => {
	const current = page([collection(1), collection(2), collection(3)]);
	const diff = diffCollectionList(current, page([collection(1, 4)], 2), {
		complete: false,
	});
	assert.equal(diff.changed, true);
	assert.deepEqual(diff.removedIds, [], "首页缺席不等于远端取消收藏");
	assert.deepEqual(diff.changedIds, [1]);
	assert.deepEqual(diff.data.data.map((item) => item.subject_id), [1, 2, 3]);
	assert.strictEqual(diff.data.data[1], current.data[1]);
	assert.strictEqual(diff.data.data[2], current.data[2]);
	assert.equal(diff.data.total, 2, "保留服务端总数，不据此截断本地条目");
});

test("收藏：相同首页保引用；首页重排或新增只影响列表，不误写未变条目", () => {
	const current = page([collection(1), collection(2), collection(3)]);
	const unchanged = diffCollectionList(current, page([collection(1)], 3), {
		complete: false,
	});
	assert.equal(unchanged.changed, false);
	assert.strictEqual(unchanged.data, current);
	assertNoCollectionWrites(unchanged);

	const reordered = diffCollectionList(current, page([collection(2)], 3), {
		complete: false,
	});
	assert.equal(reordered.changed, true);
	assert.deepEqual(reordered.data.data, [current.data[1], current.data[0], current.data[2]]);
	assertNoCollectionWrites(reordered);

	const added = diffCollectionList(current, page([collection(4), collection(2)], 4), {
		complete: false,
	});
	assert.deepEqual(added.addedIds, [4]);
	assert.deepEqual(added.removedIds, []);
	assert.deepEqual(added.changedItems.map((item) => item.subject_id), [4]);
	assert.deepEqual(added.data.data.map((item) => item.subject_id), [4, 2, 1, 3]);
});

test("收藏：仅总数变化更新页元数据；全量空响应才删除全部成员", () => {
	const current = page([collection(1), collection(2)]);
	const totalOnly = diffCollectionList(current, page(clone(current.data), 5));
	assert.equal(totalOnly.changed, true);
	assert.equal(totalOnly.data.total, 5);
	assert.strictEqual(totalOnly.data.data[0], current.data[0]);
	assertNoCollectionWrites(totalOnly);
	const removed = diffCollectionList(current, page([]));
	assert.deepEqual(removed.removedIds, [1, 2]);
	assert.deepEqual(removed.changedItems, []);
	assert.deepEqual(removed.data.data, []);
	assert.equal(removed.data.total, 0);
});

test("日历：相同内容保留整份引用，首次加载返回所有需写入的预览", () => {
	const current = [day(1, [subject(1)]), day(2, [subject(2)])];
	const same = diffCalendar(current, clone(current));
	assert.equal(same.changed, false);
	assert.strictEqual(same.calendar, current);
	assert.deepEqual(same.changedSubjects, []);
	const initial = diffCalendar(undefined, current);
	assert.equal(initial.changed, true);
	assert.strictEqual(initial.calendar, current);
	assert.deepEqual(initial.changedSubjects, [current[0].items[0], current[1].items[0]]);
});

test("日历：仅新增或内容变化的条目写预览，未变条目保引用", () => {
	const current = [day(1, [subject(1), subject(2)]), day(2, [subject(3)])];
	const before = clone(current);
	const incoming = [day(1, [subject(1), { ...subject(2), name_cn: "新标题" }]), day(2, [subject(4)])];
	const diff = diffCalendar(current, incoming);
	assert.equal(diff.changed, true);
	assert.deepEqual(diff.changedSubjects, [incoming[0].items[1], incoming[1].items[0]]);
	assert.strictEqual(diff.calendar[0].items[0], current[0].items[0]);
	assert.strictEqual(diff.calendar[0].items[1], incoming[0].items[1]);
	assert.deepEqual(current, before);
	assert.equal(diffCalendar(diff.calendar, clone(incoming)).changed, false);
});

test("日历：跨星期移动、移除和清空更新日历，但不重写未变预览", () => {
	const current = [day(1, [subject(1)]), day(2, [subject(2)])];
	const moved = diffCalendar(current, [day(1, []), day(2, [subject(1)])]);
	assert.equal(moved.changed, true);
	assert.strictEqual(moved.calendar[1].items[0], current[0].items[0]);
	assert.deepEqual(moved.changedSubjects, []);
	const cleared = diffCalendar(current, []);
	assert.equal(cleared.changed, true);
	assert.deepEqual(cleared.calendar, []);
	assert.deepEqual(cleared.changedSubjects, []);
});

test("强制窗口：起点、有效期边界、过期回落与新轮次", () => {
	const window = createForceWindow();
	assert.equal(window.current(), 0);
	assert.equal(window.isActive(NOW), false);
	assert.equal(getForcedRoundStart(window, NOW), 0);
	assert.equal(window.request(NOW), NOW);
	assert.equal(window.current(), NOW);
	assert.equal(getForcedRoundStart(window, NOW + FORCE_WINDOW_MS - 1), NOW);
	assert.equal(window.isActive(NOW + FORCE_WINDOW_MS), false);
	assert.equal(getForcedRoundStart(window, NOW + FORCE_WINDOW_MS), 0);
	assert.equal(window.current(), NOW, "过期不应改写上轮起点");
	const next = NOW + FORCE_WINDOW_MS + 1;
	assert.equal(window.request(next), next);
	assert.equal(getForcedRoundStart(window, next), next);
	const short = createForceWindow(100);
	short.request(NOW);
	assert.equal(short.isActive(NOW + 99), true);
	assert.equal(short.isActive(NOW + 100), false);
});

test("AniList：缺失必查；未来排期即使手动刷新也不重查", () => {
	assert.equal(shouldRefreshAiringRecord(undefined, NOW), true);
	assert.equal(shouldRefreshAiringRecord(undefined, NOW, { roundStart: NOW }), true);
	const future = scheduled({ airingAt: (NOW + 1000) / 1000, fetchedAt: NOW - FORCE_WINDOW_MS });
	assert.equal(shouldRefreshAiringRecord(future, NOW), false);
	assert.equal(shouldRefreshAiringRecord(future, NOW, { roundStart: NOW }), false);
});

test("AniList：自动刷新遵守播出时刻、五分钟限流和 retryAfter", () => {
	const record = scheduled({ airingAt: NOW / 1000, fetchedAt: NOW - 1000 });
	const due = record.fetchedAt + AIRING_REFRESH_MIN_INTERVAL;
	assert.equal(shouldRefreshAiringRecord(record, due - 1), false);
	assert.equal(shouldRefreshAiringRecord(record, due), true);
	const atBroadcast = scheduled({ airingAt: NOW / 1000, fetchedAt: NOW - AIRING_REFRESH_MIN_INTERVAL });
	assert.equal(shouldRefreshAiringRecord(atBroadcast, NOW - 1), false);
	assert.equal(shouldRefreshAiringRecord(atBroadcast, NOW), true);
	const retry = { ...record, retryAfter: due + 60_000 };
	assert.equal(shouldRefreshAiringRecord(retry, retry.retryAfter - 1), false);
	assert.equal(shouldRefreshAiringRecord(retry, retry.retryAfter), true);
	assert.equal(shouldRefreshAiringRecord(retry, NOW, { roundStart: NOW }), true,
		"手动刷新对已播记录跳过 retryAfter 限流");
});

test("AniList：两种负缓存均保留24小时，Ctrl+R不能绕过", () => {
	for (const status of ["not_found", "no_schedule"]) {
		for (const roundStart of [0, NOW]) {
			for (const [age, expected] of [
				[1000, false],
				[AIRING_NEGATIVE_CACHE_MAX_AGE, false],
				[AIRING_NEGATIVE_CACHE_MAX_AGE + 1, true],
			]) {
				assert.equal(shouldRefreshAiringRecord({ status, fetchedAt: NOW - age }, NOW, { roundStart }),
					expected, `${status}: age=${age}, roundStart=${roundStart}`);
			}
		}
	}
});

test("剧集：缺失或无效缓存必查，空剧集表有效，常规有效期为30分钟", () => {
	for (const record of [undefined, null, {}, { episodes: [], checkedAt: "invalid" }]) {
		assert.equal(shouldRefreshEpisodeRecord(record, NOW), true);
		assert.equal(shouldRefreshEpisodeRecord(record, NOW, { roundStart: NOW }), true);
	}
	assert.equal(shouldRefreshEpisodeRecord({ episodes: [], checkedAt: NOW }, NOW), false);
	const record = { episodes: [], checkedAt: NOW - EPISODES_CACHE_MAX_AGE };
	assert.equal(shouldRefreshEpisodeRecord(record, NOW), false);
	assert.equal(shouldRefreshEpisodeRecord(record, NOW + 1), true);
});

test("真实强制窗口：本轮前缓存强查，本轮内结果长批次复用，新一轮重新判断", () => {
	// 页面在网络请求前登记这两个独立窗口，新增成员的组合 query 也沿用该轮起点。
	airingForceWindow.request(NOW);
	episodesForceWindow.request(NOW);
	const beforeAiring = scheduled();
	const beforeEpisodes = { episodes: [], checkedAt: NOW - 1 };
	assert.equal(shouldRefreshAiringRecord(beforeAiring, NOW), false);
	assert.equal(shouldRefreshEpisodeRecord(beforeEpisodes, NOW), false);
	assert.equal(shouldRefreshAiringRecord(beforeAiring, NOW, {
		roundStart: getForcedRoundStart(airingForceWindow, NOW),
	}), true);
	assert.equal(shouldRefreshEpisodeRecord(beforeEpisodes, NOW, {
		roundStart: getForcedRoundStart(episodesForceWindow, NOW),
	}), true);

	const delayed = NOW + 7 * 60_000;
	for (const fetchedAt of [NOW, NOW + 1]) {
		assert.equal(shouldRefreshAiringRecord(scheduled({ fetchedAt }), delayed, {
			roundStart: getForcedRoundStart(airingForceWindow, delayed),
		}), false, "不能按五分钟限流重新请求本轮已取得的排期");
		assert.equal(shouldRefreshEpisodeRecord({ episodes: [], checkedAt: fetchedAt }, delayed, {
			roundStart: getForcedRoundStart(episodesForceWindow, delayed),
		}), false, "checkedAt 等于或晚于起点都必须复用");
	}

	const nextRound = delayed + 1;
	episodesForceWindow.request(nextRound);
	assert.equal(airingForceWindow.current(), NOW, "两个数据源的窗口必须独立");
	airingForceWindow.request(nextRound);
	assert.equal(shouldRefreshAiringRecord(scheduled({ fetchedAt: NOW }), nextRound, {
		roundStart: getForcedRoundStart(airingForceWindow, nextRound),
	}), true);
	assert.equal(shouldRefreshEpisodeRecord({ episodes: [], checkedAt: NOW }, nextRound, {
		roundStart: getForcedRoundStart(episodesForceWindow, nextRound),
	}), true);
	const expired = nextRound + FORCE_WINDOW_MS;
	assert.equal(shouldRefreshEpisodeRecord({ episodes: [], checkedAt: NOW }, expired, {
		roundStart: getForcedRoundStart(episodesForceWindow, expired),
	}), false, "过期窗口回落到30分钟新鲜度");
});

test("排期汇总：按记录时间合并；仅刷新元数据不计为播出变化", () => {
	const old = scheduled({ fetchedAt: NOW - 1000 });
	const fresh = scheduled({ fetchedAt: NOW, retryAfter: NOW + 1000 });
	const merged = mergeAiringRecordMaps(new Map([[1, fresh]]), undefined, new Map([[1, old], [2, old]]));
	assert.strictEqual(merged.get(1), fresh);
	assert.strictEqual(merged.get(2), old);
	assert.equal(isSameAiringSchedule(old, fresh), true);
	assert.equal(isSameAiringSchedule(old, { ...fresh, episode: 4 }), false);
	assert.equal(isSameAiringSchedule(old, { ...fresh, airingAt: fresh.airingAt + 1 }), false);
	assert.equal(isSameAiringSchedule(undefined, fresh), false);
	assert.equal(isSameAiringSchedule(old, { status: "no_schedule", fetchedAt: NOW }), false);
	assert.equal(isSameAiringSchedule({ status: "not_found", fetchedAt: 1 }, { status: "not_found", fetchedAt: NOW }), true);
});

test("组合查询：成员变化按条目复用，迟到组合不得覆盖较新排期记录", () => {
	const fresh = scheduled({ fetchedAt: NOW });
	const old = scheduled({ fetchedAt: NOW - 1000 });
	// 仅模拟 QueryCache 的输入接口，合并和版本选择完全由真实模块执行。
	const cachedQueries = new Map([
		["anilist-airing-times-cache-v2", [{ state: { dataUpdatedAt: NOW, data: new Map([[1, fresh], [9, old]]) } }]],
		["anilist-airing-times-v2", [
			{ state: { dataUpdatedAt: NOW + 2000, data: new Map([[1, old], [2, old]]) } },
			{ state: { dataUpdatedAt: NOW + 3000, data: { invalid: true } } },
		]],
	]);
	const client = { getQueryCache: () => ({ findAll: ({ queryKey }) => cachedQueries.get(queryKey[0]) ?? [] }) };
	const keys = [["anilist-airing-times-cache-v2"], ["anilist-airing-times-v2"]];
	const result = readCachedQueryMap(client, keys, [1, 2, 3], (record) => record.fetchedAt);
	assert.deepEqual([...result.keys()], [1, 2]);
	assert.strictEqual(result.get(1), fresh);
	assert.strictEqual(result.get(2), old);
	assert.equal(readCachedQueryMap(client, keys, [3]), undefined);
	assert.strictEqual(readCachedQueryMap(client, keys, [1]).get(1), old,
		"无条目时间戳时回落到组合的 dataUpdatedAt");
});
