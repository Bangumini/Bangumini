import type {
	CollectionType,
	PagedResponse,
	UserCollection,
} from "./api/types";
import type { SortedCollection } from "./sort-collections";

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
