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
}) {
  if (refreshInFlight.has(refreshKey)) return;
  refreshInFlight.add(refreshKey);

  void refresh()
    .then((nextData) => {
      if (!isSamePayload(currentData, nextData)) {
        queryClient.setQueryData<T>(queryKey, nextData);
      }
    })
    .catch((error) => {
      console.warn("[stale-cache-refresh] background refresh failed", error);
    })
    .finally(() => {
      refreshInFlight.delete(refreshKey);
    });
}
