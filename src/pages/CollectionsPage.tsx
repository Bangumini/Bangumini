import { Fragment, useState, useMemo, useEffect, useRef, useCallback } from "react";
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
	getLatestEpisodeAiringAt,
	getNextEpisodeAiringAt,
	isRecentlyAired,
	RECENT_AIRING_WINDOW_MS,
	type AiringObservation,
	type AiringSchedule,
} from "@shared/airing-schedule";
import {
	applyCalendarAiringOffsets,
	applyCollectionAiringOffsets,
	applyEpisodeAiringOffset,
	deriveManualAiringStates,
	formatAiringOffsetDays,
	type AiringOffsets,
} from "@shared/airing-offset";
import {
	AIRING_CACHE_PREFIX,
	AIRING_REFRESH_MIN_INTERVAL,
	airingForceWindow,
	isAiringCacheRecord,
	isSameAiringSchedule,
	mergeAiringRecordMaps,
	removeLegacyAiringRecord,
	shouldRefreshAiringRecord,
	type AiringCacheRecord,
} from "@shared/airing-cache";
import {
	selectAiringSubjects,
	buildAiringWeekdayMap,
	type AiringTimeTarget,
} from "@shared/airing-targets";
import { diffCalendar } from "@shared/calendar-cache";
import { getForcedRoundStart } from "@shared/cache-force";
import {
	diffCollectionList,
	mergeConcurrentCollectionChanges,
} from "@shared/collection-cache";
import {
	EPISODES_CACHE_MAX_AGE,
	episodesForceWindow,
	getEpisodeCacheKey,
	isEpisodeScheduleCache,
	shouldRefreshEpisodeRecord,
	type EpisodeScheduleCache,
} from "@shared/episodes-cache";
import { isSameJsonPayload } from "@shared/payload-equality";
import { useAiringOffsets } from "../hooks/useAiringOffsets";
import { useCacheRefreshPending } from "../hooks/useCacheRefreshPending";
import {
	sortCollections,
	getDisplayLabel,
	WEEKDAY_CN,
	GROUP_LABEL,
	GROUP_COLOR,
} from "@shared/sort-collections";
import type { SortedCollection } from "@shared/sort-collections";
import { mergeCollectionPatchIntoList } from "@shared/collection-cache";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";
import {
	readAllCachedCollections,
	readCachedCollection,
	readCachedSubjectDeep,
	readCachedValueEntryAllowStale,
	readCachedValuesAllowStale,
	readCachedValueWithLegacy,
	readLegacyHttpCache,
	deleteCachedCollection,
	deleteCachedValue,
	writeCachedCollection,
	writeCachedSubjectPreviews,
	writeCachedValue,
} from "@shared/storage/sqlite-cache";
import { getUsername } from "../api/oauth";
import { beginCacheRefresh, refreshQueryDataIfChanged } from "../api/stale-cache-refresh";
import { readCachedQueryMap } from "../api/query-map-cache";
import { getSubjectTitleForCopy } from "../api/subject-title-copy";
import {
	COLLECTION_TASK_EVENT,
	getCollectionTaskQueue,
	getOptimisticCollectionPatchForSubject,
	mergePendingCollectionTasks,
	type CollectionTaskEventDetail,
} from "../api/collection-tasks";
import { SubjectRow, Rating, Meta, Tag } from "../components/SubjectRow";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

const LIMIT = 20;
const COLLECTIONS_CACHE_PREFIX = "collections-";
const AIRING_REQUEST_DELAY = 700;
const CLOCK_EPSILON_MS = 1000;
const EMPTY_COLLECTIONS: UserCollection[] = [];
const EMPTY_LOCAL_COLLECTIONS: ReadonlyMap<number, UserCollection | null> = new Map();
const EMPTY_SORTED: SortedCollection[] = [];
const EMPTY_EPISODE_LIST_MAP = new Map<number, Episode[]>();
const EMPTY_AIRING_RECORD_MAP = new Map<number, AiringCacheRecord>();
const EMPTY_DISPLAY_LABEL_MAP = new Map<number, string | null>();
const EMPTY_SUBJECT_ID_SET = new Set<number>();
const CALENDAR_QUERY_KEY = ["calendar"] as const;

type DataSource = "cache" | "network";
type QuerySourceName = "collections" | "calendar" | "airingTimes" | "episodes";
type QuerySourceStatus = DataSource | "pending" | "error" | "skip";
type QuerySourceState = Partial<
	Record<QuerySourceName, { key: string; source: DataSource }>
>;
type CollectionsLocationState = {
	fromSubject?: boolean;
	subjectId?: number;
	page?: number;
	focusedIndex?: number;
	collectionType?: string;
	searchText?: string;
};
type CollectionsDisplayInputs = {
	collections: UserCollection[];
	calendar: CalendarItem[];
	episodes: Map<number, Episode[]>;
	airingRecords: Map<number, AiringCacheRecord>;
};

type CommittedCollectionsState = {
	inputs?: CollectionsDisplayInputs;
	scopeKey: string;
	version: string;
	airingOffsetsVersion: string;
	source: DataSource;
	sorted: SortedCollection[];
	displayLabelMap: Map<number, string | null>;
	justUpdatedSubjectIds: Set<number>;
};

type CachedSnapshot<T> = {
	key: string;
	value: T | null;
	version: number;
	complete: boolean;
};

function createLocalCacheGate(key: string) {
	let release!: () => void;
	let readers = 0;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { key, promise, release, retain() {
		readers += 1;
		return () => {
			readers -= 1;
			// StrictMode 的探测性 cleanup 不应提前释放首屏屏障。
			queueMicrotask(() => { if (readers === 0) release(); });
		};
	} };
}

// 提示只是反馈：原生桥不可用（或测试环境未注入）时不能让已完成的同步变成失败。
function showToast(message: string, variant?: "error") {
	void invoke("show_toast", variant ? { message, variant } : { message }).catch(() => {});
}

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
	return buildAiringWeekdayMap(calendar);
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

