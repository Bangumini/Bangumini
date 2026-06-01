import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getNextSeason, getNextSeasonInfo } from "@shared/api/anilist";
import type { NextSeasonItem } from "@shared/api/anilist";
import { searchAnimeSubject } from "@shared/api/client";
import { SubjectRow, Meta } from "../components/SubjectRow";

const ANILIST_WEEKDAY_CN: Record<number, string> = {
  0: "星期日", 1: "星期一", 2: "星期二", 3: "星期三",
  4: "星期四", 5: "星期五", 6: "星期六",
};

interface SeasonEntry extends NextSeasonItem {
  weekday: number | null;
  nameCn: string | null;
  bangumiId: number | null;
}

function getWeekday(item: NextSeasonItem): number | null {
  if (item.airingAt) {
    return new Date(item.airingAt * 1000).getUTCDay();
  }
  const { year, month, day } = item.startDate;
  if (year && month && day) {
    return new Date(year, month - 1, day).getDay();
  }
  return null;
}

function formatDate(item: NextSeasonItem, seasonLabel: string): string {
  const { year, month, day } = item.startDate;
  if (year && month && day) {
    return `${month}月${day}日`;
  }
  if (year && month) {
    return `${year}年${month}月`;
  }
  return seasonLabel;
}

function earliestEntryDay(entries: SeasonEntry[]): number | "tba" {
  let earliestDay: number | "tba" = "tba";
  let earliestDate: Date | null = null;
  for (const e of entries) {
    if (e.airingAt) {
      const d = new Date(e.airingAt * 1000);
      if (!earliestDate || d < earliestDate) {
        earliestDate = d;
        earliestDay = e.weekday ?? "tba";
      }
    } else if (e.startDate.year && e.startDate.month && e.startDate.day) {
      const d = new Date(e.startDate.year, e.startDate.month - 1, e.startDate.day);
      if (!earliestDate || d < earliestDate) {
        earliestDate = d;
        earliestDay = e.weekday ?? "tba";
      }
    }
  }
  return earliestDay;
}

