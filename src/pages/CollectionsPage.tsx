import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  getAllUserCollections,
  getCalendar,
  getEpisodes,
  getUserCollection,
  getUserCollections,
  postUserCollection,
} from "@shared/api/client";
import type { CalendarItem, PagedResponse, UserCollection } from "@shared/api/types";
import { getAiringAt } from "@shared/api/anilist";
import { SubjectTypeLabel } from "@shared/api/types";
import {
  sortCollections,
  getDisplayLabel,
  WEEKDAY_CN,
} from "@shared/sort-collections";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";
import {
  deleteCachedValue,
  deleteCachedValuesByPrefix,
  readCachedCollection,
  readCachedValue,
  readCachedValueEntry,
  readCachedValueWithin,
  readCachedValueWithLegacy,
  readLegacyHttpCache,
  writeCachedCollection,
  writeCachedSubjectPreviews,
  writeCachedValue,
} from "@shared/storage/sqlite-cache";
import { getUsername } from "../api/oauth";
import { isCacheStale, refreshQueryDataIfChanged } from "../api/stale-cache-refresh";
import { getSubjectTitleForCopy } from "../api/subject-title-copy";
import {
  COLLECTION_TASK_EVENT,
  PENDING_COLLECTION_ACTIONS_EVENT,
  getPendingCollectionActions,
  removePendingCollectionAction,
  runCollectionTask,
  type CollectionTaskEventDetail,
  type PendingCollectionAction,
} from "../api/collection-tasks";
import { SubjectRow, Rating, Meta, Tag } from "../components/SubjectRow";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

const LIMIT = 20;
const COLLECTIONS_CACHE_PREFIX = "collections-";
const AIRING_CACHE_PREFIX = "anilist-airing-";
const EPISODES_CACHE_PREFIX = "episodes-";
const AIRING_REQUEST_DELAY = 700;
const QUERY_CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const EPISODES_CACHE_MAX_AGE = 1000 * 60 * 30;
const EMPTY_COLLECTIONS: UserCollection[] = [];
const EMPTY_EPISODE_MAP = new Map<number, number>();
const EMPTY_DISPLAY_LABEL_MAP = new Map<number, string | null>();
const CALENDAR_QUERY_KEY = ["calendar"] as const;

type DataSource = "cache" | "network";
type QuerySourceName = "collections" | "calendar" | "airingTimes" | "episodes";
type QuerySourceStatus = DataSource | "pending" | "error" | "skip";
type QuerySourceState = Partial<Record<QuerySourceName, { key: string; source: DataSource }>>;
type AiringTime = { airingAt: number; episode: number };
type EpisodeCountCache = {
  airedEp: number;
  checkedAt: number;
  airingMinuteOfDay: number | null;
};
const EMPTY_AIRING_TIME_MAP = new Map<number, AiringTime>();
type CollectionsLocationState = {
  fromSubject?: boolean;
  subjectId?: number;
  page?: number;
  focusedIndex?: number;
};
type CommittedCollectionsState = {
  scopeKey: string;
  version: string;
  source: DataSource;
  sorted: UserCollection[];
  displayLabelMap: Map<number, string | null>;
};

function getPageStateKey(collectionType: string, searchText: string) {
  return `bangumini-collections-page-${collectionType}-${searchText}`;
}

