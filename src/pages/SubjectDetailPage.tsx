import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import type { CollectionType, UserCollection } from "@shared/api/types";
import type { QueryClient } from "@tanstack/react-query";
import {
  deleteCachedCollection,
  readCachedCharacters,
  readCachedCharactersWithin,
  readCachedCollection,
  readCachedCollectionWithin,
  readCachedEpisodes,
  readCachedEpisodesWithin,
  readCachedPersons,
  readCachedPersonsWithin,
  readCachedSubjectDeepWithin,
  readCachedSubjectDeep,
  writeCachedCharacters,
  writeCachedCollection,
  writeCachedEpisodes,
  writeCachedPersons,
  writeCachedSubject,
} from "@shared/storage/sqlite-cache";
import CachedImage from "../components/CachedImage";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

function isNotFoundError(error: unknown) {
  return error instanceof Error && error.message.includes("Bangumi API error 404");
}

function syncCollectionsCache(queryClient: QueryClient, subjectId: number) {
  const collection = queryClient.getQueryData<UserCollection>(["collection", subjectId]);
  if (!collection) return;

  queryClient.setQueriesData<{ data: UserCollection[]; total?: number }>(
    { queryKey: ["collections"], exact: false },
    (old) => {
      if (!old?.data) return old;
      const idx = old.data.findIndex((item) => item.subject_id === subjectId);
      if (idx >= 0) {
        const next = [...old.data];
        next[idx] = collection;
        return { ...old, data: next };
      }
      return {
        ...old,
        total: (old.total ?? old.data.length) + 1,
        data: [collection, ...old.data],
      };
    },
  );
}

function getAirWeekdayLabel(airWeekday?: number, date?: string) {
  const bangumiWeekdays = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  if (airWeekday && bangumiWeekdays[airWeekday]) return bangumiWeekdays[airWeekday];

  const match = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, year, month, day] = match;
  const jsWeekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return jsWeekdays[new Date(Number(year), Number(month) - 1, Number(day)).getDay()];
}
import { getUsername } from "../api/oauth";
import { ChevronLeftIcon } from "../components/icons";
import { MOD } from "../api/shortcut";

const COLLECTION_OPTIONS: { type: CollectionType; label: string; key: string }[] = [
  { type: 1, label: "想看", key: "1" },
  { type: 2, label: "看过", key: "2" },
  { type: 3, label: "在看", key: "3" },
  { type: 4, label: "搁置", key: "4" },
  { type: 5, label: "抛弃", key: "5" },
];

const DETAIL_CACHE_MAX_AGE = 1000 * 60 * 60 * 24;

function hasSummary(subject: UserCollection["subject"] | null | undefined) {
  return !!subject?.summary?.trim();
}

type ConfirmDialog = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

