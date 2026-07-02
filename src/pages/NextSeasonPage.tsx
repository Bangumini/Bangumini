import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getNextSeason, getNextSeasonInfo } from "@shared/api/anilist";
import type { NextSeasonItem } from "@shared/api/anilist";
import { searchSubjects } from "@shared/api/client";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";
import {
  deleteCachedValuesByPrefixExcept,
  getPreferredSubjectCoverUrl,
  isUsefulImageUrl,
  readCachedSubject,
  readCachedValue,
  readCachedValueEntry,
  writeCachedValue,
} from "@shared/storage/sqlite-cache";
import { isCacheStale, refreshQueryDataIfChanged } from "../api/stale-cache-refresh";
import { getSubjectTitleForCopy } from "../api/subject-title-copy";
import { SubjectRow, Meta } from "../components/SubjectRow";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

const ANILIST_WEEKDAY_CN: Record<number, string> = {
  0: "星期日", 1: "星期一", 2: "星期二", 3: "星期三",
  4: "星期四", 5: "星期五", 6: "星期六",
};

type NextSeasonLocationState = {
  fromSubject?: boolean;
  subjectId?: number;
  currentDay?: number | "tba";
  focusedIndex?: number;
};

interface SeasonEntry extends NextSeasonItem {
  weekday: number | null;
  nameCn: string | null;
  bangumiId: number | null;
}
type BangumiMatchCache = {
  query: string;
  bangumiId: number | null;
  nameCn: string | null;
};

function getWeekday(item: NextSeasonItem): number | null {
  if (item.airingAt) {
    return new Date(item.airingAt * 1000).getUTCDay();
  }
  const { year, month, day } = item.startDate;
  if (year && month && day) {
    return new Date(year, month - 1, day).getDay();
  }
  return null;
}

function formatDate(item: NextSeasonItem, seasonLabel: string): string {
  const { year, month, day } = item.startDate;
  if (year && month && day) {
    return `${month}月${day}日`;
  }
  if (year && month) {
    return `${year}年${month}月`;
  }
  return seasonLabel;
}

const NEXT_SEASON_BASE_CACHE_PREFIX = "next-season-base-";
const NEXT_SEASON_BANGUMI_MATCH_CACHE_PREFIX = "next-season-match-";
const LEGACY_SQLITE_NEXT_SEASON_CACHE_PREFIX = "next-season-";
const LEGACY_NEXT_SEASON_CACHE_PREFIX = "bangumini-next-season-";
const NEXT_SEASON_BASE_CACHE_TTL = 1000 * 60 * 60 * 24; // 1 day
const NEXT_SEASON_BANGUMI_MATCH_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days
const NEXT_SEASON_BANGUMI_MATCH_CONCURRENCY = 4;

function getNextSeasonBaseCacheKey(): string {
  const { season, seasonYear } = getNextSeasonInfo();
  return `${NEXT_SEASON_BASE_CACHE_PREFIX}${seasonYear}-${season}`;
}

function getLegacySqliteNextSeasonCacheKey(): string {
  const { season, seasonYear } = getNextSeasonInfo();
  return `${LEGACY_SQLITE_NEXT_SEASON_CACHE_PREFIX}${seasonYear}-${season}`;
}

function getLegacyNextSeasonCacheKey(): string {
  const { season, seasonYear } = getNextSeasonInfo();
  return `${LEGACY_NEXT_SEASON_CACHE_PREFIX}${seasonYear}-${season}`;
}

function getNextSeasonBangumiMatchCacheKey(anilistId: number): string {
  return `${NEXT_SEASON_BANGUMI_MATCH_CACHE_PREFIX}${anilistId}`;
}

function readLegacyNextSeasonCache(): SeasonEntry[] | null {
  try {
    const raw = localStorage.getItem(getLegacyNextSeasonCacheKey());
    if (!raw) return null;
    const cached = JSON.parse(raw) as { entries: SeasonEntry[]; cachedAt: number };
    if (!cached.entries || !cached.cachedAt) return null;
    return cached.entries;
  } catch {
    return null;
  }
}

