import type { QueryClient, QueryKey } from "@tanstack/react-query";

const refreshInFlight = new Set<string>();

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
}: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  refreshKey: string;
  currentData: T;
  refresh: () => Promise<T>;
  hasLocalChanges?: (liveData: T, originalData: T) => boolean;
}): Promise<boolean> | null {
  if (refreshInFlight.has(refreshKey)) return null;
  refreshInFlight.add(refreshKey);

  return refresh()
    .then((nextData) => {
      const liveData = queryClient.getQueryData<T>(queryKey);
      if (
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
      refreshInFlight.delete(refreshKey);
    });
}