function readLegacyAiringRecord(subjectId: number): AiringCacheRecord | null {
	try {
		const raw = localStorage.getItem(`bangumini-anilist-${subjectId}`);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as {
			airingAt?: unknown;
			episode?: unknown;
			cachedAt?: unknown;
			value?: {
				airingAt?: unknown;
				episode?: unknown;
				cachedAt?: unknown;
			};
		};
		const value = parsed.value ?? parsed;
		if (
			typeof value.airingAt !== "number" ||
			typeof value.episode !== "number"
		) {
			return null;
		}
		const fetchedAt =
			typeof parsed.cachedAt === "number"
				? parsed.cachedAt
				: typeof value.cachedAt === "number"
					? value.cachedAt
					: 0;
		return {
			status: "scheduled",
			airingAt: value.airingAt,
			episode: value.episode,
			fetchedAt,
		};
	} catch {
		return null;
	}
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
	const cachedByKey = await readCachedValuesAllowStale<AiringCacheRecord>([
		...cacheKeysBySubjectId.values(),
	]);
	const map = new Map<number, AiringCacheRecord>();
	for (const [subjectId, cacheKey] of cacheKeysBySubjectId) {
		let cached = cachedByKey.get(cacheKey);
		if (!cached) {
			cached = readLegacyAiringRecord(subjectId) ?? undefined;
			if (cached) {
				void writeCachedValue(cacheKey, cached).catch(() => {});
				// 迁移到 SQLite 后旧键即可删除，避免下次仍被当作权威记录。
				removeLegacyAiringRecord(subjectId);
			}
		}
		if (isAiringCacheRecord(cached)) {
			// 过期缓存仍用于首屏分组，是否需要刷新交给后续网络查询判断。
			map.set(subjectId, cached);
		}
	}
	return map;
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

const airingLookupsInFlight = new Map<number, ReturnType<typeof getAiringAt>>();

function lookupAiringTime(item: AiringTimeTarget) {
	const existing = airingLookupsInFlight.get(item.subjectId);
	if (existing) return existing;
	const task = lookupAiringTimeUncached(item).finally(() => airingLookupsInFlight.delete(item.subjectId));
	airingLookupsInFlight.set(item.subjectId, task);
	return task;
}

async function lookupAiringTimeUncached(item: AiringTimeTarget) {
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

async function readCachedCollectionsByType(
	username: string,
	collectionType: string,
): Promise<PagedResponse<UserCollection> | null> {
	const collections = await readAllCachedCollections(username);
	const type = Number.parseInt(collectionType, 10);
	const data = collections.filter((collection) => collection.type === type);
	if (data.length === 0) return null;
	return {
		data,
		total: data.length,
		limit: data.length,
		offset: 0,
	};
}

async function mergePendingCollectionData(
	data: PagedResponse<UserCollection>,
	currentData: PagedResponse<UserCollection> | undefined,
	username: string,
	collectionType: string,
) {
	const tasks = (await getCollectionTaskQueue()).filter(
		(task) => task.payload.username === username,
	);
	if (tasks.length === 0) return data;

	const cachedCollections = (
		await Promise.all(
			[...new Set(tasks.map((task) => task.payload.subjectId))].map((subjectId) =>
				readCachedCollection(username, subjectId),
			),
		)
	).filter((collection): collection is UserCollection => collection !== null);

	return mergePendingCollectionTasks({
		data,
		currentData,
		tasks,
		cachedCollections,
		username,
		collectionType: Number.parseInt(collectionType, 10) as UserCollection["type"],
	});
}

function hasLocalCollectionChanges(
	liveData: PagedResponse<UserCollection>,
	originalData: PagedResponse<UserCollection>,
) {
	const liveBySubjectId = new Map(
		liveData.data.map((collection) => [collection.subject_id, collection]),
	);
	if (liveBySubjectId.size !== originalData.data.length) return true;

	for (const original of originalData.data) {
		const live = liveBySubjectId.get(original.subject_id);
		if (!live) return true;
		if (live.type !== original.type || live.ep_status !== original.ep_status) {
			return true;
		}
	}
	return false;
}

async function readLocalValueEntry<T>(
	cacheKey: string,
	readLegacy: () => T | null,
	readDatabaseFallback?: () => Promise<T | null>,
): Promise<{ payload: T; updatedAt: number; isStale: boolean } | null> {
	const cached = await readCachedValueEntryAllowStale<T>(cacheKey);
	if (cached) return cached;

	const databaseFallback = await readDatabaseFallback?.();
	if (databaseFallback) {
		void writeCachedValue(cacheKey, databaseFallback).catch(() => {});
		return {
			payload: databaseFallback,
			updatedAt: 0,
			isStale: true,
		};
	}

	const legacy = readLegacy();
	if (!legacy) return null;

	void writeCachedValue(cacheKey, legacy).catch(() => {});
	return {
		payload: legacy,
		updatedAt: 0,
		isStale: true,
	};
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

const episodeSchedulesInFlight = new Map<number, Promise<Episode[]>>();
function fetchEpisodeSchedule(subjectId: number) {
	// 列表成员变化会换组合 key，但同一条目的旧请求仍属于本轮，必须共同等待。
	const existing = episodeSchedulesInFlight.get(subjectId);
	if (existing) return existing;
	const task = getEpisodes(subjectId)
		.then(data => data.data.filter(episode => episode.type === 0))
		.finally(() => episodeSchedulesInFlight.delete(subjectId));
	episodeSchedulesInFlight.set(subjectId, task);
	return task;
}

function deriveAiringMaps(
	episodeListMap: Map<number, Episode[]>,
	observationMap: Map<number, AiringObservation>,
	airingMap: Map<number, number>,
	nowMs: number,
	offsets: AiringOffsets,
) {
	const scheduleMap = new Map<number, AiringSchedule>();
	const airedEpMap = new Map<number, number>();
	const nextAiringAtMap = new Map<number, number>();
	const latestAiringAtMap = new Map<number, number>();

	for (const [subjectId, rawEpisodes] of episodeListMap) {
		const offsetDays = offsets[subjectId] ?? 0;
		const episodes = applyEpisodeAiringOffset(rawEpisodes, offsetDays);
		const observation = observationMap.get(subjectId);
		// 先按原始轨识别 24/25 点跨日，再平移日期；否则 +1 天可能被跨日推断抵消。
		const schedule = observation
			? deriveAiringSchedule(airingMap.get(subjectId), rawEpisodes, observation)
			: null;
		if (schedule) scheduleMap.set(subjectId, schedule);
		airedEpMap.set(subjectId, deriveAiredEpisodeCount(episodes, schedule, nowMs));
		const nextAiringAt = getNextEpisodeAiringAt(episodes, schedule, nowMs);
		if (nextAiringAt !== null) {
			nextAiringAtMap.set(subjectId, nextAiringAt);
		}
		const latestAiringAt = getLatestEpisodeAiringAt(episodes, schedule, nowMs);
		if (latestAiringAt !== null) {
			latestAiringAtMap.set(subjectId, latestAiringAt);
		}
	}

	return { scheduleMap, airedEpMap, nextAiringAtMap, latestAiringAtMap };
}

function getJustUpdatedSubjectIds(
	sorted: SortedCollection[],
	latestAiringAtMap: ReadonlyMap<number, number>,
	nowMs: number,
) {
	const subjectIds = new Set<number>();
	for (const item of sorted) {
		if (
			item.group === "airing_not_caught" &&
			isRecentlyAired(
				latestAiringAtMap.get(item.collection.subject_id),
				nowMs,
			)
		) {
			subjectIds.add(item.collection.subject_id);
		}
	}
	return subjectIds;
}

function projectCollectionsDisplay(
	inputs: CollectionsDisplayInputs,
	collectionType: string,
	today: number,
	nowMs: number,
	offsets: AiringOffsets,
	localCollections: ReadonlyMap<number, UserCollection | null>,
) {
	const byId = new Map(inputs.collections.map((item) => [item.subject_id, item]));
	for (const [id, local] of localCollections) {
		if (!local || local.type !== Number(collectionType)) {
			byId.delete(id);
		} else {
			const base = byId.get(id);
			// 用户操作只投影进度和收藏类型，不混入尚未整批提交的元数据。
			byId.set(id, base ? { ...base, type: local.type, ep_status: local.ep_status } : local);
		}
	}
	const raw = [...byId.values()];
	const collections = applyCollectionAiringOffsets(raw, offsets);
	const calendar = applyCalendarAiringOffsets(inputs.calendar, offsets);
	const observations = toAiringObservationMap(inputs.airingRecords);
	const derived = deriveAiringMaps(inputs.episodes, observations, buildAiringMap(inputs.calendar), nowMs, offsets);
	const sorted: SortedCollection[] = collectionType === "3"
		? sortCollections(collections, calendar, today, derived.airedEpMap, observations, derived.nextAiringAtMap,
			deriveManualAiringStates(raw, inputs.episodes, derived.airedEpMap, offsets))
		: collections.map((collection) => ({ collection, group: "completed", weekday: 0, airedEp: 0 }));
	const displayLabelMap = new Map(sorted.map((item) => [item.collection.subject_id,
		getDisplayLabel(item.collection, item, today, derived.nextAiringAtMap, nowMs)]));
	return { sorted, displayLabelMap,
		justUpdatedSubjectIds: getJustUpdatedSubjectIds(sorted, derived.latestAiringAtMap, nowMs) };
}

async function backfillTotalEpisodesFromCache(collections: UserCollection[]) {
	await Promise.allSettled(collections.map(async (c) => {
		const s = c.subject;
		if ((s.total_episodes ?? 0) > 0 || (s.eps ?? 0) > 0) return;
		const cached = await readCachedSubjectDeep(s.id);
		if (cached) {
			if (cached.total_episodes) s.total_episodes = cached.total_episodes;
			else if (cached.eps) s.eps = cached.eps;
		}
	}));
}

async function fetchAndCacheCollections(
	collectionType: string,
	uname: string,
	collectionsCacheKey: string,
	mergeResult?: (
		result: PagedResponse<UserCollection>,
	) => Promise<PagedResponse<UserCollection>>,
) {
	const networkResult =
		collectionType === "3"
			? await getAllUserCollections({ username: uname, type: 3 })
			: await getUserCollections({
					username: uname,
					type: parseInt(collectionType),
					limit: 100,
				});
	const cacheResult = {
		...networkResult,
		data: networkResult.data.map((item) => ({
			...item,
			subject: { ...item.subject },
		})),
	};
	await backfillTotalEpisodesFromCache(cacheResult.data);
	const result = mergeResult ? await mergeResult(cacheResult) : cacheResult;
	// 本地操作已经改变收藏状态时，旧响应不能落盘覆盖 worker 已确认的基础值，
	// 也不能把乐观目标当成服务端确认值持久化；交给 worker 负责相应缓存。
	if (!hasLocalCollectionChanges(result, cacheResult)) {
		void Promise.all([
			writeCachedSubjectPreviews(cacheResult.data.map((item) => item.subject)),
			writeCachedValue(collectionsCacheKey, cacheResult),
			Promise.all(cacheResult.data.map((item) => writeCachedCollection(uname, item))),
		]).catch(() => {});
	}
	return result;
}

async function fetchAndCacheCalendar() {
	const data = await getCalendar();
	// 缓存持久化放到后台，避免切换到日历时等待几十条 subject 写入完成。
	void Promise.all([
		writeCachedSubjectPreviews(data.flatMap((day) => day.items)),
		writeCachedValue("calendar", data),
	]).catch(() => {});
	return data;
}

export default function CollectionsPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const queryClient = useQueryClient();
	const [searchParams] = useSearchParams();
	const airingOffsets = useAiringOffsets();
	const airingOffsetsVersion = JSON.stringify(airingOffsets);

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
	const [cachedCollectionsSnapshot, setCachedCollectionsSnapshot] = useState<
		CachedSnapshot<PagedResponse<UserCollection>>
	>({ key: "", value: null, version: 0, complete: false });
	const [cachedCalendarSnapshot, setCachedCalendarSnapshot] = useState<
		CachedSnapshot<CalendarItem[]>
	>({ key: "", value: null, version: 0, complete: false });
	const [localCollectionState, setLocalCollectionState] = useState(() => ({
		username: getUsername(), collections: EMPTY_LOCAL_COLLECTIONS,
	}));
	const [shouldSuppressRefetch, setShouldSuppressRefetch] = useState(
		initialState.isReturningFromDetail,
	);
	const [isReconciliationPending, setIsReconciliationPending] = useState(
		initialState.isReturningFromDetail,
	);
	const [isManualSyncing, setIsManualSyncing] = useState(false);
	const manualSyncInFlight = useRef(false);
	const endRefreshCalendar = useRef<(() => void) | null>(null);
	const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
	const isWatching = collectionType === "3";
	const today = useMemo(
		() => getBangumiWeekdayFromDateKey(todayDateKey),
		[todayDateKey],
	);
	const isReturningFromDetail = useRef(initialState.isReturningFromDetail);
	const isMounted = useRef(true);

	const uname = getUsername();
	const localCollections = localCollectionState.username === uname
		? localCollectionState.collections : EMPTY_LOCAL_COLLECTIONS;

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

	useEffect(() => {
		isMounted.current = true;
		return () => {
			isMounted.current = false;
		};
	}, []);

	// 单条缓存由用户操作/worker 更新；独立投影，不解冻正在刷新的整页元数据。
	useEffect(() => {
		return queryClient.getQueryCache().subscribe((event) => {
			if (event.type !== "updated" || event.action.type !== "success") return;
			const [kind, id] = event.query.queryKey;
			if (kind !== "collection" || typeof id !== "number") return;
			const value = event.query.state.data as UserCollection | null | undefined;
			if (value === undefined) return;
			setLocalCollectionState((state) => {
				const previous = state.username === uname ? state.collections : EMPTY_LOCAL_COLLECTIONS;
				const old = previous.get(id);
				if (previous.has(id) && old?.type === value?.type && old?.ep_status === value?.ep_status) return state;
				return { username: uname, collections: new Map(previous).set(id, value) };
			});
		});
	}, [queryClient, uname]);

	const collectionsCacheKey = `${COLLECTIONS_CACHE_PREFIX}${collectionType}-${uname}`;
	const backgroundRefreshKeys = useMemo(() => isWatching
		? [collectionsCacheKey, "calendar"] : [collectionsCacheKey], [collectionsCacheKey, isWatching]);
	const isBackgroundRefreshing = useCacheRefreshPending(queryClient, backgroundRefreshKeys);
	const [localCacheGate, setLocalCacheGate] = useState(() => createLocalCacheGate(collectionsCacheKey));
	if (localCacheGate.key !== collectionsCacheKey) setLocalCacheGate(createLocalCacheGate(collectionsCacheKey));
	useEffect(() => localCacheGate.retain(), [localCacheGate]);
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

	// 从详情页返回时，先完成 pending task 投影，再解除旧列表快照的显示。
	useEffect(() => {
		const state = location.state as CollectionsLocationState | null;
		if (!(state?.fromSubject && state.subjectId && uname)) return;

		const subjectId = state.subjectId;
		let cancelled = false;

		void (async () => {
			try {
				const cachedCollection = queryClient.getQueryData<UserCollection>([
					"collection",
					subjectId,
				]);
				const fallbackCollection =
					cachedCollection ??
					((await readCachedCollection(uname, subjectId)) ?? undefined);
				const pendingTasks = (await getCollectionTaskQueue()).filter(
					(task) => task.payload.username === uname,
				);
				if (cancelled) return;

				// 等待队列期间 worker 或新任务可能已经更新内存，必须重新读取。
				const liveCollection = queryClient.getQueryData<UserCollection>([
					"collection",
					subjectId,
				]);
				const updatedCollection = liveCollection ?? fallbackCollection;
				const currentData =
					queryClient.getQueryData<PagedResponse<UserCollection>>(
						collectionsQueryKey,
					);
				const pendingPatch = getOptimisticCollectionPatchForSubject(
					subjectId,
					pendingTasks,
				);
				const currentCollection =
					updatedCollection ??
					currentData?.data.find((item) => item.subject_id === subjectId);
				const updatedPatch = updatedCollection
					? { type: updatedCollection.type, ep_status: updatedCollection.ep_status }
					: null;
				const collectionPatch = liveCollection && liveCollection !== cachedCollection
					? updatedPatch
					: pendingPatch ?? updatedPatch;
				const projectedCollection =
					currentCollection && collectionPatch
						? { ...currentCollection, ...collectionPatch }
						: currentCollection;

				if (currentData && projectedCollection && collectionPatch) {
					const reconciledData = mergeCollectionPatchIntoList({
						data: currentData,
						subjectId,
						patch: collectionPatch,
						collectionType: Number.parseInt(collectionType, 10) as UserCollection["type"],
						fallbackCollection: projectedCollection,
					});

					if (!cancelled) {
						queryClient.setQueryData(
							collectionsQueryKey,
							(liveData: PagedResponse<UserCollection> | undefined) => {
								if (!liveData) return reconciledData;
								return mergeCollectionPatchIntoList({
									data: liveData,
									subjectId,
									patch: collectionPatch,
									collectionType: Number.parseInt(collectionType, 10) as UserCollection["type"],
									fallbackCollection: projectedCollection,
								});
							},
						);
					}

					// 服务端确认后的持久化由 worker 负责；返回页不能将捕获的投影写回 SQLite。
				} else if (!cancelled) {
					await deleteCachedValue(collectionsCacheKey);
					await queryClient.invalidateQueries({
						queryKey: collectionsQueryKey,
						exact: true,
					});
				}
			} finally {
				if (!cancelled) {
					window.history.replaceState({}, document.title);
					isReturningFromDetail.current = false;
					setIsReconciliationPending(false);
					setShouldSuppressRefetch(false);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
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

			const initialData = queryClient.getQueryData<PagedResponse<UserCollection>>(
				collectionsQueryKey,
			);
			const mergeResult = async (
				data: PagedResponse<UserCollection>,
				preferMemory = false,
			) => {
				const currentData = queryClient.getQueryData<PagedResponse<UserCollection>>(
					collectionsQueryKey,
				);
				const merged = await mergePendingCollectionData(
					preferMemory ? currentData ?? data : data,
					currentData,
					uname,
					collectionType,
				);
				const liveData = queryClient.getQueryData<PagedResponse<UserCollection>>(
					collectionsQueryKey,
				);
				// SQLite/队列读取期间 worker 可能已经完成；不能再把先前读到的旧值提交回来。
				if (liveData === undefined || liveData === initialData) return merged;
				if (preferMemory) return liveData;
				return mergeConcurrentCollectionChanges({ data: merged, liveData,
					originalData: initialData ?? { data: [], total: 0, limit: 100, offset: 0 },
					collectionType: Number(collectionType) as UserCollection["type"] });
			};

			const legacyCollections = () =>
				readLegacyHttpCache<PagedResponse<UserCollection>>(
					`collections-${collectionType}-${uname}`,
				);
			const cached = await readLocalValueEntry(
				collectionsCacheKey,
				legacyCollections,
				() => readCachedCollectionsByType(uname, collectionType),
			);
			if (cached) {
				const merged = await mergeResult(cached.payload, true);
				const hydrated = { ...merged, data: merged.data.map((item) => ({ ...item, subject: { ...item.subject } })) };
				await backfillTotalEpisodesFromCache(hydrated.data);
				const live = queryClient.getQueryData<PagedResponse<UserCollection>>(collectionsQueryKey);
				const cachedPayload = live !== undefined && live !== initialData ? live : hydrated;
				const cachedEntry = { ...cached, payload: cachedPayload };
				setQuerySource("collections", collectionsCacheKey, "cache");
				setCachedCollectionsSnapshot({
					key: collectionsCacheKey,
					value: cachedEntry.payload,
					version: cachedEntry.updatedAt,
					complete: true,
				});

				const mergeLatest = (data: PagedResponse<UserCollection>, liveData: PagedResponse<UserCollection>, originalData: PagedResponse<UserCollection>) =>
					mergeConcurrentCollectionChanges({ data, liveData, originalData,
						collectionType: Number(collectionType) as UserCollection["type"] });
				const refreshTask = refreshQueryDataIfChanged({
					queryClient,
					queryKey: collectionsQueryKey,
					refreshKey: collectionsCacheKey,
					currentData: cachedEntry.payload,
					refresh: async () => {
						await localCacheGate.promise;
						return fetchAndCacheCollections(
							collectionType,
							uname,
							collectionsCacheKey,
							async (result) => {
								const merged = await mergePendingCollectionData(
									result,
									queryClient.getQueryData<PagedResponse<UserCollection>>(
										collectionsQueryKey,
									),
									uname,
									collectionType,
								);
								return mergeLatest(merged,
									queryClient.getQueryData<PagedResponse<UserCollection>>(collectionsQueryKey) ?? cachedEntry.payload,
									cachedEntry.payload);
							},
						);
					},
					mergeLatest,
				});
				void refreshTask?.then((changed) => {
					if (changed) setQuerySource("collections", collectionsCacheKey, "network");
				});
				return cachedEntry.payload;
			}

			setCachedCollectionsSnapshot({
				key: collectionsCacheKey,
				value: null,
				version: getCurrentTimestamp(),
				complete: false,
			});
			try {
				await localCacheGate.promise;
				const result = await fetchAndCacheCollections(
					collectionType,
					uname,
					collectionsCacheKey,
					mergeResult,
				);
				setQuerySource("collections", collectionsCacheKey, "network");
				return result;
			} catch (err) {
				const fallback = await readCachedValueWithLegacy<
					PagedResponse<UserCollection>
				>(collectionsCacheKey, legacyCollections);
				if (fallback) {
					const mergedFallback = await mergeResult(fallback, true);
					setQuerySource("collections", collectionsCacheKey, "cache");
					setCachedCollectionsSnapshot({
						key: collectionsCacheKey,
						value: mergedFallback,
						version: getCurrentTimestamp(),
						complete: true,
					});
					return mergedFallback;
				}
				throw err;
			}
		},
		enabled: !!uname,
		// 自定义 stale-while-revalidate 已负责刷新；短窗口内切标签直接复用内存数据。
		staleTime: 30_000,
		gcTime: 10 * 60 * 1000,
		refetchOnWindowFocus: true,
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
			const cached = await readLocalValueEntry<CalendarItem[]>(
				"calendar",
				() => readLegacyHttpCache<CalendarItem[]>("calendar"),
			);
			if (cached) {
				setQuerySource("calendar", "calendar", "cache");
				setCachedCalendarSnapshot({
					key: "calendar",
					value: cached.payload,
					version: cached.updatedAt,
					complete: true,
				});
				const refreshTask = refreshQueryDataIfChanged({
					queryClient,
					queryKey: CALENDAR_QUERY_KEY,
					refreshKey: "calendar",
					currentData: cached.payload,
					refresh: async () => {
						await localCacheGate.promise;
						return fetchAndCacheCalendar();
					},
				});
				void refreshTask?.then((changed) => {
					if (changed) setQuerySource("calendar", "calendar", "network");
				});
				return cached.payload;
			}

			setCachedCalendarSnapshot({
				key: "calendar",
				value: null,
				version: getCurrentTimestamp(),
				complete: false,
			});
			try {
				await localCacheGate.promise;
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
					setCachedCalendarSnapshot({
						key: "calendar",
						value: fallback,
						version: getCurrentTimestamp(),
						complete: true,
					});
					return fallback;
				}
				throw err;
			}
		},
		enabled: isWatching,
		staleTime: 30_000,
		gcTime: 10 * 60 * 1000,
		refetchOnWindowFocus: true,
		refetchOnMount: shouldSuppressRefetch ? false : true,
	});

	const rawCollections = collData?.data ??
		(cachedCollectionsSnapshot.key === collectionsCacheKey ? cachedCollectionsSnapshot.value?.data : undefined) ?? EMPTY_COLLECTIONS;
	const effectiveCollections = useMemo(
		() => applyCollectionAiringOffsets(rawCollections, airingOffsets),
		[rawCollections, airingOffsets],
	);
	const effectiveCalendar = useMemo(
		() => calendar && applyCalendarAiringOffsets(calendar, airingOffsets),
		[calendar, airingOffsets],
	);

	const discoveryCalendar = calendar ??
		(cachedCalendarSnapshot.key === "calendar" ? cachedCalendarSnapshot.value ?? undefined : undefined);
	const airingMap = useMemo(() => buildAiringMap(discoveryCalendar), [discoveryCalendar]);

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
		// Map 不支持结构共享；稳定工厂引用，避免请求挂起时反复生成 placeholder 并触发渲染循环。
		placeholderData: useCallback(
			() => readCachedQueryMap<AiringCacheRecord>(
				queryClient,
				[["anilist-airing-times-cache-v2"], ["anilist-airing-times-v2"]],
				airingTimeCacheIds,
				(record) => record.fetchedAt,
			),
			[queryClient, airingTimeCacheIds],
		),
		enabled: shouldReadAiringTimeCache,
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: true,
		refetchOnMount: shouldSuppressRefetch ? false : true,
	});

	// 非日历且未看完的条目——拉取 AniList 数据以确认是否在播
	// AniList nextAiringEpisode 是 isAiring 的二级判定信号
	// 未开始看（ep_status === 0）的条目同样需要确认，否则在播但未收录
	// 进 BGM 日历的条目会被误判为"完结 · 未观看"
	const airingSelection = useMemo(
		() =>
			selectAiringSubjects(rawCollections, discoveryCalendar, {
				watching: isWatching,
			}),
		[rawCollections, discoveryCalendar, isWatching],
	);
	const allEpisodeIds = airingSelection.allEpisodeIds;
	const airingTimeTargets = airingSelection.targets;

	const airingTimeTargetKey = airingTimeTargets
		.map((item) => item.subjectId)
		.join(",");

	const shouldLoadAiringTimes = isWatching && airingTimeTargets.length > 0;
	const {
		data: airingRecordMapData,
		error: airingTimeError,
		dataUpdatedAt: airingTimeUpdatedAt,
		isFetching: isAiringTimeFetching,
	} = useQuery({
		queryKey: ["anilist-airing-times-v2", airingTimeTargetKey],
		placeholderData: useCallback(
			() => readCachedQueryMap<AiringCacheRecord>(
				queryClient,
				[["anilist-airing-times-cache-v2"], ["anilist-airing-times-v2"]],
				airingTimeTargets.map((item) => item.subjectId),
				(record) => record.fetchedAt,
			),
			[queryClient, airingTimeTargets],
		),
		queryFn: async () => {
			const map = readCachedQueryMap<AiringCacheRecord>(
				queryClient,
				[["anilist-airing-times-cache-v2"], ["anilist-airing-times-v2"]],
				airingTimeTargets.map((item) => item.subjectId),
				(record) => record.fetchedAt,
			) ?? new Map<number, AiringCacheRecord>();
			for (const [subjectId, record] of cachedAiringRecordMap ?? []) {
				if (record.fetchedAt >= (map.get(subjectId)?.fetchedAt ?? -1)) {
					map.set(subjectId, record);
				}
			}
			await localCacheGate.promise;
			const now = getCurrentTimestamp();
			const roundStart = getForcedRoundStart(airingForceWindow, now);
			const targetsToRefresh = airingTimeTargets.filter((item) =>
				shouldRefreshAiringRecord(map.get(item.subjectId), now, {
					roundStart,
				}),
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
		refetchOnWindowFocus: true,
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
				if (record.fetchedAt >= (merged.get(subjectId)?.fetchedAt ?? -1)) {
					merged.set(subjectId, record);
				}
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
	// 本地读取单独缓存，不能藏在挂起的网络 query/component state 中；否则切页后读不到首版。
	const { data: cachedEpisodeRecords, isFetched: cachedEpisodeFetched } = useQuery({
		queryKey: ["episodes-schedule-local-v2", episodesQuerySourceKey],
		queryFn: () => readCachedValuesAllowStale<EpisodeScheduleCache>(allEpisodeIds.map(getEpisodeCacheKey)),
		enabled: shouldLoadEpisodes,
		staleTime: EPISODES_CACHE_MAX_AGE,
		refetchOnWindowFocus: false,
	});
	const cachedEpisodeSnapshot = useMemo<CachedSnapshot<Map<number, Episode[]>>>(() => {
		const value = new Map(readCachedQueryMap<Episode[]>(queryClient, [["episodes-schedule-v2"]], allEpisodeIds));
		let version = 0;
		for (const id of allEpisodeIds) {
			const cached = cachedEpisodeRecords?.get(getEpisodeCacheKey(id)) ?? null;
			if (isEpisodeScheduleCache(cached)) {
				if (!value.has(id)) value.set(id, cached.episodes);
				version = Math.max(version, cached.checkedAt);
			} else if (!value.has(id)) {
				const detailEpisodes = queryClient.getQueryData<PagedResponse<Episode>>(["episodes", id]);
				if (detailEpisodes) value.set(id, detailEpisodes.data.filter(episode => episode.type === 0));
			}
		}
		return { key: cachedEpisodeFetched ? episodesQuerySourceKey : "", value, version,
			complete: allEpisodeIds.every(id => value.has(id)) };
	}, [queryClient, allEpisodeIds, cachedEpisodeRecords, cachedEpisodeFetched, episodesQuerySourceKey]);

	const {
		data: episodeMap,
		error: episodeError,
		dataUpdatedAt: episodeUpdatedAt,
		isFetching: isEpisodeFetching,
	} = useQuery({
		queryKey: episodesQueryKey,
		placeholderData: useCallback(
			() => readCachedQueryMap<Episode[]>(
				queryClient,
				[["episodes-schedule-v2"]],
				allEpisodeIds,
			),
			[queryClient, allEpisodeIds],
		),
		queryFn: async () => {
			if (allEpisodeIds.length === 0) {
				return new Map<number, Episode[]>();
			}

			const now = getCurrentTimestamp();
			const roundStart = getForcedRoundStart(episodesForceWindow, now);
			const map = new Map<number, Episode[]>(
				readCachedQueryMap<Episode[]>(
					queryClient,
					[["episodes-schedule-v2"]],
					allEpisodeIds,
				),
			);
			const cachedBySubjectId = new Map<number, EpisodeScheduleCache>();
			const idsToFetch: number[] = [];
			// 一次读取所有剧集缓存，避免切换标签时为每个条目单独进行 IPC/SQLite 查询。
			const cachedByKey = cachedEpisodeRecords ?? new Map<string, EpisodeScheduleCache>();

			for (const id of allEpisodeIds) {
				const cached = cachedByKey.get(getEpisodeCacheKey(id)) ?? null;
				if (isEpisodeScheduleCache(cached)) {
					cachedBySubjectId.set(id, cached);
					if (!shouldRefreshEpisodeRecord(cached, now, { roundStart })) {
						if (!map.has(id)) map.set(id, cached.episodes);
						continue;
					}
				}
				idsToFetch.push(id);
			}

			await localCacheGate.promise;
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
		enabled: shouldLoadEpisodes && cachedEpisodeFetched,
		staleTime: EPISODES_CACHE_MAX_AGE,
		refetchOnWindowFocus: true,
		refetchOnMount: shouldSuppressRefetch ? false : true,
	});

	const episodeListMap = episodeMap ?? EMPTY_EPISODE_LIST_MAP;
	const derivedAiringData = useMemo(
		() =>
			deriveAiringMaps(episodeListMap, airingObservationMap, airingMap, nowMs, airingOffsets),
		[episodeListMap, airingObservationMap, airingMap, nowMs, airingOffsets],
	);
	const airedEpMap = derivedAiringData.airedEpMap;
	const nextAiringAtMap = derivedAiringData.nextAiringAtMap;
	const latestAiringAtMap = derivedAiringData.latestAiringAtMap;

	useEffect(() => {
		if (!isWatching) return;
		const now = Date.now();
		const nextAiringBoundary =
			nextAiringAtMap.size > 0
				? Math.min(...nextAiringAtMap.values())
				: Number.POSITIVE_INFINITY;
		const recentTagExpiry = Math.min(
			...Array.from(latestAiringAtMap.values())
				.map((airingAt) => airingAt + RECENT_AIRING_WINDOW_MS)
				.filter((expiry) => expiry > now),
			Number.POSITIVE_INFINITY,
		);
		const nextClockBoundary = Math.min(nextAiringBoundary, recentTagExpiry);
		if (!Number.isFinite(nextClockBoundary)) return;

		const timer = window.setTimeout(
			() => {
				setNowMs(Date.now());
				if (nextAiringBoundary <= recentTagExpiry) {
					void queryClient.invalidateQueries({
						queryKey: ["anilist-airing-times-v2"],
					});
				}
			},
			Math.max(1000, nextClockBoundary - now + CLOCK_EPSILON_MS),
		);
		return () => window.clearTimeout(timer);
	}, [isWatching, latestAiringAtMap, nextAiringAtMap, queryClient]);

	const sorted = useMemo(() => {
		if (isWatching) {
			return sortCollections(
				effectiveCollections,
				effectiveCalendar ?? [],
				today,
				airedEpMap,
				airingObservationMap,
				nextAiringAtMap,
				deriveManualAiringStates(rawCollections, episodeListMap, airedEpMap, airingOffsets),
			);
		}
		return effectiveCollections.map((collection) => ({
			collection,
			group: "completed" as const,
			weekday: 0,
			airedEp: 0,
		}));
	}, [
		effectiveCollections,
		effectiveCalendar,
		rawCollections,
		episodeListMap,
		airingOffsets,
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
	const justUpdatedSubjectIds = useMemo(
		() => getJustUpdatedSubjectIds(sorted, latestAiringAtMap, nowMs),
		[sorted, latestAiringAtMap, nowMs],
	);

	const committedScopeKey = `${uname ?? ""}:${collectionType}`;
	const shouldWaitForCalendar = isWatching;
	const shouldWaitForAiringTimes = shouldLoadAiringTimes;
	const shouldWaitForEpisodes = shouldLoadEpisodes;
	const shouldWaitForAiringTimeCache = shouldReadAiringTimeCache;
	const isAiringTimeCacheReady =
		!shouldWaitForAiringTimeCache || cachedAiringTimeFetched || Boolean(cachedAiringTimeError);
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
	const hasCollectionsSnapshot =
		cachedCollectionsSnapshot.key === collectionsCacheKey &&
		cachedCollectionsSnapshot.complete &&
		cachedCollectionsSnapshot.value !== null;
	// SQLite 快照只补首屏缺失数据，不能覆盖已提交的乐观/服务端内存状态。
	const cacheCollectionsData =
		collData ?? (hasCollectionsSnapshot ? cachedCollectionsSnapshot.value : null);
	const cacheRawCollections = cacheCollectionsData?.data ?? EMPTY_COLLECTIONS;
	const cacheEffectiveCollections = useMemo(
		() => applyCollectionAiringOffsets(cacheRawCollections, airingOffsets),
		[cacheRawCollections, airingOffsets],
	);
	const cacheCalendar = useMemo(
		() => {
			if (!isWatching) return undefined;
			if (cachedCalendarSnapshot.key === "calendar") return cachedCalendarSnapshot.value ?? [];
			return calendar ?? [];
		},
		[isWatching, cachedCalendarSnapshot, calendar],
	);
	const cacheEffectiveCalendar = useMemo(
		() => cacheCalendar && applyCalendarAiringOffsets(cacheCalendar, airingOffsets),
		[cacheCalendar, airingOffsets],
	);
	const cacheAiringMap = useMemo(
		() => buildAiringMap(cacheCalendar),
		[cacheCalendar],
	);
	const cacheAiringObservationMap = useMemo(
		() => toAiringObservationMap(airingRecordMap),
		[airingRecordMap],
	);
	const cacheEpisodeListMap =
		(cachedEpisodeSnapshot.key === episodesQuerySourceKey
			? cachedEpisodeSnapshot.value
			: episodeMap) ??
		EMPTY_EPISODE_LIST_MAP;

	const cacheDerivedAiringData = useMemo(
		() =>
			deriveAiringMaps(
				cacheEpisodeListMap,
				cacheAiringObservationMap,
				cacheAiringMap,
				nowMs,
				airingOffsets,
			),
		[cacheEpisodeListMap, cacheAiringObservationMap, cacheAiringMap, nowMs, airingOffsets],
	);
	const cacheAiredEpMap = cacheDerivedAiringData.airedEpMap;
	const cacheNextAiringAtMap = cacheDerivedAiringData.nextAiringAtMap;
	const cacheLatestAiringAtMap = cacheDerivedAiringData.latestAiringAtMap;
	const cacheSorted = useMemo(() => {
		if (isWatching) {
			return sortCollections(
				cacheEffectiveCollections,
				cacheEffectiveCalendar ?? [],
				today,
				cacheAiredEpMap,
				cacheAiringObservationMap,
				cacheNextAiringAtMap,
				deriveManualAiringStates(cacheRawCollections, cacheEpisodeListMap, cacheAiredEpMap, airingOffsets),
			);
		}
		return cacheEffectiveCollections.map((collection) => ({
			collection,
			group: "completed" as const,
			weekday: 0,
			airedEp: 0,
		}));
	}, [
		cacheEffectiveCollections,
		cacheEffectiveCalendar,
		cacheRawCollections,
		cacheEpisodeListMap,
		airingOffsets,
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
	const cacheJustUpdatedSubjectIds = useMemo(
		() =>
			getJustUpdatedSubjectIds(
				cacheSorted,
				cacheLatestAiringAtMap,
				nowMs,
			),
		[cacheSorted, cacheLatestAiringAtMap, nowMs],
	);
	const hasCachedCollections = hasCollectionsSnapshot || (collData !== undefined && collectionsSource !== "network");
	// 只等待本地读取，不等网络；空缓存也算读取完成，不能让离线首屏挂起。
	const localCacheReady =
		(cachedCollectionsSnapshot.key === collectionsCacheKey || collData !== undefined || Boolean(error)) &&
		(!isWatching || cachedCalendarSnapshot.key === "calendar" || calendar !== undefined || Boolean(calError)) &&
		(!shouldReadAiringTimeCache || cachedAiringTimeFetched || Boolean(cachedAiringTimeError) ||
			airingTimeCacheIds.every((id) => cachedAiringRecordMap?.has(id))) &&
		(!shouldLoadEpisodes || cachedEpisodeSnapshot.key === episodesQuerySourceKey || Boolean(episodeError) ||
			allEpisodeIds.every((id) => episodeMap?.has(id)));
	useEffect(() => { if (localCacheReady) localCacheGate.release(); }, [localCacheReady, localCacheGate]);
	const cacheInputs = useMemo<CollectionsDisplayInputs>(() => ({
		collections: cacheRawCollections, calendar: cacheCalendar ?? [], episodes: cacheEpisodeListMap,
		airingRecords: airingRecordMap,
	}), [cacheRawCollections, cacheCalendar, cacheEpisodeListMap, airingRecordMap]);
	const liveInputs = useMemo<CollectionsDisplayInputs>(() => ({
		collections: rawCollections, calendar: calendar ?? cacheCalendar ?? [],
		episodes: episodeMap ?? cacheEpisodeListMap, airingRecords: airingRecordMap,
	}), [rawCollections, calendar, cacheCalendar, episodeMap, cacheEpisodeListMap, airingRecordMap]);
	const isDisplayDataAvailable =
		Boolean(uname) &&
		collData !== undefined &&
		(!shouldWaitForCalendar || calendar !== undefined || Boolean(calError)) &&
		isAiringTimeCacheReady &&
		(!shouldWaitForAiringTimes ||
			airingRecordMapData !== undefined ||
			Boolean(airingTimeError)) &&
		(!shouldWaitForEpisodes || episodeMap !== undefined || Boolean(episodeError));
	const isDisplayNetworkIdle =
		!isBackgroundRefreshing &&
		!isCollectionsFetching &&
		(!shouldWaitForCalendar || !isCalendarFetching) &&
		(!shouldWaitForAiringTimes || (cachedAiringTimeFetched && !isAiringTimeFetching)) &&
		(!shouldWaitForEpisodes || (cachedEpisodeFetched && !isEpisodeFetching));
	const isDisplayReady =
		Boolean(uname) && isDisplayDataAvailable && isDisplayNetworkIdle;
	const canCommitCacheSnapshot = Boolean(uname) && hasCachedCollections && localCacheReady;
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
		airingOffsetsVersion,
		todayDateKey,
		nowMs,
		"cache",
		collUpdatedAt ||
			(cachedCollectionsSnapshot.key === collectionsCacheKey
				? cachedCollectionsSnapshot.version
				: "memory"),
		cachedCalendarSnapshot.key === "calendar"
			? cachedCalendarSnapshot.version
			: calendarUpdatedAt || "memory",
		cachedEpisodeSnapshot.key === episodesQuerySourceKey
			? cachedEpisodeSnapshot.version
			: episodeUpdatedAt || "memory",
		shouldWaitForAiringTimeCache
			? `airing-cache:${cachedAiringRecordMap !== undefined || airingRecordMapData !== undefined ? cachedAiringTimeUpdatedAt || airingTimeUpdatedAt : cachedAiringTimeError ? "error" : "pending"}`
			: "skip",
	].join("|");
	const committedVersion = [
		committedScopeKey,
		airingOffsetsVersion,
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
		const nextInputs = shouldCommitSettledSnapshot ? liveInputs : cacheInputs;
		const nextSorted = shouldCommitSettledSnapshot ? sorted : cacheSorted;
		const nextDisplayLabelMap = shouldCommitSettledSnapshot
			? displayLabelMap
			: cacheDisplayLabelMap;
		const nextJustUpdatedSubjectIds = shouldCommitSettledSnapshot
			? justUpdatedSubjectIds
			: cacheJustUpdatedSubjectIds;

		setCommittedState((prev) => {
			if (
				!shouldCommitSettledSnapshot &&
				prev?.scopeKey === committedScopeKey
			) {
				return prev;
			}
			if (prev?.scopeKey === committedScopeKey) {
				if (prev.inputs === nextInputs || (!prev.inputs && prev.version === nextVersion)) return prev;
				const encode = (_key: string, value: unknown) => value instanceof Map ? [...value] : value;
				if (prev.inputs && JSON.stringify(prev.inputs, encode) === JSON.stringify(nextInputs, encode)) return prev;
			}
			return {
				inputs: nextInputs,
				scopeKey: committedScopeKey,
				version: nextVersion,
				airingOffsetsVersion,
				source: nextSource,
				sorted: nextSorted,
				displayLabelMap: nextDisplayLabelMap,
				justUpdatedSubjectIds: nextJustUpdatedSubjectIds,
			};
		});
		if (shouldCommitSettledSnapshot) {
			// 基础快照已经确认同一用户目标后才移除覆盖层，防止日后刷新仍沿用旧目标。
			setLocalCollectionState((state) => {
				if (state.username !== uname) return state;
				const previous = state.collections;
				const byId = new Map(nextInputs.collections.map((item) => [item.subject_id, item]));
				const remaining = new Map([...previous].filter(([id, local]) => {
					const base = byId.get(id);
					return local?.type === Number(collectionType)
						? !base || base.type !== local.type || base.ep_status !== local.ep_status
						: base !== undefined;
				}));
				return remaining.size === previous.size ? state : { ...state, collections: remaining };
			});
		}
	}, [
		collectionType,
		localCollections,
		airingOffsetsVersion,
		cacheCommittedVersion,
		cacheDisplayLabelMap,
		cacheJustUpdatedSubjectIds,
		cacheSorted,
		cacheInputs,
		liveInputs,
		canCommitCacheSnapshot,
		committedScopeKey,
		committedSource,
		committedVersion,
		displayLabelMap,
		isDisplayReady,
		justUpdatedSubjectIds,
		sorted,
		uname,
	]);

	const localFallbackState: CommittedCollectionsState | null =
		canCommitCacheSnapshot
			? {
					inputs: cacheInputs,
					scopeKey: committedScopeKey,
					version: cacheCommittedVersion,
					airingOffsetsVersion,
					source: "cache",
					sorted: cacheSorted,
					displayLabelMap: cacheDisplayLabelMap,
					justUpdatedSubjectIds: cacheJustUpdatedSubjectIds,
				}
			: null;
	// 已提交的输入整批冻结；本地偏置、时钟和用户意图仅在其上重新投影。
	const committedForScope = committedState?.scopeKey === committedScopeKey &&
		(committedState.inputs || committedState.airingOffsetsVersion === airingOffsetsVersion)
		? committedState : null;
	const activeCommittedState = isReconciliationPending ? null : (committedForScope ?? localFallbackState);
	const projectedState = useMemo(() => {
		if (!activeCommittedState?.inputs) return activeCommittedState;
		return { ...activeCommittedState, ...projectCollectionsDisplay(activeCommittedState.inputs,
			collectionType, today, nowMs, airingOffsets, localCollections) };
	}, [activeCommittedState, collectionType, today, nowMs, airingOffsets, localCollections]);
	const visibleSorted = projectedState?.sorted ?? EMPTY_SORTED;
	const visibleDisplayLabelMap = projectedState?.displayLabelMap ?? EMPTY_DISPLAY_LABEL_MAP;
	const visibleJustUpdatedSubjectIds = projectedState?.justUpdatedSubjectIds ?? EMPTY_SUBJECT_ID_SET;

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

	// 首次切换到页面或数据页变化时不要播放无意义的滚动动画；
	// 键盘移动焦点时再平滑滚动。
	const scrollScope = `${collectionType}:${searchText}:${page}`;
	const initialScrollScopeRef = useRef<string | null>(null);
	useEffect(() => {
		const item = itemRefs.current[focusedIndex];
		if (!item) return;
		const isInitialScroll = initialScrollScopeRef.current !== scrollScope;
		initialScrollScopeRef.current = scrollScope;
		item.scrollIntoView({
			behavior: isInitialScroll ? "auto" : "smooth",
			block: isInitialScroll ? "nearest" : "center",
		});
	}, [focusedIndex, paged.length, page, scrollScope]);

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

	// Ctrl+R：以增量方式把其他端（网页/手机）的收藏与排期同步到本地。
	// 先对比再写入：未变化的条目不重建、不落盘；失败的数据源单独报告，其余照常更新。
	const runManualSync = useCallback(async () => {
		if (!uname) return;
		if (manualSyncInFlight.current) return;
		manualSyncInFlight.current = true;
		setIsManualSyncing(true);
		// 整批刷新期间保持一次提交：收藏先到、日历后到时，列表不会先闪一帧旧排期。
		const endRefresh = beginCacheRefresh(queryClient, collectionsCacheKey);
		if (isWatching) {
			endRefreshCalendar.current = beginCacheRefresh(queryClient, "calendar");
		}

		const failed: string[] = [];
		let changedCollections = 0;
		let removedCollections = 0;
		let addedCollections = 0;
		let calendarChanged = false;

		try {
			const tasks = (await getCollectionTaskQueue()).filter(
				(task) => task.payload.username === uname,
			);
			const pendingSubjectIds = new Set(
				tasks.map((task) => task.payload.subjectId),
			);

			// 强制语义要在发请求前就登记：页面里已挂载的 query 一旦被 refetch，
			// queryFn 会立刻读取这个起点，晚一步登记就会退回常规新鲜度判断。
			airingForceWindow.request();
			episodesForceWindow.request();
			const airingIds = airingSelection.allEpisodeIds;
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
					// 与常规拉取保持一致：服务端没给总集数时用本地详情补全，
					// 否则“已看完”判断会退化成 total=0 而重新请求 AniList。
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
					console.warn("[manual-sync] collections failed", error);
					failed.push("收藏");
				}
			})();

			// 3. 日历：只回写新增/变化的条目预览。
			const calendarTask = (async () => {
				if (!isWatching) return;
				try {
					const incoming = await getCalendar();
					const current = queryClient.getQueryData<CalendarItem[]>(
						CALENDAR_QUERY_KEY,
					);
					const diff = diffCalendar(current, incoming);
					if (!diff.changed) return;
					queryClient.setQueryData(CALENDAR_QUERY_KEY, diff.calendar);
					calendarChanged = true;
					if (diff.changedSubjects.length > 0) {
						await writeCachedSubjectPreviews(diff.changedSubjects);
					}
					await writeCachedValue("calendar", diff.calendar);
				} catch (error) {
					console.warn("[manual-sync] calendar failed", error);
					failed.push("日历");
				}
			})();

			// 4. 播出时间与剧集表：只跳过限流窗口，不先清空缓存，界面始终保留旧值。
			// refetchQueries 自身就会强制发起请求，因此不再先 invalidate（否则同一轮会取两次）。
			const scheduleTask = Promise.all([
				queryClient.refetchQueries({
					queryKey: ["anilist-airing-times-v2"],
				}),
				queryClient.refetchQueries({
					queryKey: ["episodes-schedule-v2"],
				}),
			]);

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

			const total =
				changedCollections + addedCollections + removedCollections;
			const summary = [
				addedCollections > 0 ? `新增 ${addedCollections}` : null,
				changedCollections > 0 ? `更新 ${changedCollections}` : null,
				removedCollections > 0 ? `移出 ${removedCollections}` : null,
			]
				.filter(Boolean)
				.join("、");
			if (failed.length > 0) {
				showToast(
					`${failed.join("、")}同步失败${total > 0 ? `，已更新 ${total} 项收藏` : ""}`,
					"error",
				);
			} else if (total > 0) {
				showToast(`已同步 ${summary} 项收藏`);
			} else if (calendarChanged) {
				showToast("日历已更新");
			} else if (airingChanges > 0) {
				showToast(`播出时间已更新 ${airingChanges} 项`);
			} else {
				showToast("已是最新");
			}
		} finally {
			endRefresh();
			endRefreshCalendar.current?.();
			endRefreshCalendar.current = null;
			manualSyncInFlight.current = false;
			if (isMounted.current) setIsManualSyncing(false);
		}
	}, [
		airingSelection,
		collectionType,
		collectionsCacheKey,
		collectionsQueryKey,
		isWatching,
		queryClient,
		uname,
	]);

	// Keyboard navigation
	useKeyboardShortcuts(
		[
			{
				key: "r",
				mod: true,
				when: () => isWatching,
				handler: () => {
					void runManualSync();
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
						: `第 ${page} / ${totalPages} 页 · 共 ${visibleSorted.length} 条`},{}
				</span>
				{isManualSyncing && (
					<span className="text-accent animate-pulse">同步中…</span>
				)}
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
											{visibleJustUpdatedSubjectIds.has(item.collection.subject_id) && (
											<Tag>刚更新</Tag>
										)}
										{label && <Tag>{label}</Tag>}
										{Boolean(airingOffsets[s.id]) && (
											<Tag>手动{formatAiringOffsetDays(airingOffsets[s.id])}</Tag>
										)}
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
