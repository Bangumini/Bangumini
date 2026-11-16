import type { Episode } from "./api/types";

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

/**
 * 批量计算每个条目的跨季偏移；偏移为 0（含无分集数据）的条目不进入结果，
 * 调用方用 `?? 0` 兜底即可退回单季计数。
 */
export function buildCrossSeasonOffsets(
	episodesBySubject: ReadonlyMap<number, Episode[]>,
): Map<number, number> {
	const offsets = new Map<number, number>();
	for (const [subjectId, episodes] of episodesBySubject) {
		const offset = getCrossSeasonEpisodeOffset(episodes);
		if (offset > 0) offsets.set(subjectId, offset);
	}
	return offsets;
}
