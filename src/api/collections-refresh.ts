import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
	getAllUserCollections,
	getCalendar,
	getEpisodes,
	getUserCollections,
} from "@shared/api/client";
import type {
	CalendarItem,
	Episode,
	PagedResponse,
	UserCollection,
} from "@shared/api/types";
import {
	airingForceWindow,
	isSameAiringSchedule,
	mergeAiringRecordMaps,
	type AiringCacheRecord,
} from "@shared/airing-cache";
import { diffCalendar } from "@shared/calendar-cache";
import {
	diffCollectionList,
	mergeConcurrentCollectionChanges,
} from "@shared/collection-cache";
import { episodesForceWindow } from "@shared/episodes-cache";
import { isSameJsonPayload } from "@shared/payload-equality";
import {
	CALENDAR_CACHE_KEY,
	COLLECTIONS_CACHE_PREFIX,
	getCollectionsCacheKey,
} from "@shared/cache-keys";
import {
	deleteCachedCollection,
	readCachedCollection,
	readCachedSubjectDeep,
	writeCachedCollection,
	writeCachedSubjectPreviews,
	writeCachedValue,
} from "@shared/storage/sqlite-cache";
import {
	getCollectionTaskQueue,
	mergePendingCollectionTasks,
} from "./collection-tasks";
import { readCachedQueryMap } from "./query-map-cache";
import { beginCacheRefresh } from "./stale-cache-refresh";

/**
 * 收藏页整批刷新：Ctrl+R（manual）与自动刷新（auto，启动/窗口重新显示）共用同一份实现。
 *
 * 触发方式只影响两件事：
 * 1. manual 会登记本轮强制窗口，让 AniList/剧集缓存跳过新鲜度窗口重新询问；
 * 2. manual 无论有无变化都会给出提示，auto 只在失败/有变化时提示，无变化保持安静。
 * 其余流程（对比后才写盘、乐观任务保护、整批一次提交）完全一致。
 */
export type CollectionsRefreshTrigger = "manual" | "auto";

export { CALENDAR_CACHE_KEY, COLLECTIONS_CACHE_PREFIX, getCollectionsCacheKey };

export type CollectionsRefreshScope = {
	trigger: CollectionsRefreshTrigger;
	collectionType: string;
	username: string;
	collectionsQueryKey: QueryKey;
	collectionsCacheKey: string;
	/** 在看页需要同时刷新日历与放送/剧集排期；其它分类只刷新收藏列表。 */
	includeSchedule: boolean;
	/** 当前列表涉及的全部条目，用于统计播出时间变化。 */
	allEpisodeIds: readonly number[];
};

export type CollectionsRefreshResult = {
	failed: string[];
	addedCollections: number;
	changedCollections: number;
	removedCollections: number;
	calendarChanged: boolean;
	airingChanges: number;
};

export type CollectionsRefreshToast = {
	message: string;
	variant?: "error";
};

const EMPTY_RESULT: CollectionsRefreshResult = {
	failed: [],
	addedCollections: 0,
	changedCollections: 0,
	removedCollections: 0,
	calendarChanged: false,
	airingChanges: 0,
};

/** 与常规拉取保持一致：服务端没给总集数时用本地详情补全。 */
export async function backfillTotalEpisodesFromCache(
	collections: UserCollection[],
) {
	await Promise.allSettled(
		collections.map(async (c) => {
			const s = c.subject;
			if ((s.total_episodes ?? 0) > 0 || (s.eps ?? 0) > 0) return;
			const cached = await readCachedSubjectDeep(s.id);
			if (cached) {
				if (cached.total_episodes) s.total_episodes = cached.total_episodes;
				else if (cached.eps) s.eps = cached.eps;
			}
		}),
	);
}

