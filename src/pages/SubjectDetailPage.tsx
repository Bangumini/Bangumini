import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  getSubject,
  getSubjectRelations,
  getSubjectPersons,
  getSubjectCharacters,
  getEpisodes,
  getUserCollection,
} from "@shared/api/client";
import { CollectionTypeLabel } from "@shared/api/types";
import type { CollectionType, Episode, PagedResponse, SubjectRelation, UserCollection } from "@shared/api/types";
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
  readCachedRelations,
  readCachedRelationsWithin,
  readCachedSubjectDeepWithin,
  readCachedSubjectDeep,
  writeCachedCharacters,
  writeCachedCollection,
  writeCachedEpisodes,
  writeCachedPersons,
  writeCachedRelations,
  writeCachedSubject,
} from "@shared/storage/sqlite-cache";
import CachedImage from "../components/CachedImage";
import SyncQueueDock from "../components/SyncQueueDock";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { getSubjectTitleForCopy } from "../api/subject-title-copy";
import {
  COLLECTION_TASK_QUEUE_EVENT,
  enqueueCompleteProgressTask,
  enqueueSetCollectionTypeTask,
  getCollectionTaskQueue,
  getOptimisticCollectionPatchForSubject,
  type CollectionTask,
} from "../api/collection-tasks";

function isNotFoundError(error: unknown) {
  return error instanceof Error && error.message.includes("Bangumi API error 404");
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
const SUMMARY_ORIGINAL_MARKER = "[简介原文]";

type SummaryBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string };

function hasSummary(subject: UserCollection["subject"] | null | undefined) {
  return !!subject?.summary?.trim();
}

function normalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeForCompare(source[key]);
        return acc;
      }, {});
  }
  return value;
}

function arePayloadsEqual(left: unknown, right: unknown) {
  try {
    return JSON.stringify(normalizeForCompare(left)) === JSON.stringify(normalizeForCompare(right));
  } catch {
    return left === right;
  }
}

function setQueryDataIfChanged<T>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  next: T,
) {
  const current = queryClient.getQueryData<T>(queryKey);
  if (!arePayloadsEqual(current, next)) {
    queryClient.setQueryData(queryKey, next);
  }
}

const inFlightDetailRefreshes = new Set<string>();

function refreshQueryInBackground<T>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  loadFresh: () => Promise<T>,
) {
  const refreshKey = JSON.stringify(queryKey);
  if (inFlightDetailRefreshes.has(refreshKey)) return;
  inFlightDetailRefreshes.add(refreshKey);

  void (async () => {
    try {
      const next = await loadFresh();
      setQueryDataIfChanged(queryClient, queryKey, next);
    } catch {
      // Keep showing the stale cached data if the refresh fails.
    } finally {
      inFlightDetailRefreshes.delete(refreshKey);
    }
  })();
}

function extractArtist(infobox?: { key: string; value: string | { v: string }[] }[]): string | null {
  if (!infobox) return null;
  const artist = infobox.find((i) => i.key === "艺术家");
  if (artist && typeof artist.value === "string") return artist.value;
  const lyricist = infobox.find((i) => i.key === "作词");
  const composer = infobox.find((i) => i.key === "作曲");
  const parts: string[] = [];
  if (lyricist && typeof lyricist.value === "string") parts.push(lyricist.value);
  if (composer && typeof composer.value === "string" && (parts.length === 0 || composer.value !== parts[0])) {
    parts.push(composer.value);
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

function getSummaryBlocks(summary: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];

  for (const rawParagraph of summary.split(/\n\s*\n/)) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;

    const parts = paragraph.split(SUMMARY_ORIGINAL_MARKER);
    parts.forEach((part, index) => {
      const text = part.trim();
      if (text) blocks.push({ type: "paragraph", text });
      if (index < parts.length - 1) {
        blocks.push({ type: "heading", text: "简介原文" });
      }
    });
  }

  return blocks;
}

type ConfirmDialog = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
};

export default function SubjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const subjectId = Number(id);

  return <SubjectDetailContent key={subjectId} subjectId={subjectId} />;
}