export default function NextSeasonPage() {
  const navigate = useNavigate();
  const { label: seasonLabel } = getNextSeasonInfo();
  const [currentDay, setCurrentDay] = useState<number | "tba">(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["next-season"],
    queryFn: async () => {
      const items = await getNextSeason();

      const results = await Promise.allSettled(
        items.map(async (item) => {
          const weekday = getWeekday(item);
          const bangumiMatch = await searchAnimeSubject(item.title.native);
          return {
            ...item,
            weekday,
            nameCn: bangumiMatch?.name_cn ?? null,
            bangumiId: bangumiMatch?.id ?? null,
          } as SeasonEntry;
        }),
      );

      return results
        .filter((r): r is PromiseFulfilledResult<SeasonEntry> => r.status === "fulfilled")
        .map((r) => r.value);
    },
    staleTime: 1000 * 60 * 60 * 24,
  });

  // Group by weekday
  const groups = useMemo(() => {
    const map = new Map<number | "tba", SeasonEntry[]>();
    for (const e of entries) {
      const key = e.weekday ?? "tba";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [entries]);

  const availableDays = useMemo(() => {
    const set = new Set<number>();
    for (const k of groups.keys()) {
      if (k !== "tba") set.add(k as number);
    }
    return set;
  }, [groups]);

  const hasTba = groups.has("tba");

  // Default to day of earliest entry
  useEffect(() => {
    if (entries.length === 0) return;
    setCurrentDay(earliestEntryDay(entries));
  }, [entries.length]);

  const currentItems = groups.get(currentDay) ?? [];

  // Reset focus when day changes
  useEffect(() => {
    setFocusedIndex(0);
  }, [currentDay]);

  // Scroll focused item into view
  useEffect(() => {
    const item = itemRefs.current[focusedIndex];
    if (item) {
      item.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusedIndex]);

  // Day options for dropdown
  const dayOptions = useMemo(() => {
    const options: { label: string; value: string }[] = [];
    for (const d of [0, 1, 2, 3, 4, 5, 6]) {
      const count = (groups.get(d) ?? []).length;
      if (count > 0) {
        options.push({ label: `${ANILIST_WEEKDAY_CN[d]} · ${count}部`, value: String(d) });
      }
    }
    if (hasTba) {
      options.push({ label: `未定 · ${groups.get("tba")!.length}部`, value: "tba" });
    }
    return options;
  }, [groups, hasTba]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const itemCount = currentItems.length;
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === "Enter" && mod) {
        e.preventDefault();
        const item = currentItems[focusedIndex];
        if (item) {
          const name = item.nameCn || item.title.native;
          navigator.clipboard.writeText(name).then(async () => {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await invoke("show_toast", { message: "已复制条目名" });
            getCurrentWindow().hide();
          });
        }
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCurrentDay((d) => {
          if (d === "tba") {
            for (let i = 6; i >= 0; i--) {
              if (availableDays.has(i)) return i;
            }
            return "tba";
          }
          for (let offset = 1; offset <= 7; offset++) {
            const candidate = (d - offset + 7) % 7;
            if (availableDays.has(candidate)) return candidate;
          }
          if (hasTba) return "tba";
          return d;
        });
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        setCurrentDay((d) => {
          if (d === "tba") return "tba";
          for (let offset = 1; offset <= 7; offset++) {
            const candidate = (d + offset) % 7;
            if (availableDays.has(candidate)) return candidate;
          }
          if (hasTba) return "tba";
          return d;
        });
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
        const item = currentItems[focusedIndex];
        if (item?.bangumiId) {
          navigate(`/subject/${item.bangumiId}`);
        } else if (item) {
          import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
            openUrl(`https://anilist.co/anime/${item.id}`);
          });
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentItems, focusedIndex, navigate, availableDays, hasTba]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-1.5 text-[12px] text-fg-tertiary border-b border-line shrink-0 flex items-center gap-2">
        <span>{seasonLabel}新番 · 共 {entries.length} 部</span>
        <select
          className="appearance-none bg-elevated border border-line rounded-md pl-2.5 pr-7 py-0.5 text-[12px] text-fg-secondary hover:text-fg focus:border-accent focus:outline-none"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 0.5rem center",
            backgroundSize: "12px",
          }}
          value={String(currentDay)}
          onChange={(e) => setCurrentDay(e.target.value === "tba" ? "tba" : Number(e.target.value))}
        >
          {dayOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2.5">
        {isLoading && <p className="text-fg-tertiary text-[13px] px-1">加载中…</p>}

        {!isLoading && currentDay === "tba" && (
          <p className="text-[12px] text-fg-tertiary mb-2 px-1">播出日期未定</p>
        )}

        <div className="space-y-0.5">
          {currentItems.map((item, index) => {
            const displayName = item.nameCn || item.title.native;
            const dateStr = formatDate(item, seasonLabel);
            const timeStr = item.airingAt
              ? `${String(new Date(item.airingAt * 1000).getUTCHours()).padStart(2, "0")}:${String(new Date(item.airingAt * 1000).getUTCMinutes()).padStart(2, "0")}`
              : "";
            const subtitle = timeStr ? `${dateStr} ${timeStr}` : dateStr;

            return (
              <SubjectRow
                key={item.id}
                ref={(el) => { itemRefs.current[index] = el; }}
                coverUrl={item.cover}
                title={displayName}
                subtitle={subtitle}
                selected={index === focusedIndex}
                onClick={() => {
                  if (item.bangumiId) {
                    navigate(`/subject/${item.bangumiId}`);
                  } else {
                    import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
                      openUrl(`https://anilist.co/anime/${item.id}`);
                    });
                  }
                }}
                accessories={
                  <>
                    {item.episodes && <Meta>{item.episodes}话</Meta>}
                    <Meta>{item.format === "MOVIE" ? "剧场版" : item.format === "TV" ? "TV" : item.format}</Meta>
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
