import { Fragment, useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
	getAllUserCollections,
	getCalendar,
	getEpisodes,
	getSubject,
	getUserCollections,
} from "@shared/api/client";
import type {
	CalendarItem,
	Episode,
	PagedResponse,
	UserCollection,
} from "@shared/api/types";
import { getAiringAt } from "@shared/api/anilist";
import { SubjectTypeLabel } from "@shared/api/types";
import {
	deriveAiredEpisodeCount,
	deriveAiringSchedule,
	getNextEpisodeAiringAt,
	type AiringObservation,
	type AiringSchedule,
} from "@shared/airing-schedule";
import {
	sortCollections,
	getDisplayLabel,
	WEEKDAY_CN,
	GROUP_LABEL,
	GROUP_COLOR,
} from "@shared/sort-collections";
import type { SortedCollection } from "@shared/sort-collections";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";
import {
	deleteCachedValue,
	deleteCachedValuesByPrefix,
	readCachedCollection,
	readCachedSubjectDeep,
	readCachedValue,
	readCachedValueEntry,
	readCachedValues,
	readCachedValueWithLegacy,
	readLegacyHttpCache,
	writeCachedCollection,
	writeCachedSubjectPreviews,
	writeCachedValue,
} from "@shared/storage/sqlite-cache";
import { getUsername } from "../api/oauth";
import { refreshQueryDataIfChanged } from "../api/stale-cache-refresh";
import { getSubjectTitleForCopy } from "../api/subject-title-copy";
import {
	COLLECTION_TASK_EVENT,
	type CollectionTaskEventDetail,
} from "../api/collection-tasks";
import { SubjectRow, Rating, Meta, Tag } from "../components/SubjectRow";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

const LIMIT = 20;
const COLLECTIONS_CACHE_PREFIX = "collections-";
const AIRING_CACHE_PREFIX = "anilist-airing-v2-";
const LEGACY_AIRING_CACHE_PREFIX = "anilist-airing-";
const EPISODES_CACHE_PREFIX = "episodes-schedule-v2-";
const LEGACY_EPISODES_CACHE_PREFIX = "episodes-";
const AIRING_REQUEST_DELAY = 700;
const AIRING_RECORD_MAX_AGE = 1000 * 60 * 60 * 24 * 14;
const AIRING_NEGATIVE_CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const AIRING_REFRESH_MIN_INTERVAL = 1000 * 60 * 5;
const EPISODES_CACHE_MAX_AGE = 1000 * 60 * 30;
const CLOCK_EPSILON_MS = 1000;
const EMPTY_COLLECTIONS: UserCollection[] = [];
const EMPTY_SORTED: SortedCollection[] = [];
const EMPTY_EPISODE_LIST_MAP = new Map<number, Episode[]>();
const EMPTY_AIRING_RECORD_MAP = new Map<number, AiringCacheRecord>();
const EMPTY_DISPLAY_LABEL_MAP = new Map<number, string | null>();
const CALENDAR_QUERY_KEY = ["calendar"] as const;

type DataSource = "cache" | "network";
type QuerySourceName = "collections" | "calendar" | "airingTimes" | "episodes";
type QuerySourceStatus = DataSource | "pending" | "error" | "skip";
type QuerySourceState = Partial<
	Record<QuerySourceName, { key: string; source: DataSource }>
>;
type AiringCacheRecord =
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
type EpisodeScheduleCache = {
	episodes: Episode[];
	checkedAt: number;
};
type CollectionsLocationState = {
	fromSubject?: boolean;
	subjectId?: number;
	page?: number;
	focusedIndex?: number;
	collectionType?: string;
	searchText?: string;
};
type CommittedCollectionsState = {
	scopeKey: string;
	version: string;
	source: DataSource;
	sorted: SortedCollection[];
	displayLabelMap: Map<number, string | null>;
};

function getPageStateKey(collectionType: string, searchText: string) {
	return `bangumini-collections-page-${collectionType}-${searchText}`;
}

function readPageState(
	collectionType: string,
	searchText: string,
): { page: number; focusedIndex: number } {
	try {
		const raw = sessionStorage.getItem(
			getPageStateKey(collectionType, searchText),
		);
		if (!raw) return { page: 1, focusedIndex: 0 };
		const state = JSON.parse(raw) as { page?: number; focusedIndex?: number };
		return {
			page: Math.max(1, state.page ?? 1),
			focusedIndex: Math.max(0, state.focusedIndex ?? 0),
		};
	} catch {
		return { page: 1, focusedIndex: 0 };
	}
}

function writePageState(
	collectionType: string,
	searchText: string,
	page: number,
	focusedIndex: number,
) {
	sessionStorage.setItem(
		getPageStateKey(collectionType, searchText),
		JSON.stringify({ page, focusedIndex }),
	);
}

function buildAiringMap(calendar: CalendarItem[] | undefined) {
	const map = new Map<number, number>();
	if (!calendar) return map;

	for (const day of calendar) {
		for (const item of day.items) {
			map.set(item.id, day.weekday.id);
		}
	}
	return map;
}

function getQuerySourceStatus(
	sources: QuerySourceState,
	name: QuerySourceName,
	key: string,
	enabled: boolean,
	hasData: boolean,
	hasError: boolean,
): QuerySourceStatus {
	if (!enabled) return "skip";
	if (hasError && !hasData) return "error";

	const entry = sources[name];
	if (entry?.key === key) return entry.source;
	return hasData ? "cache" : "pending";
}

function hasNetworkSource(sources: QuerySourceStatus[]) {
	return sources.some((source) => source === "network");
}

