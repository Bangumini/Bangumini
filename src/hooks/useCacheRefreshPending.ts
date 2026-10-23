import { useCallback, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { hasCacheRefreshInFlight, subscribeCacheRefresh } from "../api/stale-cache-refresh";

// SWR 的 Query 已返回缓存时 isFetching 为 false；跨页共享任务仍必须纳入完成屏障。
export function useCacheRefreshPending(queryClient: QueryClient, keys: readonly string[]) {
	const subscribe = useCallback((listener: () => void) => subscribeCacheRefresh(queryClient, listener), [queryClient]);
	const getSnapshot = useCallback(() => hasCacheRefreshInFlight(queryClient, keys), [queryClient, keys]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