function SubjectDetailContent({ subjectId }: { subjectId: number }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [targetEp, setTargetEp] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [collectionTasks, setCollectionTasks] = useState<CollectionTask[]>([]);
  const [loadSecondaryDetailData, setLoadSecondaryDetailData] = useState(false);
  const [loadEpisodeData, setLoadEpisodeData] = useState(false);
  const initialEpStatus = useRef<number | null>(null);
  const collectionChangedRef = useRef(false);
  const isMounted = useRef(true);
  const leftColumnRef = useRef<HTMLDivElement>(null);
  const subjectQueryKey = ["subject", subjectId] as const;
  const personsQueryKey = ["persons", subjectId] as const;
  const charactersQueryKey = ["characters", subjectId] as const;
  const episodesQueryKey = ["episodes", subjectId] as const;
  const relationsQueryKey = ["relations", subjectId] as const;

  async function fetchSubjectFromNetwork() {
    const result = await getSubject(subjectId);
    return writeCachedSubject(result);
  }

  async function fetchPersonsFromNetwork() {
    const result = await getSubjectPersons(subjectId);
    await writeCachedPersons(subjectId, result);
    return result;
  }

  async function fetchCharactersFromNetwork() {
    const result = await getSubjectCharacters(subjectId);
    await writeCachedCharacters(subjectId, result);
    return result;
  }

  async function fetchEpisodesFromNetwork() {
    const result = await getEpisodes(subjectId);
    await writeCachedEpisodes(subjectId, result);
    return result;
  }

  async function loadEpisodesFromCacheOrNetwork() {
    const cached = await readCachedEpisodesWithin(subjectId, DETAIL_CACHE_MAX_AGE);
    if (cached) return cached;

    const stale = await readCachedEpisodes(subjectId);
    if (stale) {
      refreshQueryInBackground(queryClient, episodesQueryKey, fetchEpisodesFromNetwork);
      return stale;
    }

    try {
      return await fetchEpisodesFromNetwork();
    } catch {
      return readCachedEpisodes(subjectId);
    }
  }

  async function ensureEpisodesLoaded() {
    if (isMounted.current) setLoadEpisodeData(true);
    const result = await queryClient.ensureQueryData<PagedResponse<Episode> | null>({
      queryKey: episodesQueryKey,
      queryFn: loadEpisodesFromCacheOrNetwork,
    });
    return result;
  }

  async function loadRelations(subjectId: number) {
    const cached = await readCachedRelationsWithin(subjectId, DETAIL_CACHE_MAX_AGE);
    if (cached) return cached;

    const stale = await readCachedRelations(subjectId);
    if (stale) {
      refreshQueryInBackground(queryClient, ["relations", subjectId],
        () => getSubjectRelations(subjectId).then(r => writeCachedRelations(subjectId, r)));
      return stale;
    }

    try {
      const relations = await getSubjectRelations(subjectId);
      await writeCachedRelations(subjectId, relations);
      return relations;
    } catch {
      return readCachedRelations(subjectId);
    }
  }

  async function loadArtistMap(relations: SubjectRelation[]): Promise<Record<number, string | null>> {
    const musicRelations = relations.filter((r) => r.type === 3);
    const map: Record<number, string | null> = {};

    const results = await Promise.allSettled(
      musicRelations.map(async (r) => {
        const cached = await readCachedSubjectDeep(r.id);
        if (cached?.infobox) {
          return { id: r.id, artist: extractArtist(cached.infobox) };
        }
        try {
          const subject = await getSubject(r.id);
          return { id: r.id, artist: extractArtist(subject.infobox) };
        } catch {
          return { id: r.id, artist: null };
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        map[result.value.id] = result.value.artist;
      }
    }
    return map;
  }

  const { data: subject } = useQuery({
    queryKey: subjectQueryKey,
    queryFn: async () => {
      const cached = await readCachedSubjectDeepWithin(subjectId, DETAIL_CACHE_MAX_AGE);
      if (cached) {
        if (!hasSummary(cached)) {
          refreshQueryInBackground(queryClient, subjectQueryKey, fetchSubjectFromNetwork);
        }
        return cached;
      }

      const stale = await readCachedSubjectDeep(subjectId);
      if (stale) {
        refreshQueryInBackground(queryClient, subjectQueryKey, fetchSubjectFromNetwork);
        return stale;
      }

      try {
        return fetchSubjectFromNetwork();
      } catch {
        return readCachedSubjectDeep(subjectId);
      }
    },
  });

  useEffect(() => {
    if (!subject) return;

    const timer = window.setTimeout(() => {
      setLoadSecondaryDetailData(true);
    }, 140);

    return () => window.clearTimeout(timer);
  }, [subject]);

  useEffect(() => {
    if (!subject) return;

    const timer = window.setTimeout(() => {
      setLoadEpisodeData(true);
    }, 220);

    return () => window.clearTimeout(timer);
  }, [subject]);

  const { data: persons } = useQuery({
    queryKey: personsQueryKey,
    enabled: loadSecondaryDetailData && Boolean(subject),
    queryFn: async () => {
      const cached = await readCachedPersonsWithin(subjectId, DETAIL_CACHE_MAX_AGE);
      if (cached) return cached;

      const stale = await readCachedPersons(subjectId);
      if (stale) {
        refreshQueryInBackground(queryClient, personsQueryKey, fetchPersonsFromNetwork);
        return stale;
      }

      try {
        return fetchPersonsFromNetwork();
      } catch {
        return readCachedPersons(subjectId);
      }
    },
  });

  const { data: characters } = useQuery({
    queryKey: charactersQueryKey,
    enabled: loadSecondaryDetailData && Boolean(subject),
    queryFn: async () => {
      const cached = await readCachedCharactersWithin(subjectId, DETAIL_CACHE_MAX_AGE);
      if (cached) return cached;

      const stale = await readCachedCharacters(subjectId);
      if (stale) {
        refreshQueryInBackground(queryClient, charactersQueryKey, fetchCharactersFromNetwork);
        return stale;
      }

      try {
        return fetchCharactersFromNetwork();
      } catch {
        return readCachedCharacters(subjectId);
      }
    },
  });

  const { data: episodeData } = useQuery({
    queryKey: episodesQueryKey,
    enabled: Boolean(subject) && loadEpisodeData,
    queryFn: loadEpisodesFromCacheOrNetwork,
  });

  const relationsQuery = useQuery({
    queryKey: relationsQueryKey,
    enabled: loadSecondaryDetailData && Boolean(subject),
    queryFn: () => loadRelations(subjectId),
  });

  const songGroups = useMemo(() => {
    const relations = relationsQuery.data;
    if (!relations) return null;
    const ops: SubjectRelation[] = [];
    const eds: SubjectRelation[] = [];
    const osts: SubjectRelation[] = [];
    const characterSongs: SubjectRelation[] = [];
    for (const r of relations) {
      if (r.relation === "片头曲") ops.push(r);
      else if (r.relation === "片尾曲") eds.push(r);
      else if (r.relation === "原声集") osts.push(r);
      else if (r.relation === "角色歌") characterSongs.push(r);
    }
    return { ops, eds, osts, characterSongs };
  }, [relationsQuery.data]);

  const artistMapQuery = useQuery({
    queryKey: ["relations-artists", subjectId, relationsQuery.dataUpdatedAt],
    enabled: !!relationsQuery.data && relationsQuery.data.length > 0,
    queryFn: () => loadArtistMap(relationsQuery.data!),
    staleTime: DETAIL_CACHE_MAX_AGE,
  });
  const artistMap = useMemo(() => artistMapQuery.data ?? {}, [artistMapQuery.data]);

  const collectionQueryKey = ["collection", subjectId] as const;

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const syncCollectionTasks = () => {
      void getCollectionTaskQueue().then((tasks) => {
        if (!cancelled) setCollectionTasks(tasks);
      });
    };

    syncCollectionTasks();
    window.addEventListener(COLLECTION_TASK_QUEUE_EVENT, syncCollectionTasks);
    return () => {
      cancelled = true;
      window.removeEventListener(COLLECTION_TASK_QUEUE_EVENT, syncCollectionTasks);
    };
  }, []);

  async function fetchCollectionFromNetwork() {
    const uname = getUsername();
    if (!uname) return null;

    try {
      const result = await getUserCollection(uname, subjectId);
      if (initialEpStatus.current === null && result) {
        initialEpStatus.current = result.ep_status;
      }
      await writeCachedCollection(uname, result);
      setQueryDataIfChanged(queryClient, collectionQueryKey, result);
      return result;
    } catch (error) {
      if (isNotFoundError(error)) {
        await deleteCachedCollection(uname, subjectId);
        setQueryDataIfChanged(queryClient, collectionQueryKey, null);
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

      const stale = await readCachedCollection(uname, subjectId);
      if (stale) {
        if (initialEpStatus.current === null) {
          initialEpStatus.current = stale.ep_status;
        }
        void fetchCollectionFromNetwork().catch(() => {});
        return stale;
      }

      try {
        return await fetchCollectionFromNetwork();
      } catch {
        return readCachedCollection(uname, subjectId);
      }
    },
  });

  const sorted = episodeData?.data?.slice().sort((a, b) => a.sort - b.sort) ?? [];
  const mainEps = sorted.filter((e) => e.type === 0);
  const totalEp = mainEps.length > 0 ? mainEps.length : (subject?.total_episodes || subject?.eps || 0);
  const subjectCollectionTasks = useMemo(
    () => collectionTasks.filter((task) => task.payload.subjectId === subjectId),
    [collectionTasks, subjectId],
  );
  const optimisticCollectionPatch = useMemo(
    () => getOptimisticCollectionPatchForSubject(subjectId, collectionTasks),
    [collectionTasks, subjectId],
  );
  const activeCollectionTask = subjectCollectionTasks.find((task) => task.status === "pending" || task.status === "running");
  const failedCollectionTask = subjectCollectionTasks.find((task) => task.status === "failed");
  const currentEp = optimisticCollectionPatch?.ep_status ?? collection?.ep_status ?? 0;
  const currentColType = optimisticCollectionPatch?.type ?? collection?.type;
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

  function cancelConfirmDialog() {
    const dialog = confirmDialog;
    setConfirmDialog(null);
    dialog?.onCancel?.();
  }

  function rememberQueuedTask(task: CollectionTask | null) {
    if (!task) return;
    setCollectionTasks((prev) => [
      task,
      ...prev.filter((item) => item.id !== task.id),
    ]);
  }

  function getTaskSubjectTitle() {
    return subject?.name_cn || subject?.name || `#${subjectId}`;
  }

  function confirmCanQueueProgress(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!collection) {
        setConfirmDialog({
          title: "收藏并切换到「在看」？",
          message: "更新观看进度需要先将条目以「在看」状态收藏",
          confirmLabel: "收藏",
          onCancel: () => resolve(false),
          onConfirm: () => {
            setConfirmDialog(null);
            resolve(true);
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
          onCancel: () => resolve(false),
          onConfirm: () => {
            setConfirmDialog(null);
            resolve(true);
          },
        });
        return;
      }
      resolve(true);
    });
  }

  function confirmMarkWatchedAfterSave(progressTarget: number): Promise<boolean> {
    if (progressTarget < totalEp || totalEp <= 0) return Promise.resolve(false);

    return new Promise((resolve) => {
      setConfirmDialog({
        title: "保存后标记为「看过」？",
        message: `观看进度将保存为 ${progressTarget} / ${totalEp} 集，是否在保存成功后标记为「看过」？`,
        cancelLabel: "仅保存进度",
        confirmLabel: "保存并标记",
        onCancel: () => resolve(false),
        onConfirm: () => {
          setConfirmDialog(null);
          resolve(true);
        },
      });
    });
  }

  async function commitProgress() {
    if (!isDirty || targetEp === null) return;

    const ok = await confirmCanQueueProgress();
    if (!ok) return;

    const progressTarget = targetEp;
    const markWatched = await confirmMarkWatchedAfterSave(progressTarget);
    const username = getUsername();
    if (!username) {
      await showSaveFailedToast("无法获取用户信息，请重新登录后重试");
      return;
    }

    try {
      const queued = await enqueueCompleteProgressTask({
        username,
        subjectId,
        subjectTitle: getTaskSubjectTitle(),
        targetEp: progressTarget,
        totalEp,
        ensureWatching: !collection || collection.type !== 3,
        markWatched,
        previousType: collection?.type,
      });
      rememberQueuedTask(queued);
      if (isMounted.current) {
        setTargetEp(null);
        collectionChangedRef.current = true;
      }
    } catch {
      await showSaveFailedToast("后台任务创建失败，请稍后重试");
    }
  }

  async function setCollectionType(type: CollectionType) {
    setPaletteOpen(false);
    const username = getUsername();
    if (!username) {
      await showSaveFailedToast("无法获取用户信息，请重新登录后重试");
      return;
    }

    try {
      const queued = await enqueueSetCollectionTypeTask({
        username,
        subjectId,
        subjectTitle: getTaskSubjectTitle(),
        previousType: collection?.type,
        nextType: type,
      });
      rememberQueuedTask(queued);
      if (isMounted.current) collectionChangedRef.current = true;
    } catch {
      await showSaveFailedToast("后台任务创建失败，请稍后重试");
    }
  }

  const handleBack = useCallback(() => {
    const state = location.state as { fromCollections?: boolean; fromCalendar?: boolean; fromNextSeason?: boolean; page?: number; focusedIndex?: number; currentDay?: number | "tba"; collectionType?: string; searchText?: string } | null;

    if (state?.fromCollections) {
      const params = new URLSearchParams();
      params.set("type", state.collectionType ?? "3");
      if (state.searchText) params.set("filter", state.searchText);
      navigate(`/collections?${params.toString()}`, { state: { fromSubject: true, subjectId, page: state.page, focusedIndex: state.focusedIndex } });
    } else if (state?.fromCalendar) {
      navigate("/calendar", { state: { fromSubject: true, subjectId, currentDay: state.currentDay, focusedIndex: state.focusedIndex } });
    } else if (state?.fromNextSeason) {
      navigate("/next-season", { state: { fromSubject: true, subjectId, currentDay: state.currentDay, focusedIndex: state.focusedIndex } });
    } else {
      navigate(-1);
    }
  }, [location, navigate, subjectId]);

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
        cancelConfirmDialog();
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
        const name = getSubjectTitleForCopy(subject?.name_cn || subject?.name || "");
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
        void ensureEpisodesLoaded();
        setTargetEp((prev) => Math.min(totalEp, (prev ?? currentEp) + 1));
      },
    },
    {
      key: "ArrowLeft",
      when: ({ isInput }) => !isInput && totalEp > 0,
      handler: () => {
        void ensureEpisodesLoaded();
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
      </header>

      {/* Two-column body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left column: scrollable content */}
        <div ref={leftColumnRef} className="flex-1 overflow-y-auto p-5 space-y-6">
          {subject?.summary && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">简介</h3>
              <div className="text-[13px] text-fg-secondary leading-relaxed space-y-3">
                {getSummaryBlocks(subject.summary).map((block, i) => {
                  if (block.type === "heading") {
                    return (
                      <h3
                        key={`${block.type}-${i}`}
                        className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary pt-2"
                      >
                        {block.text}
                      </h3>
                    );
                  }

                  return (
                    <p
                      key={`${block.type}-${i}`}
                      className="cursor-pointer hover:text-accent transition-colors whitespace-pre-line"
                      onClick={() => copyText(block.text)}
                    >{block.text}</p>
                  );
                })}
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

          {relationsQuery.data != null && songGroups && (
            Object.values(songGroups).some(g => g.length > 0) ? (
              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">OP/ED/OST</h3>
                <div className="space-y-3">
                  {songGroups.ops.length > 0 && (
                    <div>
                      <span className="text-[11px] text-fg-tertiary/70">片头曲 (OP)</span>
                      <div className="space-y-1 mt-1">
                        {songGroups.ops.map((r) => (
                          <div key={r.id} className="text-[13px] leading-relaxed text-fg-secondary">
                            <span
                              className="cursor-pointer hover:text-accent transition-colors"
                              onClick={() => copyText(r.name_cn || r.name)}
                            >
                              {r.name_cn || r.name}
                              {r.name_cn && r.name ? ` / ${r.name}` : ""}
                            </span>
                            {artistMap[r.id] ? (
                              <span className="text-fg-tertiary"> · {artistMap[r.id]}</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {songGroups.eds.length > 0 && (
                    <div>
                      <span className="text-[11px] text-fg-tertiary/70">片尾曲 (ED)</span>
                      <div className="space-y-1 mt-1">
                        {songGroups.eds.map((r) => (
                          <div key={r.id} className="text-[13px] leading-relaxed text-fg-secondary">
                            <span
                              className="cursor-pointer hover:text-accent transition-colors"
                              onClick={() => copyText(r.name_cn || r.name)}
                            >
                              {r.name_cn || r.name}
                              {r.name_cn && r.name ? ` / ${r.name}` : ""}
                            </span>
                            {artistMap[r.id] ? (
                              <span className="text-fg-tertiary"> · {artistMap[r.id]}</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {songGroups.osts.length > 0 && (
                    <div>
                      <span className="text-[11px] text-fg-tertiary/70">原声集 (OST)</span>
                      <div className="space-y-1 mt-1">
                        {songGroups.osts.map((r) => (
                          <div key={r.id} className="text-[13px] leading-relaxed text-fg-secondary">
                            <span
                              className="cursor-pointer hover:text-accent transition-colors"
                              onClick={() => copyText(r.name_cn || r.name)}
                            >
                              {r.name_cn || r.name}
                              {r.name_cn && r.name ? ` / ${r.name}` : ""}
                            </span>
                            {artistMap[r.id] ? (
                              <span className="text-fg-tertiary"> · {artistMap[r.id]}</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {songGroups.characterSongs.length > 0 && (
                    <div>
                      <span className="text-[11px] text-fg-tertiary/70">角色歌</span>
                      <div className="space-y-1 mt-1">
                        {songGroups.characterSongs.map((r) => (
                          <div key={r.id} className="text-[13px] leading-relaxed text-fg-secondary">
                            <span
                              className="cursor-pointer hover:text-accent transition-colors"
                              onClick={() => copyText(r.name_cn || r.name)}
                            >
                              {r.name_cn || r.name}
                              {r.name_cn && r.name ? ` / ${r.name}` : ""}
                            </span>
                            {artistMap[r.id] ? (
                              <span className="text-fg-tertiary"> · {artistMap[r.id]}</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            ) : null
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
              className="max-h-82 rounded-card border border-line self-center"
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
              {currentColType ? (
                <span className="text-accent font-medium">{CollectionTypeLabel[currentColType]}</span>
              ) : (
                <span className="text-fg-tertiary">未收藏</span>
              )}
              {activeCollectionTask && <span className="text-fg-tertiary ml-1">同步中</span>}
              {failedCollectionTask && <span className="text-danger ml-1">同步失败</span>}
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
                {!isDirty && activeCollectionTask && <p className="text-[12px] text-fg-tertiary mt-1.5">后台同步中，可返回或隐藏窗口</p>}
                {!isDirty && failedCollectionTask && <p className="text-[12px] text-danger mt-1.5">后台同步失败，将自动重试</p>}
                {!isDirty && !activeCollectionTask && !failedCollectionTask && totalEp > 0 && (
                  <p className="text-[12px] text-fg-tertiary mt-1.5">← → 调整进度</p>
                )}
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
                  {currentColType === opt.type && (
                    <span className={`text-[11px] ${i === paletteIndex ? "text-accent-fg" : "text-accent"}`}>●</span>
                  )}
                  {currentColType !== opt.type && <span className="w-3.5" />}
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
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={cancelConfirmDialog} />
          <div className="relative w-72 bg-elevated rounded-xl border border-line-strong shadow-pop overflow-hidden">
            <div className="px-4 pt-3 pb-1">
              <span className="text-[13px] font-semibold text-fg">{confirmDialog.title}</span>
            </div>
            <div className="px-4 pb-3 text-[13px] text-fg-secondary">
              {confirmDialog.message}
            </div>
            <div className="flex gap-2 px-4 pb-3">
              <button
                onClick={cancelConfirmDialog}
                className="flex-1 px-3 py-1.5 text-[13px] rounded-md text-fg-secondary hover:bg-hover transition-colors"
              >
                {confirmDialog.cancelLabel ?? "取消"}
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

      <SyncQueueDock />
    </div>
  );
}