function isAired(item: Pick<NextSeasonItem, "airingAt" | "startDate">): boolean {
  const nowSec = Date.now() / 1000;
  if (item.airingAt && item.airingAt < nowSec) return true;
  const { year, month, day } = item.startDate;
  if (year && month && day) {
    const startSec = new Date(year, month - 1, day).getTime() / 1000;
    if (startSec < nowSec - 86400) return true; // more than 1 day past start
  }
  return false;
}

function isBangumiMatchCache(value: BangumiMatchCache | null): value is BangumiMatchCache {
  return !!value
    && typeof value.query === "string"
    && (typeof value.bangumiId === "number" || value.bangumiId === null)
    && (typeof value.nameCn === "string" || value.nameCn === null);
}

function toBaseNextSeasonItem(item: NextSeasonItem): NextSeasonItem {
  return {
    id: item.id,
    title: item.title,
    cover: item.cover,
    startDate: item.startDate,
    airingAt: item.airingAt,
    episode: item.episode,
    episodes: item.episodes,
    format: item.format,
  };
}

function filterUpcomingNextSeasonItems(items: NextSeasonItem[]) {
  return items.filter((item) => !isAired(item)).map(toBaseNextSeasonItem);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) return;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );

  return results;
}

async function fetchBangumiMatch(item: NextSeasonItem): Promise<BangumiMatchCache> {
  const resp = await searchSubjects({ keyword: item.title.native, type: [2], limit: 3 });
  const match = resp.data?.[0];
  return {
    query: item.title.native,
    bangumiId: match?.id ?? null,
    nameCn: match ? (match.name_cn || match.name) : null,
  };
}

async function fetchAndCacheNextSeasonBase(nextSeasonBaseCacheKey: string) {
  const items = filterUpcomingNextSeasonItems(await getNextSeason());
  await writeCachedValue(nextSeasonBaseCacheKey, items);
  return items;
}

async function hydrateBangumiMatchCachesFromEntries(entries: SeasonEntry[]) {
  const positiveMatches = entries.filter((entry) => entry.bangumiId !== null);
  await Promise.all(
    positiveMatches.map((entry) => writeCachedValue(
      getNextSeasonBangumiMatchCacheKey(entry.id),
      {
        query: entry.title.native,
        bangumiId: entry.bangumiId,
        nameCn: entry.nameCn,
      } satisfies BangumiMatchCache,
    )),
  );
}

async function migrateLegacyNextSeasonBaseCache(nextSeasonBaseCacheKey: string) {
  const legacySqlite = await readCachedValue<SeasonEntry[]>(getLegacySqliteNextSeasonCacheKey());
  const legacyEntries = legacySqlite ?? readLegacyNextSeasonCache();
  if (!legacyEntries) return null;

  const baseItems = filterUpcomingNextSeasonItems(legacyEntries);
  await writeCachedValue(nextSeasonBaseCacheKey, baseItems);
  await hydrateBangumiMatchCachesFromEntries(legacyEntries);
  return baseItems;
}

async function applyCachedSubjectCovers(entries: SeasonEntry[]) {
  let changed = false;
  const resolved = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.bangumiId) return entry;
      const subject = await readCachedSubject(entry.bangumiId);
      const cachedCover = getPreferredSubjectCoverUrl(subject);
      if (!cachedCover) return entry;

      if (!isUsefulImageUrl(entry.cover) || entry.cover !== cachedCover) {
        changed = true;
        return { ...entry, cover: cachedCover };
      }
      return entry;
    }),
  );
  return { entries: resolved, changed };
}

function earliestEntryDay(entries: SeasonEntry[]): number | "tba" {
  let earliestDay: number | "tba" = "tba";
  let earliestDate: Date | null = null;
  for (const e of entries) {
    if (e.airingAt) {
      const d = new Date(e.airingAt * 1000);
      if (!earliestDate || d < earliestDate) {
        earliestDate = d;
        earliestDay = e.weekday ?? "tba";
      }
    } else if (e.startDate.year && e.startDate.month && e.startDate.day) {
      const d = new Date(e.startDate.year, e.startDate.month - 1, e.startDate.day);
      if (!earliestDate || d < earliestDate) {
        earliestDate = d;
        earliestDay = e.weekday ?? "tba";
      }
    }
  }
  return earliestDay;
}

