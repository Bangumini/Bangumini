import type { QueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  getEpisodes,
  getUserCollection,
  patchSubjectEpisodes,
  postUserCollection,
} from "@shared/api/client";
import type { CollectionType, Episode, PagedResponse, UserCollection } from "@shared/api/types";
import {
  completePersistentCollectionTask,
  deletePersistentCollectionTask,
  markPersistentCollectionTaskFailed,
  markPersistentCollectionTaskRunning,
  readCachedValue,
  readDuePersistentCollectionTask,
  readNextPersistentCollectionTaskRunAt,
  readPersistentCollectionTasks,
  recoverRunningPersistentCollectionTasks,
  retryPersistentCollectionTask,
  upsertPersistentCollectionTask,
  writeCachedCollection,
  writeCachedEpisodes,
  writeCachedValue,
  type PersistentCollectionTask,
  type PersistentCollectionTaskStatus,
} from "@shared/storage/sqlite-cache";

export const COLLECTION_TASK_EVENT = "bangumini:collection-task";
export const COLLECTION_TASK_QUEUE_EVENT = "bangumini:collection-task-queue";

const COLLECTIONS_CACHE_PREFIX = "collections-";
const COLLECTION_TYPES: CollectionType[] = [1, 2, 3, 4, 5];
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 30 * 60_000;

export type CollectionTaskStatus = "started" | "finished" | "failed";
export type CollectionTaskKind = "set-collection-type" | "set-progress" | "complete-progress";

type CollectionTaskBasePayload = {
  username: string;
  subjectId: number;
  subjectTitle: string;
  previousType?: CollectionType;
};

export type SetCollectionTypeTaskPayload = CollectionTaskBasePayload & {
  nextType: CollectionType;
};

export type SetProgressTaskPayload = CollectionTaskBasePayload & {
  targetEp: number;
  ensureWatching: boolean;
};

export type CompleteProgressTaskPayload = CollectionTaskBasePayload & {
  targetEp: number;
  totalEp: number;
  ensureWatching: boolean;
  markWatched: boolean;
};

export type CollectionTaskPayload =
  | SetCollectionTypeTaskPayload
  | SetProgressTaskPayload
  | CompleteProgressTaskPayload;

export type SetCollectionTypeTask = PersistentCollectionTask<SetCollectionTypeTaskPayload> & {
  kind: "set-collection-type";
  status: PersistentCollectionTaskStatus;
};

export type SetProgressTask = PersistentCollectionTask<SetProgressTaskPayload> & {
  kind: "set-progress";
  status: PersistentCollectionTaskStatus;
};

export type CompleteProgressTask = PersistentCollectionTask<CompleteProgressTaskPayload> & {
  kind: "complete-progress";
  status: PersistentCollectionTaskStatus;
};

export type CollectionTask = SetCollectionTypeTask | SetProgressTask | CompleteProgressTask;

export type CollectionTaskEventDetail = {
  taskId: string;
  status: CollectionTaskStatus;
  kind: CollectionTaskKind;
  subjectId: number;
  previousType?: CollectionType;
  nextType?: CollectionType;
};

let queryClient: QueryClient | null = null;
let workerStarted = false;
let workerRunning = false;
let retryTimer: number | null = null;

function emitCollectionTaskEvent(detail: CollectionTaskEventDetail) {
  window.dispatchEvent(new CustomEvent(COLLECTION_TASK_EVENT, { detail }));
}

function emitCollectionTaskQueueChanged() {
  window.dispatchEvent(new CustomEvent(COLLECTION_TASK_QUEUE_EVENT));
}

