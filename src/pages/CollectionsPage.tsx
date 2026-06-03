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
  getTodayBangumiWeekday,
  WEEKDAY_CN,
} from "@shared/sort-collections";
import { buildSubjectKeywords } from "@shared/pinyin-keywords";
import { readCache, writeCache } from "@shared/local-cache";
import { getUsername } from "../api/oauth";
import { SubjectRow, Rating, Meta, Tag } from "../components/SubjectRow";

const LIMIT = 20;
const AIRING_CACHE_PREFIX = "bangumini-anilist-";
const AIRING_REQUEST_DELAY = 700;

type AiringTime = { airingAt: number; episode: number };
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

function readAiringCache(subjectId: number): AiringTime | null {
  try {
    const raw = localStorage.getItem(`${AIRING_CACHE_PREFIX}${subjectId}`);
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

function writeAiringCache(subjectId: number, value: AiringTime) {
  localStorage.setItem(
    `${AIRING_CACHE_PREFIX}${subjectId}`,
    JSON.stringify(value),
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isWatching = collectionType === "3";
  const today = getTodayBangumiWeekday();
  const isReturningFromDetail = useRef(initialState.isReturningFromDetail);

  const uname = getUsername();

  // Detect return from subject detail page and invalidate if ep_status changed
  useEffect(() => {
    const state = location.state as CollectionsLocationState | null;
    if (state?.fromSubject && state?.subjectId) {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith("bangumini-http-collections-")) localStorage.removeItem(key);
      }
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      window.history.replaceState({}, document.title);
      // Reset the flag after other effects have run
      setTimeout(() => { isReturningFromDetail.current = false; }, 100);
    }
  }, [location, queryClient]);

  const seedCollections = useMemo(
    () => readCache<PagedResponse<UserCollection>>(`collections-${collectionType}-${uname}`),
    [collectionType, uname],
  );

  const { data: collData, isLoading, error } = useQuery({
    queryKey: ["collections", collectionType, uname],
    queryFn: async () => {
      if (!uname) return { data: [], total: 0 };
      let result;
      if (collectionType === "3") {
        result = await getAllUserCollections({ username: uname, type: 3 });
      } else {
        result = await getUserCollections({ username: uname, type: parseInt(collectionType), limit: 100 });
      }
      writeCache(`collections-${collectionType}-${uname}`, result);
      return result;
    },
    enabled: !!uname,
    initialData: seedCollections ?? undefined,
    initialDataUpdatedAt: 0,
    staleTime: 1000 * 60 * 60 * 24,
  });

  const seedCalendar = useMemo(() => readCache<CalendarItem[]>("calendar"), []);

  const { data: calendar, error: calError } = useQuery({
    queryKey: ["calendar"],
    queryFn: async () => {
      const data = await getCalendar();
      writeCache("calendar", data);
      return data;
    },
    enabled: isWatching,
    initialData: seedCalendar ?? undefined,
    initialDataUpdatedAt: 0,
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

  const episodesCacheKey = `episodes-${airingIds.join(",")}`;
  const seedEpisodes = useMemo(
    () => {
      const raw = readCache<[number, number][]>(episodesCacheKey);
      if (!raw) return null;
      return new Map<number, number>(raw);
    },
    [episodesCacheKey],
  );

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
      writeCache(episodesCacheKey, [...map]);
      return map;
    },
    enabled: isWatching && airingIds.length > 0,
    initialData: seedEpisodes ?? undefined,
    initialDataUpdatedAt: 0,
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

  const airingTimeTargets = useMemo(() => {
    if (!isWatching || airingMap.size === 0) return [];
    return sorted
      .filter((item) => airingMap.has(item.subject_id) && item.ep_status > 0)
      .map((item) => ({
        subjectId: item.subject_id,
        name: item.subject.name,
      }));
  }, [sorted, airingMap, isWatching]);

  const { data: airingTimeMap = new Map<number, AiringTime>() } = useQuery({
    queryKey: ["anilist-airing-times", airingTimeTargets.map((item) => item.subjectId).join(",")],
    queryFn: async () => {
      const map = new Map<number, AiringTime>();

      for (const item of airingTimeTargets) {
        const cached = readAiringCache(item.subjectId);
        if (cached) {
          map.set(item.subjectId, cached);
        }
      }

      const missing = airingTimeTargets.filter((item) => !map.has(item.subjectId));
      for (const [index, item] of missing.entries()) {
        if (index > 0) await delay(AIRING_REQUEST_DELAY);
        if (!item.name) continue;
        const result = await getAiringAt(item.name);
        if (result) {
          writeAiringCache(item.subjectId, result);
          map.set(item.subjectId, result);
        }
      }

      return map;
    },
    enabled: isWatching && airingTimeTargets.length > 0,
  });

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
  }, [scrollKey]);

  function openSubject(subjectId: number) {
    writePageState(collectionType, searchText, page, focusedIndex);
    navigate(`/subject/${subjectId}`, {
      state: { fromCollections: true, page, focusedIndex },
    });
  }

  const clearAiringCache = async () => {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(AIRING_CACHE_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
    queryClient.resetQueries({ queryKey: ["anilist-airing-times"] });
    await queryClient.refetchQueries({ queryKey: ["anilist-airing-times"] });
    invoke("show_toast", { message: "播出时间已刷新" });
  };

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const itemCount = paged.length;
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === "r" && mod && !isWatching) return; // let browser handle Ctrl+R on non-watching pages

      if (e.key === "r" && mod && isWatching) {
        e.preventDefault();
        clearAiringCache();
        return;
      }

      // Ctrl+Enter: copy focused subject name and close window
      if (e.key === "Enter" && mod) {
        e.preventDefault();
        const item = paged[focusedIndex];
        if (item) {
          const name = item.subject.name_cn || item.subject.name;
          navigator.clipboard.writeText(name).then(async () => {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await invoke("show_toast", { message: "已复制条目名" });
            getCurrentWindow().hide();
          });
        }
        return;
      }

      // Ctrl/Cmd + Left/Right = pagination. (Ctrl/Cmd + Up/Down switches sidebar
      // tabs and is handled in Layout, so we ignore those here.)
      // Also allow plain Left/Right when coming from search page with empty query.
      if ((mod || !searchText) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
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
          openSubject(item.subject.id);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [paged.length, focusedIndex, page, totalPages, navigate, searchText]);

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
