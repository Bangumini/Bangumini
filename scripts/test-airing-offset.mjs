// 本地日期偏置的排期、排序与日历回归测试；不请求网络。
import assert from "node:assert/strict";
import {
	MAX_AIRING_OFFSET_DAYS,
	applyCalendarAiringOffsets,
	applyCollectionAiringOffsets,
	applyEpisodeAiringOffset,
	formatAiringOffsetDays,
	deriveManualAiringStates,
	isValidAiringOffsetDays,
	shiftAiringDate,
	shiftAiringWeekday,
} from "../shared/airing-offset.ts";
import {
	deriveAiredEpisodeCount,
	deriveAiringSchedule,
	getEffectiveAiringAt,
	getLatestEpisodeAiringAt,
	getNextEpisodeAiringAt,
	isRecentlyAired,
} from "../shared/airing-schedule.ts";
import { getDisplayLabel, sortCollections } from "../shared/sort-collections.ts";

const at = (date, hour = 22, minute = 30) => Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);
const observe = (date, hour, minute, episode) => ({ airingAt: at(date, hour, minute) / 1000, episode, fetchedAt: 1 });
for (const value of [0, -1, 1, -7, 7, -MAX_AIRING_OFFSET_DAYS, MAX_AIRING_OFFSET_DAYS]) assert.ok(isValidAiringOffsetDays(value));
for (const value of [0.5, -0.5, NaN, Infinity, "1", null, undefined, MAX_AIRING_OFFSET_DAYS + 1]) assert.equal(isValidAiringOffsetDays(value), false);
assert.equal(formatAiringOffsetDays(0), "默认排期");
assert.equal(formatAiringOffsetDays(-1), "提前1天");
assert.equal(formatAiringOffsetDays(1), "延后1天");
assert.equal(shiftAiringDate("2026-01-01", -1), "2025-12-31");
assert.equal(shiftAiringDate("2024-02-28", 1), "2024-02-29");
assert.equal(shiftAiringDate("2026-02-28", 1), "2026-03-01");
assert.equal(shiftAiringDate("2026-12-31", 1), "2027-01-01");
for (const date of ["", "invalid", "2026-02-30", "2026-13-01"]) assert.equal(shiftAiringDate(date, -1), date);
assert.equal(shiftAiringWeekday(1, -1), 7);
assert.equal(shiftAiringWeekday(7, 1), 1);
assert.equal(shiftAiringWeekday(6, -7), 6);
assert.equal(shiftAiringWeekday(undefined, 1), undefined);

// 真实条目 616808：修正后应按网络先行轨计算，而不是直接给已播集数加1。
const raw = Array.from({ length: 12 }, (_, index) => ({ ep: index + 1, sort: index + 13, airdate: shiftAiringDate("2026-10-03", index * 7) }));
const original = structuredClone(raw);
const observation = observe("2026-10-24", 22, 30, 5);
const now = at("2026-10-21");
const baseline = deriveAiringSchedule(6, raw, observation);
assert.equal(baseline.confidence, "track_conflict");
assert.equal(deriveAiredEpisodeCount(raw, baseline, now), 3);
const early = applyEpisodeAiringOffset(raw, -7);
const corrected = deriveAiringSchedule(6, raw, observation);
assert.equal(corrected.confidence, "track_conflict", "源数据冲突仍保留，用户偏置单独叠加");
assert.equal(deriveAiredEpisodeCount(early, corrected, now), 4);
assert.equal(getNextEpisodeAiringAt(early, corrected, now), at("2026-10-24"));
assert.equal(getLatestEpisodeAiringAt(early, corrected, now), at("2026-10-17"));
assert.equal(isRecentlyAired(getLatestEpisodeAiringAt(early, corrected, at("2026-10-17") + 1), at("2026-10-17") + 1), true);
assert.equal(deriveAiredEpisodeCount(early, corrected, at("2026-09-25")), 0);
assert.equal(deriveAiredEpisodeCount(early, corrected, at("2026-12-20")), 12);
assert.deepEqual(raw, original, "不得修改缓存中的原始日期、ep 或 sort");
assert.equal(applyEpisodeAiringOffset(raw, 0), raw);