async function resolveNextSeasonEntries(
  baseItems: NextSeasonItem[],
  options: { refreshMissingOrStaleMatches: boolean },
) {
  const cachedMatches = await Promise.all(
    baseItems.map((item) => readCachedValueEntry<BangumiMatchCache>(getNextSeasonBangumiMatchCacheKey(item.id))),
  );

  const matches: Array<BangumiMatchCache | null> = new Array(baseItems.length).fill(null);
  const pendingMatches: Array<{ index: number; item: NextSeasonItem; fallback: BangumiMatchCache | null }> = [];
  let needsBangumiRefresh = false;

  for (let index = 0; index < baseItems.length; index += 1) {
    const item = baseItems[index];
    const cached = cachedMatches[index];
    const payload = isBangumiMatchCache(cached?.payload ?? null) ? cached!.payload : null;
    const stale = cached ? isCacheStale(cached.updatedAt, NEXT_SEASON_BANGUMI_MATCH_TTL) : true;
    const titleChangedWithoutMatch = payload !== null
      && payload.bangumiId === null
      && payload.query !== item.title.native;
    const shouldRefresh = !payload || stale || titleChangedWithoutMatch;

    matches[index] = payload;
    if (shouldRefresh) {
      needsBangumiRefresh = true;
      if (options.refreshMissingOrStaleMatches) {
        pendingMatches.push({ index, item, fallback: payload });
      }
    }
  }

  if (options.refreshMissingOrStaleMatches && pendingMatches.length > 0) {
    const refreshedMatches = await mapWithConcurrency(
      pendingMatches,
      NEXT_SEASON_BANGUMI_MATCH_CONCURRENCY,
      async ({ item, fallback }) => {
        try {
          const nextMatch = await fetchBangumiMatch(item);
          await writeCachedValue(getNextSeasonBangumiMatchCacheKey(item.id), nextMatch);
          return nextMatch;
        } catch {
          return fallback;
        }
      },
    );

    pendingMatches.forEach((pending, index) => {
      matches[pending.index] = refreshedMatches[index] ?? matches[pending.index];
    });
    needsBangumiRefresh = false;
  }

  const resolved = await applyCachedSubjectCovers(
    baseItems.map((item, index) => ({
      ...item,
      weekday: getWeekday(item),
      nameCn: matches[index]?.nameCn ?? null,
      bangumiId: matches[index]?.bangumiId ?? null,
    })),
  );

  return { entries: resolved.entries, needsBangumiRefresh };
}

