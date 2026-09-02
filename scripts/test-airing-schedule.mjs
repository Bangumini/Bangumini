// 在看页分钟级排期回归测试（零依赖，需要 Node ≥ 22.6）
// 运行：node --experimental-strip-types scripts/test-airing-schedule.mjs
import assert from "node:assert/strict";
import {
	deriveAiredEpisodeCount,
	deriveAiringSchedule,
	getEffectiveAiringAt,
	getNextEpisodeAiringAt,
} from "../shared/airing-schedule.ts";
import {
	getDisplayLabel,
	sortCollections,
} from "../shared/sort-collections.ts";

function jstTimestamp(date, hour, minute) {
	const [year, month, day] = date.split("-").map(Number);
	return Date.UTC(year, month - 1, day, hour - 9, minute);
}

function observation(date, hour, minute, episode) {
	return {
		airingAt: jstTimestamp(date, hour, minute) / 1000,
		episode,
		fetchedAt: jstTimestamp(date, hour, minute) - 60_000,
	};
}

const normalEpisodes = [
	{ ep: 6, airdate: "2026-08-14" },
	{ ep: 7, airdate: "2026-08-21" },
	{ ep: 8, airdate: "2026-08-28" },
];
const normalSchedule = deriveAiringSchedule(
	5,
	normalEpisodes,
	observation("2026-08-21", 22, 30, 7),
);
assert.equal(normalSchedule.dayOffset, 0);
assert.equal(normalSchedule.minuteOfDayJst, 22 * 60 + 30);
assert.equal(normalSchedule.confidence, "aligned");
assert.equal(
	deriveAiredEpisodeCount(
		normalEpisodes,
		normalSchedule,
		jstTimestamp("2026-08-21", 22, 29),
	),
	1,
	"普通条目在首播前不应提前计入",
);
assert.equal(
	deriveAiredEpisodeCount(
		normalEpisodes,
		normalSchedule,
		jstTimestamp("2026-08-21", 22, 30),
	),
	2,
	"普通条目到达首播时刻应立即计入",
);

const lateNightEpisodes = [
	{ ep: 7, airdate: "2026-08-14" },
	{ ep: 8, airdate: "2026-08-21" },
	{ ep: 9, airdate: "2026-08-28" },
];
const lateNightSchedule = deriveAiringSchedule(
	5,
	lateNightEpisodes,
	observation("2026-08-22", 1, 30, 8),
);
assert.equal(lateNightSchedule.dayOffset, 1);
assert.equal(lateNightSchedule.confidence, "aligned");
assert.equal(
	getEffectiveAiringAt(lateNightEpisodes[1], lateNightSchedule),
	jstTimestamp("2026-08-22", 1, 30),
	"周五 25:30 应转换为周六 01:30 JST",
);
assert.equal(
	deriveAiredEpisodeCount(
		lateNightEpisodes,
		lateNightSchedule,
		jstTimestamp("2026-08-22", 1, 29),
	),
	1,
	"深夜档在实际播出前仍应视为已追平",
);
assert.equal(
	deriveAiredEpisodeCount(
		lateNightEpisodes,
		lateNightSchedule,
		jstTimestamp("2026-08-22", 1, 30),
	),
	2,
	"深夜档到达实际播出时刻后应进入未追平状态",
);

const maidEpisodes = [
	{ ep: 8, airdate: "2026-08-19" },
	{ ep: 9, airdate: "2026-08-26" },
];
const maidSchedule = deriveAiringSchedule(
	3,
	maidEpisodes,
	observation("2026-08-26", 22, 30, 10),
);
assert.equal(
	maidSchedule.confidence,
	"track_conflict",
	"AniList 先行配信集号不得覆盖 BGM 集号",
);
assert.equal(maidSchedule.dayOffset, 0);
assert.equal(
	deriveAiredEpisodeCount(
		maidEpisodes,
		maidSchedule,
		jstTimestamp("2026-08-26", 22, 29),
	),
	1,
);
assert.equal(
	deriveAiredEpisodeCount(
		maidEpisodes,
		maidSchedule,
		jstTimestamp("2026-08-26", 22, 30),
	),
	2,
);

const streamingConflict = deriveAiringSchedule(
	4,
	[{ ep: 9, airdate: "2026-08-27" }],
	observation("2026-08-24", 22, 0, 9),
);
assert.equal(streamingConflict.confidence, "track_conflict");
assert.equal(streamingConflict.dayOffset, 0);
assert.equal(
	getEffectiveAiringAt({ ep: 9, airdate: "2026-08-27" }, streamingConflict),
	jstTimestamp("2026-08-27", 22, 0),
	"发行轨冲突时保留 BGM 日期，只提取 AniList 时分",
);

assert.equal(
	deriveAiredEpisodeCount(
		[{ ep: 1, airdate: "2026-08-23" }],
		null,
		jstTimestamp("2026-08-23", 0, 0),
	),
	1,
	"无 AniList 排期时退回 BGM 日期粒度",
);
assert.equal(
	getNextEpisodeAiringAt(
		lateNightEpisodes,
		lateNightSchedule,
		jstTimestamp("2026-08-22", 1, 29),
	),
	jstTimestamp("2026-08-22", 1, 30),
	"调度器应找到最近的绝对播出边界",
);