function isNotFoundError(error: unknown) {
  return error instanceof Error && error.message.includes("Bangumi API error 404");
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isCollectionTaskKind(kind: string): kind is CollectionTaskKind {
  return kind === "set-collection-type" || kind === "set-progress" || kind === "complete-progress";
}

function asCollectionTask(task: PersistentCollectionTask): CollectionTask | null {
  if (!isCollectionTaskKind(task.kind)) return null;
  if (!task.payload || typeof task.payload !== "object") return null;
  const payload = task.payload as Partial<CollectionTaskPayload>;
  if (typeof payload.username !== "string" || typeof payload.subjectId !== "number") return null;
  return task as CollectionTask;
}

function getTaskId(kind: CollectionTaskKind, username: string, subjectId: number) {
  return `${kind}:${username}:${subjectId}`;
}

async function getTaskIdForEnqueue(kind: CollectionTaskKind, username: string, subjectId: number) {
  const baseId = getTaskId(kind, username, subjectId);
  const tasks = await getCollectionTaskQueue();
  const existing = tasks.find((task) => task.id === baseId);
  return existing?.status === "running" ? `${baseId}:${Date.now()}` : baseId;
}

function getTaskSubjectId(task: Pick<CollectionTask, "payload">) {
  return task.payload.subjectId;
}

function getTaskPreviousType(task: CollectionTask) {
  return task.payload.previousType;
}

function getExpectedNextType(task: CollectionTask): CollectionType | undefined {
  if (task.kind === "set-collection-type") return task.payload.nextType;
  if (task.kind === "set-progress") return task.payload.ensureWatching ? 3 : undefined;
  if (task.kind === "complete-progress") return task.payload.markWatched ? 2 : 3;
  return undefined;
}

function upsertCollection(data: PagedResponse<UserCollection>, collection: UserCollection): PagedResponse<UserCollection> {
  const idx = data.data.findIndex((item) => item.subject_id === collection.subject_id);
  if (idx >= 0) {
    const next = [...data.data];
    next[idx] = collection;
    return { ...data, data: next };
  }

  return {
    ...data,
    total: data.total + 1,
    data: [collection, ...data.data],
  };
}

function removeCollection(data: PagedResponse<UserCollection>, subjectId: number): PagedResponse<UserCollection> {
  const idx = data.data.findIndex((item) => item.subject_id === subjectId);
  if (idx < 0) return data;

  const next = [...data.data];
  next.splice(idx, 1);
  return {
    ...data,
    total: Math.max(0, data.total - 1),
    data: next,
  };
}

async function syncCollectionCaches(username: string, collection: UserCollection, previousType?: CollectionType) {
  await writeCachedCollection(username, collection);
  queryClient?.setQueryData(["collection", collection.subject_id], collection);

  const currentCacheKey = `${COLLECTIONS_CACHE_PREFIX}${collection.type}-${username}`;
  const currentCached = await readCachedValue<PagedResponse<UserCollection>>(currentCacheKey);
  if (currentCached?.data) {
    await writeCachedValue(currentCacheKey, upsertCollection(currentCached, collection));
  }

  queryClient?.setQueryData<PagedResponse<UserCollection>>(
    ["collections", String(collection.type), username],
    (old) => old ? upsertCollection(old, collection) : old,
  );

  const typesToRemoveFrom = previousType && previousType !== collection.type
    ? [previousType]
    : COLLECTION_TYPES.filter((type) => type !== collection.type);

  for (const type of typesToRemoveFrom) {
    const cacheKey = `${COLLECTIONS_CACHE_PREFIX}${type}-${username}`;
    const cached = await readCachedValue<PagedResponse<UserCollection>>(cacheKey);
    if (cached?.data) {
      await writeCachedValue(cacheKey, removeCollection(cached, collection.subject_id));
    }

    queryClient?.setQueryData<PagedResponse<UserCollection>>(
      ["collections", String(type), username],
      (old) => old ? removeCollection(old, collection.subject_id) : old,
    );
  }
}

async function fetchAndSyncCollection(username: string, subjectId: number, previousType?: CollectionType) {
  const collection = await getUserCollection(username, subjectId);
  await syncCollectionCaches(username, collection, previousType);
  return collection;
}

async function fetchCollectionOrNull(username: string, subjectId: number) {
  try {
    return await getUserCollection(username, subjectId);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function ensureCollectionType(username: string, subjectId: number, nextType: CollectionType, previousType?: CollectionType) {
  const current = await fetchCollectionOrNull(username, subjectId);
  if (current?.type === nextType) {
    await syncCollectionCaches(username, current, previousType);
    return current;
  }

  await postUserCollection(subjectId, { type: nextType });
  return fetchAndSyncCollection(username, subjectId, current?.type ?? previousType);
}

async function fetchEpisodesForProgress(subjectId: number) {
  const episodes = await getEpisodes(subjectId);
  await writeCachedEpisodes(subjectId, episodes);
  return episodes;
}

function getMainEpisodeIdsBetween(episodes: Episode[], fromEp: number, toEp: number) {
  return episodes
    .slice()
    .sort((a, b) => a.sort - b.sort)
    .filter((episode) => episode.type === 0)
    .slice(fromEp, toEp)
    .map((episode) => episode.id);
}

async function executeProgressTask(payload: SetProgressTaskPayload | CompleteProgressTaskPayload) {
  const { username, subjectId, targetEp, ensureWatching, previousType } = payload;
  let collection = ensureWatching
    ? await ensureCollectionType(username, subjectId, 3, previousType)
    : await fetchCollectionOrNull(username, subjectId);

  if (!collection) {
    throw new Error("Collection is required before updating progress");
  }

  const currentEp = collection.ep_status;
  if (currentEp !== targetEp) {
    const episodes = await fetchEpisodesForProgress(subjectId);
    const from = Math.min(currentEp, targetEp);
    const to = Math.max(currentEp, targetEp);
    const episodeIds = getMainEpisodeIdsBetween(episodes.data, from, to);

    if (episodeIds.length === 0 && from !== to) {
      throw new Error("Episode list is not ready");
    }

    if (episodeIds.length > 0) {
      await patchSubjectEpisodes(subjectId, {
        episode_id: episodeIds,
        type: targetEp > currentEp ? 2 : 0,
      });
    }

    collection = await fetchAndSyncCollection(username, subjectId, collection.type);
  } else {
    await syncCollectionCaches(username, collection, previousType);
  }

  if ("markWatched" in payload && payload.markWatched && collection.type !== 2) {
    await postUserCollection(subjectId, { type: 2 });
    collection = await fetchAndSyncCollection(username, subjectId, collection.type);
  }

  return collection;
}

async function executeCollectionTask(task: CollectionTask) {
  if (task.kind === "set-collection-type") {
    return ensureCollectionType(
      task.payload.username,
      task.payload.subjectId,
      task.payload.nextType,
      task.payload.previousType,
    );
  }

  return executeProgressTask(task.payload);
}

function getRetryDelay(attemptCount: number) {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** attemptCount));
}

async function showFailureToast(task: CollectionTask) {
  const message = task.kind === "set-progress" || task.kind === "complete-progress"
    ? "进度同步失败，将稍后重试"
    : "收藏状态同步失败，将稍后重试";

  await invoke("show_toast", {
    message,
    variant: "error",
    width: 360,
    durationMs: 2200,
  }).catch(() => {});
}

async function scheduleNextWorkerRun() {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }

  const nextRunAt = await readNextPersistentCollectionTaskRunAt();
  if (nextRunAt === null) return;

  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void kickCollectionTaskWorker();
  }, Math.max(1000, nextRunAt - Date.now()));
}

