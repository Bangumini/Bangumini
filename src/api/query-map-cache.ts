import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** 组合查询的成员变化时，按条目复用已知数据，而不是把整个 Map 当作冷缓存。 */
export function readCachedQueryMap<T>(
	client: QueryClient,
	queryKeys: readonly QueryKey[],
	subjectIds: readonly number[],
	getValueUpdatedAt?: (value: T) => number,
): Map<number, T> | undefined {
	const ids = new Set(subjectIds);
	const queries = queryKeys
		.flatMap((queryKey) => client.getQueryCache().findAll({ queryKey }))
		.sort((left, right) => left.state.dataUpdatedAt - right.state.dataUpdatedAt);
	const result = new Map<number, T>();
	const versions = new Map<number, number>();
	for (const query of queries) {
		if (!(query.state.data instanceof Map)) continue;
		for (const [subjectId, value] of query.state.data as Map<number, T>) {
			if (!ids.has(subjectId)) continue;
			// 慢组合的完成时刻不等于每个条目的获取时刻，优先使用条目自己的版本。
			const updatedAt = getValueUpdatedAt?.(value) ?? query.state.dataUpdatedAt;
			if (updatedAt >= (versions.get(subjectId) ?? Number.NEGATIVE_INFINITY)) {
				result.set(subjectId, value);
				versions.set(subjectId, updatedAt);
			}
		}
	}
	return result.size > 0 ? result : undefined;
}