const subject = {
	id: 627136,
	name: "うしろの正面カムイさん",
	name_cn: "从后面来的神威先生",
	date: "2026-07-03",
	eps: 12,
	total_episodes: 12,
};
const collection = {
	subject_id: subject.id,
	subject,
	ep_status: 1,
};
const calendar = [{ weekday: { id: 5 }, items: [subject] }];
const airingSignalMap = new Map([
	[subject.id, observation("2026-08-22", 1, 30, 8)],
]);
const beforeSorted = sortCollections(
	[collection],
	calendar,
	6,
	new Map([[subject.id, 1]]),
	airingSignalMap,
	new Map([[subject.id, jstTimestamp("2026-08-22", 1, 30)]]),
);
assert.equal(
	beforeSorted[0].group,
	"airing_caught",
	"条目 X 在深夜首播前必须留在已追上进度组",
);
const afterBoundary = jstTimestamp("2026-08-22", 1, 30);
const afterNextAiringMap = new Map([
	[
		subject.id,
		getNextEpisodeAiringAt(lateNightEpisodes, lateNightSchedule, afterBoundary),
	],
]);
const afterSorted = sortCollections(
	[collection],
	calendar,
	6,
	new Map([[subject.id, 2]]),
	airingSignalMap,
	afterNextAiringMap,
);
assert.equal(
	afterSorted[0].group,
	"airing_not_caught",
	"条目 X 到达深夜首播时刻后必须进入第一组",
);
collection.ep_status = 2;
const caughtUpLabel = getDisplayLabel(
	collection,
	{ ...afterSorted[0], group: "airing_caught" },
	6,
	afterNextAiringMap,
	afterBoundary,
);
assert.match(
	caughtUpLabel,
	/^下周/,
	"今日播出结束后，下一集标签不得错误显示为今日",
);

const liarGameEpisodes = [
	...Array.from({ length: 20 }, (_, index) => ({
		ep: index + 1,
		airdate: "2026-08-17",
	})),
	{ ep: 21, airdate: "2026-08-24" },
	{ ep: 22, airdate: "2026-08-31" },
];
const liarGameObservation = observation("2026-08-25", 0, 0, 21);
const liarGameSchedule = deriveAiringSchedule(
	undefined,
	liarGameEpisodes,
	liarGameObservation,
);
assert.equal(
	liarGameSchedule.dayOffset,
	1,
	"缺少 BGM calendar weekday 时也应从同集 airdate 识别 24:00 跨日",
);
const liarGameMondayMorning = jstTimestamp("2026-08-24", 10, 0);
const liarGameAiredEp = deriveAiredEpisodeCount(
	liarGameEpisodes,
	liarGameSchedule,
	liarGameMondayMorning,
);
const liarGameCollection = {
	subject_id: 580133,
	subject: {
		id: 580133,
		name: "LIAR GAME",
		name_cn: "欺诈游戏",
		date: "2026-04-06",
		eps: 24,
		total_episodes: 24,
	},
	ep_status: 20,
};
const liarGameSorted = sortCollections(
	[liarGameCollection],
	[],
	1,
	new Map([[580133, liarGameAiredEp]]),
	new Map([[580133, liarGameObservation]]),
	new Map([[580133, jstTimestamp("2026-08-25", 0, 0)]]),
);
assert.equal(
	liarGameSorted[0].group,
	"airing_caught",
	"欺诈游戏在周一上午、当晚 23:00（中国时间）放送前必须留在已追平组",
);

const doublePremiereEpisodes = [
	{ ep: 1, airdate: "2026-07-05" },
	{ ep: 2, airdate: "2026-07-05" },
	{ ep: 3, airdate: "2026-07-12" },
];
const doublePremiereSchedule = deriveAiringSchedule(
	7,
	doublePremiereEpisodes,
	observation("2026-07-05", 23, 0, 2),
);
assert.equal(doublePremiereSchedule.confidence, "aligned");
assert.equal(
	deriveAiredEpisodeCount(
		doublePremiereEpisodes,
		doublePremiereSchedule,
		jstTimestamp("2026-07-05", 22, 59),
	),
	0,
);
assert.equal(
	deriveAiredEpisodeCount(
		doublePremiereEpisodes,
		doublePremiereSchedule,
		jstTimestamp("2026-07-05", 23, 0),
	),
	2,
	"BGM 同日双集首播应在同一边界一次计入两集",
);

// 未开始看（ep_status=0）且不在 BGM 日历的条目：只要 AniList 给出
// scheduled 信号，就必须按在播分组，不得误判为"完结 · 未观看"
const unstartedSubject = {
	id: 900001,
	name: "Unstarted Airing Show",
	name_cn: "未开始看的在播番",
	date: "2026-07-10",
	eps: 12,
	total_episodes: 12,
};
const unstartedCollection = {
	subject_id: unstartedSubject.id,
	subject: unstartedSubject,
	ep_status: 0,
};
const unstartedObservation = observation("2026-08-28", 22, 30, 8);
const unstartedSorted = sortCollections(
	[unstartedCollection],
	[], // 不在 BGM 日历
	5,
	new Map([[unstartedSubject.id, 7]]),
	new Map([[unstartedSubject.id, unstartedObservation]]),
	new Map([[unstartedSubject.id, jstTimestamp("2026-09-04", 22, 30)]]),
);
assert.equal(
	unstartedSorted[0].group,
	"airing_not_caught",
	"未开始看的在播条目（非日历 + AniList scheduled）不得落入完结 · 未观看",
);
const finishedSorted = sortCollections(
	[unstartedCollection],
	[],
	5,
	new Map(),
	new Map(),
	new Map(),
);
assert.equal(
	finishedSorted[0].group,
	"finished_unwatched",
	"无在播信号时未开始看的条目仍应归入完结 · 未观看",
);

process.stdout.write("airing schedule: 全部通过 ✓\n");
