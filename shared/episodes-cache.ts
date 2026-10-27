import type { Episode } from "./api/types.ts";
import { createForceWindow } from "./cache-force.ts";

/** BGM 剧集表缓存：键名与新鲜度规则，供收藏页与手动同步共用。 */
export const EPISODES_CACHE_PREFIX = "episodes-schedule-v2-";
export const EPISODES_CACHE_MAX_AGE = 1000 * 60 * 30;

export const episodesForceWindow = createForceWindow();

export type EpisodeScheduleCache = {
	episodes: Episode[];
	checkedAt: number;
};

export function getEpisodeCacheKey(subjectId: number) {
	return `${EPISODES_CACHE_PREFIX}${subjectId}`;
}

export function isEpisodeScheduleCache(
	value: EpisodeScheduleCache | null | undefined,
): value is EpisodeScheduleCache {
	return (
		!!value &&
		Array.isArray(value.episodes) &&
		typeof value.checkedAt === "number"
	);
}

/**
 * 剧集表 30 分钟内不重复请求。
 *
 * 手动刷新（roundStart > 0）跳过这个窗口，但本轮已经刷新过的记录（checkedAt >= roundStart）
 * 必须复用：否则连按 Ctrl+R 或同批多个 query 会把同一批条目重复打进 Bangumi。
 */
export function shouldRefreshEpisodeRecord(
	record: EpisodeScheduleCache | null | undefined,
	now: number,
	{ roundStart = 0 }: { roundStart?: number } = {},
) {
	if (!isEpisodeScheduleCache(record)) return true;
	if (roundStart > 0) return record.checkedAt < roundStart;
	return now - record.checkedAt > EPISODES_CACHE_MAX_AGE;
}