function isAiringCacheRecord(value: unknown): value is AiringCacheRecord {
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

async function readCachedAiringRecords(subjectIds: number[]) {
	const uniqueIds = [...new Set(subjectIds)];
	if (uniqueIds.length === 0) return new Map<number, AiringCacheRecord>();

	const cacheKeysBySubjectId = new Map(
		uniqueIds.map((subjectId) => [
			subjectId,
			`${AIRING_CACHE_PREFIX}${subjectId}`,
		]),
	);
	const cachedByKey = await readCachedValues<AiringCacheRecord>([
		...cacheKeysBySubjectId.values(),
	]);
	const now = Date.now();
	const map = new Map<number, AiringCacheRecord>();
	for (const [subjectId, cacheKey] of cacheKeysBySubjectId) {
		const cached = cachedByKey.get(cacheKey);
		if (
			isAiringCacheRecord(cached) &&
			now - cached.fetchedAt <= AIRING_RECORD_MAX_AGE
		) {
			map.set(subjectId, cached);
		}
	}
	return map;
}

function shouldRefreshAiringRecord(
	record: AiringCacheRecord | undefined,
	now: number,
) {
	if (!record) return true;
	if (record.status !== "scheduled") {
		return now - record.fetchedAt > AIRING_NEGATIVE_CACHE_MAX_AGE;
	}
	const refreshAt = Math.max(
		record.airingAt * 1000,
		record.retryAfter ?? record.fetchedAt + AIRING_REFRESH_MIN_INTERVAL,
	);
	return now >= refreshAt;
}

function toAiringObservationMap(records: Map<number, AiringCacheRecord>) {
	const map = new Map<number, AiringObservation>();
	for (const [subjectId, record] of records) {
		if (record.status !== "scheduled") continue;
		map.set(subjectId, {
			airingAt: record.airingAt,
			episode: record.episode,
			fetchedAt: record.fetchedAt,
		});
	}
	return map;
}

function getInfoboxAliases(subject: Awaited<ReturnType<typeof getSubject>>) {
	const aliases: string[] = [];
	for (const item of subject.infobox ?? []) {
		if (!/(别名|中文名|英文名|日文名|原作名)/.test(item.key)) continue;
		if (typeof item.value === "string") {
			aliases.push(item.value);
			continue;
		}
		for (const value of item.value) aliases.push(value.v);
	}
	return aliases;
}

async function lookupAiringTime(item: {
	subjectId: number;
	name: string;
	nameCn: string;
}) {
	let result = await getAiringAt(item.name);
	if (result.status !== "not_found") return result;

	let aliases = item.nameCn ? [item.nameCn] : [];
	try {
		const subject = await getSubject(item.subjectId);
		aliases = [...aliases, ...getInfoboxAliases(subject)];
	} catch (error) {
		console.warn("[airing-schedule] failed to load BGM aliases", error);
	}

	for (const title of [...new Set(aliases)].filter(Boolean)) {
		if (title === item.name) continue;
		await delay(AIRING_REQUEST_DELAY);
		result = await getAiringAt(title);
		if (result.status !== "not_found") return result;
	}
	return result;
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCurrentTimestamp() {
	return Date.now();
}

function getLocalDateString(date = new Date()) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function getMsUntilNextLocalDay(date = new Date()) {
	const nextDay = new Date(date);
	nextDay.setHours(24, 0, 1, 0);
	return Math.max(1000, nextDay.getTime() - date.getTime());
}

function getBangumiWeekdayFromDateKey(dateKey: string) {
	const [year, month, day] = dateKey.split("-").map(Number);
	const jsDay = new Date(year, month - 1, day).getDay();
	return jsDay === 0 ? 7 : jsDay;
}

function getEpisodeCacheKey(subjectId: number) {
	return `${EPISODES_CACHE_PREFIX}${subjectId}`;
}

function isEpisodeScheduleCache(
	value: EpisodeScheduleCache | null,
): value is EpisodeScheduleCache {
	return (
		!!value &&
		Array.isArray(value.episodes) &&
		typeof value.checkedAt === "number"
	);
}

async function fetchEpisodeSchedule(subjectId: number) {
	const data = await getEpisodes(subjectId);
	return data.data.filter((episode) => episode.type === 0);
}

function deriveAiringMaps(
	episodeListMap: Map<number, Episode[]>,
	observationMap: Map<number, AiringObservation>,
	airingMap: Map<number, number>,
	nowMs: number,
) {
	const scheduleMap = new Map<number, AiringSchedule>();
	const airedEpMap = new Map<number, number>();
	const nextAiringAtMap = new Map<number, number>();

	for (const [subjectId, episodes] of episodeListMap) {
		const observation = observationMap.get(subjectId);
		const schedule = observation
			? deriveAiringSchedule(airingMap.get(subjectId), episodes, observation)
			: null;
		if (schedule) scheduleMap.set(subjectId, schedule);
		airedEpMap.set(subjectId, deriveAiredEpisodeCount(episodes, schedule, nowMs));
		const nextAiringAt = getNextEpisodeAiringAt(episodes, schedule, nowMs);
		if (nextAiringAt !== null) {
			nextAiringAtMap.set(subjectId, nextAiringAt);
		}
	}

	return { scheduleMap, airedEpMap, nextAiringAtMap };
}

async function backfillTotalEpisodesFromCache(collections: UserCollection[]) {
	for (const c of collections) {
		const s = c.subject;
		if ((s.total_episodes ?? 0) > 0 || (s.eps ?? 0) > 0) continue;
		const cached = await readCachedSubjectDeep(s.id);
		if (cached) {
			if (cached.total_episodes) s.total_episodes = cached.total_episodes;
			else if (cached.eps) s.eps = cached.eps;
		}
	}
}

async function fetchAndCacheCollections(
	collectionType: string,
	uname: string,
	collectionsCacheKey: string,
) {
	const result =
		collectionType === "3"
			? await getAllUserCollections({ username: uname, type: 3 })
			: await getUserCollections({
					username: uname,
					type: parseInt(collectionType),
					limit: 100,
				});

	await backfillTotalEpisodesFromCache(result.data);
	await writeCachedSubjectPreviews(result.data.map((item) => item.subject));
	await writeCachedValue(collectionsCacheKey, result);
	// 同步写入单条目收藏缓存，确保详情页读到最新数据
	await Promise.all(
		result.data.map((item) => writeCachedCollection(uname, item)),
	);
	return result;
}

async function fetchAndCacheCalendar() {
	const data = await getCalendar();
	await writeCachedSubjectPreviews(data.flatMap((day) => day.items));
	await writeCachedValue("calendar", data);
	return data;
}

export default function CollectionsPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const queryClient = useQueryClient();
	const [searchParams] = useSearchParams();

	const collectionType = searchParams.get("type") ?? "3";
	const searchText = searchParams.get("filter") ?? "";
	const restoredPageState = useMemo(
		() => readPageState(collectionType, searchText),
		[collectionType, searchText],
	);

	// Check if returning from detail page and use navigation state if available
	const initialState = useMemo(() => {
		const state = location.state as CollectionsLocationState | null;
		if (state?.fromSubject && state?.subjectId) {
			return {
				page: state.page ?? restoredPageState.page,
				focusedIndex: state.focusedIndex ?? restoredPageState.focusedIndex,
				isReturningFromDetail: true,
			};
		}
		return {
			page: restoredPageState.page,
			focusedIndex: restoredPageState.focusedIndex,
			isReturningFromDetail: false,
		};
	}, [location.state, restoredPageState.page, restoredPageState.focusedIndex]);

	const [page, setPage] = useState(initialState.page);
	const [focusedIndex, setFocusedIndex] = useState(initialState.focusedIndex);
	const [todayDateKey, setTodayDateKey] = useState(() => getLocalDateString());
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [committedState, setCommittedState] =
		useState<CommittedCollectionsState | null>(null);
	const [querySources, setQuerySources] = useState<QuerySourceState>({});
	const [backgroundRefreshCount, setBackgroundRefreshCount] = useState(0);
	const [shouldSuppressRefetch, setShouldSuppressRefetch] = useState(
		initialState.isReturningFromDetail,
	);
	const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
	const isWatching = collectionType === "3";
	const today = useMemo(
		() => getBangumiWeekdayFromDateKey(todayDateKey),
		[todayDateKey],
	);
	const isReturningFromDetail = useRef(initialState.isReturningFromDetail);
	const isMounted = useRef(true);

	const uname = getUsername();

	function setQuerySource(
		name: QuerySourceName,
		key: string,
		source: DataSource,
	) {
		if (!isMounted.current) return;
		setQuerySources((prev) => {
			const current = prev[name];
			if (current?.key === key && current.source === source) return prev;
			return { ...prev, [name]: { key, source } };
		});
	}

	function trackBackgroundRefresh(task: Promise<boolean> | null) {
		if (!task) return;
		if (isMounted.current) {
			setBackgroundRefreshCount((count) => count + 1);
		}
		void task.finally(() => {
			if (!isMounted.current) return;
			setBackgroundRefreshCount((count) => Math.max(0, count - 1));
		});
	}

	useEffect(() => {
		isMounted.current = true;
		return () => {
			isMounted.current = false;
		};
	}, []);

	const collectionsCacheKey = `${COLLECTIONS_CACHE_PREFIX}${collectionType}-${uname}`;
	const collectionsQueryKey = useMemo(
		() => ["collections", collectionType, uname] as const,
		[collectionType, uname],
	);

	useEffect(() => {
		const syncClock = () => {
			const now = Date.now();
			setNowMs(now);
			setTodayDateKey(getLocalDateString(new Date(now)));
		};
		const handleVisibilityChange = () => {
			if (!document.hidden) syncClock();
		};
		const timer = window.setTimeout(syncClock, getMsUntilNextLocalDay());

		window.addEventListener("focus", syncClock);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("focus", syncClock);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [todayDateKey]);

	useEffect(() => {
		const handleCollectionTask = (event: Event) => {
			const detail = (event as CustomEvent<CollectionTaskEventDetail>).detail;
			if (detail.status !== "finished") return;

			const currentType = parseInt(collectionType);
			if (detail.previousType !== currentType && detail.nextType !== currentType)
				return;

			void queryClient.invalidateQueries({
				queryKey: collectionsQueryKey,
				exact: true,
			});
		};

		window.addEventListener(COLLECTION_TASK_EVENT, handleCollectionTask);
		return () => {
			window.removeEventListener(COLLECTION_TASK_EVENT, handleCollectionTask);
		};
	}, [collectionType, collectionsQueryKey, queryClient]);

	// Detect return from subject detail page and update only the changed item
	useEffect(() => {
		const state = location.state as CollectionsLocationState | null;
		if (state?.fromSubject && state?.subjectId && uname) {
			const subjectId = state.subjectId;
			let cancelled = false;
			void (async () => {
				// Get the updated collection from the detail page's cache
				let updatedCollection = queryClient.getQueryData<UserCollection>([
					"collection",
					subjectId,
				]);

				// Fallback: try to read the individual collection from SQLite
				if (!updatedCollection) {
					updatedCollection =
						(await readCachedCollection(uname!, subjectId)) ?? undefined;
				}

				// Get the current collections list
				const currentData =
					queryClient.getQueryData<PagedResponse<UserCollection>>(
						collectionsQueryKey,
					);

				if (currentData?.data && updatedCollection) {
					// Create updated list
					let updatedList = [...currentData.data];
					const itemIndex = updatedList.findIndex(
						(item) => item.subject_id === state.subjectId,
					);

					// Check if collection type matches current tab
					const typeMatches = updatedCollection.type === parseInt(collectionType);

					if (itemIndex >= 0) {
						if (typeMatches) {
							// Update in place
							updatedList[itemIndex] = updatedCollection;
						} else {
							// Type changed - remove from current list
							updatedList.splice(itemIndex, 1);
						}
					} else if (typeMatches) {
						// New item for this collection type - add it
						updatedList = [updatedCollection, ...updatedList];
					}

					const updatedData = {
						...currentData,
						data: updatedList,
						total:
							itemIndex >= 0 && !typeMatches
								? Math.max(0, (currentData.total ?? currentData.data.length) - 1)
								: itemIndex < 0 && typeMatches
									? (currentData.total ?? currentData.data.length) + 1
									: currentData.total,
					};

					// Write to SQLite cache
					await writeCachedValue(collectionsCacheKey, updatedData);

					if (!cancelled) {
						// Update React Query cache directly without triggering refetch
						queryClient.setQueryData(collectionsQueryKey, updatedData);
					}
				} else {
					// No usable data — delete stale SQLite cache and force a fresh fetch
					if (!cancelled) {
						await deleteCachedValue(collectionsCacheKey);
						await queryClient.invalidateQueries({
							queryKey: collectionsQueryKey,
							exact: true,
						});
					}
				}
			})();
			window.history.replaceState({}, document.title);
			// Reset the flag after other effects have run
			const timer = window.setTimeout(() => {
				isReturningFromDetail.current = false;
				setShouldSuppressRefetch(false);
			}, 100);
			return () => {
				cancelled = true;
				window.clearTimeout(timer);
			};
		}
	}, [
		location,
		queryClient,
		collectionType,
		uname,
		collectionsQueryKey,
		collectionsCacheKey,
	]);

	const {
		data: collData,
		isLoading,
		error,
		dataUpdatedAt: collUpdatedAt,
		isFetching: isCollectionsFetching,
	} = useQuery({
		queryKey: collectionsQueryKey,
		queryFn: async () => {
			if (!uname) return { data: [], total: 0 };

			const legacyCollections = () =>
				readLegacyHttpCache<PagedResponse<UserCollection>>(
					`collections-${collectionType}-${uname}`,
				);
			const cached =
				await readCachedValueEntry<PagedResponse<UserCollection>>(
					collectionsCacheKey,
				);
			if (cached) {
				setQuerySource("collections", collectionsCacheKey, "cache");
				await backfillTotalEpisodesFromCache(cached.payload.data);
				const refreshTask = refreshQueryDataIfChanged({
					queryClient,
					queryKey: collectionsQueryKey,
					refreshKey: collectionsCacheKey,
					currentData: cached.payload,
					refresh: () =>
						fetchAndCacheCollections(collectionType, uname, collectionsCacheKey),
				});
				trackBackgroundRefresh(
					refreshTask?.then((changed) => {
						if (changed)
							setQuerySource("collections", collectionsCacheKey, "network");
						return changed;
					}) ?? null,
				);
				return cached.payload;
			}

			try {
				const result = await fetchAndCacheCollections(
					collectionType,
					uname,
					collectionsCacheKey,
				);
				setQuerySource("collections", collectionsCacheKey, "network");
				return result;
			} catch (err) {
				const fallback = await readCachedValueWithLegacy<
					PagedResponse<UserCollection>
				>(collectionsCacheKey, legacyCollections);
				if (fallback) {
					setQuerySource("collections", collectionsCacheKey, "cache");
					return fallback;
				}
				throw err;
			}
		},
		enabled: !!uname,
		staleTime: 0,
		refetchOnWindowFocus: "always",
		refetchOnMount: shouldSuppressRefetch ? false : true,
	});

	const {
		data: calendar,
		error: calError,
		dataUpdatedAt: calendarUpdatedAt,
		isFetching: isCalendarFetching,
	} = useQuery({
		queryKey: CALENDAR_QUERY_KEY,
		queryFn: async () => {
			const cached = await readCachedValueEntry<CalendarItem[]>("calendar");
			if (cached) {
				setQuerySource("calendar", "calendar", "cache");
				const refreshTask = refreshQueryDataIfChanged({
					queryClient,
					queryKey: CALENDAR_QUERY_KEY,
					refreshKey: "calendar",
					currentData: cached.payload,
					refresh: fetchAndCacheCalendar,
				});
				trackBackgroundRefresh(
					refreshTask?.then((changed) => {
						if (changed) setQuerySource("calendar", "calendar", "network");
						return changed;
					}) ?? null,
				);
				return cached.payload;
			}

			try {
				const result = await fetchAndCacheCalendar();
				setQuerySource("calendar", "calendar", "network");
				return result;
			} catch (err) {
				const fallback = await readCachedValueWithLegacy<CalendarItem[]>(
					"calendar",
					() => readLegacyHttpCache<CalendarItem[]>("calendar"),
				);
				if (fallback) {
					setQuerySource("calendar", "calendar", "cache");
					return fallback;
				}
				throw err;
			}
		},
		enabled: isWatching,
		staleTime: 0,
		refetchOnWindowFocus: "always",
		refetchOnMount: shouldSuppressRefetch ? false : true,
	});

	const rawCollections = collData?.data ?? EMPTY_COLLECTIONS;

	const airingMap = useMemo(() => buildAiringMap(calendar), [calendar]);

	const airingTimeCacheIds = useMemo(
		() =>
			isWatching
				? [...new Set(rawCollections.map((item) => item.subject_id))]
				: [],
		[rawCollections, isWatching],
	);
	const airingTimeCacheKey = airingTimeCacheIds.join(",");
	const shouldReadAiringTimeCache = isWatching && airingTimeCacheIds.length > 0;

	const {
		data: cachedAiringRecordMap,
		error: cachedAiringTimeError,
		dataUpdatedAt: cachedAiringTimeUpdatedAt,
		isFetched: cachedAiringTimeFetched,
	} = useQuery({
		queryKey: ["anilist-airing-times-cache-v2", airingTimeCacheKey],
		queryFn: () => readCachedAiringRecords(airingTimeCacheIds),
		enabled: shouldReadAiringTimeCache,
		staleTime: 5 * 60 * 1000,
		refetchOnMount: shouldSuppressRefetch ? false : true,
	});

	const airingIds = useMemo(
		() =>
			rawCollections
				.filter((item) => airingMap.has(item.subject_id))
				.map((item) => item.subject_id),
		[rawCollections, airingMap],
	);

	// 非日历但在补的条目——拉取 AniList 数据以确认是否在播
	// AniList nextAiringEpisode 是 isAiring 的二级判定信号
	const staleAiringIds = useMemo(
		() =>
			isWatching
				? rawCollections
						.filter((item) => !airingMap.has(item.subject_id))
						.filter((item) => {
							const total = item.subject.eps || item.subject.total_episodes || 0;
							return item.ep_status > 0 && (total === 0 || item.ep_status < total);
						})
						.map((item) => item.subject_id)
				: [],
		[rawCollections, airingMap, isWatching],
	);

	const allEpisodeIds = useMemo(
		() => [...new Set([...airingIds, ...staleAiringIds])],
		[airingIds, staleAiringIds],
	);

	const airingTimeTargets = useMemo(() => {
		if (!isWatching) return [];
		if (airingIds.length === 0 && staleAiringIds.length === 0) return [];
		const targetIds = new Set([...airingIds, ...staleAiringIds]);
		return rawCollections
			.filter((item) => targetIds.has(item.subject_id) && item.subject.name)
			.map((item) => ({
				subjectId: item.subject_id,
				name: item.subject.name,
				nameCn: item.subject.name_cn,
			}));
	}, [rawCollections, airingIds, staleAiringIds, isWatching]);

	const airingTimeTargetKey = airingTimeTargets
		.map((item) => item.subjectId)
		.join(",");

	const shouldLoadAiringTimes = isWatching && airingTimeTargets.length > 0;
	const {
		data: airingRecordMapData,
		error: airingTimeError,
		dataUpdatedAt: airingTimeUpdatedAt,
	} = useQuery({
		queryKey: ["anilist-airing-times-v2", airingTimeTargetKey],
		queryFn: async () => {
			const map = new Map<number, AiringCacheRecord>(
				cachedAiringRecordMap ?? EMPTY_AIRING_RECORD_MAP,
			);
			const now = getCurrentTimestamp();
			const targetsToRefresh = airingTimeTargets.filter((item) =>
				shouldRefreshAiringRecord(map.get(item.subjectId), now),
			);

			for (const [index, item] of targetsToRefresh.entries()) {
				if (index > 0) await delay(AIRING_REQUEST_DELAY);
				const previous = map.get(item.subjectId);
				const result = await lookupAiringTime(item);
				const fetchedAt = getCurrentTimestamp();
				if (result.status === "network_error") {
					console.warn(`[airing-schedule] ${item.subjectId}: ${result.message}`);
					continue;
				}

				const record: AiringCacheRecord =
					result.status === "scheduled"
						? {
								status: "scheduled",
								...result.value,
								fetchedAt,
							}
						: previous?.status === "scheduled"
							? {
									...previous,
									retryAfter: fetchedAt + AIRING_REFRESH_MIN_INTERVAL,
								}
							: { status: result.status, fetchedAt };
				await writeCachedValue(`${AIRING_CACHE_PREFIX}${item.subjectId}`, record);
				map.set(item.subjectId, record);
			}

			setQuerySource(
				"airingTimes",
				airingTimeTargetKey,
				targetsToRefresh.length > 0 ? "network" : "cache",
			);
			return map;
		},
		enabled: shouldLoadAiringTimes && cachedAiringTimeFetched,
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: "always",
		refetchOnMount: shouldSuppressRefetch ? false : true,
	});

	const airingRecordMap = useMemo(() => {
		if (!cachedAiringRecordMap && !airingRecordMapData) {
			return EMPTY_AIRING_RECORD_MAP;
		}
		const merged = new Map<number, AiringCacheRecord>(
			cachedAiringRecordMap ?? undefined,
		);
		if (airingRecordMapData) {
			for (const [subjectId, record] of airingRecordMapData) {
				merged.set(subjectId, record);
			}
		}
		return merged;
	}, [cachedAiringRecordMap, airingRecordMapData]);
	const airingObservationMap = useMemo(
		() => toAiringObservationMap(airingRecordMap),
		[airingRecordMap],
	);
	const episodesQueryKey = ["episodes-schedule-v2", allEpisodeIds.join(",")];
	const episodesQuerySourceKey = allEpisodeIds.join(",");
	const shouldLoadEpisodes =
		isWatching && rawCollections.length > 0 && allEpisodeIds.length > 0;

	const {
		data: episodeMap,
		error: episodeError,
		dataUpdatedAt: episodeUpdatedAt,
		isFetching: isEpisodeFetching,
	} = useQuery({
		queryKey: episodesQueryKey,
		queryFn: async () => {
			if (allEpisodeIds.length === 0) {
				return new Map<number, Episode[]>();
			}

			const now = getCurrentTimestamp();
			const map = new Map<number, Episode[]>();
			const cachedBySubjectId = new Map<number, EpisodeScheduleCache>();
			const idsToFetch: number[] = [];

			for (const id of allEpisodeIds) {
				const cached = await readCachedValue<EpisodeScheduleCache>(
					getEpisodeCacheKey(id),
				);
				if (isEpisodeScheduleCache(cached)) {
					cachedBySubjectId.set(id, cached);
					if (now - cached.checkedAt <= EPISODES_CACHE_MAX_AGE) {
						map.set(id, cached.episodes);
						continue;
					}
				}
				idsToFetch.push(id);
			}

			const results = await Promise.allSettled(
				idsToFetch.map(async (id) => ({
					id,
					episodes: await fetchEpisodeSchedule(id),
				})),
			);

			for (let index = 0; index < results.length; index += 1) {
				const result = results[index];
				const id = idsToFetch[index];
				if (result.status === "fulfilled") {
					const record: EpisodeScheduleCache = {
						episodes: result.value.episodes,
						checkedAt: getCurrentTimestamp(),
					};
					await writeCachedValue(getEpisodeCacheKey(id), record);
					map.set(id, record.episodes);
					continue;
				}

				console.warn(
					`[airing-schedule] failed to load BGM episodes for ${id}`,
					result.reason,
				);
				const cached = cachedBySubjectId.get(id);
				if (cached) map.set(id, cached.episodes);
			}

			setQuerySource(
				"episodes",
				episodesQuerySourceKey,
				idsToFetch.length > 0 ? "network" : "cache",
			);
			return map;
		},
		enabled: shouldLoadEpisodes,
		staleTime: EPISODES_CACHE_MAX_AGE,
		refetchOnWindowFocus: "always",
		refetchOnMount: shouldSuppressRefetch ? false : true,
	});

	const episodeListMap = episodeMap ?? EMPTY_EPISODE_LIST_MAP;
	const derivedAiringData = useMemo(
		() =>
			deriveAiringMaps(episodeListMap, airingObservationMap, airingMap, nowMs),
		[episodeListMap, airingObservationMap, airingMap, nowMs],
	);
	const airedEpMap = derivedAiringData.airedEpMap;
	const nextAiringAtMap = derivedAiringData.nextAiringAtMap;

	useEffect(() => {
		if (!isWatching || nextAiringAtMap.size === 0) return;
		const now = Date.now();
		const nextBoundary = Math.min(...nextAiringAtMap.values());
		const timer = window.setTimeout(
			() => {
				setNowMs(Date.now());
				void queryClient.invalidateQueries({
					queryKey: ["anilist-airing-times-v2"],
				});
			},
			Math.max(1000, nextBoundary - now + CLOCK_EPSILON_MS),
		);
		return () => window.clearTimeout(timer);
	}, [isWatching, nextAiringAtMap, queryClient]);

	const sorted = useMemo(() => {
		if (isWatching && calendar) {
			return sortCollections(
				rawCollections,
				calendar,
				today,
				airedEpMap,
				airingObservationMap,
				nextAiringAtMap,
			);
		}
		return rawCollections.map((collection) => ({
			collection,
			group: "completed" as const,
			weekday: 0,
			airedEp: 0,
		}));
	}, [
		rawCollections,
		calendar,
		isWatching,
		today,
		airedEpMap,
		airingObservationMap,
		nextAiringAtMap,
	]);

	const displayLabelMap = useMemo(() => {
		const map = new Map<number, string | null>();
		for (const item of sorted) {
			map.set(
				item.collection.subject_id,
				getDisplayLabel(
					item.collection,
					{ group: item.group, weekday: item.weekday, airedEp: item.airedEp },
					today,
					nextAiringAtMap,
					nowMs,
				),
			);
		}
		return map;
	}, [sorted, today, nextAiringAtMap, nowMs]);

	const committedScopeKey = `${uname ?? ""}:${collectionType}`;
	const shouldWaitForCalendar = isWatching;
	const shouldWaitForAiringTimes = shouldLoadAiringTimes;
	const shouldWaitForEpisodes = shouldLoadEpisodes;
	const shouldWaitForAiringTimeCache = shouldReadAiringTimeCache;
	const isAiringTimeCacheReady =
		!shouldWaitForAiringTimeCache ||
		cachedAiringRecordMap !== undefined ||
		Boolean(cachedAiringTimeError);
	const collectionsSource = getQuerySourceStatus(
		querySources,
		"collections",
		collectionsCacheKey,
		Boolean(uname),
		collData !== undefined,
		Boolean(error),
	);
	const calendarSource = getQuerySourceStatus(
		querySources,
		"calendar",
		"calendar",
		shouldWaitForCalendar,
		calendar !== undefined,
		Boolean(calError),
	);
	const airingTimesSource = getQuerySourceStatus(
		querySources,
		"airingTimes",
		airingTimeTargetKey,
		shouldWaitForAiringTimes,
		airingRecordMapData !== undefined,
		Boolean(airingTimeError),
	);
	const episodesSource = getQuerySourceStatus(
		querySources,
		"episodes",
		episodesQuerySourceKey,
		shouldWaitForEpisodes,
		episodeMap !== undefined,
		Boolean(episodeError),
	);
	const cacheCalendar = calendarSource === "cache" ? calendar : undefined;
	const cacheAiringObservationMap = useMemo(
		() =>
			toAiringObservationMap(cachedAiringRecordMap ?? EMPTY_AIRING_RECORD_MAP),
		[cachedAiringRecordMap],
	);
	const cacheEpisodeListMap =
		episodesSource === "cache" ? episodeListMap : EMPTY_EPISODE_LIST_MAP;
	const cacheDerivedAiringData = useMemo(
		() =>
			deriveAiringMaps(
				cacheEpisodeListMap,
				cacheAiringObservationMap,
				airingMap,
				nowMs,
			),
		[cacheEpisodeListMap, cacheAiringObservationMap, airingMap, nowMs],
	);
	const cacheAiredEpMap = cacheDerivedAiringData.airedEpMap;
	const cacheNextAiringAtMap = cacheDerivedAiringData.nextAiringAtMap;
	const cacheSorted = useMemo(() => {
		if (isWatching && cacheCalendar) {
			return sortCollections(
				rawCollections,
				cacheCalendar,
				today,
				cacheAiredEpMap,
				cacheAiringObservationMap,
				cacheNextAiringAtMap,
			);
		}
		return rawCollections.map((collection) => ({
			collection,
			group: "completed" as const,
			weekday: 0,
			airedEp: 0,
		}));
	}, [
		rawCollections,
		cacheCalendar,
		isWatching,
		today,
		cacheAiredEpMap,
		cacheAiringObservationMap,
		cacheNextAiringAtMap,
	]);
	const cacheDisplayLabelMap = useMemo(() => {
		const map = new Map<number, string | null>();
		for (const item of cacheSorted) {
			map.set(
				item.collection.subject_id,
				getDisplayLabel(
					item.collection,
					{ group: item.group, weekday: item.weekday, airedEp: item.airedEp },
					today,
					cacheNextAiringAtMap,
					nowMs,
				),
			);
		}
		return map;
	}, [cacheSorted, today, cacheNextAiringAtMap, nowMs]);
	const isDisplayDataAvailable =
		Boolean(uname) &&
		collData !== undefined &&
		(!shouldWaitForCalendar || calendar !== undefined || Boolean(calError)) &&
		isAiringTimeCacheReady &&
		(!shouldWaitForEpisodes || episodeMap !== undefined || Boolean(episodeError));
	const isDisplayNetworkIdle =
		backgroundRefreshCount === 0 &&
		!isCollectionsFetching &&
		(!shouldWaitForCalendar || !isCalendarFetching) &&
		(!shouldWaitForEpisodes || !isEpisodeFetching);
	const isDisplayReady =
		Boolean(uname) && isDisplayDataAvailable && isDisplayNetworkIdle;
	const canCommitCacheSnapshot =
		Boolean(uname) &&
		collData !== undefined &&
		collectionsSource === "cache" &&
		isAiringTimeCacheReady;
	const committedSource: DataSource = hasNetworkSource([
		collectionsSource,
		shouldWaitForCalendar ? calendarSource : "skip",
		shouldWaitForAiringTimes ? airingTimesSource : "skip",
		shouldWaitForEpisodes ? episodesSource : "skip",
	])
		? "network"
		: "cache";
	const cacheCommittedVersion = [
		committedScopeKey,
		todayDateKey,
		nowMs,
		"cache",
		collUpdatedAt || "pending",
		calendarSource === "cache" ? calendarUpdatedAt : "skip",
		shouldWaitForAiringTimeCache
			? `airing-cache:${cachedAiringRecordMap !== undefined ? cachedAiringTimeUpdatedAt : cachedAiringTimeError ? "error" : "pending"}`
			: "skip",
		episodesSource === "cache" ? episodeUpdatedAt : "skip",
	].join("|");
	const committedVersion = [
		committedScopeKey,
		todayDateKey,
		nowMs,
		committedSource,
		collectionsSource,
		collUpdatedAt || "pending",
		shouldWaitForCalendar
			? `${calendarSource}:${calendar !== undefined ? calendarUpdatedAt : calError ? "error" : "pending"}`
			: "skip",
		shouldWaitForAiringTimeCache
			? `airing-cache:${cachedAiringRecordMap !== undefined ? cachedAiringTimeUpdatedAt : cachedAiringTimeError ? "error" : "pending"}`
			: "skip",
		shouldWaitForAiringTimes
			? `${airingTimesSource}:${airingRecordMapData !== undefined ? airingTimeUpdatedAt : airingTimeError ? "error" : "pending"}`
			: "skip",
		shouldWaitForEpisodes
			? `${episodesSource}:${episodeMap !== undefined ? episodeUpdatedAt : episodeError ? "error" : "pending"}`
			: "skip",
	].join("|");

	useEffect(() => {
		if (!uname) {
			// eslint-disable-next-line react-hooks/set-state-in-effect
			setCommittedState(null);
			return;
		}
		if (!isDisplayReady && !canCommitCacheSnapshot) return;

		const shouldCommitSettledSnapshot = isDisplayReady;
		const nextVersion = shouldCommitSettledSnapshot
			? committedVersion
			: cacheCommittedVersion;
		const nextSource = shouldCommitSettledSnapshot ? committedSource : "cache";
		const nextSorted = shouldCommitSettledSnapshot ? sorted : cacheSorted;
		const nextDisplayLabelMap = shouldCommitSettledSnapshot
			? displayLabelMap
			: cacheDisplayLabelMap;

		setCommittedState((prev) => {
			if (!shouldCommitSettledSnapshot && prev?.scopeKey === committedScopeKey) {
				return prev;
			}
			if (prev?.version === nextVersion && prev.scopeKey === committedScopeKey) {
				return prev;
			}
			return {
				scopeKey: committedScopeKey,
				version: nextVersion,
				source: nextSource,
				sorted: nextSorted,
				displayLabelMap: nextDisplayLabelMap,
			};
		});
	}, [
		cacheCommittedVersion,
		cacheDisplayLabelMap,
		cacheSorted,
		canCommitCacheSnapshot,
		committedScopeKey,
		committedSource,
		committedVersion,
		displayLabelMap,
		isDisplayReady,
		sorted,
		uname,
	]);

	const activeCommittedState =
		committedState?.scopeKey === committedScopeKey ? committedState : null;
	const visibleSorted = activeCommittedState?.sorted ?? EMPTY_SORTED;
	const visibleDisplayLabelMap =
		activeCommittedState?.displayLabelMap ?? EMPTY_DISPLAY_LABEL_MAP;

	const filtered = searchText
		? visibleSorted.filter((item) => {
				const kw = buildSubjectKeywords(
					item.collection.subject.name_cn,
					item.collection.subject.name,
				);
				const lower = searchText.toLowerCase();
				return (
					(item.collection.subject.name_cn || "").toLowerCase().includes(lower) ||
					(item.collection.subject.name || "").toLowerCase().includes(lower) ||
					kw.some((k) => k.toLowerCase().includes(lower))
				);
			})
		: visibleSorted;

	const totalPages = Math.max(1, Math.ceil(visibleSorted.length / LIMIT));
	const isCommittedLoading = Boolean(uname) && !activeCommittedState && !error;

	const paged = filtered.slice((page - 1) * LIMIT, page * LIMIT);

	useEffect(() => {
		if (filtered.length === 0) return;
		const total = Math.max(1, Math.ceil(filtered.length / LIMIT));
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setPage((p) => Math.min(p, total));
	}, [filtered.length]);

	const prevTypeRef = useRef(collectionType);
	const prevSearchRef = useRef(searchText);
	const prevPageRef = useRef(page);

	useEffect(() => {
		// Don't adjust when returning from detail page
		if (isReturningFromDetail.current) {
			prevPageRef.current = page;
			return;
		}

		// If page changed, reset to first item
		if (prevPageRef.current !== page) {
			setFocusedIndex(0);
			prevPageRef.current = page;
		} else if (paged.length > 0) {
			// If only paged.length changed (data updated on same page), adjust to valid range
			// eslint-disable-next-line react-hooks/set-state-in-effect
			setFocusedIndex((i) => Math.min(i, paged.length - 1));
		}
	}, [paged.length, page]);

	useEffect(() => {
		// Don't reset when returning from detail page
		if (isReturningFromDetail.current) {
			prevTypeRef.current = collectionType;
			prevSearchRef.current = searchText;
			return;
		}
		// Only reset if type or search actually changed
		if (
			prevTypeRef.current !== collectionType ||
			prevSearchRef.current !== searchText
		) {
			setPage(1);
			setFocusedIndex(0);
			prevTypeRef.current = collectionType;
			prevSearchRef.current = searchText;
		}
	}, [collectionType, searchText]);

	useEffect(() => {
		if (
			page !== restoredPageState.page ||
			focusedIndex !== restoredPageState.focusedIndex
		) {
			writePageState(collectionType, searchText, page, focusedIndex);
		}
	}, [
		collectionType,
		focusedIndex,
		page,
		restoredPageState.focusedIndex,
		restoredPageState.page,
		searchText,
	]);

	const scrollKey = `${page}-${focusedIndex}-${paged.length}`;

	// Scroll focused item into view, centered
	useEffect(() => {
		const item = itemRefs.current[focusedIndex];
		if (item) {
			item.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	}, [focusedIndex, scrollKey]);

	function openSubject(subjectId: number) {
		writePageState(collectionType, searchText, page, focusedIndex);
		navigate(`/subject/${subjectId}`, {
			state: {
				fromCollections: true,
				page,
				focusedIndex,
				collectionType,
				searchText,
			},
		});
	}

	const clearAiringCache = async () => {
		await Promise.all([
			deleteCachedValuesByPrefix(AIRING_CACHE_PREFIX),
			deleteCachedValuesByPrefix(LEGACY_AIRING_CACHE_PREFIX),
			deleteCachedValuesByPrefix(EPISODES_CACHE_PREFIX),
			deleteCachedValuesByPrefix(LEGACY_EPISODES_CACHE_PREFIX),
		]);
		queryClient.resetQueries({ queryKey: ["episodes-schedule-v2"] });
		queryClient.resetQueries({ queryKey: ["anilist-airing-times-v2"] });
		await queryClient.refetchQueries({ queryKey: ["episodes-schedule-v2"] });
		await queryClient.refetchQueries({
			queryKey: ["anilist-airing-times-v2"],
		});
		invoke("show_toast", { message: "播出时间已刷新" });
	};

	// Keyboard navigation
	useKeyboardShortcuts(
		[
			{
				key: "r",
				mod: true,
				when: () => isWatching,
				handler: () => {
					clearAiringCache();
				},
			},
			{
				key: "o",
				mod: true,
				when: () => paged.length > 0,
				handler: () => {
					const item = paged[focusedIndex];
					if (item) {
						import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
							openUrl(`https://bgm.tv/subject/${item.collection.subject.id}`);
						});
					}
				},
			},
			{
				key: "Enter",
				mod: true,
				handler: () => {
					const item = paged[focusedIndex];
					if (item) {
						const name = getSubjectTitleForCopy(
							item.collection.subject.name_cn || item.collection.subject.name,
						);
						navigator.clipboard.writeText(name).then(async () => {
							const { getCurrentWindow } = await import("@tauri-apps/api/window");
							await invoke("show_toast", { message: "已复制条目名" });
							getCurrentWindow().hide();
						});
					}
				},
			},
			{
				key: ["ArrowLeft", "ArrowRight"],
				when: ({ mod }) => mod || !searchText,
				handler: ({ event }) => {
					if (event.key === "ArrowLeft") {
						setPage((p) => Math.max(1, p - 1));
					} else {
						setPage((p) => Math.min(totalPages, p + 1));
					}
				},
			},
			{
				key: "ArrowUp",
				when: () => paged.length > 0,
				handler: () => {
					setFocusedIndex((i) => (i <= 0 ? paged.length - 1 : i - 1));
				},
			},
			{
				key: "ArrowDown",
				when: () => paged.length > 0,
				handler: () => {
					setFocusedIndex((i) => (i >= paged.length - 1 ? 0 : i + 1));
				},
			},
			{
				key: "Enter",
				when: () => paged.length > 0,
				handler: () => {
					const item = paged[focusedIndex];
					if (item) {
						openSubject(item.collection.subject.id);
					}
				},
			},
		],
		{ priority: 10 },
	);

	return (
		<div className="h-full flex flex-col">
			{/* Page indicator */}
			<div className="px-4 py-1.5 text-[12px] text-fg-tertiary border-b border-line shrink-0 flex items-center gap-2">
				<span>
					{searchText
						? `搜索 · 共 ${filtered.length} 条`
						: `第 ${page} / ${totalPages} 页 · 共 ${visibleSorted.length} 条`}
				</span>
			</div>

			{/* Scrollable list */}
			<div className="flex-1 overflow-y-auto p-2.5">
				{error && !collData && (
					<p className="text-danger text-[13px] mb-2 px-1">
						收藏加载出错: {String(error)}
					</p>
				)}
				{error && collData && (
					<p className="text-fg-tertiary text-[12px] mb-2 px-1">
						收藏加载失败，显示缓存数据
					</p>
				)}
				{calError && !calendar && (
					<p className="text-danger text-[13px] mb-2 px-1">
						日历加载出错: {String(calError)}
					</p>
				)}
				{calError && calendar && (
					<p className="text-fg-tertiary text-[12px] mb-2 px-1">
						日历加载失败，显示缓存数据
					</p>
				)}
				{isCommittedLoading && (
					<p className="text-fg-tertiary text-[13px] px-1">加载中…</p>
				)}
				{!uname && !isLoading && (
					<p className="text-fg-tertiary text-[13px] px-1">正在获取用户信息…</p>
				)}

				<div className="space-y-0.5">
					{paged.map((item, index) => {
						const s = item.collection.subject;
						const label = isWatching
							? (visibleDisplayLabelMap.get(item.collection.subject_id) ?? null)
							: null;
						const weekday = s.air_weekday ? WEEKDAY_CN[s.air_weekday] : undefined;
						const showGroupHeader =
							isWatching && (index === 0 || item.group !== paged[index - 1].group);
						return (
							<Fragment key={s.id}>
								{showGroupHeader && (
									<div className="flex items-center gap-2 px-1 pt-3 pb-1.5 select-none">
										<div
											className="w-0.5 h-3.5 rounded-full shrink-0"
											style={{ backgroundColor: GROUP_COLOR[item.group] }}
										/>
										<span className="text-[12px] font-medium text-fg-secondary whitespace-nowrap">
											{GROUP_LABEL[item.group]}
										</span>
										<div className="flex-1 h-px bg-line" />
									</div>
								)}
								<SubjectRow
									ref={(el) => {
										itemRefs.current[index] = el;
									}}
									subjectId={s.id}
									coverUrl={s.images?.small}
									title={s.name_cn || s.name}
									subtitle={s.name_cn ? s.name : undefined}
									selected={index === focusedIndex}
									onClick={() => setFocusedIndex(index)}
									onDoubleClick={() => openSubject(s.id)}
									accessories={
										<>
											{label && <Tag>{label}</Tag>}
											{(s.score ?? s.rating?.score) ? (
												<Rating score={s.score ?? s.rating!.score} />
											) : null}
											{item.collection.subject.rank ? (
												<Meta>#{item.collection.subject.rank}</Meta>
											) : null}
											{weekday && <Meta>{weekday}</Meta>}
											<Meta>{SubjectTypeLabel[s.type]}</Meta>
										</>
									}
								/>
							</Fragment>
						);
					})}
				</div>
			</div>
		</div>
	);
}
