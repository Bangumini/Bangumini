// 收藏列表乐观更新与旧快照闪现回归测试
import assert from "node:assert/strict";
import {
	hasCollectionStateChanged,
	mergeCollectionPatchIntoList,
	mergeConcurrentCollectionChanges,
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

const serverNewMetadata = { ...watching, subject: { ...watching.subject, name_cn: "新元数据" } };
const mergedConcurrent = mergeConcurrentCollectionChanges({
  data: page([serverNewMetadata, collection(9, 3, 0)]), originalData: watchingPage,
  liveData: page([{ ...watching, ep_status: 3 }]), collectionType: 3,
});
assert.equal(mergedConcurrent.data[0].ep_status, 3);
assert.equal(mergedConcurrent.data[0].subject.name_cn, "新元数据");
assert.equal(mergedConcurrent.data.length, 2, "远端新增成员不能被本地进度投影误删");
const movedConcurrent = mergeConcurrentCollectionChanges({
  data: page([serverNewMetadata]), originalData: watchingPage, liveData: page([]), collectionType: 3,
});
assert.equal(movedConcurrent.data.length, 0, "本地移出的成员不能被旧响应重新加入");
const addedConcurrent = mergeConcurrentCollectionChanges({
  data: page([]), originalData: page([]), liveData: watchingPage, collectionType: 3,
});
assert.equal(addedConcurrent.data[0].subject_id, 7);
assert.equal(watchingPage.data[0].ep_status, 2, "投影不能污染原始快照");

console.log("collection cache: 全部通过 ✓");
