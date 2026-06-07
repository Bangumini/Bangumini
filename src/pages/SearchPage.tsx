import { useEffect, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { searchSubjects } from "@shared/api/client";
import { SubjectTypeLabel } from "@shared/api/types";
import { writeCachedSubjectPreviews } from "@shared/storage/sqlite-cache";
import { SubjectRow, Rating, Meta } from "../components/SubjectRow";
import { SearchIcon } from "../components/icons";

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
  const typeFilter = searchParams.get("stype") ?? "";
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["search", keyword, typeFilter],
    queryFn: async () => {
      const result = await searchSubjects({
        keyword,
        type: typeFilter ? [parseInt(typeFilter)] : undefined,
      });
      await writeCachedSubjectPreviews(result.data);
      return result;
    },
    enabled: keyword.length > 0,
    staleTime: 30_000,
  });

  const subjects = data?.data ?? [];

  // Select the first result whenever the result set changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedIndex(0);
    itemRefs.current = [];
  }, [keyword, typeFilter]);

  useEffect(() => {
    itemRefs.current[focusedIndex]?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex, subjects.length]);

  // Keyboard navigation over results (works while the search box stays focused).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;

      // Ctrl+Enter: copy focused subject name and close window
      if (e.key === "Enter" && mod) {
        e.preventDefault();
        const s = subjects[focusedIndex];
        if (s) {
          const name = s.name_cn || s.name;
          navigator.clipboard.writeText(name).then(async () => {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await invoke("show_toast", { message: "已复制条目名" });
            getCurrentWindow().hide();
          });
        }
        return;
      }

      // When search box is empty, allow plain Left/Right for pagination
      if (!keyword && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        // Let CollectionsPage/CalendarPage handle pagination
        return;
      }

      if (mod) return; // reserved for sidebar / global shortcuts
      const count = subjects.length;
      if (count === 0) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(count - 1, i + 1));
      } else if (e.key === "Enter") {
        const s = subjects[focusedIndex];
        if (s) {
          e.preventDefault();
          navigate(`/subject/${s.id}`);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [subjects, focusedIndex, navigate, keyword]);

  if (!keyword) return <EmptyState>输入关键词开始搜索</EmptyState>;
  if (error) return <EmptyState>搜索出错: {String(error)}</EmptyState>;
  if (isLoading) return <EmptyState>搜索中…</EmptyState>;
  if (subjects.length === 0) return <EmptyState>无结果</EmptyState>;

  return (
    <div className="p-2.5 space-y-0.5">
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
  );
}
