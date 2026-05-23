import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getCalendar } from "@shared/api/client";
import { WEEKDAY_CN, getTodayBangumiWeekday } from "@shared/sort-collections";

export default function CalendarPage() {
  const navigate = useNavigate();
  const today = getTodayBangumiWeekday();
  const [currentDay, setCurrentDay] = useState<number>(today);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const { data: calendar, isLoading, error } = useQuery({
    queryKey: ["calendar"],
    queryFn: getCalendar,
    staleTime: 1000 * 60 * 60 * 24, // 24 hours - daily update
  });

  // Reset focus when day changes
  useEffect(() => {
    setFocusedIndex(0);
    itemRefs.current = [];
  }, [currentDay]);

  // Scroll focused item into view, keep it centered
  useEffect(() => {
    const item = itemRefs.current[focusedIndex];
    if (item) {
      item.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusedIndex]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const dayData = dayMap.get(currentDay);
      const itemCount = dayData?.items.length || 0;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCurrentDay((d) => (d <= 1 ? 7 : d - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setCurrentDay((d) => (d >= 7 ? 1 : d + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(itemCount - 1, i + 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = dayData?.items[focusedIndex];
        if (item) {
          navigate(`/subject/${item.id}`);
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        setCurrentDay(today);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [today, currentDay, focusedIndex, navigate]);

  if (isLoading) return <p className="p-4 text-gray-500 text-sm">加载中…</p>;
  if (error) return <p className="p-4 text-red-400 text-sm">加载出错: {String(error)}</p>;
  if (!calendar || calendar.length === 0) return <p className="p-4 text-gray-500 text-sm">暂无放送数据</p>;

  const dayMap = new Map(calendar.map((day) => [day.weekday.id, day]));
  const currentDayData = dayMap.get(currentDay);
  const isToday = currentDay === today;

  return (
    <div className="flex flex-col h-full">
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
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
                  <img
                    src={s.images.small}
                    alt=""
                    className="w-12 h-16 rounded object-cover shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {s.name_cn || s.name}
                  </p>
                  {s.name_cn && s.name && (
                    <p className="text-xs text-gray-500 truncate mt-0.5">{s.name}</p>
                  )}
                </div>
                {s.rating?.score && (
                  <span className="text-xs text-yellow-500 shrink-0">
                    ★ {s.rating.score.toFixed(1)}
                  </span>
                )}
                {s.rank && (
                  <span className="text-xs text-gray-500 shrink-0">
                    #{s.rank}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Keyboard hints */}
      <div className="px-4 py-2 border-t border-gray-700 text-xs text-gray-500">
        提示: ← → 切换日期 | ↑ ↓ 选择条目 | Enter 查看详情 | Home 回到今天
      </div>
    </div>
  );
}