export default function NextSeasonPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const filterText = searchParams.get("filter") ?? "";
  const filterWeekday = searchParams.get("weekday") ?? "";
  const { label: seasonLabel } = getNextSeasonInfo();

  // Check if returning from detail page
  const initialState = useMemo(() => {
    const state = location.state as NextSeasonLocationState | null;
    if (state?.fromSubject && state?.subjectId) {
      return {
        currentDay: state.currentDay ?? 0,
        focusedIndex: state.focusedIndex ?? 0,
        isReturningFromDetail: true,
      };
    }
    return {
      currentDay: 0 as number | "tba",
      focusedIndex: 0,
      isReturningFromDetail: false,
    };
  }, [location.state]);

  const [currentDay, setCurrentDay] = useState<number | "tba">(initialState.currentDay);
  const [focusedIndex, setFocusedIndex] = useState(initialState.focusedIndex);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isReturningFromDetail = useRef(initialState.isReturningFromDetail);
  const isFiltering = filterText !== "" || filterWeekday !== "";
  const nextSeasonBaseCacheKey = getNextSeasonBaseCacheKey();
  const nextSeasonQueryKey = ["next-season", seasonLabel] as const;

  const { data: rawEntries, isLoading, error } = useQuery({
    queryKey: nextSeasonQueryKey,
    queryFn: async () => {
      await deleteCachedValuesByPrefixExcept(NEXT_SEASON_BASE_CACHE_PREFIX, nextSeasonBaseCacheKey);

      let cachedBase = await readCachedValueEntry<NextSeasonItem[]>(nextSeasonBaseCacheKey);
      if (!cachedBase) {
        const migratedBase = await migrateLegacyNextSeasonBaseCache(nextSeasonBaseCacheKey);
        if (migratedBase) {
          cachedBase = await readCachedValueEntry<NextSeasonItem[]>(nextSeasonBaseCacheKey);
        }
      }

      if (cachedBase) {
        const baseItems = filterUpcomingNextSeasonItems(cachedBase.payload);
        const staleBase = isCacheStale(cachedBase.updatedAt, NEXT_SEASON_BASE_CACHE_TTL);
        const resolved = await resolveNextSeasonEntries(baseItems, { refreshMissingOrStaleMatches: false });

        if (staleBase || resolved.needsBangumiRefresh) {
          const refreshKey = staleBase
            ? `${nextSeasonBaseCacheKey}:base`
            : `${nextSeasonBaseCacheKey}:matches`;
          refreshQueryDataIfChanged({
            queryClient,
            queryKey: nextSeasonQueryKey,
            refreshKey,
            currentData: resolved.entries,
            refresh: async () => {
              const refreshedBase = staleBase
                ? await fetchAndCacheNextSeasonBase(nextSeasonBaseCacheKey)
                : baseItems;
              const nextResolved = await resolveNextSeasonEntries(refreshedBase, {
                refreshMissingOrStaleMatches: true,
              });
              return nextResolved.entries;
            },
          });
        }

        return resolved.entries;
      }

      try {
        const baseItems = await fetchAndCacheNextSeasonBase(nextSeasonBaseCacheKey);
        const resolved = await resolveNextSeasonEntries(baseItems, {
          refreshMissingOrStaleMatches: true,
        });
        return resolved.entries;
      } catch (err) {
        const migratedBase = await migrateLegacyNextSeasonBaseCache(nextSeasonBaseCacheKey);
        if (migratedBase) {
          const resolved = await resolveNextSeasonEntries(migratedBase, {
            refreshMissingOrStaleMatches: false,
          });
          return resolved.entries;
        }
        throw err;
      }
    },
    staleTime: 0,
  });

  const entries = useMemo(() => rawEntries ?? [], [rawEntries]);

  // Group by weekday
  const groups = useMemo(() => {
    const map = new Map<number | "tba", SeasonEntry[]>();
    for (const e of entries) {
      const key = e.weekday ?? "tba";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [entries]);

  const availableDays = useMemo(() => {
    const set = new Set<number>();
    for (const k of groups.keys()) {
      if (k !== "tba") set.add(k as number);
    }
    return set;
  }, [groups]);

  const hasTba = groups.has("tba");

  // Clear navigation state after returning from detail
  useEffect(() => {
    const state = location.state as NextSeasonLocationState | null;
    if (state?.fromSubject) {
      window.history.replaceState({}, document.title);
      const timer = window.setTimeout(() => { isReturningFromDetail.current = false; }, 100);
      return () => window.clearTimeout(timer);
    }
  }, [location.state]);

  // Default to day of earliest entry
  useEffect(() => {
    if (entries.length === 0) return;
    if (isReturningFromDetail.current) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCurrentDay(earliestEntryDay(entries));
  }, [entries]);

  // Filtered items (grouped by weekday, TBA last)
  const filteredGroups = useMemo(() => {
    if (!isFiltering) return [];
    const lower = filterText.toLowerCase();
    const items = entries.filter((item) => {
      if (filterWeekday === "nontv") return item.format !== "TV";
      if (filterWeekday && String(item.weekday ?? "tba") !== filterWeekday) return false;
      if (filterText) {
        const display = item.nameCn || item.title.native;
        if (
          display.toLowerCase().includes(lower) ||
          item.title.native.toLowerCase().includes(lower) ||
          item.title.romaji.toLowerCase().includes(lower)
        ) return true;
        const kw = buildSubjectKeywords(item.nameCn ?? undefined, item.title.native);
        if (kw.some((k) => k.toLowerCase().includes(lower))) return true;
        return false;
      }
      return true;
    });
    // Group by weekday, TBA last
    const map = new Map<number | "tba", SeasonEntry[]>();
    const tbaItems: SeasonEntry[] = [];
    for (const item of items) {
      const key = item.weekday ?? "tba";
      if (key === "tba") {
        tbaItems.push(item);
      } else {
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(item);
      }
    }
    const result: { weekday: number | "tba"; items: SeasonEntry[] }[] = [];
    for (const d of [0, 1, 2, 3, 4, 5, 6]) {
      const group = map.get(d);
      if (group) result.push({ weekday: d, items: group });
    }
    if (tbaItems.length > 0) result.push({ weekday: "tba", items: tbaItems });
    return result;
  }, [entries, filterText, filterWeekday, isFiltering]);

  const allFilteredItems = filteredGroups.flatMap((g) => g.items);
  const currentItems = isFiltering ? allFilteredItems : (groups.get(currentDay) ?? []);

  // Reset focus when day or filter changes (but not when returning from detail)
  useEffect(() => {
    if (isReturningFromDetail.current) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedIndex(0);
  }, [currentDay, filterText, filterWeekday]);

  // Scroll focused item into view
  useEffect(() => {
    const item = itemRefs.current[focusedIndex];
    if (item) {
      item.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusedIndex]);

  // Keyboard navigation
  useKeyboardShortcuts([
    {
      key: "Enter",
      mod: true,
      handler: () => {
        const item = currentItems[focusedIndex];
        if (item) {
          const name = getSubjectTitleForCopy(item.nameCn || item.title.native);
          navigator.clipboard.writeText(name).then(async () => {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await invoke("show_toast", { message: "已复制条目名" });
            getCurrentWindow().hide();
          });
        }
      },
    },
    {
      key: "ArrowLeft",
      when: () => !isFiltering,
      handler: () => {
        setCurrentDay((d) => {
          if (d === "tba") {
            for (let i = 6; i >= 0; i--) {
              if (availableDays.has(i)) return i;
            }
            return "tba";
          }
          for (let offset = 1; offset <= 7; offset++) {
            const candidate = (d - offset + 7) % 7;
            if (availableDays.has(candidate)) return candidate;
          }
          if (hasTba) return "tba";
          return d;
        });
      },
    },
    {
      key: "ArrowRight",
      when: () => !isFiltering,
      handler: () => {
        setCurrentDay((d) => {
          if (d === "tba") return "tba";
          for (let offset = 1; offset <= 7; offset++) {
            const candidate = (d + offset) % 7;
            if (availableDays.has(candidate)) return candidate;
          }
          if (hasTba) return "tba";
          return d;
        });
      },
    },
    {
      key: "ArrowUp",
      when: () => currentItems.length > 0,
      handler: () => {
        setFocusedIndex((i) => i <= 0 ? currentItems.length - 1 : i - 1);
      },
    },
    {
      key: "ArrowDown",
      when: () => currentItems.length > 0,
      handler: () => {
        setFocusedIndex((i) => i >= currentItems.length - 1 ? 0 : i + 1);
      },
    },
    {
      key: "Enter",
      when: () => currentItems.length > 0,
      handler: () => {
        const item = currentItems[focusedIndex];
        if (item?.bangumiId) {
          navigate(`/subject/${item.bangumiId}`, {
            state: { fromNextSeason: true, currentDay, focusedIndex },
          });
        } else if (item) {
          import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
            openUrl(`https://anilist.co/anime/${item.id}`);
          });
        }
      },
    },
  ], { priority: 10 });

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      {isFiltering && (
        <div className="px-4 py-1.5 text-[12px] text-fg-tertiary border-b border-line shrink-0">
          <span>
            筛选{filterText ? `"${filterText}"` : ""}
            {filterWeekday && ` · ${filterWeekday === "tba" ? "未定" : filterWeekday === "nontv" ? "非TV" : ANILIST_WEEKDAY_CN[parseInt(filterWeekday)]}`}
            {" "}· 共 {allFilteredItems.length} 条
          </span>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2.5">
        {isLoading && !rawEntries && <p className="text-fg-tertiary text-[13px] px-1">加载中…</p>}
        {error && !rawEntries && <p className="text-danger text-[13px] px-1 mb-2">加载出错: {String(error)}</p>}
        {error && rawEntries && <p className="text-fg-tertiary text-[12px] px-1 mb-2">加载失败，显示缓存数据</p>}

        {!isLoading && !isFiltering && currentDay === "tba" && (
          <p className="text-[12px] text-fg-tertiary mb-2 px-1">播出日期未定</p>
        )}

        {isFiltering ? (
          allFilteredItems.length === 0 ? (
            <p className="text-[13px] text-fg-tertiary px-1">无匹配条目</p>
          ) : (
            (() => {
              let flatIdx = 0;
              return filteredGroups.map(({ weekday, items }) => (
                <div key={weekday} className="mb-3">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-1 px-2.5">
                    {weekday === "tba" ? "未定 (TBA)" : ANILIST_WEEKDAY_CN[weekday]}
                    <span className="ml-2 normal-case font-normal">共 {items.length} 部</span>
                  </h3>
                  <div className="space-y-0.5">
                    {items.map((item) => {
                      const idx = flatIdx++;
                      const displayName = item.nameCn || item.title.native;
                      const dateStr = formatDate(item, seasonLabel);
                      const timeStr = item.airingAt
                        ? `${String(new Date(item.airingAt * 1000).getUTCHours()).padStart(2, "0")}:${String(new Date(item.airingAt * 1000).getUTCMinutes()).padStart(2, "0")}`
                        : "";
                      const subtitle = timeStr ? `${dateStr} ${timeStr}` : dateStr;
                      return (
                        <SubjectRow
                          key={item.id}
                          ref={(el) => { itemRefs.current[idx] = el; }}
                          subjectId={item.bangumiId}
                          coverUrl={item.cover}
                          title={displayName}
                          subtitle={subtitle}
                          selected={idx === focusedIndex}
                          onClick={() => setFocusedIndex(idx)}
                          onDoubleClick={() => {
                            if (item.bangumiId) {
                              navigate(`/subject/${item.bangumiId}`, {
                                state: { fromNextSeason: true, currentDay, focusedIndex: idx },
                              });
                            } else {
                              import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
                                openUrl(`https://anilist.co/anime/${item.id}`);
                              });
                            }
                          }}
                          accessories={
                            <>
                              {item.episodes && <Meta>{item.episodes}话</Meta>}
                              <Meta>{item.format === "MOVIE" ? "剧场版" : item.format === "TV" ? "TV" : item.format}</Meta>
                            </>
                          }
                        />
                      );
                    })}
                  </div>
                </div>
              ));
            })()
          )
        ) : (
          <>
            <div className="flex items-center justify-between mb-2 px-1">
              <h2 className="text-[15px] font-semibold text-fg">
                {currentDay === "tba" ? "未定 (TBA)" : ANILIST_WEEKDAY_CN[currentDay]}
              </h2>
              <span className="text-[12px] text-fg-tertiary">
                {seasonLabel}新番 · 共 {entries.length} 部
              </span>
            </div>

            {currentItems.length === 0 ? (
              <p className="text-[13px] text-fg-tertiary px-1">暂无放送</p>
            ) : (
              <div className="space-y-0.5">
              {currentItems.map((item, index) => {
              const displayName = item.nameCn || item.title.native;
              const dateStr = formatDate(item, seasonLabel);
              const timeStr = item.airingAt
                ? `${String(new Date(item.airingAt * 1000).getUTCHours()).padStart(2, "0")}:${String(new Date(item.airingAt * 1000).getUTCMinutes()).padStart(2, "0")}`
                : "";
              const subtitle = timeStr ? `${dateStr} ${timeStr}` : dateStr;

              return (
                <SubjectRow
                  key={item.id}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  subjectId={item.bangumiId}
                  coverUrl={item.cover}
                  title={displayName}
                  subtitle={subtitle}
                  selected={index === focusedIndex}
                  onClick={() => setFocusedIndex(index)}
                  onDoubleClick={() => {
                    if (item.bangumiId) {
                      navigate(`/subject/${item.bangumiId}`, {
                        state: { fromNextSeason: true, currentDay, focusedIndex: index },
                      });
                    } else {
                      import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
                        openUrl(`https://anilist.co/anime/${item.id}`);
                      });
                    }
                  }}
                  accessories={
                    <>
                      {item.episodes && <Meta>{item.episodes}话</Meta>}
                      <Meta>{item.format === "MOVIE" ? "剧场版" : item.format === "TV" ? "TV" : item.format}</Meta>
                    </>
                  }
                />
              );
            })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
