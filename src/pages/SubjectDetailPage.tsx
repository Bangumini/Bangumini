import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  getSubject,
  getSubjectPersons,
  getSubjectCharacters,
  getEpisodes,
  getUserCollection,
  patchSubjectEpisodes,
  postUserCollection,
} from "@shared/api/client";
import { CollectionTypeLabel } from "@shared/api/types";
import type { CollectionType } from "@shared/api/types";
import { getUsername } from "../api/oauth";
import { ChevronLeftIcon, ExternalIcon } from "../components/icons";
import { MOD } from "../api/shortcut";

const COLLECTION_OPTIONS: { type: CollectionType; label: string; key: string }[] = [
  { type: 1, label: "想看", key: "1" },
  { type: 2, label: "看过", key: "2" },
  { type: 3, label: "在看", key: "3" },
  { type: 4, label: "搁置", key: "4" },
  { type: 5, label: "抛弃", key: "5" },
];

export default function SubjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const subjectId = Number(id);
  const [targetEp, setTargetEp] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const initialEpStatus = useRef<number | null>(null);
  const leftColumnRef = useRef<HTMLDivElement>(null);

  const { data: subject } = useQuery({
    queryKey: ["subject", subjectId],
    queryFn: () => getSubject(subjectId),
  });

  const { data: persons } = useQuery({
    queryKey: ["persons", subjectId],
    queryFn: () => getSubjectPersons(subjectId),
  });

  const { data: characters } = useQuery({
    queryKey: ["characters", subjectId],
    queryFn: () => getSubjectCharacters(subjectId),
  });

  const { data: episodeData } = useQuery({
    queryKey: ["episodes", subjectId],
    queryFn: () => getEpisodes(subjectId),
  });

  const { data: collection, refetch: refetchCollection } = useQuery({
    queryKey: ["collection", subjectId],
    queryFn: async () => {
      try {
        const uname = getUsername();
        if (!uname) return null;
        const result = await getUserCollection(uname, subjectId);
        if (initialEpStatus.current === null && result) {
          initialEpStatus.current = result.ep_status;
        }
        return result;
      } catch {
        return null;
      }
    },
  });

  const sorted = episodeData?.data?.slice().sort((a, b) => a.sort - b.sort) ?? [];
  const mainEps = sorted.filter((e) => e.type === 0);
  const totalEp = mainEps.length > 0 ? mainEps.length : (subject?.total_episodes ?? 0);
  const currentEp = collection?.ep_status ?? 0;
  const displayTarget = targetEp ?? currentEp;
  const isDirty = targetEp !== null && targetEp !== currentEp;

  async function commitProgress() {
    if (!isDirty || targetEp === null) return;
    setLoading(true);
    try {
      const from = Math.min(currentEp, targetEp);
      const to = Math.max(currentEp, targetEp);
      const ids = mainEps.slice(from, to).map((e) => e.id);
      if (ids.length > 0) {
        await patchSubjectEpisodes(subjectId, { episode_id: ids, type: targetEp > currentEp ? 2 : 0 });
      }
      await refetchCollection();
      setTargetEp(null);
    } finally {
      setLoading(false);
    }
  }

  async function setCollectionType(type: CollectionType) {
    setLoading(true);
    setPaletteOpen(false);
    try {
      await postUserCollection(subjectId, { type });
      refetchCollection();
    } finally {
      setLoading(false);
    }
  }

  const handleBack = useCallback(() => {
    const state = location.state as { fromCollections?: boolean; page?: number; focusedIndex?: number } | null;
    const currentEpStatus = collection?.ep_status ?? 0;
    const hasChanged = initialEpStatus.current !== null && initialEpStatus.current !== currentEpStatus;
    if (state?.fromCollections && hasChanged) {
      navigate("/collections", { state: { fromSubject: true, subjectId, page: state.page, focusedIndex: state.focusedIndex } });
    } else {
      navigate(-1);
    }
  }, [collection, location, navigate, subjectId]);

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // Ctrl+O: open in browser (handle early, before other checks)
      if (e.key === "o" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
          openUrl(`https://bgm.tv/subject/${subjectId}`);
        });
        return;
      }

      // Ctrl+K: command palette
      if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        setPaletteIndex(0);
        return;
      }

      // Ctrl+Enter or Enter (when not in input): copy subject name and close window
      if (e.key === "Enter" && ((e.ctrlKey || e.metaKey) || !isInput)) {
        if (!paletteOpen && !isDirty) {
          e.preventDefault();
          const name = subject?.name_cn || subject?.name || "";
          if (name) {
            navigator.clipboard.writeText(name).then(async () => {
              const { getCurrentWindow } = await import("@tauri-apps/api/window");
              await invoke("show_toast", { message: "已复制条目名" });
              getCurrentWindow().hide();
            });
          }
          return;
        }
      }

      if (paletteOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setPaletteIndex((i) => Math.min(COLLECTION_OPTIONS.length - 1, i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setPaletteIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const opt = COLLECTION_OPTIONS[paletteIndex];
          if (opt) setCollectionType(opt.type);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setPaletteOpen(false);
          return;
        }
        // Number key quick select
        const num = parseInt(e.key);
        if (num >= 1 && num <= 5) {
          e.preventDefault();
          setCollectionType(num as CollectionType);
          return;
        }
        return;
      }

      if (isInput) return;

      // Backspace or Esc: go back (Esc only reaches here when the palette is closed)
      if (e.key === "Backspace" || e.key === "Escape") {
        e.preventDefault();
        handleBack();
        return;
      }

      // ArrowUp/ArrowDown: scroll left column when no episodes or not adjusting progress
      if (totalEp <= 0 || !isDirty) {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const scrollAmount = 100;
          if (leftColumnRef.current) {
            leftColumnRef.current.scrollBy({
              top: e.key === "ArrowDown" ? scrollAmount : -scrollAmount,
              behavior: "smooth"
            });
          }
          return;
        }
      }

      if (totalEp <= 0) return;

      // ArrowRight: increment target episode
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setTargetEp((prev) => Math.min(totalEp, (prev ?? currentEp) + 1));
        return;
      }
      // ArrowLeft: decrement target episode
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setTargetEp((prev) => Math.max(0, (prev ?? currentEp) - 1));
        return;
      }
      // Enter: commit progress
      if (e.key === "Enter" && isDirty) {
        e.preventDefault();
        commitProgress();
        return;
      }
    }
    window.addEventListener("keydown", handleKeyDown, true); // Use capture phase
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [paletteOpen, paletteIndex, totalEp, currentEp, targetEp, isDirty, handleBack, subject]);

  const staffMap = new Map<string, string[]>();
  (persons ?? []).forEach((p) => {
    const role = p.relation || "其他";
    const names = staffMap.get(role) ?? [];
    names.push(p.name);
    staffMap.set(role, names);
  });

  return (
    <div className="h-screen flex flex-col text-fg bg-surface/90">
      {/* Header */}
      <header className="flex items-center gap-2 h-12 px-3 border-b border-line shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center gap-1 pl-1.5 pr-2.5 py-1 rounded-md text-fg-secondary hover:bg-hover hover:text-fg transition-colors text-[13px]"
        >
          <ChevronLeftIcon size={16} />
          返回
        </button>
        <span className="text-[13px] font-medium truncate">
          {subject?.name_cn || subject?.name || "条目详情"}
        </span>
        {loading && <span className="text-[12px] text-fg-tertiary animate-pulse">保存中…</span>}
        <button
          onClick={async () => {
            const { openUrl } = await import("@tauri-apps/plugin-opener");
            openUrl(`https://bgm.tv/subject/${subjectId}`);
          }}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-fg-secondary hover:bg-hover hover:text-fg transition-colors"
        >
          Bangumi
          <ExternalIcon size={13} />
        </button>
      </header>

      {/* Two-column body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left column: scrollable content */}
        <div ref={leftColumnRef} className="flex-1 overflow-y-auto p-5 space-y-6">
          {subject?.summary && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">简介</h3>
              <p className="text-[13px] text-fg-secondary leading-relaxed whitespace-pre-line">{subject.summary}</p>
            </section>
          )}

          {staffMap.size > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">Staff</h3>
              <div className="space-y-1.5">
                {[...staffMap].map(([role, names]) => (
                  <div key={role} className="text-[13px] leading-relaxed">
                    <span className="text-fg-tertiary">{role}: </span>
                    <span className="text-fg-secondary">{names.join(" / ")}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(characters ?? []).length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">角色 / Cast</h3>
              <div className="space-y-1.5">
                {(characters ?? []).map((ch) => (
                  <div key={ch.id} className="text-[13px] leading-relaxed">
                    <span className="text-fg">{ch.name}</span>
                    {ch.actors.length > 0 && (
                      <span className="text-fg-tertiary"> CV: {ch.actors.map((a) => a.name).join(" / ")}</span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right column: fixed info panel */}
        <div className="w-72 shrink-0 border-l border-line p-5 flex flex-col gap-4 overflow-y-auto bg-panel/40">
          {subject?.images?.large && (
            <img src={subject.images.large} alt="" className="w-full rounded-card border border-line" />
          )}

          <div className="space-y-3 text-[13px]">
            <div className="flex items-baseline gap-2">
              <span className="text-fg-tertiary">评分</span>
              <span className="text-star text-2xl font-semibold tabular-nums">
                {subject?.rating?.score?.toFixed(1) ?? "—"}
              </span>
              {subject?.rank ? <span className="text-fg-tertiary">#{subject.rank}</span> : null}
            </div>

            {subject?.date && (
              <div>
                <span className="text-fg-tertiary">放送 </span>
                <span className="text-fg-secondary">{subject.date}</span>
                {subject.air_weekday ? (
                  <span className="text-fg-tertiary ml-1">
                    ({["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][subject.air_weekday]})
                  </span>
                ) : null}
              </div>
            )}

            <div>
              <span className="text-fg-tertiary">状态 </span>
              {collection ? (
                <span className="text-accent font-medium">{CollectionTypeLabel[collection.type]}</span>
              ) : (
                <span className="text-fg-tertiary">未收藏</span>
              )}
            </div>

            {totalEp > 0 && (
              <div className="pt-1">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-fg-tertiary">进度</span>
                  {isDirty ? (
                    <span className="text-success tabular-nums">{currentEp} → {displayTarget} / {totalEp}</span>
                  ) : (
                    <span className="text-fg-secondary tabular-nums">{currentEp} / {totalEp}</span>
                  )}
                </div>
                <div className="h-1.5 rounded-full bg-elevated overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${isDirty ? "bg-success" : "bg-accent"}`}
                    style={{ width: `${Math.min(100, (displayTarget / totalEp) * 100)}%` }}
                  />
                </div>
                {isDirty && <p className="text-[12px] text-fg-tertiary mt-1.5">按 Enter 提交 · ← → 调整</p>}
                {!isDirty && totalEp > 0 && <p className="text-[12px] text-fg-tertiary mt-1.5">← → 调整进度</p>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer hints */}
      <footer className="flex items-center gap-4 h-9 px-4 border-t border-line shrink-0 bg-panel/40">
        <span className="flex items-center gap-1.5 text-fg-tertiary">
          <kbd className="inline-flex min-w-5 h-5 items-center justify-center px-1 rounded bg-elevated border border-line text-[11px] font-medium text-fg-secondary">
            {MOD} K
          </kbd>
          <span className="text-[12px]">菜单</span>
        </span>
        <span className="flex items-center gap-1.5 text-fg-tertiary">
          <kbd className="inline-flex min-w-5 h-5 items-center justify-center px-1 rounded bg-elevated border border-line text-[11px] font-medium text-fg-secondary">
            {MOD} ↵
          </kbd>
          <span className="text-[12px]">复制名称</span>
        </span>
        <span className="flex items-center gap-1.5 text-fg-tertiary">
          <kbd className="inline-flex min-w-5 h-5 items-center justify-center px-1 rounded bg-elevated border border-line text-[11px] font-medium text-fg-secondary">
            {MOD} O
          </kbd>
          <span className="text-[12px]">浏览器打开</span>
        </span>
        {(totalEp <= 0 || !isDirty) && (
          <span className="flex items-center gap-1.5 text-fg-tertiary">
            <kbd className="inline-flex min-w-5 h-5 items-center justify-center px-1 rounded bg-elevated border border-line text-[11px] font-medium text-fg-secondary">
              ↑↓
            </kbd>
            <span className="text-[12px]">滚动内容</span>
          </span>
        )}
        <span className="flex items-center gap-1.5 text-fg-tertiary">
          <kbd className="inline-flex min-w-5 h-5 items-center justify-center px-1 rounded bg-elevated border border-line text-[11px] font-medium text-fg-secondary">
            Esc
          </kbd>
          <span className="text-[12px]">返回</span>
        </span>
      </footer>

      {/* Command Palette Overlay */}
      {paletteOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setPaletteOpen(false)} />
          <div className="relative w-80 bg-elevated border border-line-strong rounded-card shadow-pop overflow-hidden">
            <div className="px-3 py-2 text-[12px] text-fg-tertiary border-b border-line">
              收藏状态 · 按数字键或回车选择
            </div>
            <div className="p-1.5">
              {COLLECTION_OPTIONS.map((opt, i) => (
                <button
                  key={opt.type}
                  onClick={() => setCollectionType(opt.type)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-[13px] text-left transition-colors ${
                    i === paletteIndex
                      ? "bg-accent text-accent-fg"
                      : collection?.type === opt.type
                        ? "bg-accent-soft text-accent"
                        : "text-fg-secondary hover:bg-hover"
                  }`}
                >
                  <kbd className={`text-[11px] w-4 ${i === paletteIndex ? "text-accent-fg/70" : "text-fg-tertiary"}`}>{opt.key}</kbd>
                  <span>{opt.label}</span>
                  {collection?.type === opt.type && (
                    <span className="ml-auto text-[11px] opacity-70">当前</span>
                  )}
                </button>
              ))}
            </div>
            <div className="px-3 py-2 text-[12px] text-fg-tertiary border-t border-line">
              ↑↓ 导航 · Enter/数字键 选择 · Esc 关闭
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
