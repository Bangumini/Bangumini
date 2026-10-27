import type { CalendarItem, UserCollection } from "./api/types.ts";

export type AiringTimeTarget = {
	subjectId: number;
	name: string;
	nameCn: string;
};

export type AiringSubjectSelection = {
	airingIds: number[];
	staleAiringIds: number[];
	allEpisodeIds: number[];
	targets: AiringTimeTarget[];
};

const EMPTY_SELECTION: AiringSubjectSelection = {
	airingIds: [],
	staleAiringIds: [],
	allEpisodeIds: [],
	targets: [],
};

export function buildAiringWeekdayMap(calendar: CalendarItem[] | undefined) {
	const map = new Map<number, number>();
	if (!calendar) return map;

	for (const day of calendar) {
		for (const item of day.items) {
			map.set(item.id, day.weekday.id);
		}
	}
	return map;
}

/**
 * 选出需要 AniList 播出时间与 BGM 剧集表的条目。
 * BGM 日历是在播的一级信号；未收录进日历且未看完的条目需要 AniList 二次确认。
 */
export function selectAiringSubjects(
	collections: readonly UserCollection[],
	calendar: CalendarItem[] | undefined,
	{ watching }: { watching: boolean },
): AiringSubjectSelection {
	if (!watching) return EMPTY_SELECTION;

	const airingMap = buildAiringWeekdayMap(calendar);
	const airingIds = collections
		.filter((item) => airingMap.has(item.subject_id))
		.map((item) => item.subject_id);
	const staleAiringIds = collections
		.filter((item) => !airingMap.has(item.subject_id))
		.filter((item) => {
			const total = item.subject.eps || item.subject.total_episodes || 0;
			return total === 0 || item.ep_status < total;
		})
		.map((item) => item.subject_id);

	const targetIds = new Set([...airingIds, ...staleAiringIds]);
	const targets = collections
		.filter((item) => targetIds.has(item.subject_id) && item.subject.name)
		.map((item) => ({
			subjectId: item.subject_id,
			name: item.subject.name,
			nameCn: item.subject.name_cn,
		}));

	return {
		airingIds,
		staleAiringIds,
		allEpisodeIds: [...targetIds],
		targets,
	};
}