export function getCollectionsRefreshToast(
	result: CollectionsRefreshResult,
	trigger: CollectionsRefreshTrigger,
): CollectionsRefreshToast | null {
	const total =
		result.addedCollections + result.changedCollections + result.removedCollections;
	const summary = [
		result.addedCollections > 0 ? `新增 ${result.addedCollections}` : null,
		result.changedCollections > 0 ? `更新 ${result.changedCollections}` : null,
		result.removedCollections > 0 ? `移出 ${result.removedCollections}` : null,
	]
		.filter(Boolean)
		.join("、");
	if (result.failed.length > 0) {
		return {
			message: `${result.failed.join("、")}同步失败${total > 0 ? `，已更新 ${total} 项收藏` : ""}`,
			variant: "error",
		};
	}
	if (total > 0) return { message: `已同步 ${summary} 项收藏` };
	if (result.calendarChanged) return { message: "日历已更新" };
	if (result.airingChanges > 0) {
		return { message: `播出时间已更新 ${result.airingChanges} 项` };
	}
	// 自动刷新发生在启动和窗口重新显示时：有变化才提示，无变化保持安静。
	if (trigger === "auto") return null;
	return { message: "已是最新" };
}

/**
 * 以增量方式把其他端（网页/手机）的收藏与排期同步到本地。
 *
 * 先对比再写入：未变化的条目不重建、不落盘；失败的数据源单独报告，其余照常更新。
 * 返回的 Promise 只在整批数据源结束（成功或失败）后完成，供调用方维护“刷新中”状态。
 */
