import type { CalendarItem, UserCollection } from "./api/types";

export function getTodayBangumiWeekday(): number {
	const jsDay = new Date().getDay();
	return jsDay === 0 ? 7 : jsDay;
}

function getTodayDateKey(): string {
	const d = new Date();
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function weekdayOffset(weekday: number, today: number): number {
	return (weekday - today + 7) % 7;
}

function getTotalEp(c: UserCollection): number {
	return c.subject.total_episodes || c.subject.eps || 0;
}

function getWeekdayFromDate(dateStr: string): number {
	const parts = dateStr.split("-").map(Number);
	if (parts.length !== 3) return 0;
	const jsDay = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
	return jsDay === 0 ? 7 : jsDay;
}

/** 从 Unix 时间戳（秒）提取当天分钟数（0-1439），用于同一天内按播出时刻排序 */
export function getAiringMinutes(airingAt: number): number {
	const d = new Date(airingAt * 1000);
	return d.getHours() * 60 + d.getMinutes();
}

export type SortedGroup =
	| "airing_not_caught"
	| "finished_started"
	| "finished_unwatched"
	| "completed"
	| "airing_caught"
	| "pre_air";

export interface CollectionMeta {
	group: SortedGroup;
	weekday: number;
	airedEp: number;
}

export interface SortedCollection extends CollectionMeta {
	collection: UserCollection;
}

export function getCollectionMeta(
	c: UserCollection,
	airingMap: Map<number, number>,
	airedEpMap: Map<number, number>,
	today: number,
	airingTimeMap?: Map<number, { airingAt: number; episode: number }>,
): CollectionMeta {
	const weekday =
		airingMap.get(c.subject_id) ??
		c.subject.air_weekday ??
		(c.subject.date ? getWeekdayFromDate(c.subject.date) : 0);
	const totalEp = getTotalEp(c);
	// 两级判定：Bangumi 日历为主，AniList nextAiringEpisode 为兜底
	// AniList 返回 nextAiringEpisode 说明作品确实在播，不会有误判
	const isAiring =
		airingMap.has(c.subject_id) || airingTimeMap?.has(c.subject_id);
	const knownAiredEp = isAiring ? airedEpMap.get(c.subject_id) : totalEp;
	const airedEp = knownAiredEp ?? Math.max(1, c.ep_status);

	// 检查今日是否尚未到播出时刻
	let effectiveAiredEp = airedEp;
	if (isAiring && weekday > 0 && weekday === today && airingTimeMap) {
		const airingTime = airingTimeMap.get(c.subject_id);
		if (airingTime) {
			const airingMinutes = getAiringMinutes(airingTime.airingAt);
			const now = new Date();
			const nowMinutes = now.getHours() * 60 + now.getMinutes();
			if (nowMinutes < airingMinutes) {
				effectiveAiredEp = Math.max(0, airedEp - 1);
			}
		}
	}

	let group: SortedGroup;
	const todayDateKey = getTodayDateKey();

	if (isAiring && c.subject.date && c.subject.date > todayDateKey) {
		group = "pre_air";
	} else if (totalEp > 0 && c.ep_status >= totalEp) {
		group = "completed";
	} else if (!isAiring && c.ep_status === 0) {
		group = "finished_unwatched";
	} else if (isAiring && c.ep_status < effectiveAiredEp) {
		group = "airing_not_caught";
	} else if (isAiring) {
		group = "airing_caught";
	} else {
		// 不在日历中、ep > 0 → 完结作品在补番中
		group = "finished_started";
	}

	return { group, weekday, airedEp };
}

export function sortCollections(
	collections: UserCollection[],
	calendar: CalendarItem[],
	today: number,
	airedEpMap: Map<number, number>,
	airingTimeMap?: Map<number, { airingAt: number; episode: number }>,
): SortedCollection[] {
	const airingMap = new Map<number, number>();
	for (const day of calendar) {
		for (const item of day.items) {
			airingMap.set(item.id, day.weekday.id);
		}
	}

	const groupI: { c: UserCollection; meta: CollectionMeta }[] = [];
	const groupIIa: { c: UserCollection; meta: CollectionMeta }[] = [];
	const groupIIb: { c: UserCollection; meta: CollectionMeta }[] = [];
	const groupIII: { c: UserCollection; meta: CollectionMeta }[] = [];
	const groupIV: { c: UserCollection; meta: CollectionMeta }[] = [];
	const groupV: { c: UserCollection; meta: CollectionMeta }[] = [];

	for (const c of collections) {
		const meta = getCollectionMeta(
			c,
			airingMap,
			airedEpMap,
			today,
			airingTimeMap,
		);
		switch (meta.group) {
			case "airing_not_caught":
				groupI.push({ c, meta });
				break;
			case "finished_started":
				groupIIa.push({ c, meta });
				break;
			case "finished_unwatched":
				groupIIb.push({ c, meta });
				break;
			case "airing_caught":
				groupIII.push({ c, meta });
				break;
			case "pre_air":
				groupV.push({ c, meta });
				break;
			case "completed":
				groupIV.push({ c, meta });
				break;
		}
	}

	// Group I / III：按 weekdayOffset 升序，同天按播出时分升序，缺失时按名称字典序兜底
	const sortByWeekdayThenTime = (
		a: { c: UserCollection },
		b: { c: UserCollection },
	) => {
		const wa = airingMap.get(a.c.subject_id) ?? 0;
		const wb = airingMap.get(b.c.subject_id) ?? 0;
		const offsetDiff = weekdayOffset(wa, today) - weekdayOffset(wb, today);
		if (offsetDiff !== 0) return offsetDiff;

		const ta = airingTimeMap?.get(a.c.subject_id);
		const tb = airingTimeMap?.get(b.c.subject_id);
		if (ta && tb) {
			const minDiff =
				getAiringMinutes(ta.airingAt) - getAiringMinutes(tb.airingAt);
			if (minDiff !== 0) return minDiff;
		}

		return (a.c.subject.name_cn || a.c.subject.name).localeCompare(
			b.c.subject.name_cn || b.c.subject.name,
		);
	};

	groupI.sort(sortByWeekdayThenTime);
	groupIII.sort(sortByWeekdayThenTime);

	// Group V：按开播日期数值排序
	groupV.sort((a, b) => {
		const [ay, am, ad] = (a.c.subject.date || "").split("-").map(Number);
		const [by, bm, bd] = (b.c.subject.date || "").split("-").map(Number);
		return ay - by || am - bm || ad - bd;
	});

	// IIa, IIb, IV：保持 API 原始顺序，不排序

	const result: SortedCollection[] = [];
	for (const { c, meta } of [
		...groupI,
		...groupIIa,
		...groupIIb,
		...groupIII,
		...groupV,
		...groupIV,
	]) {
		result.push({ collection: c, ...meta });
	}
	return result;
}

/** 分组中文显示名称 */
export const GROUP_LABEL: Record<SortedGroup, string> = {
	airing_not_caught: "未追上进度",
	finished_started: "完结 · 观看中",
	finished_unwatched: "完结 · 未观看",
	airing_caught: "已追上进度",
	pre_air: "即将开播",
	completed: "已看完",
};

export function getDisplayLabel(
	c: UserCollection,
	meta: CollectionMeta,
	today: number,
	airingTimeMap?: Map<number, { airingAt: number; episode: number }>,
): string | null {
	const { group, weekday, airedEp } = meta;

	if (group === "pre_air") {
		if (c.subject.date) {
			const parts = c.subject.date.split("-");
			if (parts.length === 3) {
				const m = parseInt(parts[1], 10);
				const d = parseInt(parts[2], 10);
				return `${m}月${d}日 开播`;
			}
		}
		return "即将开播";
	}

	if (group === "airing_caught") {
		if (weekday <= 0) return "等待更新";

		let label: string;
		let showTodayAsNextWeek = false;

		if (weekday === today && airingTimeMap) {
			const airingTime = airingTimeMap.get(c.subject_id);
			if (airingTime) {
				const airingMinutes = getAiringMinutes(airingTime.airingAt);
				const now = new Date();
				const nowMinutes = now.getHours() * 60 + now.getMinutes();
				if (nowMinutes >= airingMinutes && c.ep_status >= airedEp) {
					showTodayAsNextWeek = true;
				}
			}
		}

		if (weekday === today && !showTodayAsNextWeek) {
			label = "今日";
		} else {
			const tomorrow = today >= 7 ? 1 : today + 1;
			label =
				weekday === tomorrow
					? "明日"
					: WEEKDAY_CN[weekday].replace("星期", "周");
		}

		const at = airingTimeMap?.get(c.subject_id);
		if (at) {
			const d = new Date(at.airingAt * 1000);
			const hh = String(d.getHours()).padStart(2, "0");
			const mm = String(d.getMinutes()).padStart(2, "0");
			if (showTodayAsNextWeek) {
				return `下周${label} ${hh}:${mm} 更新`;
			}
			return `${label} ${hh}:${mm} 更新`;
		}

		return `${label}更新`;
	}

	if (group === "airing_not_caught" || group === "finished_started") {
		return `继续观看 ${c.ep_status + 1}`;
	}

	if (group === "completed") {
		return "已看完";
	}

	if (group === "finished_unwatched") {
		return "开始观看";
	}

	return null;
}

export const WEEKDAY_CN: Record<number, string> = {
	1: "星期一",
	2: "星期二",
	3: "星期三",
	4: "星期四",
	5: "星期五",
	6: "星期六",
	7: "星期日",
};
