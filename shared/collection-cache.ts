import type {
	CollectionType,
	PagedResponse,
	UserCollection,
} from "./api/types.ts";
import { isSameJsonPayload } from "./payload-equality.ts";
import type { SortedCollection } from "./sort-collections.ts";

export type CollectionPatch = Partial<
	Pick<UserCollection, "ep_status" | "type">
>;

export function applyCollectionPatch(
	collection: UserCollection,
	patch: CollectionPatch,
): UserCollection {
	return { ...collection, ...patch };
}

export function upsertCollection(
	data: PagedResponse<UserCollection>,
	collection: UserCollection,
): PagedResponse<UserCollection> {
	const index = data.data.findIndex(
		(item) => item.subject_id === collection.subject_id,
	);
	if (index >= 0) {
		const next = [...data.data];
		next[index] = collection;
		return { ...data, data: next };
	}

	return {
		...data,
		total: data.total + 1,
		data: [collection, ...data.data],
	};
}

export function removeCollection(
	data: PagedResponse<UserCollection>,
	subjectId: number,
): PagedResponse<UserCollection> {
	const index = data.data.findIndex((item) => item.subject_id === subjectId);
	if (index < 0) return data;

	const next = [...data.data];
	next.splice(index, 1);
	return {
		...data,
		total: Math.max(0, data.total - 1),
		data: next,
	};
}

export function updateCollectionListForType(
	data: PagedResponse<UserCollection> | undefined,
	collection: UserCollection,
	collectionType: CollectionType,
) {
	if (!data) return data;
	return collection.type === collectionType
		? upsertCollection(data, collection)
		: removeCollection(data, collection.subject_id);
}

export function mergeCollectionPatchIntoList({
	data,
	subjectId,
	patch,
	collectionType,
	fallbackCollection,
}: {
	data: PagedResponse<UserCollection>;
	subjectId: number;
	patch: CollectionPatch;
	collectionType: CollectionType;
	fallbackCollection?: UserCollection;
}): PagedResponse<UserCollection> {
	const index = data.data.findIndex((item) => item.subject_id === subjectId);
	const source = index >= 0 ? data.data[index] : fallbackCollection;
	if (!source) return data;

	const merged = applyCollectionPatch(source, patch);
	if (merged.type === collectionType) {
		return upsertCollection(data, merged);
	}
	return removeCollection(data, subjectId);
}

/** 保留请求期间产生的本地收藏目标，同时接受服务端的新条目元数据。 */
export function mergeConcurrentCollectionChanges({
	data,
	originalData,
	liveData,
	collectionType,
}: {
	data: PagedResponse<UserCollection>;
	originalData: PagedResponse<UserCollection>;
	liveData: PagedResponse<UserCollection>;
	collectionType: CollectionType;
}) {
	const originalById = new Map(originalData.data.map((item) => [item.subject_id, item]));
	const liveById = new Map(liveData.data.map((item) => [item.subject_id, item]));
	let next = data;
	for (const id of originalById.keys()) {
		if (!liveById.has(id)) next = removeCollection(next, id);
	}
	for (const live of liveData.data) {
		const original = originalById.get(live.subject_id);
		if (original && original.type === live.type && original.ep_status === live.ep_status) continue;
		next = mergeCollectionPatchIntoList({ data: next, subjectId: live.subject_id,
			patch: { type: live.type, ep_status: live.ep_status }, collectionType, fallbackCollection: live });
	}
	return next;
}

function isSamePayload(left: unknown, right: unknown) {
	return isSameJsonPayload(left, right);
}

/**
 * 本地（乐观任务、worker 确认）与刷新起点不一致的条目：
 * 这些条目不能用本次网络响应覆盖，也不能按响应结果持久化。
 */
export function getLocalCollectionChangeIds(
	originalData: PagedResponse<UserCollection>,
	liveData: PagedResponse<UserCollection>,
) {
	const changed = new Set<number>();
	const liveById = new Map(liveData.data.map((item) => [item.subject_id, item]));
	for (const original of originalData.data) {
		const live = liveById.get(original.subject_id);
		if (!live || live.type !== original.type || live.ep_status !== original.ep_status) {
			changed.add(original.subject_id);
		}
	}
	const originalIds = new Set(originalData.data.map((item) => item.subject_id));
	for (const live of liveData.data) {
		if (!originalIds.has(live.subject_id)) changed.add(live.subject_id);
	}
	return changed;
}

export type CollectionListDiff = {
	data: PagedResponse<UserCollection>;
	changed: boolean;
	addedIds: number[];
	changedIds: number[];
	removedIds: number[];
	/** 新增或有字段变化的条目，用于只写回受影响的行与预览。 */
	changedItems: UserCollection[];
};

/**
 * 服务端列表与当前快照的逐条对比：
 * 未变化的条目复用原对象，调用方只持久化 changedItems/removedIds。
 * complete=false（服务端只返回了首页）时不能推断删除，也不能丢掉本地多出的条目。
 */
export function diffCollectionList(
	current: PagedResponse<UserCollection> | undefined,
	incoming: PagedResponse<UserCollection>,
	{ complete = true }: { complete?: boolean } = {},
): CollectionListDiff {
	if (!current) {
		return {
			data: incoming,
			changed: incoming.data.length > 0 || incoming.total !== 0,
			addedIds: incoming.data.map((item) => item.subject_id),
			changedIds: [],
			removedIds: [],
			changedItems: [...incoming.data],
		};
	}

	const currentById = new Map(
		current.data.map((item) => [item.subject_id, item]),
	);
	const seen = new Set<number>();
	const addedIds: number[] = [];
	const changedIds: number[] = [];
	const changedItems: UserCollection[] = [];
	const data = incoming.data.map((item) => {
		seen.add(item.subject_id);
		const previous = currentById.get(item.subject_id);
		if (!previous) {
			addedIds.push(item.subject_id);
			changedItems.push(item);
			return item;
		}
		if (isSamePayload(previous, item)) return previous;
		changedIds.push(item.subject_id);
		changedItems.push(item);
		return item;
	});
	const removedIds = complete
		? current.data
				.filter((item) => !seen.has(item.subject_id))
				.map((item) => item.subject_id)
		: [];
	const mergedData = complete
		? data
		: [...data, ...current.data.filter((item) => !seen.has(item.subject_id))];
	// 只刷新首页时服务端仍可能调整顺序，成员相同也要让列表重排。
	const orderChanged =
		!complete &&
		(mergedData.length !== current.data.length ||
			mergedData.some(
				(item, index) => item.subject_id !== current.data[index]?.subject_id,
			));
	const changed =
		addedIds.length > 0 ||
		changedIds.length > 0 ||
		removedIds.length > 0 ||
		orderChanged ||
		current.total !== incoming.total;

	return {
		data: changed ? { ...incoming, data: mergedData } : current,
		changed,
		addedIds,
		changedIds,
		removedIds,
		changedItems,
	};
}

export function hasCollectionStateChanged(
	previous: readonly SortedCollection[],
	next: readonly SortedCollection[],
) {
	if (previous.length !== next.length) return true;

	const previousBySubjectId = new Map(
		previous.map((item) => [item.collection.subject_id, item.collection]),
	);
	for (const item of next) {
		const previousCollection = previousBySubjectId.get(
			item.collection.subject_id,
		);
		if (!previousCollection) return true;
		if (
			previousCollection.type !== item.collection.type ||
			previousCollection.ep_status !== item.collection.ep_status
		) {
			return true;
		}
	}
	return false;
}
