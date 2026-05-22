import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getCalendar } from "@shared/api/client";
import { WEEKDAY_CN, getTodayBangumiWeekday } from "@shared/sort-collections";

export default function CalendarPage() {
  const navigate = useNavigate();
  const today = getTodayBangumiWeekday();

  const { data: calendar, isLoading, error } = useQuery({
    queryKey: ["calendar"],
    queryFn: getCalendar,
    staleTime: 1000 * 60 * 30,
  });

  if (isLoading) return <p className="p-4 text-gray-500 text-sm">加载中…</p>;
  if (error) return <p className="p-4 text-red-400 text-sm">加载出错: {String(error)}</p>;
  if (!calendar || calendar.length === 0) return <p className="p-4 text-gray-500 text-sm">暂无放送数据</p>;

  return (
    <div className="p-4">
      <div className="space-y-4">
        {calendar.map((day) => {
          const isToday = day.weekday.id === today;
          return (
            <div key={day.weekday.id}>
              <h3 className={`text-sm font-medium mb-2 ${isToday ? "text-indigo-400" : "text-gray-400"}`}>
                {WEEKDAY_CN[day.weekday.id]}
                {isToday && " · 今天"}
                <span className="text-gray-600 ml-1 text-xs">{day.weekday.ja}</span>
              </h3>
              {day.items.length === 0 && (
                <p className="text-xs text-gray-600">暂无放送</p>
              )}
              <div className="space-y-0.5">
                {day.items.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => navigate(`/subject/${s.id}`)}
                    className="flex items-center gap-2 p-1.5 rounded hover:bg-gray-800/50 cursor-pointer text-sm"
                  >
                    {s.images?.small && (
                      <img src={s.images.small} alt="" className="w-8 h-11 rounded object-cover shrink-0" />
                    )}
                    <span className="truncate">{s.name_cn || s.name}</span>
                    {s.rating?.score && (
                      <span className="text-xs text-yellow-500 shrink-0 ml-auto">★ {s.rating.score.toFixed(1)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
