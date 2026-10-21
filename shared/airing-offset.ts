import type { CalendarItem, Episode, UserCollection } from "./api/types";

export const MAX_AIRING_OFFSET_DAYS = 365;
export type AiringOffsets = Readonly<Record<number, number>>;

export function isValidAiringOffsetDays(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		Math.abs(value) <= MAX_AIRING_OFFSET_DAYS
	);
}

export function formatAiringOffsetDays(days: number): string {
	if (!isValidAiringOffsetDays(days) || days === 0) return "默认排期";
	return days < 0 ? `提前${-days}天` : `延后${days}天`;
}

/** 只平移日期，不改变剧集编号或原始缓存；空日期和无效日期保持原样。 */
export function shiftAiringDate(dateKey: string, offsetDays: number): string {
	if (!isValidAiringOffsetDays(offsetDays) || offsetDays === 0) return dateKey;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return dateKey;
	const timestamp = Date.parse(`${dateKey}T00:00:00.000Z`);
	if (!Number.isFinite(timestamp)) return dateKey;
	if (new Date(timestamp).toISOString().slice(0, 10) !== dateKey) return dateKey;
	const shifted = new Date(timestamp + offsetDays * 86_400_000).toISOString();
	return /^\d{4}-/.test(shifted) ? shifted.slice(0, 10) : dateKey;
}

export function shiftAiringWeekday(
	weekday: number | undefined,
	offsetDays: number,
): number | undefined {
	if (weekday === undefined || weekday < 1 || weekday > 7) return undefined;
	if (!isValidAiringOffsetDays(offsetDays)) return weekday;
	return ((weekday - 1 + (offsetDays % 7) + 7) % 7) + 1;
}

export function applyEpisodeAiringOffset<T extends Pick<Episode, "airdate">>(
	episodes: T[],
	offsetDays: number,
): T[] {
	if (!isValidAiringOffsetDays(offsetDays) || offsetDays === 0) return episodes;
	return episodes.map((episode) => ({
		...episode,
		airdate: shiftAiringDate(episode.airdate, offsetDays),
	}));
}

export function applySubjectAiringOffset<
	T extends { date?: string; air_date?: string; air_weekday?: number },
>(subject: T, offsetDays: number): T {
	if (!isValidAiringOffsetDays(offsetDays) || offsetDays === 0) return subject;
	return {
		...subject,
		...(typeof subject.date === "string"
			? { date: shiftAiringDate(subject.date, offsetDays) }
			: {}),
		...(typeof subject.air_date === "string"
			? { air_date: shiftAiringDate(subject.air_date, offsetDays) }
			: {}),
		air_weekday: shiftAiringWeekday(subject.air_weekday, offsetDays),
	};
}

/** 仅创建渲染投影；绝不将修正写回收藏同步任务或 API 缓存。 */
export function applyCollectionAiringOffsets(
	collections: UserCollection[],
	offsets: AiringOffsets,
): UserCollection[] {
	return collections.map((collection) => {
		const subject = applySubjectAiringOffset(
			collection.subject,
			offsets[collection.subject_id] ?? 0,
		);
		return subject === collection.subject ? collection : { ...collection, subject };
	});
}

/** 只有正篇排期完整且总集数明确时，才按手动修正后的末集判断是否仍在播。 */
export function deriveManualAiringStates(
	collections: UserCollection[],
	episodeListMap: ReadonlyMap<number, Pick<Episode, "airdate">[]>,
	airedEpMap: ReadonlyMap<number, number>,
	offsets: AiringOffsets,
): Map<number, boolean> {
	const states = new Map<number, boolean>();
	for (const collection of collections) {
		const id = collection.subject_id;
		if (!offsets[id]) continue;
		const total = collection.subject.total_episodes || collection.subject.eps;
		const episodes = episodeListMap.get(id);
		const aired = airedEpMap.get(id);
		if (!Number.isInteger(total) || total <= 0 || episodes?.length !== total || aired === undefined) continue;
		const datesComplete = episodes.every(({ airdate }) => {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(airdate)) return false;
			const timestamp = Date.parse(`${airdate}T00:00:00Z`);
			return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === airdate;
		});
		if (datesComplete) states.set(id, aired < total);
	}
	return states;
}

const WEEKDAYS = [
	{ id: 1, en: "Monday", cn: "星期一", ja: "月曜日" },
	{ id: 2, en: "Tuesday", cn: "星期二", ja: "火曜日" },
	{ id: 3, en: "Wednesday", cn: "星期三", ja: "水曜日" },
	{ id: 4, en: "Thursday", cn: "星期四", ja: "木曜日" },
	{ id: 5, en: "Friday", cn: "星期五", ja: "金曜日" },
	{ id: 6, en: "Saturday", cn: "星期六", ja: "土曜日" },
	{ id: 7, en: "Sunday", cn: "星期日", ja: "日曜日" },
];

/** 日期偏置也影响日历分组；保留源数据及各日元信息，不修改缓存。 */
export function applyCalendarAiringOffsets(
	calendar: CalendarItem[],
	offsets: AiringOffsets,
): CalendarItem[] {
	if (!calendar.some((day) => day.items.some((item) => offsets[item.id]))) {
		return calendar;
	}
	const days = new Map<number, CalendarItem>(
		calendar.map((day) => [day.weekday.id, { ...day, items: [] }]),
	);
	for (const day of calendar) {
		for (const item of day.items) {
			const offset = offsets[item.id] ?? 0;
			const weekday = shiftAiringWeekday(day.weekday.id, offset) ?? day.weekday.id;
			let target = days.get(weekday);
			if (!target) {
				target = { weekday: WEEKDAYS[weekday - 1], items: [] };
				days.set(weekday, target);
			}
			target.items.push(applySubjectAiringOffset(item, offset));
		}
	}
	return [...days.values()].sort((left, right) => left.weekday.id - right.weekday.id);
}
