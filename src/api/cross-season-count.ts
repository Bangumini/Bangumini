import type { Episode } from "@shared/api/types";

export const CROSS_SEASON_COUNT_STORAGE_KEY = "bangumini_cross_season_count";

export function isCrossSeasonCountEnabled() {
	try {
		return localStorage.getItem(CROSS_SEASON_COUNT_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

export function setCrossSeasonCountEnabled(enabled: boolean) {
	localStorage.setItem(CROSS_SEASON_COUNT_STORAGE_KEY, String(enabled));
}

/**
 * Bangumi 的 `ep` 是当前条目内编号，`sort` 是同类剧集的连续编号。
 * 两者的差值即当前季度在整部系列中的集数偏移。
 */
export function getCrossSeasonEpisodeOffset(episodes: Episode[]) {
	const firstMainEpisode = episodes
		.filter(
			(episode) =>
				episode.type === 0 &&
				Number.isFinite(episode.ep) &&
				Number.isFinite(episode.sort),
		)
		.sort((left, right) => left.ep - right.ep)[0];

	if (!firstMainEpisode) return 0;
	return Math.max(0, firstMainEpisode.sort - firstMainEpisode.ep);
}
