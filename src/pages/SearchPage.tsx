import { useEffect, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { searchSubjects } from "@shared/api/client";
import { SubjectTypeLabel } from "@shared/api/types";
import { writeCachedSubjectPreviews } from "@shared/storage/sqlite-cache";
import { getSubjectTitleForCopy } from "../api/subject-title-copy";
import { SubjectRow, Rating, Meta } from "../components/SubjectRow";
import { SearchIcon } from "../components/icons";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

const DEFAULT_SEARCH_TYPE = "2";
const SEARCH_PAGE_LIMIT = 30;

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-fg-tertiary">
      <SearchIcon size={32} className="opacity-40" />
      <p className="text-[13px]">{children}</p>
    </div>
  );
}

export default function SearchPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const keyword = searchParams.get("q") ?? "";
  const typeFilter = searchParams.has("stype")
    ? searchParams.get("stype") ?? ""
    : DEFAULT_SEARCH_TYPE;
  const [page, setPage] = useState(1);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["search", keyword, typeFilter, page],
    queryFn: async () => {
      const result = await searchSubjects({
        keyword,
        type: typeFilter ? [parseInt(typeFilter)] : undefined,
        limit: SEARCH_PAGE_LIMIT,
        offset: (page - 1) * SEARCH_PAGE_LIMIT,
      });
      await writeCachedSubjectPreviews(result.data);
      return result;
    },
    enabled: keyword.length > 0,
    staleTime: 30_000,
  });

  const subjects = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / SEARCH_PAGE_LIMIT));

  // Return to the first page whenever a new search starts.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
    setFocusedIndex(0);
    itemRefs.current = [];
  }, [keyword, typeFilter]);

  // Select the first result whenever the visible page changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedIndex(0);
    itemRefs.current = [];
  }, [page]);

  useEffect(() => {
    itemRefs.current[focusedIndex]?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex, subjects.length]);

  // Keyboard navigation over results (works while the search box stays focused).
  useKeyboardShortcuts([
    {
      key: "Enter",
      mod: true,
      handler: () => {
        const s = subjects[focusedIndex];
        if (s) {
          const name = getSubjectTitleForCopy(s.name_cn || s.name);
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
      when: () => subjects.length > 0,
      handler: ({ event }) => {
        if (event.key === "ArrowLeft") {
          setPage((p) => Math.max(1, p - 1));
        } else {
          setPage((p) => Math.min(totalPages, p + 1));
        }
      },
    },
    {
      key: "ArrowUp",
      mod: false,
      when: () => subjects.length > 0,
      handler: () => {
        setFocusedIndex((i) => i <= 0 ? subjects.length - 1 : i - 1);
      },
    },
    {
      key: "ArrowDown",
      mod: false,
      when: () => subjects.length > 0,
      handler: () => {
        setFocusedIndex((i) => i >= subjects.length - 1 ? 0 : i + 1);
      },
    },
    {
      key: "Enter",
      mod: false,
      when: () => subjects.length > 0,
      handler: () => {
        const s = subjects[focusedIndex];
        if (s) navigate(`/subject/${s.id}`);
      },
    },
  ], { priority: 10 });

  if (!keyword) return <EmptyState>输入关键词开始搜索</EmptyState>;
  if (error) return <EmptyState>搜索出错: {String(error)}</EmptyState>;
  if (isLoading) return <EmptyState>搜索中…</EmptyState>;
  if (subjects.length === 0) return <EmptyState>无结果</EmptyState>;

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-1.5 text-[12px] text-fg-tertiary border-b border-line shrink-0">
        第 {page} / {totalPages} 页 · 共 {total} 条
      </div>

      <div className="flex-1 overflow-y-auto p-2.5">
        <div className="space-y-0.5">
          {subjects.map((s, i) => (
            <SubjectRow
              key={s.id}
              ref={(el) => { itemRefs.current[i] = el; }}
              subjectId={s.id}
              coverUrl={s.images?.small}
              title={s.name_cn || s.name}
              subtitle={s.name_cn ? s.name : undefined}
              selected={i === focusedIndex}
              onClick={() => setFocusedIndex(i)}
              onDoubleClick={() => navigate(`/subject/${s.id}`)}
              accessories={
                <>
                  <Meta>{SubjectTypeLabel[s.type]}</Meta>
                  {s.rating?.score ? <Rating score={s.rating.score} /> : null}
                </>
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
