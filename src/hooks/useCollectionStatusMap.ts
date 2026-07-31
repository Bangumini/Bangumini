import { useQuery } from "@tanstack/react-query";
import { getUsername } from "../api/oauth";
import { readAllCachedCollections } from "@shared/storage/sqlite-cache";
import type { CollectionType } from "@shared/api/types";

/**
 * 从 SQLite 读取用户全部收藏，构建 subjectId → CollectionType 映射。
 * 不依赖 React Query 缓存（避免只缓存过部分 type），
 * 通过 useQuery 订阅 invalidate 事件实现实时更新。
 */
export function useCollectionStatusMap(): Map<number, CollectionType> {
	const uname = getUsername();

	const { data: map } = useQuery({
		queryKey: ["collection-status-map", uname],
		queryFn: async () => {
			const collections = await readAllCachedCollections(uname);
			const m = new Map<number, CollectionType>();
			for (const col of collections) {
				if (!m.has(col.subject_id)) {
					m.set(col.subject_id, col.type);
				}
			}
			return m;
		},
		enabled: Boolean(uname),
		staleTime: 30_000, // 30s 内命中缓存，减少 SQLite 读取
		gcTime: 5 * 60_000,
	});

	return map ?? new Map();
}
