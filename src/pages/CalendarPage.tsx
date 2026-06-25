import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getCalendar } from "@shared/api/client";
import type { CalendarItem } from "@shared/api/types";
import {
  readCachedValueEntry,
  readCachedValueWithLegacy,
  readLegacyHttpCache,
  writeCachedSubjectPreviews,
  writeCachedValue,
} from "@shared/storage/sqlite-cache";
import { WEEKDAY_CN, getTodayBangumiWeekday } from "@shared/sort-collections";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";
import type { SubjectSmall } from "@shared/api/types";
import { getSubjectTitleForCopy } from "../api/subject-title-copy";
import { SubjectRow, Rating, Meta } from "../components/SubjectRow";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { isCacheStale, refreshQueryDataIfChanged } from "../api/stale-cache-refresh";

const QUERY_CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const CALENDAR_QUERY_KEY = ["calendar"] as const;

type CalendarLocationState = {
  fromSubject?: boolean;
  subjectId?: number;
  currentDay?: number;
  focusedIndex?: number;
};

async function fetchAndCacheCalendar() {
  const data = await getCalendar();
  await writeCachedSubjectPreviews(data.flatMap((day) => day.items));
  await writeCachedValue("calendar", data);
  return data;
}

export default function CalendarPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const today = getTodayBangumiWeekday();

  // Check if returning from detail page
  const initialState = useMemo(() => {
    const state = location.state as CalendarLocationState | null;
    if (state?.fromSubject && state?.subjectId) {
      return {
        currentDay: state.currentDay ?? today,
        focusedIndex: state.focusedIndex ?? 0,
        isReturningFromDetail: true,
      };
    }
    return {
      currentDay: today,
      focusedIndex: 0,
      isReturningFromDetail: false,
    };
  }, [location.state, today]);

  const [currentDay, setCurrentDay] = useState<number>(initialState.currentDay);
  const [focusedIndex, setFocusedIndex] = useState(initialState.focusedIndex);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isReturningFromDetail = useRef(initialState.isReturningFromDetail);

  const filterText = searchParams.get("filter") ?? "";
  const filterWeekday = searchParams.get("weekday") ?? "";
  const isFiltering = filterText !== "" || filterWeekday !== "";

  const { data: calendar, isLoading, error } = useQuery({
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
    staleTime: 0,
  });

  // Build flat list of all items with their weekday context
  const allItems = useMemo(() => {
    if (!calendar) return [];
    const items: (SubjectSmall & { weekday: number; weekdayJa: string })[] = [];
    for (const day of calendar) {
      for (const item of day.items) {
        items.push({ ...item, weekday: day.weekday.id, weekdayJa: day.weekday.ja });
      }
    }
    return items;
  }, [calendar]);

  // Filtered items when filtering is active, sorted by weekday
  const filteredItems = useMemo(() => {
    if (!isFiltering) return [];
    const filtered = allItems.filter((item) => {
      if (filterWeekday && item.weekday !== parseInt(filterWeekday)) return false;
      if (filterText) {
        const lower = filterText.toLowerCase();
        const keywords = buildSubjectKeywords(item.name_cn, item.name);
        return (
          (item.name_cn || "").toLowerCase().includes(lower) ||
          (item.name || "").toLowerCase().includes(lower) ||
          keywords.some((k) => k.toLowerCase().includes(lower))
        );
      }
      return true;
    });
    filtered.sort((a, b) => a.weekday - b.weekday);
    return filtered;
  }, [allItems, filterText, filterWeekday, isFiltering]);

  // In normal mode, the items for the current day
  const dayMap = new Map(calendar?.map((day) => [day.weekday.id, day]) ?? []);
  const currentDayData = dayMap.get(currentDay);
  const isToday = currentDay === today;

  // The items to display (filtered or normal)
  const displayItems = isFiltering ? filteredItems : (currentDayData?.items ?? []);

  // Clear navigation state after returning from detail
  useEffect(() => {
    const state = location.state as CalendarLocationState | null;
    if (state?.fromSubject) {
      window.history.replaceState({}, document.title);
      const timer = window.setTimeout(() => { isReturningFromDetail.current = false; }, 100);
      return () => window.clearTimeout(timer);
    }
  }, [location.state]);

  // Reset focus when items change (but not when returning from detail)
  useEffect(() => {
    if (isReturningFromDetail.current) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedIndex(0);
    itemRefs.current = [];
  }, [currentDay, filterText, filterWeekday]);

  // Scroll focused item into view, centered
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
        const item = displayItems[focusedIndex];
        if (item) {
          const name = getSubjectTitleForCopy(item.name_cn || item.name);
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
      when: () => !isFiltering,
      handler: ({ event }) => {
        if (event.key === "ArrowLeft") {
          setCurrentDay((d) => (d <= 1 ? 7 : d - 1));
        } else {
          setCurrentDay((d) => (d >= 7 ? 1 : d + 1));
        }
      },
    },
    {
      key: "ArrowUp",
      when: () => displayItems.length > 0,
      handler: () => {
        setFocusedIndex((i) => Math.max(0, i - 1));
      },
    },
    {
      key: "ArrowDown",
      when: () => displayItems.length > 0,
      handler: () => {
        setFocusedIndex((i) => Math.min(displayItems.length - 1, i + 1));
      },
    },
    {
      key: "Enter",
      when: () => displayItems.length > 0,
      handler: () => {
        const item = displayItems[focusedIndex];
        if (item) {
          navigate(`/subject/${item.id}`, {
            state: { fromCalendar: true, currentDay, focusedIndex },
          });
        }
      },
    },
    {
      key: "Home",
      when: () => !isFiltering,
      handler: () => {
        setCurrentDay(today);
      },
    },
  ], { priority: 10 });

  if (isLoading && !calendar) return <p className="p-4 text-fg-tertiary text-[13px]">加载中…</p>;
  if (error && !calendar) return <p className="p-4 text-danger text-[13px]">加载出错: {String(error)}</p>;
  if (!calendar || calendar.length === 0) return <p className="p-4 text-fg-tertiary text-[13px]">暂无放送数据</p>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-2.5">
        {error && calendar && (
          <p className="text-fg-tertiary text-[12px] mb-2 px-1">日历加载失败，显示缓存数据</p>
        )}
        {isFiltering ? (
          <>
            {/* Filtering mode: flat list across all days */}
            <div className="mb-2 px-1">
              <h2 className="text-[12px] text-fg-secondary">
                筛选{filterText ? `"${filterText}"` : ""}{" "}
                {filterWeekday && `· ${WEEKDAY_CN[parseInt(filterWeekday)]}`}{" "}
                · 共 {filteredItems.length} 条
              </h2>
            </div>
            {filteredItems.length === 0 ? (
              <p className="text-[13px] text-fg-tertiary px-1">无匹配条目</p>
            ) : (
              (() => {
                // Group by weekday
                const grouped = new Map<number, typeof filteredItems>();
                for (const item of filteredItems) {
                  const list = grouped.get(item.weekday) ?? [];
                  list.push(item);
                  grouped.set(item.weekday, list);
                }
                // Preserve weekday order (1-7)
                const groups = [...grouped].sort(([a], [b]) => a - b);

                let flatIdx = 0;
                return groups.map(([weekday, items]) => (
                  <div key={weekday} className="mb-3">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-1 px-2.5">
                      {WEEKDAY_CN[weekday]}
                      <span className="ml-2 normal-case font-normal">共 {items.length} 部</span>
                    </h3>
                    <div className="space-y-0.5">
                      {items.map((s) => {
                        const idx = flatIdx++;
                        return (
                          <SubjectRow
                            key={s.id}
                            ref={(el) => { itemRefs.current[idx] = el; }}
                            subjectId={s.id}
                            coverUrl={s.images?.small}
                            title={s.name_cn || s.name}
                            subtitle={s.name_cn && s.name ? s.name : undefined}
                            selected={idx === focusedIndex}
                            onClick={() => setFocusedIndex(idx)}
                            onDoubleClick={() => navigate(`/subject/${s.id}`, {
                              state: { fromCalendar: true, currentDay, focusedIndex: idx },
                            })}
                            accessories={
                              <>
                                {s.rating?.score ? <Rating score={s.rating.score} /> : null}
                                {s.rank ? <Meta>#{s.rank}</Meta> : null}
                              </>
                            }
                          />
                        );
                      })}
                    </div>
                  </div>
                ));
              })()
            )}
          </>
        ) : (
          <>
            {/* Normal mode: one day at a time */}
            <div className="flex items-center justify-between mb-2 px-1">
              <h2 className={`text-[15px] font-semibold ${isToday ? "text-accent" : "text-fg"}`}>
                {WEEKDAY_CN[currentDay]}
                {isToday && " · 今天"}
                {currentDayData?.weekday.ja && (
                  <span className="text-[12px] font-normal text-fg-tertiary ml-2">{currentDayData.weekday.ja}</span>
                )}
              </h2>
              <div className="flex items-center gap-3">
                {!isToday && (
                  <button
                    onClick={() => setCurrentDay(today)}
                    className="px-2 py-1 text-[12px] text-accent hover:opacity-80 transition-opacity"
                  >
                    回到今天
                  </button>
                )}
              </div>
            </div>

            {!currentDayData || currentDayData.items.length === 0 ? (
              <p className="text-[13px] text-fg-tertiary px-1">
                {isToday ? "今天暂无放送" : "暂无放送"}
              </p>
            ) : (
              <div className="space-y-0.5">
                {currentDayData.items.map((s, index) => (
                  <SubjectRow
                    key={s.id}
                    ref={(el) => { itemRefs.current[index] = el; }}
                    size="md"
                    subjectId={s.id}
                    coverUrl={s.images?.small}
                    title={s.name_cn || s.name}
                    subtitle={s.name_cn && s.name ? s.name : undefined}
                    selected={index === focusedIndex}
                    onClick={() => setFocusedIndex(index)}
                    onDoubleClick={() => navigate(`/subject/${s.id}`, {
                      state: { fromCalendar: true, currentDay, focusedIndex: index },
                    })}
                    accessories={
                      <>
                        {s.rating?.score ? <Rating score={s.rating.score} /> : null}
                        {s.rank ? <Meta>#{s.rank}</Meta> : null}
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
