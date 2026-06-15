import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getAllUserCollections, getCalendar, getEpisodes, getUserCollections } from "@shared/api/client";
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
  deleteCachedValuesByPrefix,
  readCachedValue,
  readCachedValueEntry,
  readCachedValueWithin,
  readCachedValueWithLegacy,
  readLegacyHttpCache,
  writeCachedSubjectPreviews,
  writeCachedValue,
} from "@shared/storage/sqlite-cache";
import { getUsername } from "../api/oauth";
import { isCacheStale, refreshQueryDataIfChanged } from "../api/stale-cache-refresh";
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
const CALENDAR_QUERY_KEY = ["calendar"] as const;

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
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isWatching = collectionType === "3";
  const today = useMemo(() => getBangumiWeekdayFromDateKey(todayDateKey), [todayDateKey]);
  const isReturningFromDetail = useRef(initialState.isReturningFromDetail);

  const uname = getUsername();

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

  // Detect return from subject detail page and invalidate if ep_status changed
  useEffect(() => {
    const state = location.state as CollectionsLocationState | null;
    if (state?.fromSubject && state?.subjectId) {
      let cancelled = false;
      void (async () => {
        await deleteCachedValuesByPrefix(COLLECTIONS_CACHE_PREFIX);
        if (!cancelled) {
          await queryClient.invalidateQueries({ queryKey: ["collections"] });
        }
      })();
      window.history.replaceState({}, document.title);
      // Reset the flag after other effects have run
      const timer = window.setTimeout(() => { isReturningFromDetail.current = false; }, 100);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
  }, [location, queryClient]);

  const collectionsCacheKey = `${COLLECTIONS_CACHE_PREFIX}${collectionType}-${uname}`;
  const collectionsQueryKey = ["collections", collectionType, uname] as const;

  const { data: collData, isLoading, error } = useQuery({
    queryKey: collectionsQueryKey,
    queryFn: async () => {
      if (!uname) return { data: [], total: 0 };

      const legacyCollections = () => readLegacyHttpCache<PagedResponse<UserCollection>>(`collections-${collectionType}-${uname}`);
      const cached = await readCachedValueEntry<PagedResponse<UserCollection>>(collectionsCacheKey);
      if (cached) {
        if (isCacheStale(cached.updatedAt, QUERY_CACHE_MAX_AGE)) {
          refreshQueryDataIfChanged({
            queryClient,
            queryKey: collectionsQueryKey,
            refreshKey: collectionsCacheKey,
            currentData: cached.payload,
            refresh: () => fetchAndCacheCollections(collectionType, uname, collectionsCacheKey),
          });
        }
        return cached.payload;
      }

      try {
        return await fetchAndCacheCollections(collectionType, uname, collectionsCacheKey);
      } catch (err) {
        const fallback = await readCachedValueWithLegacy<PagedResponse<UserCollection>>(
          collectionsCacheKey,
          legacyCollections,
        );
        if (fallback) return fallback;
        throw err;
      }
    },
    enabled: !!uname,
    staleTime: 0,
  });

  const { data: calendar, error: calError } = useQuery({
    queryKey: CALENDAR_QUERY_KEY,
    queryFn: async () => {
      const cached = await readCachedValueEntry<CalendarItem[]>("calendar");
      if (cached) {
        if (isCacheStale(cached.updatedAt, QUERY_CACHE_MAX_AGE)) {
          refreshQueryDataIfChanged({
            queryClient,
            queryKey: CALENDAR_QUERY_KEY,
            refreshKey: "calendar",
            currentData: cached.payload,
            refresh: fetchAndCacheCalendar,
          });
        }
        return cached.payload;
      }

      try {
        return await fetchAndCacheCalendar();
      } catch (err) {
        const fallback = await readCachedValueWithLegacy<CalendarItem[]>(
          "calendar",
          () => readLegacyHttpCache<CalendarItem[]>("calendar"),
        );
        if (fallback) return fallback;
        throw err;
      }
    },
    enabled: isWatching,
    staleTime: 0,
  });

  const rawCollections = collData?.data ?? EMPTY_COLLECTIONS;

  const airingMap = useMemo(() => {
    const map = new Map<number, number>();
    if (calendar) {
      for (const day of calendar) {
        for (const item of day.items) {
          map.set(item.id, day.weekday.id);
        }
      }
    }
    return map;
  }, [calendar]);

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
  const { data: airingTimeMapData } = useQuery({
    queryKey: ["anilist-airing-times", airingTimeTargetKey],
    queryFn: async () => {
      const map = new Map<number, AiringTime>();
      const staleBySubjectId = new Map<number, AiringTime>();

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
        const result = await getAiringAt(item.name);
        if (result) {
          await writeCachedValue(`${AIRING_CACHE_PREFIX}${item.subjectId}`, result);
          map.set(item.subjectId, result);
        } else {
          const stale = staleBySubjectId.get(item.subjectId);
          if (stale) map.set(item.subjectId, stale);
        }
      }

      return map;
    },
    enabled: shouldLoadAiringTimes,
    refetchOnWindowFocus: "always",
  });

  const airingTimeMap = airingTimeMapData ?? EMPTY_AIRING_TIME_MAP;
  const airingTimeSignature = airingIds
    .map((id) => {
      const airingTime = airingTimeMap.get(id);
      return `${id}:${airingTime ? getAiringMinuteOfDay(airingTime.airingAt) : ""}`;
    })
    .join(",");
  const episodesQueryKey = ["episodes", todayDateKey, airingIds.join(","), airingTimeSignature];

  const { data: episodeMap } = useQuery({
    queryKey: episodesQueryKey,
    queryFn: async () => {
      if (airingIds.length === 0) return new Map<number, number>();

      const now = Date.now();
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

      const results = await Promise.allSettled(
        idsToFetch.map((id) => fetchAiredEpisodeCount(id, todayDateKey).then((airedEp) => ({ id, airedEp }))),
      );

      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const id = idsToFetch[index];
        if (result.status === "fulfilled") {
          const { airedEp } = result.value;
          const checkedAt = Date.now();
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

      return map;
    },
    enabled: isWatching && rawCollections.length > 0 && airingIds.length > 0,
    staleTime: EPISODES_CACHE_MAX_AGE,
    refetchOnWindowFocus: "always",
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

  const sorted = useMemo(() => {
    if (isWatching && calendar) {
      return sortCollections(rawCollections, calendar, today, airedEpMap);
    }
    return rawCollections;
  }, [rawCollections, calendar, isWatching, today, airedEpMap]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / LIMIT));
  const displayLabelMap = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const item of sorted) {
      map.set(item.subject_id, getDisplayLabel(item, airingMap, airedEpMap, today, airingTimeMap));
    }
    return map;
  }, [sorted, airingMap, airedEpMap, today, airingTimeMap]);

  const filtered = searchText
    ? sorted.filter((item) => {
        const kw = buildSubjectKeywords(item.subject.name_cn, item.subject.name);
        const lower = searchText.toLowerCase();
        return (
          (item.subject.name_cn || "").toLowerCase().includes(lower) ||
          (item.subject.name || "").toLowerCase().includes(lower) ||
          kw.some((k) => k.toLowerCase().includes(lower))
        );
      })
    : sorted;

  const paged = filtered.slice((page - 1) * LIMIT, page * LIMIT);

  useEffect(() => {
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
          const name = item.subject.name_cn || item.subject.name;
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

  return (
    <div className="h-full flex flex-col">
      {/* Page indicator */}
      <div className="px-4 py-1.5 text-[12px] text-fg-tertiary border-b border-line shrink-0 flex items-center gap-2">
        <span>
          {searchText
            ? `搜索 · 共 ${filtered.length} 条`
            : `第 ${page} / ${totalPages} 页 · 共 ${sorted.length} 条`}
        </span>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto p-2.5">
        {error && !collData && <p className="text-danger text-[13px] mb-2 px-1">收藏加载出错: {String(error)}</p>}
        {error && collData && <p className="text-fg-tertiary text-[12px] mb-2 px-1">收藏加载失败，显示缓存数据</p>}
        {calError && !calendar && <p className="text-danger text-[13px] mb-2 px-1">日历加载出错: {String(calError)}</p>}
        {calError && calendar && <p className="text-fg-tertiary text-[12px] mb-2 px-1">日历加载失败，显示缓存数据</p>}
        {isLoading && <p className="text-fg-tertiary text-[13px] px-1">加载中…</p>}
        {!uname && !isLoading && <p className="text-fg-tertiary text-[13px] px-1">正在获取用户信息…</p>}

        <div className="space-y-0.5">
          {paged.map((item, index) => {
            const s = item.subject;
            const label = isWatching ? displayLabelMap.get(item.subject_id) ?? null : null;
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