export async function getCollectionTaskQueue(): Promise<CollectionTask[]> {
  const tasks = await readPersistentCollectionTasks();
  return tasks
    .map((task) => asCollectionTask(task))
    .filter((task): task is CollectionTask => task !== null);
}

export async function enqueueSetCollectionTypeTask(payload: SetCollectionTypeTaskPayload) {
  const task = await upsertPersistentCollectionTask({
    id: await getTaskIdForEnqueue("set-collection-type", payload.username, payload.subjectId),
    kind: "set-collection-type",
    payload,
  });
  emitCollectionTaskQueueChanged();
  void kickCollectionTaskWorker();
  return task ? asCollectionTask(task) : null;
}

export async function enqueueCompleteProgressTask(payload: CompleteProgressTaskPayload) {
  const task = await upsertPersistentCollectionTask({
    id: await getTaskIdForEnqueue("complete-progress", payload.username, payload.subjectId),
    kind: "complete-progress",
    payload,
  });
  emitCollectionTaskQueueChanged();
  void kickCollectionTaskWorker();
  return task ? asCollectionTask(task) : null;
}

export async function retryCollectionTask(id: string) {
  await retryPersistentCollectionTask(id);
  emitCollectionTaskQueueChanged();
  void kickCollectionTaskWorker();
}

