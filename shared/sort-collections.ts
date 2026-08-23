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

function getBangumiWeekdayFromDate(date: Date): number {
	const jsDay = date.getDay();
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
	airingSignalMap?: ReadonlyMap<number, unknown>,
	nextAiringAtMap?: ReadonlyMap<number, number>,
): CollectionMeta {
	const nextAiringAt = nextAiringAtMap?.get(c.subject_id);
	const nextAiringWeekday = nextAiringAt
		? getBangumiWeekdayFromDate(new Date(nextAiringAt))
		: 0;
	const weekday =
		nextAiringWeekday ||
		airingMap.get(c.subject_id) ||
		c.subject.air_weekday ||
		(c.subject.date ? getWeekdayFromDate(c.subject.date) : 0);
	const totalEp = getTotalEp(c);
	// BGM 日历为主要在播信号；AniList 仅在 BGM 日历缺失时辅助判定。
	const isAiring =
		airingMap.has(c.subject_id) || Boolean(airingSignalMap?.has(c.subject_id));
	const knownAiredEp = isAiring ? airedEpMap.get(c.subject_id) : totalEp;
	// BGM 剧集数据缺失时保持当前进度，避免网络失败把条目提前推入未追平组。
	const airedEp = knownAiredEp ?? c.ep_status;

	let group: SortedGroup;
	const todayDateKey = getTodayDateKey();

	if (isAiring && c.subject.date && c.subject.date > todayDateKey) {
		group = "pre_air";
	} else if (totalEp > 0 && c.ep_status >= totalEp) {
		group = "completed";
	} else if (!isAiring && c.ep_status === 0) {
		group = "finished_unwatched";
	} else if (isAiring && c.ep_status < airedEp) {
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
	airingSignalMap?: ReadonlyMap<number, unknown>,
	nextAiringAtMap?: ReadonlyMap<number, number>,
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
			airingSignalMap,
			nextAiringAtMap,
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
			default: {
				const exhaustiveGroup: never = meta.group;
				throw new Error(`Unknown collection group: ${exhaustiveGroup}`);
			}
		}
	}

	// Group I / III：按 weekdayOffset 升序，同天按播出时分升序，缺失时按名称字典序兜底
	const sortByWeekdayThenTime = (
		a: { c: UserCollection },
		b: { c: UserCollection },
	) => {
		const ta = nextAiringAtMap?.get(a.c.subject_id);
		const tb = nextAiringAtMap?.get(b.c.subject_id);
		const wa = ta
			? getBangumiWeekdayFromDate(new Date(ta))
			: (airingMap.get(a.c.subject_id) ?? 0);
		const wb = tb
			? getBangumiWeekdayFromDate(new Date(tb))
			: (airingMap.get(b.c.subject_id) ?? 0);
		const offsetDiff = weekdayOffset(wa, today) - weekdayOffset(wb, today);
		if (offsetDiff !== 0) return offsetDiff;
		if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;

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

/** 分组左侧强调色 */
export const GROUP_COLOR: Record<SortedGroup, string> = {
	airing_not_caught: "#f59e0b", // 琥珀 — 需要追赶
	finished_started: "#60a5fa", // 浅蓝 — 补番进行中
	finished_unwatched: "#94a3b8", // 石板灰 — 尚未开始
	airing_caught: "#34d399", // 翠绿 — 已同步
	pre_air: "#e879f9", // 品红 — 即将开播
	completed: "#eab308", // 金黄 — 已看完
};

export function getDisplayLabel(
	c: UserCollection,
	meta: CollectionMeta,
	today: number,
	nextAiringAtMap: ReadonlyMap<number, number> | undefined,
	nowMs: number,
): string | null {
	const { group, weekday } = meta;

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

		const nextAiringAt = nextAiringAtMap?.get(c.subject_id);
		const effectiveWeekday = nextAiringAt
			? getBangumiWeekdayFromDate(new Date(nextAiringAt))
			: weekday;
		const tomorrow = today >= 7 ? 1 : today + 1;
		let label: string;

		if (nextAiringAt !== undefined) {
			const date = new Date(nextAiringAt);
			const now = new Date(nowMs);
			const currentDay = Date.UTC(
				now.getFullYear(),
				now.getMonth(),
				now.getDate(),
			);
			const airingDay = Date.UTC(
				date.getFullYear(),
				date.getMonth(),
				date.getDate(),
			);
			const dayOffset = Math.round((airingDay - currentDay) / 86_400_000);
			if (dayOffset === 0) label = "今日";
			else if (dayOffset === 1) label = "明日";
			else {
				const weekdayName = WEEKDAY_CN[effectiveWeekday];
				label =
					dayOffset >= 7
						? `下周${weekdayName.replace("星期", "")}`
						: weekdayName.replace("星期", "周");
			}

			const hh = String(date.getHours()).padStart(2, "0");
			const mm = String(date.getMinutes()).padStart(2, "0");
			return `${label} ${hh}:${mm} 更新`;
		}

		if (effectiveWeekday === today) label = "今日";
		else if (effectiveWeekday === tomorrow) label = "明日";
		else label = WEEKDAY_CN[effectiveWeekday].replace("星期", "周");
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
