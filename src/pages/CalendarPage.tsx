import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getCalendar } from "@shared/api/client";
import { WEEKDAY_CN, getTodayBangumiWeekday } from "@shared/sort-collections";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";
import type { SubjectSmall } from "@shared/api/types";

export default function CalendarPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const today = getTodayBangumiWeekday();
  const [currentDay, setCurrentDay] = useState<number>(today);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const filterText = searchParams.get("filter") ?? "";
  const filterWeekday = searchParams.get("weekday") ?? "";
  const isFiltering = filterText !== "" || filterWeekday !== "";

  const { data: calendar, isLoading, error } = useQuery({
    queryKey: ["calendar"],
    queryFn: getCalendar,
    staleTime: 1000 * 60 * 60 * 24,
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

  // Reset focus when items change
  useEffect(() => {
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
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "SELECT";
      const itemCount = displayItems.length;

      if (e.key === "ArrowLeft") {
        if (isInput) return;
        e.preventDefault();
        if (isFiltering) return;
        setCurrentDay((d) => (d <= 1 ? 7 : d - 1));
      } else if (e.key === "ArrowRight") {
        if (isInput) return;
        e.preventDefault();
        if (isFiltering) return;
        setCurrentDay((d) => (d >= 7 ? 1 : d + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(itemCount - 1, i + 1));
      } else if (e.key === "Enter") {
        if (isInput) return;
        e.preventDefault();
        const item = displayItems[focusedIndex];
        if (item) navigate(`/subject/${item.id}`);
      } else if (e.key === "Home" && !isFiltering) {
        if (isInput) return;
        e.preventDefault();
        setCurrentDay(today);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [today, currentDay, focusedIndex, navigate, displayItems.length, isFiltering]);

  if (isLoading) return <p className="p-4 text-gray-500 text-sm">加载中…</p>;
  if (error) return <p className="p-4 text-red-400 text-sm">加载出错: {String(error)}</p>;
  if (!calendar || calendar.length === 0) return <p className="p-4 text-gray-500 text-sm">暂无放送数据</p>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4">
        {isFiltering ? (
          <>
            {/* Filtering mode: flat list across all days */}
            <div className="mb-3">
              <h2 className="text-sm text-gray-400">
                筛选{filterText ? `"${filterText}"` : ""}{" "}
                {filterWeekday && `· ${WEEKDAY_CN[parseInt(filterWeekday)]}`}{" "}
                · 共 {filteredItems.length} 条
              </h2>
            </div>
            {filteredItems.length === 0 ? (
              <p className="text-sm text-gray-500">无匹配条目</p>
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
                  <div key={weekday} className="mb-4">
                    <h3 className="text-sm font-medium text-gray-400 mb-2">
                      {WEEKDAY_CN[weekday]}
                      <span className="text-xs text-gray-600 ml-2">共 {items.length} 部</span>
                    </h3>
                    <div className="space-y-1">
                      {items.map((s) => {
                        const idx = flatIdx++;
                        return (
                          <div
                            key={s.id}
                            ref={(el) => (itemRefs.current[idx] = el)}
                            onClick={() => navigate(`/subject/${s.id}`)}
                            className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${
                              idx === focusedIndex
                                ? "bg-indigo-600/30 ring-2 ring-indigo-500"
                                : "hover:bg-gray-800/50"
                            }`}
                          >
                            {s.images?.small && (
                              <img src={s.images.small} alt="" className="w-10 h-14 rounded object-cover shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{s.name_cn || s.name}</p>
                              {s.name_cn && s.name && (
                                <p className="text-xs text-gray-500 truncate mt-0.5">{s.name}</p>
                              )}
                            </div>
                            {s.rating?.score && (
                              <span className="text-xs text-yellow-500 shrink-0">★ {s.rating.score.toFixed(1)}</span>
                            )}
                            {s.rank && (
                              <span className="text-xs text-gray-500 shrink-0">#{s.rank}</span>
                            )}
                          </div>
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
            <div className="flex items-center justify-between mb-3">
              <h2 className={`text-lg font-medium ${isToday ? "text-indigo-400" : "text-gray-300"}`}>
                {WEEKDAY_CN[currentDay]}
                {isToday && " · 今天"}
                {currentDayData?.weekday.ja && (
                  <span className="text-xs text-gray-500 ml-2">{currentDayData.weekday.ja}</span>
                )}
              </h2>
              {!isToday && (
                <button
                  onClick={() => setCurrentDay(today)}
                  className="px-2 py-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  回到今天
                </button>
              )}
            </div>

            {!currentDayData || currentDayData.items.length === 0 ? (
              <p className="text-sm text-gray-500">
                {isToday ? "今天暂无放送" : "暂无放送"}
              </p>
            ) : (
              <div className="space-y-2">
                {currentDayData.items.map((s, index) => (
                  <div
                    key={s.id}
                    ref={(el) => (itemRefs.current[index] = el)}
                    onClick={() => navigate(`/subject/${s.id}`)}
                    className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${
                      index === focusedIndex
                        ? "bg-indigo-600/30 ring-2 ring-indigo-500"
                        : "hover:bg-gray-800/50"
                    }`}
                  >
                    {s.images?.small && (
                      <img src={s.images.small} alt="" className="w-12 h-16 rounded object-cover shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{s.name_cn || s.name}</p>
                      {s.name_cn && s.name && (
                        <p className="text-xs text-gray-500 truncate mt-0.5">{s.name}</p>
                      )}
                    </div>
                    {s.rating?.score && (
                      <span className="text-xs text-yellow-500 shrink-0">★ {s.rating.score.toFixed(1)}</span>
                    )}
                    {s.rank && (
                      <span className="text-xs text-gray-500 shrink-0">#{s.rank}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2 border-t border-gray-700 text-xs text-gray-500">
        提示: ← → 切换日期 | ↑ ↓ 选择条目 | Enter 查看详情 | Home 回到今天
      </div>
    </div>
  );
}