export async function ignoreCollectionTask(id: string) {
  await deletePersistentCollectionTask(id);
  emitCollectionTaskQueueChanged();
}

export function getOptimisticCollectionPatchForSubject(
  subjectId: number,
  tasks: CollectionTask[],
): Partial<Pick<UserCollection, "ep_status" | "type">> | null {
  const patch: Partial<Pick<UserCollection, "ep_status" | "type">> = {};
  const subjectTasks = tasks
    .filter((task) => getTaskSubjectId(task) === subjectId)
    .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt);

  for (const task of subjectTasks) {
    if (task.kind === "set-collection-type") {
      patch.type = task.payload.nextType;
    } else if (task.kind === "set-progress") {
      patch.ep_status = task.payload.targetEp;
      if (task.payload.ensureWatching) patch.type = 3;
    } else if (task.kind === "complete-progress") {
      patch.ep_status = task.payload.targetEp;
      patch.type = task.payload.markWatched ? 2 : 3;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function getCollectionTaskSummary(task: CollectionTask) {
  const title = task.payload.subjectTitle || `#${task.payload.subjectId}`;
  if (task.kind === "set-collection-type") {
    return `${title} 收藏状态同步`;
  }
  if (task.kind === "complete-progress" && task.payload.markWatched) {
    return `${title} 进度与看过状态同步`;
  }
  return `${title} 观看进度同步`;
}

export async function kickCollectionTaskWorker() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (true) {
      const dueTask = await readDuePersistentCollectionTask();
      const task = dueTask ? asCollectionTask(dueTask) : null;
      if (!task) break;

      await markPersistentCollectionTaskRunning(task.id);
      emitCollectionTaskQueueChanged();
      emitCollectionTaskEvent({
        taskId: task.id,
        status: "started",
        kind: task.kind,
        subjectId: task.payload.subjectId,
        previousType: getTaskPreviousType(task),
        nextType: getExpectedNextType(task),
      });

      try {
        const collection = await executeCollectionTask(task);
        await completePersistentCollectionTask(task.id);
        emitCollectionTaskEvent({
          taskId: task.id,
          status: "finished",
          kind: task.kind,
          subjectId: task.payload.subjectId,
          previousType: getTaskPreviousType(task),
          nextType: collection.type,
        });
        emitCollectionTaskQueueChanged();
      } catch (error) {
        const delay = getRetryDelay(task.attemptCount);
        await markPersistentCollectionTaskFailed(task.id, getErrorMessage(error), Date.now() + delay);
        emitCollectionTaskEvent({
          taskId: task.id,
          status: "failed",
          kind: task.kind,
          subjectId: task.payload.subjectId,
          previousType: getTaskPreviousType(task),
          nextType: getExpectedNextType(task),
        });
        emitCollectionTaskQueueChanged();
        if (task.attemptCount === 0 || document.hasFocus()) {
          await showFailureToast(task);
        }
      }
    }
  } finally {
    workerRunning = false;
    await scheduleNextWorkerRun();
  }
}

export function startCollectionTaskWorker(client: QueryClient) {
  queryClient = client;
  if (workerStarted) {
    void kickCollectionTaskWorker();
    return;
  }

  workerStarted = true;
  window.addEventListener("online", () => {
    void kickCollectionTaskWorker();
  });
  window.addEventListener("focus", () => {
    void kickCollectionTaskWorker();
  });

  void recoverRunningPersistentCollectionTasks().then(() => {
    emitCollectionTaskQueueChanged();
    void kickCollectionTaskWorker();
  });
}
