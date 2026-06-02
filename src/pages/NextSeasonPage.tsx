import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getNextSeason, getNextSeasonInfo } from "@shared/api/anilist";
import type { NextSeasonItem } from "@shared/api/anilist";
import { searchAnimeSubject } from "@shared/api/client";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";
import { SubjectRow, Meta } from "../components/SubjectRow";

const ANILIST_WEEKDAY_CN: Record<number, string> = {
  0: "星期日", 1: "星期一", 2: "星期二", 3: "星期三",
  4: "星期四", 5: "星期五", 6: "星期六",
};

interface SeasonEntry extends NextSeasonItem {
  weekday: number | null;
  nameCn: string | null;
  bangumiId: number | null;
}

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

const NEXT_SEASON_CACHE_PREFIX = "bangumini-next-season-";
const NEXT_SEASON_CACHE_TTL = 1000 * 60 * 60 * 24; // 1 day

function getNextSeasonCacheKey(): string {
  const { season, seasonYear } = getNextSeasonInfo();
  return `${NEXT_SEASON_CACHE_PREFIX}${seasonYear}-${season}`;
}

function readNextSeasonCache(): SeasonEntry[] | null {
  try {
    const raw = localStorage.getItem(getNextSeasonCacheKey());
    if (!raw) return null;
    const cached = JSON.parse(raw) as { entries: SeasonEntry[]; cachedAt: number };
    if (!cached.entries || !cached.cachedAt) return null;
    return cached.entries;
  } catch {
    return null;
  }
}

function writeNextSeasonCache(entries: SeasonEntry[]) {
  localStorage.setItem(
    getNextSeasonCacheKey(),
    JSON.stringify({ entries, cachedAt: Date.now() }),
  );
}

function cleanOldNextSeasonCaches() {
  const currentKey = getNextSeasonCacheKey();
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(NEXT_SEASON_CACHE_PREFIX) && key !== currentKey) {
      localStorage.removeItem(key);
    }
  }
}

function isAired(item: SeasonEntry): boolean {
  const nowSec = Date.now() / 1000;
  if (item.airingAt && item.airingAt < nowSec) return true;
  // For items without airingAt, check startDate
  const { year, month, day } = item.startDate;
  if (year && month && day) {
    const startSec = new Date(year, month - 1, day).getTime() / 1000;
    if (startSec < nowSec - 86400) return true; // more than 1 day past start
  }
  return false;
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

export default function NextSeasonPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const filterText = searchParams.get("filter") ?? "";
  const filterWeekday = searchParams.get("weekday") ?? "";
  const { label: seasonLabel } = getNextSeasonInfo();
  const [currentDay, setCurrentDay] = useState<number | "tba">(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isFiltering = filterText !== "" || filterWeekday !== "";

  const seedCache = useMemo(() => {
    cleanOldNextSeasonCaches();
    return readNextSeasonCache() ?? [];
  }, []);

  const { data: rawEntries, isLoading, error } = useQuery({
    queryKey: ["next-season", seasonLabel],
    queryFn: async () => {
      const items = await getNextSeason();

      const results = await Promise.allSettled(
        items.map(async (item) => {
          const weekday = getWeekday(item);
          const bangumiMatch = await searchAnimeSubject(item.title.native);
          return {
            ...item,
            weekday,
            nameCn: bangumiMatch?.name_cn ?? null,
            bangumiId: bangumiMatch?.id ?? null,
          } as SeasonEntry;
        }),
      );

      const enriched = results
        .filter((r): r is PromiseFulfilledResult<SeasonEntry> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((e) => !isAired(e));

      writeNextSeasonCache(enriched);
      return enriched;
    },
    initialData: seedCache.length > 0 ? seedCache : undefined,
    initialDataUpdatedAt: 0,
    staleTime: NEXT_SEASON_CACHE_TTL,
  });

  const entries = rawEntries ?? [];

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

  // Default to day of earliest entry
  useEffect(() => {
    if (entries.length === 0) return;
    setCurrentDay(earliestEntryDay(entries));
  }, [entries.length]);

  // Filtered items (grouped by weekday, TBA last)
  const filteredGroups = useMemo(() => {
    if (!isFiltering) return [];
    const lower = filterText.toLowerCase();
    let items = entries.filter((item) => {
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

  // Reset focus when day or filter changes
  useEffect(() => {
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
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const itemCount = currentItems.length;
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === "Enter" && mod) {
        e.preventDefault();
        const item = currentItems[focusedIndex];
        if (item) {
          const name = item.nameCn || item.title.native;
          navigator.clipboard.writeText(name).then(async () => {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await invoke("show_toast", { message: "已复制条目名" });
            getCurrentWindow().hide();
          });
        }
        return;
      }

      if (e.key === "ArrowLeft" && !isFiltering) {
        e.preventDefault();
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
        return;
      }

      if (e.key === "ArrowRight" && !isFiltering) {
        e.preventDefault();
        setCurrentDay((d) => {
          if (d === "tba") return "tba";
          for (let offset = 1; offset <= 7; offset++) {
            const candidate = (d + offset) % 7;
            if (availableDays.has(candidate)) return candidate;
          }
          if (hasTba) return "tba";
          return d;
        });
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(itemCount - 1, i + 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = currentItems[focusedIndex];
        if (item?.bangumiId) {
          navigate(`/subject/${item.bangumiId}`);
        } else if (item) {
          import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
            openUrl(`https://anilist.co/anime/${item.id}`);
          });
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentItems, focusedIndex, navigate, availableDays, hasTba, isFiltering]);

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
                          coverUrl={item.cover}
                          title={displayName}
                          subtitle={subtitle}
                          selected={idx === focusedIndex}
                          onClick={() => {
                            if (item.bangumiId) {
                              navigate(`/subject/${item.bangumiId}`);
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
                  coverUrl={item.cover}
                  title={displayName}
                  subtitle={subtitle}
                  selected={index === focusedIndex}
                  onClick={() => {
                    if (item.bangumiId) {
                      navigate(`/subject/${item.bangumiId}`);
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
