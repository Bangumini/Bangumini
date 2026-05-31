import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
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
import { SubjectRow, Rating, Meta, Tag } from "../components/SubjectRow";
import { MOD } from "../api/shortcut";

const LIMIT = 20;

export default function CollectionsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  const collectionType = searchParams.get("type") ?? "3";
  const searchText = searchParams.get("filter") ?? "";
  const [page, setPage] = useState(1);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isWatching = collectionType === "3";
  const today = getTodayBangumiWeekday();

  const uname = getUsername();

  // Detect return from subject detail page and invalidate if ep_status changed
  useEffect(() => {
    const state = location.state as { fromSubject?: boolean; subjectId?: number } | null;
    if (state?.fromSubject && state?.subjectId) {
      queryClient.invalidateQueries({ queryKey: ["collections", collectionType, uname] });
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
    staleTime: 1000 * 60 * 60 * 24,
  });

  const { data: calendar, error: calError } = useQuery({
    queryKey: ["calendar"],
    queryFn: getCalendar,
    enabled: isWatching,
    staleTime: 1000 * 60 * 60 * 24,
  });

  const rawCollections = collData?.data ?? [];

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
    staleTime: 1000 * 60 * 60 * 24,
  });

  const airedEpMap = episodeMap ?? new Map<number, number>();

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

  // Reset page and focus when filter/type changes
  useEffect(() => {
    setPage(1);
    setFocusedIndex(0);
    itemRefs.current = [];
  }, [searchText, collectionType]);

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
      const itemCount = paged.length;
      const mod = e.ctrlKey || e.metaKey;

      // Ctrl/Cmd + Left/Right = pagination. (Ctrl/Cmd + Up/Down switches sidebar
      // tabs and is handled in Layout, so we ignore those here.)
      if (mod) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setPage((p) => Math.max(1, p - 1));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          setPage((p) => Math.min(totalPages, p + 1));
        }
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
        const item = paged[focusedIndex];
        if (item) {
          navigate(`/subject/${item.subject.id}`, { state: { fromCollections: true } });
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [paged, focusedIndex, page, totalPages, navigate]);

  return (
    <div className="h-full flex flex-col">
      {/* Page indicator */}
      <div className="px-4 py-1.5 text-[12px] text-fg-tertiary border-b border-line shrink-0">
        {searchText
          ? `搜索 · 共 ${filtered.length} 条`
          : `第 ${page} / ${totalPages} 页 · 共 ${sorted.length} 条${totalPages > 1 ? ` · ${MOD}←→ 翻页` : ""}`}
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto p-2.5">
        {error && <p className="text-danger text-[13px] mb-2 px-1">收藏加载出错: {String(error)}</p>}
        {calError && <p className="text-danger text-[13px] mb-2 px-1">日历加载出错: {String(calError)}</p>}
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
                coverUrl={s.images?.small}
                title={s.name_cn || s.name}
                subtitle={s.name_cn ? s.name : undefined}
                selected={index === focusedIndex}
                onClick={() => navigate(`/subject/${s.id}`, { state: { fromCollections: true } })}
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
