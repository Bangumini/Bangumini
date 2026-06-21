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
}: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  refreshKey: string;
  currentData: T;
  refresh: () => Promise<T>;
}): Promise<boolean> | null {
  if (refreshInFlight.has(refreshKey)) return null;
  refreshInFlight.add(refreshKey);

  return refresh()
    .then((nextData) => {
      if (!isSamePayload(currentData, nextData)) {
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
