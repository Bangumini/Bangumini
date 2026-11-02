import type { QueryClient, QueryKey } from "@tanstack/react-query";

const refreshInFlight = new WeakMap<QueryClient, Map<string, Promise<boolean>>>();
const refreshListeners = new WeakMap<QueryClient, Set<() => void>>();
/** 页面自己发起的整批刷新（如 Ctrl+R）：与 SWR 任务共用完成屏障，但不参与去重。 */
const externalRefresh = new WeakMap<QueryClient, Map<string, number>>();
/** 最近一次后台刷新完成时刻：自动刷新用它判断“这一轮是否已经被别人做过”。 */
const lastRefreshAt = new WeakMap<QueryClient, Map<string, number>>();

function recordRefreshDone(client: QueryClient, key: string) {
  let recorded = lastRefreshAt.get(client);
  if (!recorded) { recorded = new Map(); lastRefreshAt.set(client, recorded); }
  recorded.set(key, Date.now());
}

/**
 * 这些缓存键最近一次刷新完成的时间戳；0 表示本次会话还没完成过。
 * 按 key 区分：在日历页完成的刷新不能让收藏页误判“已经刷过”。
 */
export function getLastCacheRefreshAt(client: QueryClient, keys: readonly string[]) {
  const recorded = lastRefreshAt.get(client);
  let latest = 0;
  for (const key of keys) latest = Math.max(latest, recorded?.get(key) ?? 0);
  return latest;
}

export function hasCacheRefreshInFlight(client: QueryClient, keys: readonly string[]) {
  return keys.some(key => refreshInFlight.get(client)?.has(key)
    || (externalRefresh.get(client)?.get(key) ?? 0) > 0);
}

/** 等待这些键当前的刷新结束；没有在跑时立即完成。 */
export function waitForCacheRefresh(client: QueryClient, keys: readonly string[]): Promise<void> {
  if (!hasCacheRefreshInFlight(client, keys)) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = subscribeCacheRefresh(client, () => {
      if (hasCacheRefreshInFlight(client, keys)) return;
      unsubscribe();
      resolve();
    });
    // 订阅前可能刚好结束，再确认一次避免永久挂起。
    if (!hasCacheRefreshInFlight(client, keys)) {
      unsubscribe();
      resolve();
    }
  });
}

export function subscribeCacheRefresh(client: QueryClient, listener: () => void) {
  let listeners = refreshListeners.get(client);
  if (!listeners) { listeners = new Set(); refreshListeners.set(client, listeners); }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyRefresh(client: QueryClient) {
  for (const listener of refreshListeners.get(client) ?? []) listener();
}

/**
 * 登记一段由调用方自行执行的刷新，返回结束回调。
 * 期间 isBackgroundRefreshing 为 true，页面的整批提交屏障会推迟到刷新结束，
 * 避免收藏与日历各自触发一次中间帧。
 */
export function beginCacheRefresh(client: QueryClient, key: string) {
  let pending = externalRefresh.get(client);
  if (!pending) { pending = new Map(); externalRefresh.set(client, pending); }
  pending.set(key, (pending.get(key) ?? 0) + 1);
  notifyRefresh(client);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const current = pending.get(key) ?? 0;
    if (current <= 1) pending.delete(key);
    else pending.set(key, current - 1);
    recordRefreshDone(client, key);
    notifyRefresh(client);
  };
}

export function isCacheStale(updatedAt: number, maxAgeMs: number, now = Date.now()) {
  return now - updatedAt > maxAgeMs;
}

function isSamePayload(currentData: unknown, nextData: unknown) {
  try {
    return JSON.stringify(currentData) === JSON.stringify(nextData);
  } catch {
    return false;
  }
}

export function refreshQueryDataIfChanged<T>({
  queryClient,
  queryKey,
  refreshKey,
  currentData,
  refresh,
  hasLocalChanges,
  mergeLatest,
}: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  refreshKey: string;
  currentData: T;
  refresh: () => Promise<T>;
  hasLocalChanges?: (liveData: T, originalData: T) => boolean;
  mergeLatest?: (nextData: T, liveData: T, originalData: T) => T;
}): Promise<boolean> {
  let pending = refreshInFlight.get(queryClient);
  if (!pending) {
    pending = new Map();
    refreshInFlight.set(queryClient, pending);
  }
  const existing = pending.get(refreshKey);
  // 每个调用者都能等待同一轮结束；切页重挂载不能误把去重请求当成已完成。
  if (existing) return existing;

  const task = refresh()
    .then((result) => {
      const liveData = queryClient.getQueryData<T>(queryKey);
      const nextData = mergeLatest && liveData !== undefined
        ? mergeLatest(result, liveData, currentData)
        : result;
      if (
        !mergeLatest &&
        liveData !== undefined &&
        !isSamePayload(liveData, currentData) &&
        !isSamePayload(liveData, nextData) &&
        (!hasLocalChanges || hasLocalChanges(liveData, currentData))
      ) {
        // 刷新期间已有本地交互更新，避免迟到的网络快照覆盖它。
        return false;
      }

      const baseData = liveData ?? currentData;
      if (!isSamePayload(baseData, nextData)) {
        queryClient.setQueryData<T>(queryKey, nextData);
        return true;
      }
      return false;
    })
    .catch((error) => {
      console.warn("[stale-cache-refresh] background refresh failed", error);
      return false;
    })
    .finally(() => {
      pending.delete(refreshKey);
      recordRefreshDone(queryClient, refreshKey);
      notifyRefresh(queryClient);
    });
  pending.set(refreshKey, task);
  notifyRefresh(queryClient);
  return task;
}