// 固定真实 AniList 观测，只调整本地设置；偏置不能被跨日识别抵消。
const rawLateNight = [{ ep: 1, airdate: "2026-08-21" }];
const fixedObservation = observe("2026-08-22", 1, 30, 1);
for (const days of [-7, -1, 1, 7]) {
	const episodes = applyEpisodeAiringOffset(rawLateNight, days);
	const actual = shiftAiringDate("2026-08-22", days);
	const schedule = deriveAiringSchedule(5, rawLateNight, fixedObservation);
	assert.equal(schedule.dayOffset, 1);
	assert.equal(schedule.confidence, "aligned");
	assert.equal(getEffectiveAiringAt(episodes[0], schedule), at(actual, 1, 30));
	assert.equal(deriveAiredEpisodeCount(episodes, schedule, at(actual, 1, 29)), 0);
	assert.equal(deriveAiredEpisodeCount(episodes, schedule, at(actual, 1, 30)), 1);
}
const shiftedWithoutAniList = applyEpisodeAiringOffset([{ ep: 1, airdate: "2026-08-21" }, { ep: 2, airdate: "" }], -1);
assert.equal(deriveAiredEpisodeCount(shiftedWithoutAniList, null, at("2026-08-20", 0, 0)), 1, "无 AniList 时，日期粒度兜底也要修正");
assert.equal(getNextEpisodeAiringAt(shiftedWithoutAniList, null, now), null, "不能为未知时分编造精确倒计时");

const localKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const today = localKey(new Date());
const subject = { id: 616808, type: 2, date: shiftAiringDate(today, 1), air_weekday: 6, total_episodes: 12, eps: 12 };
const collection = { subject_id: subject.id, subject, type: 3, ep_status: 0 };
const untouched = { ...collection, subject_id: 9, subject: { ...subject, id: 9 } };
const collections = [collection, untouched];
const projected = applyCollectionAiringOffsets(collections, { 616808: -1 });
assert.equal(projected[0].subject.date, today);
assert.equal(projected[0].subject.air_weekday, 5);
assert.equal(projected[0].ep_status, collection.ep_status);
assert.equal(projected[1], untouched, "其他条目不能受到影响");
assert.equal(collection.subject.date, shiftAiringDate(today, 1));
const calendar = [{ weekday: { id: 6, en: "Saturday", cn: "星期六", ja: "土曜日" }, items: [{ id: 616808, air_date: subject.date, air_weekday: 6 }, { id: 9, air_date: subject.date, air_weekday: 6 }] }];
const beforeCalendar = structuredClone(calendar);
const shiftedCalendar = applyCalendarAiringOffsets(calendar, { 616808: -1 });
assert.equal(shiftedCalendar.find((day) => day.weekday.id === 5).items[0].id, 616808);
assert.equal(shiftedCalendar.find((day) => day.weekday.id === 5).items[0].air_date, today);
assert.deepEqual(shiftedCalendar.find((day) => day.weekday.id === 6).items.map((item) => item.id), [9]);
assert.deepEqual(calendar, beforeCalendar);
assert.equal(applyCalendarAiringOffsets(calendar, {}), calendar);
const aired = new Map([[616808, 1]]);
const sorted = sortCollections([projected[0]], shiftedCalendar, 5, aired);
assert.equal(sorted[0].group, "airing_not_caught", "提前开播后不能仍读取原 subject.date 判定未开播");
assert.equal(sorted[0].weekday, 5);
const postponed = applyCollectionAiringOffsets([collection], { 616808: 1 });
const postponedSort = sortCollections(postponed, applyCalendarAiringOffsets(calendar, { 616808: 1 }), 5, new Map());
assert.equal(postponedSort[0].group, "pre_air");
const expectedDate = postponed[0].subject.date.split("-").map(Number);
assert.equal(getDisplayLabel(postponed[0], postponedSort[0], 5, new Map(), Date.now()), `${expectedDate[1]}月${expectedDate[2]}日 开播`);
// 手动轨的完结与延期：不被原日历/旧 AniList 在播信号绑住。
const completeCollection = { ...collection, ep_status: 3, subject: { ...subject, date: "2026-09-26" } };
const endedAired = new Map([[616808, 12]]);
const completeStates = deriveManualAiringStates([completeCollection], new Map([[616808, early]]), endedAired, { 616808: -7 });
assert.equal(completeStates.get(616808), false);
assert.equal(sortCollections([completeCollection], calendar, 5, endedAired, new Map([[616808, observation]]), new Map(), completeStates)[0].group, "finished_started");
const postponedStates = deriveManualAiringStates([completeCollection], new Map([[616808, raw]]), new Map([[616808, 11]]), { 616808: 7 });
assert.equal(sortCollections([completeCollection], [], 5, new Map([[616808, 11]]), new Map(), new Map(), postponedStates)[0].group, "airing_not_caught", "延期后的末集仍未播时应继续在播");
assert.equal(deriveManualAiringStates([completeCollection], new Map([[616808, early.slice(0, 11)]]), endedAired, { 616808: -7 }).size, 0, "不完整的剧集列表不能推定完结");
assert.equal(deriveManualAiringStates([completeCollection], new Map([[616808, early]]), endedAired, {}).size, 0, "默认0不改变原在播策略");
console.log("airing offset: 全部通过 ✓");