export async function refreshCollectionsData(
	queryClient: QueryClient,
	scope: CollectionsRefreshScope,
): Promise<CollectionsRefreshResult> {
	const {
		collectionType,
		username: uname,
		collectionsQueryKey,
		collectionsCacheKey,
		allEpisodeIds,
	} = scope;
	const isWatching = collectionType === "3";
	const includeCalendar = scope.includeSchedule && isWatching;

	// 整批刷新期间保持一次提交：收藏先到、日历后到时，列表不会先闪一帧旧排期。
	const endRefresh = beginCacheRefresh(queryClient, collectionsCacheKey);
	const endCalendarRefresh = includeCalendar
		? beginCacheRefresh(queryClient, CALENDAR_CACHE_KEY)
		: null;

	const failed: string[] = [];
	let changedCollections = 0;
	let removedCollections = 0;
	let addedCollections = 0;
	let calendarChanged = false;

	try {
		// 队列读取失败时不做自动刷新：避免与 worker 的确认写入相互覆盖。
		let tasks: Awaited<ReturnType<typeof getCollectionTaskQueue>>;
		try {
			tasks = (await getCollectionTaskQueue()).filter(
				(task) => task.payload.username === uname,
			);
		} catch (error) {
			if (scope.trigger === "auto") {
				console.warn("[collections-refresh] auto refresh skipped", error);
				return { ...EMPTY_RESULT };
			}
			tasks = [];
		}
		// 自动刷新不能与收藏 worker 抢写：队列非空时在发任何请求前就退出，
		// 由 worker 在整批确认后统一提交并落盘。
		if (scope.trigger === "auto" && tasks.length > 0) return { ...EMPTY_RESULT };
		const pendingSubjectIds = new Set(
			tasks.map((task) => task.payload.subjectId),
		);

		// 强制语义要在发请求前就登记：页面里已挂载的 query 一旦被 refetch，
		// queryFn 会立刻读取这个起点，晚一步登记就会退回常规新鲜度判断。
		// 自动刷新刻意不登记：它跟随 AniList 5 分钟 / 剧集 30 分钟的既有窗口，
		// 否则每次显示窗口都会重新询问全部条目。
		if (scope.trigger === "manual") {
			airingForceWindow.request();
			episodesForceWindow.request();
		}
		const airingIds = allEpisodeIds;
		const airingBefore = readCachedQueryMap<AiringCacheRecord>(
			queryClient,
			[["anilist-airing-times-v2"], ["anilist-airing-times-cache-v2"]],
			airingIds,
			(record) => record.fetchedAt,
		);

		// 三个数据源互不依赖，必须并发：串行会把用户可见的等待时间相加。
		// 新增成员导致的 query key 变化由下一次渲染补齐（仍在同一个强制轮次内）。
		const collectionsTask = (async () => {
			// 1. 收藏列表：与页面读取共用同一套“网络 → 队列投影 → 并发保护”顺序。
			try {
				// 刷新起点必须在发请求之前取，否则请求期间的本地改动会被当成“服务端最新值”。
				const baseline =
					queryClient.getQueryData<PagedResponse<UserCollection>>(
						collectionsQueryKey,
					);
				const networkResult =
					collectionType === "3"
						? await getAllUserCollections({ username: uname, type: 3 })
						: await getUserCollections({
								username: uname,
								type: parseInt(collectionType),
								limit: 100,
							});
				// 只有“在看”全量拉取才能推断条目已被其它端移出。
				const complete = collectionType === "3";
				const subjectType = Number(collectionType) as UserCollection["type"];
				const networkData = networkResult.data.map((item) => ({
					...item,
					subject: { ...item.subject },
				}));
				await backfillTotalEpisodesFromCache(networkData);
				const serverById = new Map(
					networkData.map((item) => [item.subject_id, item]),
				);
				const cachedFallbacks = (
					await Promise.all(
						[...pendingSubjectIds].map((subjectId) =>
							readCachedCollection(uname, subjectId),
						),
					)
				).filter((item): item is UserCollection => item !== null);
				let merged = mergePendingCollectionTasks({
					data: { ...networkResult, data: networkData },
					currentData: baseline,
					tasks,
					cachedCollections: cachedFallbacks,
					username: uname,
					collectionType: subjectType,
				});
				const liveDuringFetch =
					queryClient.getQueryData<PagedResponse<UserCollection>>(
						collectionsQueryKey,
					);
				// 请求期间 worker 可能已完成写入；迟到的服务端快照不能覆盖已确认的本地意图。
				if (baseline && liveDuringFetch && liveDuringFetch !== baseline) {
					merged = mergeConcurrentCollectionChanges({
						data: merged,
						originalData: baseline,
						liveData: liveDuringFetch,
						collectionType: subjectType,
					});
				}

				const current =
					queryClient.getQueryData<PagedResponse<UserCollection>>(
						collectionsQueryKey,
					) ?? baseline;
				const diff = diffCollectionList(current, merged, { complete });
				if (diff.changed) {
					queryClient.setQueryData(collectionsQueryKey, diff.data);
				}
				changedCollections = diff.changedIds.length;
				addedCollections = diff.addedIds.length;
				removedCollections = diff.removedIds.length;

				// 2. 只持久化“服务端值原样保留”的条目：乐观任务与并发本地更改都不落盘。
				const persistable = diff.changedItems.filter((item) => {
					if (pendingSubjectIds.has(item.subject_id)) return false;
					const server = serverById.get(item.subject_id);
					return server !== undefined && isSameJsonPayload(server, item);
				});
				if (persistable.length > 0) {
					await Promise.all([
						writeCachedSubjectPreviews(persistable.map((item) => item.subject)),
						...persistable.map((item) => writeCachedCollection(uname, item)),
					]);
					for (const item of persistable) {
						queryClient.setQueryData(["collection", item.subject_id], item);
					}
				}
				// 只在服务端确实“没有这条收藏”时才删除本地行；
				// 被其它端改到别的分类的条目，行里存的是新分类，必须保留。
				const removedCandidates = diff.removedIds.filter(
					(subjectId) => !pendingSubjectIds.has(subjectId),
				);
				if (removedCandidates.length > 0) {
					const removedCached = await Promise.all(
						removedCandidates.map((subjectId) =>
							readCachedCollection(uname, subjectId),
						),
					);
					const reallyRemoved = removedCandidates.filter(
						(_subjectId, index) =>
							(removedCached[index]?.type ?? subjectType) === subjectType,
					);
					await Promise.all(
						reallyRemoved.map((subjectId) =>
							deleteCachedCollection(uname, subjectId),
						),
					);
				}
				if (diff.changed) {
					// 快照只写服务端确认值：内存里的乐观投影不能变成“已确认”缓存，
					// 否则下次冷启动会把还没同步成功的本地意图当成服务端状态。
					// 未变化的条目本来就在缓存里，原样保留即可。
					const touchedIds = new Set([...diff.changedIds, ...diff.addedIds]);
					const snapshotData = diff.data.data.filter(
						(item) =>
							!touchedIds.has(item.subject_id) ||
							isSameJsonPayload(serverById.get(item.subject_id), item),
					);
					await writeCachedValue(collectionsCacheKey, {
						...diff.data,
						data: snapshotData,
						total: snapshotData.length,
					});
					void queryClient.invalidateQueries({
						queryKey: ["collection-status-map", uname],
					});
				}
			} catch (error) {
				console.warn("[collections-refresh] collections failed", error);
				failed.push("收藏");
			}
		})();

		// 3. 日历：只回写新增/变化的条目预览。
		const calendarTask = (async () => {
			if (!includeCalendar) return;
			try {
				const incoming = await getCalendar();
				const current = queryClient.getQueryData<CalendarItem[]>(
					[CALENDAR_CACHE_KEY],
				);
				const diff = diffCalendar(current, incoming);
				if (!diff.changed) return;
				queryClient.setQueryData([CALENDAR_CACHE_KEY], diff.calendar);
				calendarChanged = true;
				if (diff.changedSubjects.length > 0) {
					await writeCachedSubjectPreviews(diff.changedSubjects);
				}
				await writeCachedValue(CALENDAR_CACHE_KEY, diff.calendar);
			} catch (error) {
				console.warn("[collections-refresh] calendar failed", error);
				failed.push("日历");
			}
		})();

		// 4. 播出时间与剧集表：只跳过限流窗口，不先清空缓存，界面始终保留旧值。
		// refetchQueries 自身就会强制发起请求，因此不再先 invalidate（否则同一轮会取两次）。
		const scheduleTask = includeCalendar
			? Promise.all([
					queryClient.refetchQueries({
						queryKey: ["anilist-airing-times-v2"],
					}),
					queryClient.refetchQueries({
						queryKey: ["episodes-schedule-v2"],
					}),
				])
			: Promise.resolve();

		await Promise.all([collectionsTask, calendarTask, scheduleTask]);
		const airingAfter = mergeAiringRecordMaps(
			airingBefore,
			readCachedQueryMap<AiringCacheRecord>(
				queryClient,
				[["anilist-airing-times-v2"]],
				airingIds,
				(record) => record.fetchedAt,
			),
		);
		let airingChanges = 0;
		for (const [subjectId, record] of airingAfter) {
			if (isSameAiringSchedule(airingBefore?.get(subjectId), record)) continue;
			airingChanges += 1;
		}

		return {
			failed,
			addedCollections,
			changedCollections,
			removedCollections,
			calendarChanged,
			airingChanges,
		};
	} finally {
		endRefresh();
		endCalendarRefresh?.();
	}
}

/** 单条剧集表请求：列表成员变化换了组合 key 时，同一条目仍复用本轮请求。 */
const episodeSchedulesInFlight = new Map<number, Promise<Episode[]>>();

export function fetchEpisodeSchedule(subjectId: number) {
	const existing = episodeSchedulesInFlight.get(subjectId);
	if (existing) return existing;
	const task = getEpisodes(subjectId)
		.then((data) => data.data.filter((episode) => episode.type === 0))
		.finally(() => episodeSchedulesInFlight.delete(subjectId));
	episodeSchedulesInFlight.set(subjectId, task);
	return task;
}
