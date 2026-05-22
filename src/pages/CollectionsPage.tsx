import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getAllUserCollections, getCalendar } from "@shared/api/client";
import { SubjectTypeLabel } from "@shared/api/types";
import {
  sortCollections,
  getDisplayLabel,
  getTodayBangumiWeekday,
  WEEKDAY_CN,
} from "@shared/sort-collections";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";

const LIMIT = 20;

export default function CollectionsPage() {
  const navigate = useNavigate();
  const [collectionType, setCollectionType] = useState("3");
  const [page, setPage] = useState(1);
  const [searchText, setSearchText] = useState("");
  const isWatching = collectionType === "3";
  const today = getTodayBangumiWeekday();

  const { data: collData, isLoading } = useQuery({
    queryKey: ["collections", collectionType],
    queryFn: async () => {
      if (collectionType === "3") {
        return getAllUserCollections({ username: "", type: 3 });
      }
      const mod = await import("@shared/api/client");
      return mod.getUserCollections({ username: "", type: parseInt(collectionType), limit: 200 });
    },
    staleTime: 60_000,
  });

  const { data: calendar } = useQuery({
    queryKey: ["calendar"],
    queryFn: getCalendar,
    enabled: isWatching,
    staleTime: 1000 * 60 * 30,
  });

  const rawCollections = collData?.data ?? [];

  const sorted = useMemo(() => {
    if (isWatching && calendar) {
      return sortCollections(rawCollections, calendar, today, new Map());
    }
    return rawCollections;
  }, [rawCollections, calendar, isWatching, today]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / LIMIT));
  const displayLabelText = (item: (typeof sorted)[0]) => {
    if (!isWatching) return null;
    return getDisplayLabel(item, new Map(), new Map(), today);
  };

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

  return (
    <div className="p-4">
      <div className="flex gap-2 mb-4">
        <input
          value={searchText}
          onChange={(e) => { setSearchText(e.target.value); setPage(1); }}
          placeholder="筛选条目（支持拼音）…"
          className="flex-1 px-3 py-2 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 placeholder-gray-500 focus:border-indigo-500"
        />
        <select
          value={collectionType}
          onChange={(e) => { setCollectionType(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200"
        >
          <option value="3">在看</option>
          <option value="1">想看</option>
          <option value="2">看过</option>
          <option value="4">搁置</option>
          <option value="5">抛弃</option>
        </select>
      </div>

      {isLoading && <p className="text-gray-500 text-sm">加载中…</p>}

      <div className="text-xs text-gray-500 mb-2">
        {searchText ? `搜索 · 共 ${filtered.length} 条` : `第 ${page} / ${totalPages} 页 · 共 ${sorted.length} 条`}
      </div>

      <div className="space-y-1">
        {paged.map((item) => {
          const s = item.subject;
          const label = displayLabelText(item);
          const weekday = s.air_weekday ? WEEKDAY_CN[s.air_weekday] : undefined;
          return (
            <div
              key={s.id}
              onClick={() => navigate(`/subject/${s.id}`)}
              className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-800/50 cursor-pointer"
            >
              {s.images?.small && (
                <img src={s.images.small} alt="" className="w-10 h-14 rounded object-cover shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{s.name_cn || s.name}</div>
                {s.name_cn && <div className="text-xs text-gray-500 truncate">{s.name}</div>}
              </div>
              {label && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 shrink-0">
                  {label}
                </span>
              )}
              {item.rate > 0 && (
                <span className="text-xs text-yellow-500 shrink-0">★ {item.rate}</span>
              )}
              {weekday && <span className="text-xs text-gray-500 shrink-0">{weekday}</span>}
              <span className="text-xs text-gray-600 shrink-0">{SubjectTypeLabel[s.type]}</span>
            </div>
          );
        })}
      </div>

      {!searchText && (
        <div className="flex justify-center gap-2 mt-4">
          <button
            onClick={() => setPage(1)}
            disabled={page === 1}
            className="px-2 py-1 text-xs bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
          >
            ««
          </button>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-2 py-1 text-xs bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
          >
            «
          </button>
          <span className="px-2 py-1 text-xs text-gray-400">{page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-2 py-1 text-xs bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
          >
            »
          </button>
          <button
            onClick={() => setPage(totalPages)}
            disabled={page === totalPages}
            className="px-2 py-1 text-xs bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
          >
            »»
          </button>
        </div>
      )}
    </div>
  );
}
