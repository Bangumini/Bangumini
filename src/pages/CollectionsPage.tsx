import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAllUserCollections, getCalendar, getEpisodes, getUserCollections } from "@shared/api/client";
import { SubjectTypeLabel } from "@shared/api/types";
import {
  sortCollections,
  getDisplayLabel,
  getTodayBangumiWeekday,
  WEEKDAY_CN,
} from "@shared/sort-collections";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";
import { getUsername } from "../api/oauth";

const LIMIT = 20;

export default function CollectionsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [collectionType, setCollectionType] = useState("3");
  const [page, setPage] = useState(1);
  const [searchText, setSearchText] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isWatching = collectionType === "3";
  const today = getTodayBangumiWeekday();

  const uname = getUsername();

  // Detect return from subject detail page and invalidate if ep_status changed
  useEffect(() => {
    const state = location.state as { fromSubject?: boolean; subjectId?: number } | null;
    if (state?.fromSubject && state?.subjectId) {
      // Invalidate collections to refetch and re-sort
      queryClient.invalidateQueries({ queryKey: ["collections", collectionType, uname] });
      // Clear the state to avoid repeated invalidation
      window.history.replaceState({}, document.title);
    }
  }, [location, queryClient, collectionType, uname]);

  const { data: collData, isLoading, error } = useQuery({
    queryKey: ["collections", collectionType, uname],
    queryFn: async () => {
      if (!uname) return { data: [], total: 0 };
      if (collectionType === "3") {
        return getAllUserCollections({ username: uname, type: 3 });
      }
      return getUserCollections({ username: uname, type: parseInt(collectionType), limit: 200 });
    },
    enabled: !!uname,
    staleTime: 1000 * 60 * 60 * 24, // 24 hours - daily update
  });

  const { data: calendar, error: calError } = useQuery({
    queryKey: ["calendar"],
    queryFn: getCalendar,
    enabled: isWatching,
    staleTime: 1000 * 60 * 60 * 24, // 24 hours - daily update
  });

  const rawCollections = collData?.data ?? [];

  // Build airing subject set from calendar
  const airingIds = useMemo(() => {
    if (!calendar) return [];
    const ids: number[] = [];
    for (const day of calendar) {
      for (const item of day.items) {
        ids.push(item.id);
      }
    }
    return ids;
  }, [calendar]);

  // Fetch episodes for airing items (only in watching mode)
  const { data: episodeMap } = useQuery({
    queryKey: ["episodes", airingIds.join(",")],
    queryFn: async () => {
      if (airingIds.length === 0) return new Map<number, number>();
      const results = await Promise.allSettled(
        airingIds.map((id) => getEpisodes(id).then((data) => ({ id, data }))),
      );
      const map = new Map<number, number>();
      const todayStr = new Date().toISOString().slice(0, 10);
      for (const r of results) {
        if (r.status === "fulfilled") {
          const { id, data } = r.value;
          const mainEps = data.data.filter((ep) => ep.type === 0);
          const airedCount = mainEps.filter((ep) => ep.airdate && ep.airdate <= todayStr).length;
          map.set(id, airedCount);
        }
      }
      return map;
    },
    enabled: isWatching && airingIds.length > 0,
    staleTime: 1000 * 60 * 60 * 24, // 24 hours - daily update
  });

  const airedEpMap = episodeMap ?? new Map<number, number>();

  // Build airingMap (subject_id → weekday)
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
      map.set(item.subject_id, getDisplayLabel(item, airingMap, airedEpMap, today));
    }
    return map;
  }, [sorted, airingMap, airedEpMap, today]);

  const displayLabelText = (item: (typeof sorted)[0]) => {
    if (!isWatching) return null;
    return displayLabelMap.get(item.subject_id) ?? null;
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

  // Reset focus when page changes
  useEffect(() => {
    setFocusedIndex(0);
    itemRefs.current = [];
  }, [page, collectionType, searchText]);

  // Scroll focused item into view
  useEffect(() => {
    const item = itemRefs.current[focusedIndex];
    if (item) {
      item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focusedIndex]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const itemCount = paged.length;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(itemCount - 1, i + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPage((p) => Math.max(1, p - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPage((p) => Math.min(totalPages, p + 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = paged[focusedIndex];
        if (item) {
          navigate(`/subject/${item.subject.id}`, {
            state: { fromCollections: true }
          });
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [paged, focusedIndex, page, totalPages, navigate]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-700">
        <div className="flex gap-2 mb-3">
          <input
            value={searchText}
            onChange={(e) => { setSearchText(e.target.value); setPage(1); }}
            placeholder="筛选条目（支持拼音）…"
            className="flex-1 px-3 py-2 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
          />
          <select
            value={collectionType}
            onChange={(e) => { setCollectionType(e.target.value); setPage(1); }}
            className="px-3 py-2 text-sm bg-gray-800 rounded-md border border-gray-700 text-gray-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="3">在看</option>
            <option value="1">想看</option>
            <option value="2">看过</option>
            <option value="4">搁置</option>
            <option value="5">抛弃</option>
          </select>
        </div>

        <div className="text-xs text-gray-500">
          {searchText
            ? `搜索 · 共 ${filtered.length} 条`
            : `第 ${page} / ${totalPages} 页 · 共 ${sorted.length} 条`}
          {isWatching && (
            <span className="ml-2 text-gray-600">
              (日历条目: {airingMap.size}, 剧集数据: {airedEpMap.size})
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {error && <p className="text-red-400 text-sm mb-2">收藏加载出错: {String(error)}</p>}
        {calError && <p className="text-red-400 text-sm mb-2">日历加载出错: {String(calError)}</p>}
        {isLoading && <p className="text-gray-500 text-sm">加载中…</p>}
        {!uname && !isLoading && <p className="text-gray-500 text-sm">正在获取用户信息…</p>}

        <div className="space-y-1">
          {paged.map((item, index) => {
            const s = item.subject;
            const label = displayLabelText(item);
            const weekday = s.air_weekday ? WEEKDAY_CN[s.air_weekday] : undefined;
            return (
              <div
                key={s.id}
                ref={(el) => (itemRefs.current[index] = el)}
                onClick={() => navigate(`/subject/${s.id}`, {
                  state: { fromCollections: true }
                })}
                className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                  index === focusedIndex
                    ? "bg-indigo-600/30 ring-2 ring-indigo-500"
                    : "hover:bg-gray-800/50"
                }`}
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
      </div>

      {!searchText && (
        <div className="p-4 border-t border-gray-700">
          <div className="flex justify-center gap-2 mb-2">
            <button
              onClick={() => setPage(1)}
              disabled={page === 1}
              className="px-2 py-1 text-xs bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700 transition-colors"
            >
              ««
            </button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-2 py-1 text-xs bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700 transition-colors"
            >
              «
            </button>
            <span className="px-2 py-1 text-xs text-gray-400">{page} / {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-2 py-1 text-xs bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700 transition-colors"
            >
              »
            </button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={page === totalPages}
              className="px-2 py-1 text-xs bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700 transition-colors"
            >
              »»
            </button>
          </div>
          <div className="text-xs text-gray-500 text-center">
            提示: ↑ ↓ 选择条目 | ← → 翻页 | Enter 查看详情
          </div>
        </div>
      )}
    </div>
  );
}
