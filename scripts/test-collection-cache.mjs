// 收藏列表乐观更新与旧快照闪现回归测试
import assert from "node:assert/strict";
import {
	hasCollectionStateChanged,
	mergeCollectionPatchIntoList,
	updateCollectionListForType,
} from "../shared/collection-cache.ts";

function collection(subjectId, type, epStatus) {
	return {
		subject_id: subjectId,
		type,
		ep_status: epStatus,
		subject: {
			id: subjectId,
			name: `Subject ${subjectId}`,
			name_cn: `条目 ${subjectId}`,
		},
	};
}

function page(data) {
	return { data, total: data.length, limit: data.length, offset: 0 };
}

const watching = collection(7, 3, 2);
const watched = { ...watching, type: 2 };
const watchingPage = page([watching]);
const watchedPage = page([]);

const removedFromWatching = updateCollectionListForType(
	watchingPage,
	watched,
	3,
);
assert.equal(removedFromWatching.data.length, 0);
assert.equal(removedFromWatching.total, 0);

const insertedIntoWatched = updateCollectionListForType(
	watchedPage,
	watched,
	2,
);
assert.equal(insertedIntoWatched.data[0].subject_id, 7);
assert.equal(insertedIntoWatched.total, 1);

const progressed = mergeCollectionPatchIntoList({
	data: watchingPage,
	subjectId: 7,
	patch: { ep_status: 3 },
	collectionType: 3,
});
assert.equal(progressed.data[0].ep_status, 3);
assert.equal(progressed.data[0].type, 3);

const projectedIntoEmptyList = mergeCollectionPatchIntoList({
	data: watchedPage,
	subjectId: 7,
	patch: { type: 2, ep_status: 3 },
	collectionType: 2,
	fallbackCollection: watching,
});
assert.equal(projectedIntoEmptyList.data[0].subject_id, 7);
assert.equal(projectedIntoEmptyList.data[0].type, 2);

const oldSorted = [
	{ collection: watching, group: "airing_caught", weekday: 5, airedEp: 2 },
];
const changedProgressSorted = [
	{
		collection: { ...watching, ep_status: 3 },
		group: "airing_not_caught",
		weekday: 5,
		airedEp: 4,
	},
];
assert.equal(hasCollectionStateChanged(oldSorted, changedProgressSorted), true);

const changedScheduleOnlySorted = [
	{ collection: watching, group: "airing_not_caught", weekday: 5, airedEp: 3 },
];
assert.equal(hasCollectionStateChanged(oldSorted, changedScheduleOnlySorted), false);

console.log("collection cache: 全部通过 ✓");