function readPageState(collectionType: string, searchText: string): { page: number; focusedIndex: number } {
  try {
    const raw = sessionStorage.getItem(getPageStateKey(collectionType, searchText));
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

function writePageState(collectionType: string, searchText: string, page: number, focusedIndex: number) {
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

function readLegacyAiringCache(subjectId: number): AiringTime | null {
  try {
    const raw = localStorage.getItem(`bangumini-anilist-${subjectId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // new format: { airingAt, episode }
    if (typeof parsed.airingAt === "number") return parsed as AiringTime;
    // old format: { title, value: { airingAt, episode }, cachedAt }
    if (parsed.value && typeof parsed.value.airingAt === "number") return parsed.value as AiringTime;
    return null;
  } catch {
    return null;
  }
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

function isEpisodeCountCache(value: EpisodeCountCache | null): value is EpisodeCountCache {
  return (
    !!value &&
    typeof value.airedEp === "number" &&
    typeof value.checkedAt === "number" &&
    (typeof value.airingMinuteOfDay === "number" || value.airingMinuteOfDay === null)
  );
}

function getBangumiWeekdayFromDate(date: Date) {
  const jsDay = date.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function getAiringMinuteOfDay(airingAt: number) {
  const date = new Date(airingAt * 1000);
  return date.getHours() * 60 + date.getMinutes();
}

function hasWeeklyAiringSinceLastCheck(
  cached: EpisodeCountCache,
  weekday: number | undefined,
  currentAiringMinuteOfDay: number | null,
  now: number,
) {
  const airingMinuteOfDay = currentAiringMinuteOfDay ?? cached.airingMinuteOfDay;
  if (!weekday || airingMinuteOfDay === null) return false;

  const day = new Date(cached.checkedAt);
  day.setHours(0, 0, 0, 0);

  while (day.getTime() <= now) {
    if (getBangumiWeekdayFromDate(day) === weekday) {
      const airingAt = day.getTime() + airingMinuteOfDay * 60 * 1000;
      if (airingAt >= cached.checkedAt && airingAt <= now) return true;
    }
    day.setDate(day.getDate() + 1);
  }

  return false;
}

function hasKnownWeeklyAiringTime(cached: EpisodeCountCache, currentAiringMinuteOfDay: number | null) {
  return currentAiringMinuteOfDay !== null || cached.airingMinuteOfDay !== null;
}

function shouldUseCachedEpisodeCount(
  cached: EpisodeCountCache,
  weekday: number | undefined,
  currentAiringMinuteOfDay: number | null,
  now: number,
) {
  if (hasWeeklyAiringSinceLastCheck(cached, weekday, currentAiringMinuteOfDay, now)) {
    return false;
  }
  const maxAge = hasKnownWeeklyAiringTime(cached, currentAiringMinuteOfDay)
    ? QUERY_CACHE_MAX_AGE
    : EPISODES_CACHE_MAX_AGE;
  return now - cached.checkedAt <= maxAge;
}

function getAiringMinuteForCache(currentAiringMinuteOfDay: number | null, cached?: EpisodeCountCache) {
  return currentAiringMinuteOfDay ?? cached?.airingMinuteOfDay ?? null;
}

function getNextWeeklyAiringAt(weekday: number, airingMinuteOfDay: number, now: number) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(day);
    candidate.setDate(day.getDate() + offset);
    if (getBangumiWeekdayFromDate(candidate) !== weekday) continue;

    const airingAt = candidate.getTime() + airingMinuteOfDay * 60 * 1000;
    if (airingAt > now) return airingAt;
  }

  return null;
}

async function fetchAiredEpisodeCount(subjectId: number, todayDateKey: string) {
  const data = await getEpisodes(subjectId);
  const mainEps = data.data.filter((ep) => ep.type === 0);
  return mainEps.filter((ep) => ep.airdate && ep.airdate <= todayDateKey).length;
}

async function fetchAndCacheCollections(
  collectionType: string,
  uname: string,
  collectionsCacheKey: string,
) {
  const result = collectionType === "3"
    ? await getAllUserCollections({ username: uname, type: 3 })
    : await getUserCollections({ username: uname, type: parseInt(collectionType), limit: 100 });

  await writeCachedSubjectPreviews(result.data.map((item) => item.subject));
  await writeCachedValue(collectionsCacheKey, result);
  return result;
}

async function fetchAndCacheCalendar() {
  const data = await getCalendar();
  await writeCachedSubjectPreviews(data.flatMap((day) => day.items));
  await writeCachedValue("calendar", data);
  return data;
}

function upsertCollection(
  data: PagedResponse<UserCollection>,
  collection: UserCollection,
): PagedResponse<UserCollection> {
  const idx = data.data.findIndex((item) => item.subject_id === collection.subject_id);
  if (idx >= 0) {
    const next = [...data.data];
    next[idx] = collection;
    return { ...data, data: next };
  }

  return {
    ...data,
    total: data.total + 1,
    data: [collection, ...data.data],
  };
}

function removeCollection(
  data: PagedResponse<UserCollection>,
  subjectId: number,
): PagedResponse<UserCollection> {
  const idx = data.data.findIndex((item) => item.subject_id === subjectId);
  if (idx < 0) return data;

  const next = [...data.data];
  next.splice(idx, 1);
  return {
    ...data,
    total: Math.max(0, data.total - 1),
    data: next,
  };
}

export default function CollectionsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  const collectionType = searchParams.get("type") ?? "3";
  const searchText = searchParams.get("filter") ?? "";
  const restoredPageState = useMemo(() => readPageState(collectionType, searchText), [collectionType, searchText]);

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
  const [committedState, setCommittedState] = useState<CommittedCollectionsState | null>(null);
  const [querySources, setQuerySources] = useState<QuerySourceState>({});
  const [backgroundRefreshCount, setBackgroundRefreshCount] = useState(0);
  const [shouldSuppressRefetch, setShouldSuppressRefetch] = useState(initialState.isReturningFromDetail);
  const [pendingActions, setPendingActions] = useState<PendingCollectionAction[]>(() => getPendingCollectionActions());
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isWatching = collectionType === "3";
  const today = useMemo(() => getBangumiWeekdayFromDateKey(todayDateKey), [todayDateKey]);
  const isReturningFromDetail = useRef(initialState.isReturningFromDetail);
  const isMounted = useRef(true);

  const uname = getUsername();

  function setQuerySource(name: QuerySourceName, key: string, source: DataSource) {
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
  const collectionsQueryKey = useMemo(() => ["collections", collectionType, uname] as const, [collectionType, uname]);

  useEffect(() => {
    const syncTodayDateKey = () => setTodayDateKey(getLocalDateString());
    const handleVisibilityChange = () => {
      if (!document.hidden) syncTodayDateKey();
    };
    const timer = window.setTimeout(syncTodayDateKey, getMsUntilNextLocalDay());

    window.addEventListener("focus", syncTodayDateKey);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", syncTodayDateKey);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [todayDateKey]);

  useEffect(() => {
    const handleCollectionTask = (event: Event) => {
      const detail = (event as CustomEvent<CollectionTaskEventDetail>).detail;
      if (detail.status !== "finished") return;

      const currentType = parseInt(collectionType);
      if (detail.previousType !== currentType && detail.nextType !== currentType) return;

      void queryClient.invalidateQueries({ queryKey: collectionsQueryKey, exact: true });
    };

    window.addEventListener(COLLECTION_TASK_EVENT, handleCollectionTask);
    return () => {
      window.removeEventListener(COLLECTION_TASK_EVENT, handleCollectionTask);
    };
  }, [collectionType, collectionsQueryKey, queryClient]);

  useEffect(() => {
    const syncPendingActions = () => setPendingActions(getPendingCollectionActions());

    window.addEventListener(PENDING_COLLECTION_ACTIONS_EVENT, syncPendingActions);
    return () => {
      window.removeEventListener(PENDING_COLLECTION_ACTIONS_EVENT, syncPendingActions);
    };
  }, []);

  async function executePendingAction(action: PendingCollectionAction) {
    if (!uname) return;

    try {
      await runCollectionTask({
        subjectId: action.subjectId,
        previousType: action.previousType,
        nextType: action.nextType,
      }, async () => {
        await postUserCollection(action.subjectId, { type: action.nextType });
        const updated = await getUserCollection(uname, action.subjectId);

        await writeCachedCollection(uname, updated);
        queryClient.setQueryData(["collection", action.subjectId], updated);

        queryClient.setQueryData<PagedResponse<UserCollection>>(
          ["collections", String(updated.type), uname],
          (old) => old ? upsertCollection(old, updated) : old,
        );
        queryClient.setQueryData<PagedResponse<UserCollection>>(
          ["collections", String(action.previousType), uname],
          (old) => old ? removeCollection(old, action.subjectId) : old,
        );

        const nextCacheKey = `${COLLECTIONS_CACHE_PREFIX}${updated.type}-${uname}`;
        const nextCached = await readCachedValue<PagedResponse<UserCollection>>(nextCacheKey);
        if (nextCached?.data) {
          await writeCachedValue(nextCacheKey, upsertCollection(nextCached, updated));
        }

        const previousCacheKey = `${COLLECTIONS_CACHE_PREFIX}${action.previousType}-${uname}`;
        const previousCached = await readCachedValue<PagedResponse<UserCollection>>(previousCacheKey);
        if (previousCached?.data) {
          await writeCachedValue(previousCacheKey, removeCollection(previousCached, action.subjectId));
        }

        return {
          subjectId: action.subjectId,
          previousType: action.previousType,
          nextType: updated.type,
        };
      });

      removePendingCollectionAction(action.id);
    } catch {
      await invoke("show_toast", {
        message: "收藏状态保存失败，请检查网络后重试",
        variant: "error",
        width: 360,
        durationMs: 2200,
      }).catch(() => {});
    }
  }

  // Detect return from subject detail page and update only the changed item
  useEffect(() => {
    const state = location.state as CollectionsLocationState | null;
    if (state?.fromSubject && state?.subjectId && uname) {
      const subjectId = state.subjectId;
      let cancelled = false;
      void (async () => {
        // Get the updated collection from the detail page's cache
        let updatedCollection = queryClient.getQueryData<UserCollection>(["collection", subjectId]);

        // Fallback: try to read the individual collection from SQLite
        if (!updatedCollection) {
          updatedCollection = (await readCachedCollection(uname!, subjectId)) ?? undefined;
        }

        // Get the current collections list
        const currentData = queryClient.getQueryData<PagedResponse<UserCollection>>(collectionsQueryKey);

        if (currentData?.data && updatedCollection) {
          // Create updated list
          let updatedList = [...currentData.data];
          const itemIndex = updatedList.findIndex((item) => item.subject_id === state.subjectId);

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
            total: itemIndex >= 0 && !typeMatches
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
            await queryClient.invalidateQueries({ queryKey: collectionsQueryKey, exact: true });
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
  }, [location, queryClient, collectionType, uname, collectionsQueryKey, collectionsCacheKey]);

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

      const legacyCollections = () => readLegacyHttpCache<PagedResponse<UserCollection>>(`collections-${collectionType}-${uname}`);
      const cached = await readCachedValueEntry<PagedResponse<UserCollection>>(collectionsCacheKey);
      if (cached) {
        setQuerySource("collections", collectionsCacheKey, "cache");
        if (isCacheStale(cached.updatedAt, QUERY_CACHE_MAX_AGE)) {
          const refreshTask = refreshQueryDataIfChanged({
            queryClient,
            queryKey: collectionsQueryKey,
            refreshKey: collectionsCacheKey,
            currentData: cached.payload,
            refresh: () => fetchAndCacheCollections(collectionType, uname, collectionsCacheKey),
          });
          trackBackgroundRefresh(refreshTask?.then((changed) => {
            if (changed) setQuerySource("collections", collectionsCacheKey, "network");
            return changed;
          }) ?? null);
        }
        return cached.payload;
      }

      try {
        const result = await fetchAndCacheCollections(collectionType, uname, collectionsCacheKey);
        setQuerySource("collections", collectionsCacheKey, "network");
        return result;
      } catch (err) {
        const fallback = await readCachedValueWithLegacy<PagedResponse<UserCollection>>(
          collectionsCacheKey,
          legacyCollections,
        );
        if (fallback) {
          setQuerySource("collections", collectionsCacheKey, "cache");
          return fallback;
        }
        throw err;
      }
    },
    enabled: !!uname,
    staleTime: 0,
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
        if (isCacheStale(cached.updatedAt, QUERY_CACHE_MAX_AGE)) {
          const refreshTask = refreshQueryDataIfChanged({
            queryClient,
            queryKey: CALENDAR_QUERY_KEY,
            refreshKey: "calendar",
            currentData: cached.payload,
            refresh: fetchAndCacheCalendar,
          });
          trackBackgroundRefresh(refreshTask?.then((changed) => {
            if (changed) setQuerySource("calendar", "calendar", "network");
            return changed;
          }) ?? null);
        }
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
    refetchOnMount: shouldSuppressRefetch ? false : true,
  });

  const rawCollections = collData?.data ?? EMPTY_COLLECTIONS;

  const airingMap = useMemo(() => buildAiringMap(calendar), [calendar]);

  const airingIds = useMemo(
    () => rawCollections
      .filter((item) => airingMap.has(item.subject_id))
      .map((item) => item.subject_id),
    [rawCollections, airingMap],
  );

  const airingTimeTargets = useMemo(() => {
    if (!isWatching || airingMap.size === 0) return [];
    return rawCollections
      .filter((item) => airingMap.has(item.subject_id))
      .map((item) => ({
        subjectId: item.subject_id,
        name: item.subject.name,
      }));
  }, [rawCollections, airingMap, isWatching]);

  const airingTimeTargetKey = airingTimeTargets.map((item) => item.subjectId).join(",");

  const shouldLoadAiringTimes = isWatching && airingTimeTargets.length > 0;
  const {
    data: airingTimeMapData,
    error: airingTimeError,
    dataUpdatedAt: airingTimeUpdatedAt,
    isFetching: isAiringTimeFetching,
  } = useQuery({
    queryKey: ["anilist-airing-times", airingTimeTargetKey],
    queryFn: async () => {
      const map = new Map<number, AiringTime>();
      const staleBySubjectId = new Map<number, AiringTime>();
      let loadedFromNetwork = false;

      for (const item of airingTimeTargets) {
        const cacheKey = `${AIRING_CACHE_PREFIX}${item.subjectId}`;
        const cached = await readCachedValueWithin<AiringTime>(cacheKey, QUERY_CACHE_MAX_AGE);
        if (cached) {
          map.set(item.subjectId, cached);
          continue;
        }

        const stale = await readCachedValue<AiringTime>(cacheKey);
        if (stale) staleBySubjectId.set(item.subjectId, stale);

        const legacy = readLegacyAiringCache(item.subjectId);
        if (legacy) {
          await writeCachedValue(cacheKey, legacy);
          map.set(item.subjectId, legacy);
        }
      }

      const missing = airingTimeTargets.filter((item) => !map.has(item.subjectId));
      for (const [index, item] of missing.entries()) {
        if (index > 0) await delay(AIRING_REQUEST_DELAY);
        if (!item.name) continue;
        loadedFromNetwork = true;
        const result = await getAiringAt(item.name);
        if (result) {
          await writeCachedValue(`${AIRING_CACHE_PREFIX}${item.subjectId}`, result);
          map.set(item.subjectId, result);
        } else {
          const stale = staleBySubjectId.get(item.subjectId);
          if (stale) map.set(item.subjectId, stale);
        }
      }

      setQuerySource("airingTimes", airingTimeTargetKey, loadedFromNetwork ? "network" : "cache");
      return map;
    },
    enabled: shouldLoadAiringTimes,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: shouldSuppressRefetch ? false : true,
  });

  const airingTimeMap = airingTimeMapData ?? EMPTY_AIRING_TIME_MAP;
  const airingTimeSignature = airingIds
    .map((id) => {
      const airingTime = airingTimeMap.get(id);
      return `${id}:${airingTime ? getAiringMinuteOfDay(airingTime.airingAt) : ""}`;
    })
    .join(",");
  const episodesQueryKey = ["episodes", todayDateKey, airingIds.join(","), airingTimeSignature];
  const episodesQuerySourceKey = `${todayDateKey}|${airingIds.join(",")}|${airingTimeSignature}`;
  const shouldLoadEpisodes = isWatching && rawCollections.length > 0 && airingIds.length > 0;

  const {
    data: episodeMap,
    error: episodeError,
    dataUpdatedAt: episodeUpdatedAt,
    isFetching: isEpisodeFetching,
  } = useQuery({
    queryKey: episodesQueryKey,
    queryFn: async () => {
      if (airingIds.length === 0) return new Map<number, number>();

      const now = getCurrentTimestamp();
      const map = new Map<number, number>();
      const cachedBySubjectId = new Map<number, EpisodeCountCache>();
      const idsToFetch: number[] = [];

      for (const id of airingIds) {
        const weekday = airingMap.get(id);
        const currentAiringMinuteOfDay = (() => {
          const airingTime = airingTimeMap.get(id);
          return airingTime ? getAiringMinuteOfDay(airingTime.airingAt) : null;
        })();
        const cached = await readCachedValue<EpisodeCountCache>(getEpisodeCacheKey(id));
        if (isEpisodeCountCache(cached)) {
          cachedBySubjectId.set(id, cached);
          if (shouldUseCachedEpisodeCount(cached, weekday, currentAiringMinuteOfDay, now)) {
            map.set(id, cached.airedEp);
            const airingMinuteOfDay = getAiringMinuteForCache(currentAiringMinuteOfDay, cached);
            if (airingMinuteOfDay !== cached.airingMinuteOfDay) {
              await writeCachedValue(getEpisodeCacheKey(id), { ...cached, airingMinuteOfDay });
            }
            continue;
          }
        }
        idsToFetch.push(id);
      }

      const loadedFromNetwork = idsToFetch.length > 0;
      const results = await Promise.allSettled(
        idsToFetch.map((id) => fetchAiredEpisodeCount(id, todayDateKey).then((airedEp) => ({ id, airedEp }))),
      );

      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const id = idsToFetch[index];
        if (result.status === "fulfilled") {
          const { airedEp } = result.value;
          const checkedAt = getCurrentTimestamp();
          const currentAiringMinuteOfDay = (() => {
            const airingTime = airingTimeMap.get(id);
            return airingTime ? getAiringMinuteOfDay(airingTime.airingAt) : null;
          })();
          const airingMinuteOfDay = getAiringMinuteForCache(
            currentAiringMinuteOfDay,
            cachedBySubjectId.get(id),
          );
          await writeCachedValue(getEpisodeCacheKey(id), { airedEp, checkedAt, airingMinuteOfDay });
          map.set(id, airedEp);
          continue;
        }

        const cached = cachedBySubjectId.get(id);
        if (cached) map.set(id, cached.airedEp);
      }

      setQuerySource("episodes", episodesQuerySourceKey, loadedFromNetwork ? "network" : "cache");
      return map;
    },
    enabled: shouldLoadEpisodes,
    staleTime: EPISODES_CACHE_MAX_AGE,
    refetchOnWindowFocus: "always",
    refetchOnMount: shouldSuppressRefetch ? false : true,
  });

  const airedEpMap = episodeMap ?? EMPTY_EPISODE_MAP;

  useEffect(() => {
    if (!isWatching) return;

    const now = Date.now();
    const nextAiringAt = [...airingMap]
      .map(([subjectId, weekday]) => {
        const airingTime = airingTimeMap.get(subjectId);
        if (!airingTime) return null;
        return getNextWeeklyAiringAt(weekday, getAiringMinuteOfDay(airingTime.airingAt), now);
      })
      .filter((airingAt): airingAt is number => airingAt !== null)
      .sort((a, b) => a - b)[0];
    if (!nextAiringAt) return;

    const timer = window.setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["anilist-airing-times"] });
      queryClient.invalidateQueries({ queryKey: ["episodes"] });
    }, Math.max(1000, nextAiringAt - now + 1000));

    return () => window.clearTimeout(timer);
  }, [isWatching, airingMap, airingTimeMap, queryClient]);

  // Auto-refresh sorting when today's episode airing time passes
  useEffect(() => {
    if (!isWatching) return;

    const now = Date.now() / 1000; // Current time in seconds
    const todayAiringTimes: number[] = [];

    // Find all airing times for today's episodes that haven't aired yet
    [...airingMap].forEach(([subjectId, weekday]) => {
      if (weekday === today) {
        const airingTime = airingTimeMap.get(subjectId);
        if (airingTime && airingTime.airingAt > now) {
          todayAiringTimes.push(airingTime.airingAt);
        }
      }
    });

    if (todayAiringTimes.length === 0) return;

    // Find the next airing time
    const nextAiringAt = Math.min(...todayAiringTimes);
    const delayMs = Math.max(1000, (nextAiringAt - now) * 1000 + 1000);

    const timer = window.setTimeout(() => {
      // Force re-render by invalidating episodes query
      // This will cause the sorting to recalculate with updated airing time check
      queryClient.invalidateQueries({ queryKey: ["episodes"] });
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [isWatching, airingMap, airingTimeMap, today, queryClient]);

  const sorted = useMemo(() => {
    if (isWatching && calendar) {
      return sortCollections(rawCollections, calendar, today, airedEpMap, airingTimeMap);
    }
    return rawCollections;
  }, [rawCollections, calendar, isWatching, today, airedEpMap, airingTimeMap]);

  const displayLabelMap = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const item of sorted) {
      map.set(item.subject_id, getDisplayLabel(item, airingMap, airedEpMap, today, airingTimeMap));
    }
    return map;
  }, [sorted, airingMap, airedEpMap, today, airingTimeMap]);

  const committedScopeKey = `${uname ?? ""}:${collectionType}`;
  const shouldWaitForCalendar = isWatching;
  const shouldWaitForAiringTimes = shouldLoadAiringTimes;
  const shouldWaitForEpisodes = shouldLoadEpisodes;
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
    airingTimeMapData !== undefined,
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
  const cacheAiringMap = useMemo(() => buildAiringMap(cacheCalendar), [cacheCalendar]);
  const cacheAiringTimeMap = airingTimesSource === "cache" ? airingTimeMap : EMPTY_AIRING_TIME_MAP;
  const cacheAiredEpMap = episodesSource === "cache" ? airedEpMap : EMPTY_EPISODE_MAP;
  const cacheSorted = useMemo(() => {
    if (isWatching && cacheCalendar) {
      return sortCollections(rawCollections, cacheCalendar, today, cacheAiredEpMap, cacheAiringTimeMap);
    }
    return rawCollections;
  }, [rawCollections, cacheCalendar, isWatching, today, cacheAiredEpMap, cacheAiringTimeMap]);
  const cacheDisplayLabelMap = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const item of cacheSorted) {
      map.set(item.subject_id, getDisplayLabel(item, cacheAiringMap, cacheAiredEpMap, today, cacheAiringTimeMap));
    }
    return map;
  }, [cacheSorted, cacheAiringMap, cacheAiredEpMap, today, cacheAiringTimeMap]);
  const isDisplayDataAvailable = Boolean(uname)
    && collData !== undefined
    && (!shouldWaitForCalendar || calendar !== undefined || Boolean(calError))
    && (!shouldWaitForAiringTimes || airingTimeMapData !== undefined || Boolean(airingTimeError))
    && (!shouldWaitForEpisodes || episodeMap !== undefined || Boolean(episodeError));
  const isDisplayNetworkIdle = backgroundRefreshCount === 0
    && !isCollectionsFetching
    && (!shouldWaitForCalendar || !isCalendarFetching)
    && (!shouldWaitForAiringTimes || !isAiringTimeFetching)
    && (!shouldWaitForEpisodes || !isEpisodeFetching);
  const isDisplayReady = Boolean(uname)
    && isDisplayDataAvailable
    && isDisplayNetworkIdle;
  const canCommitCacheSnapshot = Boolean(uname)
    && collData !== undefined
    && collectionsSource === "cache";
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
    "cache",
    collUpdatedAt || "pending",
    calendarSource === "cache" ? calendarUpdatedAt : "skip",
    airingTimesSource === "cache" ? airingTimeUpdatedAt : "skip",
    episodesSource === "cache" ? episodeUpdatedAt : "skip",
  ].join("|");
  const committedVersion = [
    committedScopeKey,
    todayDateKey,
    committedSource,
    collectionsSource,
    collUpdatedAt || "pending",
    shouldWaitForCalendar
      ? `${calendarSource}:${calendar !== undefined ? calendarUpdatedAt : (calError ? "error" : "pending")}`
      : "skip",
    shouldWaitForAiringTimes
      ? `${airingTimesSource}:${airingTimeMapData !== undefined ? airingTimeUpdatedAt : (airingTimeError ? "error" : "pending")}`
      : "skip",
    shouldWaitForEpisodes
      ? `${episodesSource}:${episodeMap !== undefined ? episodeUpdatedAt : (episodeError ? "error" : "pending")}`
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
    const nextVersion = shouldCommitSettledSnapshot ? committedVersion : cacheCommittedVersion;
    const nextSource = shouldCommitSettledSnapshot ? committedSource : "cache";
    const nextSorted = shouldCommitSettledSnapshot ? sorted : cacheSorted;
    const nextDisplayLabelMap = shouldCommitSettledSnapshot ? displayLabelMap : cacheDisplayLabelMap;

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

  const activeCommittedState = committedState?.scopeKey === committedScopeKey ? committedState : null;
  const visibleSorted = activeCommittedState?.sorted ?? EMPTY_COLLECTIONS;
  const visibleDisplayLabelMap = activeCommittedState?.displayLabelMap ?? EMPTY_DISPLAY_LABEL_MAP;

  const filtered = searchText
    ? visibleSorted.filter((item) => {
        const kw = buildSubjectKeywords(item.subject.name_cn, item.subject.name);
        const lower = searchText.toLowerCase();
        return (
          (item.subject.name_cn || "").toLowerCase().includes(lower) ||
          (item.subject.name || "").toLowerCase().includes(lower) ||
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
    if (prevTypeRef.current !== collectionType || prevSearchRef.current !== searchText) {
      setPage(1);
      setFocusedIndex(0);
      prevTypeRef.current = collectionType;
      prevSearchRef.current = searchText;
    }
  }, [collectionType, searchText]);

  useEffect(() => {
    if (page !== restoredPageState.page || focusedIndex !== restoredPageState.focusedIndex) {
      writePageState(collectionType, searchText, page, focusedIndex);
    }
  }, [collectionType, focusedIndex, page, restoredPageState.focusedIndex, restoredPageState.page, searchText]);

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
      state: { fromCollections: true, page, focusedIndex },
    });
  }

  const clearAiringCache = async () => {
    await deleteCachedValuesByPrefix(AIRING_CACHE_PREFIX);
    await deleteCachedValuesByPrefix(EPISODES_CACHE_PREFIX);
    queryClient.resetQueries({ queryKey: ["episodes"] });
    queryClient.resetQueries({ queryKey: ["anilist-airing-times"] });
    await queryClient.refetchQueries({ queryKey: ["episodes"] });
    await queryClient.refetchQueries({ queryKey: ["anilist-airing-times"] });
    invoke("show_toast", { message: "播出时间已刷新" });
  };

  // Keyboard navigation
  useKeyboardShortcuts([
    {
      key: "r",
      mod: true,
      when: () => isWatching,
      handler: () => {
        clearAiringCache();
      },
    },
    {
      key: "Enter",
      mod: true,
      handler: () => {
        const item = paged[focusedIndex];
        if (item) {
          const name = getSubjectTitleForCopy(item.subject.name_cn || item.subject.name);
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
        setFocusedIndex((i) => Math.max(0, i - 1));
      },
    },
    {
      key: "ArrowDown",
      when: () => paged.length > 0,
      handler: () => {
        setFocusedIndex((i) => Math.min(paged.length - 1, i + 1));
      },
    },
    {
      key: "Enter",
      when: () => paged.length > 0,
      handler: () => {
        const item = paged[focusedIndex];
        if (item) {
          openSubject(item.subject.id);
        }
      },
    },
  ], { priority: 10 });

  const pendingAction = pendingActions[0];

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

      {pendingAction && (
        <div className="shrink-0 border-b border-line bg-bg-secondary px-4 py-2 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-fg truncate">
              {pendingAction.subjectTitle} 已看到完结
            </p>
            {pendingActions.length > 1 && (
              <p className="text-[12px] text-fg-tertiary">
                另有 {pendingActions.length - 1} 个待处理条目
              </p>
            )}
          </div>
          <button
            type="button"
            className="shrink-0 h-7 px-3 rounded border border-line bg-bg hover:bg-hover text-[12px] text-fg"
            onClick={() => {
              void executePendingAction(pendingAction);
            }}
          >
            标记看过
          </button>
          <button
            type="button"
            className="shrink-0 h-7 px-2 rounded border border-line bg-bg hover:bg-hover text-[12px] text-fg-tertiary"
            onClick={() => removePendingCollectionAction(pendingAction.id)}
          >
            忽略
          </button>
        </div>
      )}

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto p-2.5">
        {error && !collData && <p className="text-danger text-[13px] mb-2 px-1">收藏加载出错: {String(error)}</p>}
        {error && collData && <p className="text-fg-tertiary text-[12px] mb-2 px-1">收藏加载失败，显示缓存数据</p>}
        {calError && !calendar && <p className="text-danger text-[13px] mb-2 px-1">日历加载出错: {String(calError)}</p>}
        {calError && calendar && <p className="text-fg-tertiary text-[12px] mb-2 px-1">日历加载失败，显示缓存数据</p>}
        {isCommittedLoading && <p className="text-fg-tertiary text-[13px] px-1">加载中…</p>}
        {!uname && !isLoading && <p className="text-fg-tertiary text-[13px] px-1">正在获取用户信息…</p>}

        <div className="space-y-0.5">
          {paged.map((item, index) => {
            const s = item.subject;
            const label = isWatching ? visibleDisplayLabelMap.get(item.subject_id) ?? null : null;
            const weekday = s.air_weekday ? WEEKDAY_CN[s.air_weekday] : undefined;
            return (
              <SubjectRow
                key={s.id}
                ref={(el) => { itemRefs.current[index] = el; }}
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
                    {item.rate > 0 && <Rating score={item.rate} />}
                    {weekday && <Meta>{weekday}</Meta>}
                    <Meta>{SubjectTypeLabel[s.type]}</Meta>
                  </>
                }
              />
            );
          })}
        </div>
      </div>

    </div>
  );
}
