import { createForceWindow } from "./cache-force.ts";

/** AniList 播出记录的类型与新鲜度规则（无 IO，便于单测与页面/同步模块共用）。 */
export const AIRING_CACHE_PREFIX = "anilist-airing-v2-";
export const LEGACY_AIRING_KEY_PREFIX = "bangumini-anilist-";
export const AIRING_NEGATIVE_CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
export const AIRING_REFRESH_MIN_INTERVAL = 1000 * 60 * 5;

export type AiringCacheRecord =
	| {
			status: "scheduled";
			airingAt: number;
			episode: number;
			fetchedAt: number;
			retryAfter?: number;
	  }
	| {
			status: "no_schedule" | "not_found";
			fetchedAt: number;
	  };

export const airingForceWindow = createForceWindow();

export function isAiringCacheRecord(value: unknown): value is AiringCacheRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<AiringCacheRecord>;
	if (typeof record.fetchedAt !== "number") return false;
	if (record.status === "not_found" || record.status === "no_schedule") {
		return true;
	}
	return (
		record.status === "scheduled" &&
		typeof record.airingAt === "number" &&
		typeof record.episode === "number"
	);
}

/**
 * 自动刷新：按“已到播出时刻”和 5 分钟重试窗口判断。
 *
 * 手动刷新（roundStart > 0，即本轮起点）只跳过限流窗口，不重查未来才播出的记录 ——
 * 这些记录不会因本次刷新提前改变；负缓存（未收录/未找到）仍按 24 小时处理，
 * 避免一次刷新触发整批 AniList 请求。
 *
 * 本轮已经刷新过的记录（fetchedAt >= roundStart）必须复用，
 * 否则节流期间后到的 query 会把同一批条目再查一遍。
 */
export function shouldRefreshAiringRecord(
	record: AiringCacheRecord | undefined,
	now: number,
	{ roundStart = 0 }: { roundStart?: number } = {},
) {
	if (!record) return true;
	if (record.status !== "scheduled") {
		return now - record.fetchedAt > AIRING_NEGATIVE_CACHE_MAX_AGE;
	}

	if (roundStart > 0 && record.fetchedAt >= roundStart) return false;
	const airingAt = record.airingAt * 1000;
	if (airingAt > now) return false;
	if (roundStart > 0) {
		// 已过播出时刻的记录：本轮就是来重查它的。
		return record.fetchedAt < roundStart;
	}
	return (
		now >=
		Math.max(
			airingAt,
			record.retryAfter ?? record.fetchedAt + AIRING_REFRESH_MIN_INTERVAL,
		)
	);
}

/** 合并多份按条目分片的记录，保留 fetchedAt 更新的一份。 */
export function mergeAiringRecordMaps(
	...maps: ReadonlyArray<ReadonlyMap<number, AiringCacheRecord> | undefined>
) {
	const merged = new Map<number, AiringCacheRecord>();
	for (const map of maps) {
		for (const [subjectId, record] of map ?? []) {
			const current = merged.get(subjectId);
			if (!current || record.fetchedAt >= current.fetchedAt) {
				merged.set(subjectId, record);
			}
		}
	}
	return merged;
}

/** 只比较会改变展示/排序的排期字段，忽略 fetchedAt 这类刷新元数据。 */
export function isSameAiringSchedule(
	previous: AiringCacheRecord | undefined,
	next: AiringCacheRecord,
) {
	if (!previous) return false;
	if (previous.status !== next.status) return false;
	if (previous.status === "scheduled" && next.status === "scheduled") {
		return previous.airingAt === next.airingAt && previous.episode === next.episode;
	}
	return true;
}

/**
 * 旧版记录只存在 localStorage 中，并且会在 SQLite 缺失时被重新导入。
 * 刷新拿到新记录后清掉这些键，避免旧值在冷启动时再次顶替。
 */
export function removeLegacyAiringRecord(subjectId: number) {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.removeItem(`${LEGACY_AIRING_KEY_PREFIX}${subjectId}`);
	} catch {
		// 非浏览器环境或存储被禁用时忽略：SQLite 记录已经是权威来源。
	}
}