export default function SubjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const subjectId = Number(id);
  const queryClient = useQueryClient();
  const [targetEp, setTargetEp] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const initialEpStatus = useRef<number | null>(null);
  const collectionChangedRef = useRef(false);
  const subjectRefreshRef = useRef<number | null>(null);
  const leftColumnRef = useRef<HTMLDivElement>(null);

  const { data: subject } = useQuery({
    queryKey: ["subject", subjectId],
    queryFn: async () => {
      const cached = await readCachedSubjectDeepWithin(subjectId, DETAIL_CACHE_MAX_AGE);
      if (cached) return cached;

      try {
        const result = await getSubject(subjectId);
        return writeCachedSubject(result);
      } catch {
        return readCachedSubjectDeep(subjectId);
      }
    },
  });

  useEffect(() => {
    if (!subject || hasSummary(subject) || subjectRefreshRef.current === subjectId) return;

    let cancelled = false;
    subjectRefreshRef.current = subjectId;

    void (async () => {
      try {
        const result = await getSubject(subjectId);
        const nextSubject = await writeCachedSubject(result);
        if (!cancelled) {
          queryClient.setQueryData(["subject", subjectId], nextSubject);
        }
      } catch {
        // Keep showing the cached subject if the detail refresh fails.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [queryClient, subject, subjectId]);

  const { data: persons } = useQuery({
    queryKey: ["persons", subjectId],
    queryFn: async () => {
      const cached = await readCachedPersonsWithin(subjectId, DETAIL_CACHE_MAX_AGE);
      if (cached) return cached;

      try {
        const result = await getSubjectPersons(subjectId);
        await writeCachedPersons(subjectId, result);
        return result;
      } catch {
        return readCachedPersons(subjectId);
      }
    },
  });

  const { data: characters } = useQuery({
    queryKey: ["characters", subjectId],
    queryFn: async () => {
      const cached = await readCachedCharactersWithin(subjectId, DETAIL_CACHE_MAX_AGE);
      if (cached) return cached;

      try {
        const result = await getSubjectCharacters(subjectId);
        await writeCachedCharacters(subjectId, result);
        return result;
      } catch {
        return readCachedCharacters(subjectId);
      }
    },
  });

  const { data: episodeData } = useQuery({
    queryKey: ["episodes", subjectId],
    queryFn: async () => {
      const cached = await readCachedEpisodesWithin(subjectId, DETAIL_CACHE_MAX_AGE);
      if (cached) return cached;

      try {
        const result = await getEpisodes(subjectId);
        await writeCachedEpisodes(subjectId, result);
        return result;
      } catch {
        return readCachedEpisodes(subjectId);
      }
    },
  });

  const collectionQueryKey = ["collection", subjectId] as const;

  async function fetchCollectionFromNetwork() {
    const uname = getUsername();
    if (!uname) return null;

    try {
      const result = await getUserCollection(uname, subjectId);
      if (initialEpStatus.current === null && result) {
        initialEpStatus.current = result.ep_status;
      }
      await writeCachedCollection(uname, result);
      queryClient.setQueryData(collectionQueryKey, result);
      return result;
    } catch (error) {
      if (isNotFoundError(error)) {
        await deleteCachedCollection(uname, subjectId);
        queryClient.setQueryData(collectionQueryKey, null);
        return null;
      }
      throw error;
    }
  }

  const { data: collection } = useQuery({
    queryKey: collectionQueryKey,
    queryFn: async () => {
      const uname = getUsername();
      if (!uname) return null;

      const cached = await readCachedCollectionWithin(uname, subjectId, DETAIL_CACHE_MAX_AGE);
      if (cached) {
        if (initialEpStatus.current === null) {
          initialEpStatus.current = cached.ep_status;
        }
        return cached;
      }

      try {
        return await fetchCollectionFromNetwork();
      } catch {
        return readCachedCollection(uname, subjectId);
      }
    },
  });

  async function syncLocalCollection(patch: Partial<UserCollection>) {
    const current = queryClient.getQueryData<UserCollection | null>(collectionQueryKey) ?? collection ?? null;
    if (!current) return null;

    const next = { ...current, ...patch };
    queryClient.setQueryData(collectionQueryKey, next);

    const uname = getUsername();
    if (uname) {
      await writeCachedCollection(uname, next);
    }
    return next;
  }

  const sorted = episodeData?.data?.slice().sort((a, b) => a.sort - b.sort) ?? [];
  const mainEps = sorted.filter((e) => e.type === 0);
  const totalEp = mainEps.length > 0 ? mainEps.length : (subject?.total_episodes ?? 0);
  const currentEp = collection?.ep_status ?? 0;
  const currentColType = collection?.type;
  const displayTarget = targetEp ?? currentEp;
  const isDirty = targetEp !== null && targetEp !== currentEp;
  const airWeekdayLabel = getAirWeekdayLabel(subject?.air_weekday, subject?.date);

  const copyText = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    await invoke("show_toast", { message: "已复制内容" });
  }, []);

  async function showSaveFailedToast(message = "保存失败，请检查网络后重试") {
    await invoke("show_toast", {
      message,
      variant: "error",
      width: 360,
      durationMs: 2200,
    }).catch(() => {});
  }

  function ensureWatching(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!collection) {
        setConfirmDialog({
          title: "收藏并切换到「在看」？",
          message: "更新观看进度需要先将条目以「在看」状态收藏",
          confirmLabel: "收藏",
          onConfirm: () => {
            setConfirmDialog(null);
            postUserCollection(subjectId, { type: 3 })
              .then(() => fetchCollectionFromNetwork())
              .then(() => resolve(true))
              .catch(() => {
                void showSaveFailedToast("收藏状态保存失败，请检查网络后重试");
                resolve(false);
              });
          },
        });
        return;
      }
      const currentType = collection.type;
      if (currentType !== 3) {
        setConfirmDialog({
          title: "切换到「在看」？",
          message: `当前收藏状态为「${CollectionTypeLabel[currentType] || "其他"}」，需要切换到「在看」才能更新进度`,
          confirmLabel: "切换",
          onConfirm: () => {
            setConfirmDialog(null);
            postUserCollection(subjectId, { type: 3 })
              .then(() => fetchCollectionFromNetwork())
              .then(() => resolve(true))
              .catch(() => {
                void showSaveFailedToast("收藏状态保存失败，请检查网络后重试");
                resolve(false);
              });
          },
        });
        return;
      }
      resolve(true);
    });
  }

  async function commitProgress() {
    if (!isDirty || targetEp === null) return;

    const ok = await ensureWatching();
    if (!ok) return;

    setLoading(true);
    let saved = false;
    try {
      const from = Math.min(currentEp, targetEp);
      const to = Math.max(currentEp, targetEp);
      const ids = mainEps.slice(from, to).map((e) => e.id);
      if (ids.length === 0 && from !== to) {
        throw new Error("Episode list is not ready");
      }
      if (ids.length > 0) {
        await patchSubjectEpisodes(subjectId, { episode_id: ids, type: targetEp > currentEp ? 2 : 0 });
      }
      await fetchCollectionFromNetwork();
      await syncLocalCollection({ ep_status: targetEp, type: 3 });
      syncCollectionsCache(queryClient, subjectId);
      setTargetEp(null);
      collectionChangedRef.current = true;
      saved = true;
    } catch {
      await showSaveFailedToast("进度保存失败，请检查网络后重试");
    } finally {
      setLoading(false);
    }

    if (!saved) return;

    // After progress update, check if fully watched
    if (targetEp >= totalEp && totalEp > 0) {
      setConfirmDialog({
        title: "标记为「看过」？",
        message: `观看进度已达 ${totalEp} 集（总集数），是否标记为「看过」？`,
        confirmLabel: "标记",
        onConfirm: () => {
          setConfirmDialog(null);
          postUserCollection(subjectId, { type: 2 })
            .then(() => {
              fetchCollectionFromNetwork().then(() => syncCollectionsCache(queryClient, subjectId));
              collectionChangedRef.current = true;
            })
            .catch(() => {
              void showSaveFailedToast("收藏状态保存失败，请检查网络后重试");
            });
        },
      });
    }
  }

  async function setCollectionType(type: CollectionType) {
    setLoading(true);
    setPaletteOpen(false);
    try {
      await postUserCollection(subjectId, { type });
      await fetchCollectionFromNetwork();
      syncCollectionsCache(queryClient, subjectId);
      collectionChangedRef.current = true;
    } catch {
      await showSaveFailedToast("收藏状态保存失败，请检查网络后重试");
    } finally {
      setLoading(false);
    }
  }

  const handleBack = useCallback(() => {
    const state = location.state as { fromCollections?: boolean; page?: number; focusedIndex?: number } | null;
    const currentEpStatus = collection?.ep_status ?? 0;
    const hasChanged = collectionChangedRef.current || (initialEpStatus.current !== null && initialEpStatus.current !== currentEpStatus);
    if (state?.fromCollections && hasChanged) {
      navigate("/collections", { state: { fromSubject: true, subjectId, page: state.page, focusedIndex: state.focusedIndex } });
    } else {
      navigate(-1);
    }
  }, [collection, location, navigate, subjectId]);

  // Global keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: "o",
      mod: true,
      stopPropagation: true,
      handler: () => {
        import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
          openUrl(`https://bgm.tv/subject/${subjectId}`);
        });
      },
    },
    {
      key: "Enter",
      when: () => Boolean(confirmDialog),
      handler: () => {
        confirmDialog?.onConfirm();
      },
    },
    {
      key: "Escape",
      when: () => Boolean(confirmDialog),
      handler: () => {
        setConfirmDialog(null);
      },
    },
    {
      when: () => Boolean(confirmDialog),
      preventDefault: false,
      handler: () => {},
    },
    {
      key: "k",
      mod: true,
      handler: () => {
        const idx = COLLECTION_OPTIONS.findIndex((o) => o.type === (currentColType ?? 3));
        setPaletteOpen((prev) => !prev);
        setPaletteIndex(idx >= 0 ? idx : 2); // default to "在看" (index 2)
      },
    },
    {
      key: "Enter",
      when: ({ mod, isInput }) => (mod || !isInput) && !paletteOpen && !isDirty,
      handler: () => {
        const name = subject?.name_cn || subject?.name || "";
        if (name) {
          navigator.clipboard.writeText(name).then(async () => {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await invoke("show_toast", { message: "已复制条目名" });
            getCurrentWindow().hide();
          });
        }
      },
    },
    {
      key: "ArrowDown",
      when: () => paletteOpen,
      handler: () => {
        setPaletteIndex((i) => Math.min(COLLECTION_OPTIONS.length - 1, i + 1));
      },
    },
    {
      key: "ArrowUp",
      when: () => paletteOpen,
      handler: () => {
        setPaletteIndex((i) => Math.max(0, i - 1));
      },
    },
    {
      key: "Enter",
      when: () => paletteOpen,
      handler: () => {
        const opt = COLLECTION_OPTIONS[paletteIndex];
        if (opt) setCollectionType(opt.type);
      },
    },
    {
      key: "Escape",
      when: () => paletteOpen,
      handler: () => {
        setPaletteOpen(false);
      },
    },
    {
      key: ["1", "2", "3", "4", "5"],
      when: () => paletteOpen,
      handler: ({ event }) => {
        setCollectionType(parseInt(event.key) as CollectionType);
      },
    },
    {
      when: () => paletteOpen,
      preventDefault: false,
      handler: () => {},
    },
    {
      key: ["Backspace", "Escape"],
      when: ({ isInput }) => !isInput,
      handler: () => {
        handleBack();
      },
    },
    {
      key: ["ArrowUp", "ArrowDown"],
      when: ({ isInput }) => !isInput && (totalEp <= 0 || !isDirty),
      handler: ({ event }) => {
        const scrollAmount = 100;
        if (leftColumnRef.current) {
          leftColumnRef.current.scrollBy({
            top: event.key === "ArrowDown" ? scrollAmount : -scrollAmount,
            behavior: "smooth",
          });
        }
      },
    },
    {
      key: "ArrowRight",
      when: ({ isInput }) => !isInput && totalEp > 0,
      handler: () => {
        setTargetEp((prev) => Math.min(totalEp, (prev ?? currentEp) + 1));
      },
    },
    {
      key: "ArrowLeft",
      when: ({ isInput }) => !isInput && totalEp > 0,
      handler: () => {
        setTargetEp((prev) => Math.max(0, (prev ?? currentEp) - 1));
      },
    },
    {
      key: "Enter",
      when: ({ isInput }) => !isInput && totalEp > 0 && isDirty,
      handler: () => {
        commitProgress();
      },
    },
  ], { capture: true, priority: 10 });

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
        {loading && <span className="text-[12px] text-fg-tertiary animate-pulse ml-auto">保存中…</span>}
      </header>

      {/* Two-column body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left column: scrollable content */}
        <div ref={leftColumnRef} className="flex-1 overflow-y-auto p-5 space-y-6">
          {subject?.summary && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">简介</h3>
              <div className="text-[13px] text-fg-secondary leading-relaxed space-y-3">
                {subject.summary.split(/\n\s*\n/).filter(Boolean).map((para, i) => (
                  <p
                    key={i}
                    className="cursor-pointer hover:text-accent transition-colors whitespace-pre-line"
                    onClick={() => copyText(para.trim())}
                  >{para.trim()}</p>
                ))}
              </div>
            </section>
          )}

          {staffMap.size > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">Staff</h3>
              <div className="space-y-1.5">
                {[...staffMap].map(([role, names]) => (
                  <div key={role} className="text-[13px] leading-relaxed">
                    <span className="text-fg-tertiary">{role}: </span>
                    <span className="text-fg-secondary">
                      {names.map((name, i) => (
                        <span key={name}>
                          {i > 0 && <span className="text-fg-tertiary/50"> / </span>}
                          <span
                            className="cursor-pointer hover:text-accent transition-colors"
                            onClick={() => copyText(name)}
                          >{name}</span>
                        </span>
                      ))}
                    </span>
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
                    <span
                      className="text-fg cursor-pointer hover:text-accent transition-colors"
                      onClick={() => copyText(ch.name)}
                    >{ch.name}</span>
                    {ch.actors.length > 0 && (
                      <span className="text-fg-tertiary">
                        {" CV: "}
                        {ch.actors.map((a, i) => (
                          <span key={a.name}>
                            {i > 0 && <span>/ </span>}
                            <span
                              className="cursor-pointer hover:text-accent transition-colors"
                              onClick={() => copyText(a.name)}
                            >{a.name}</span>
                          </span>
                        ))}
                      </span>
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
            <CachedImage
              src={subject.images.large}
              alt=""
              loading="eager"
              className="w-full rounded-card border border-line"
            />
          )}

          <div className="space-y-3 text-[13px]">
            <div className="flex items-baseline gap-2">
              <span className="text-fg-tertiary">评分</span>
              <span
                className="text-star text-2xl font-semibold tabular-nums cursor-pointer hover:text-accent transition-colors"
                onClick={() => {
                  const score = subject?.rating?.score?.toFixed(1);
                  if (score) copyText(score);
                }}
              >
                {subject?.rating?.score?.toFixed(1) ?? "—"}
              </span>
              {subject?.rank ? <span className="text-fg-tertiary">#{subject.rank}</span> : null}
            </div>

            {subject?.date && (
              <div>
                <span className="text-fg-tertiary">放送 </span>
                <span
                  className="text-fg-secondary cursor-pointer hover:text-accent transition-colors"
                  onClick={() => copyText(subject.date)}
                >{subject.date}</span>
                {airWeekdayLabel ? (
                  <span className="text-fg-tertiary ml-1">
                    ({airWeekdayLabel})
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
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[25vh]">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setPaletteOpen(false)} />
          <div className="relative w-64 bg-elevated rounded-xl border border-line-strong shadow-pop overflow-hidden">
            <div className="px-4 pt-3 pb-2">
              <span className="text-[12px] font-semibold text-fg">收藏状态</span>
            </div>
            <div className="px-2 pb-1">
              {COLLECTION_OPTIONS.map((opt, i) => (
                <button
                  key={opt.type}
                  onClick={() => setCollectionType(opt.type)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] text-left transition-colors ${
                    i === paletteIndex
                      ? "bg-accent text-accent-fg"
                      : "text-fg-secondary hover:bg-hover"
                  }`}
                >
                  <kbd className={`text-[11px] w-4 text-center ${i === paletteIndex ? "text-accent-fg/70" : "text-fg-tertiary"}`}>{opt.key}</kbd>
                  {collection?.type === opt.type && (
                    <span className={`text-[11px] ${i === paletteIndex ? "text-accent-fg" : "text-accent"}`}>●</span>
                  )}
                  {collection?.type !== opt.type && <span className="w-3.5" />}
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
            <div className="px-3 py-1.5 text-[11px] text-fg-tertiary border-t border-line/50">
              ↑↓ 导航 · Enter/数字键 选择 · Esc 关闭
            </div>
          </div>
        </div>
      )}

      {/* Confirm Dialog */}
      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[30vh]">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setConfirmDialog(null)} />
          <div className="relative w-72 bg-elevated rounded-xl border border-line-strong shadow-pop overflow-hidden">
            <div className="px-4 pt-3 pb-1">
              <span className="text-[13px] font-semibold text-fg">{confirmDialog.title}</span>
            </div>
            <div className="px-4 pb-3 text-[13px] text-fg-secondary">
              {confirmDialog.message}
            </div>
            <div className="flex gap-2 px-4 pb-3">
              <button
                onClick={() => setConfirmDialog(null)}
                className="flex-1 px-3 py-1.5 text-[13px] rounded-md text-fg-secondary hover:bg-hover transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmDialog.onConfirm}
                className="flex-1 px-3 py-1.5 text-[13px] font-medium bg-accent text-accent-fg rounded-md hover:opacity-90 transition-opacity"
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
