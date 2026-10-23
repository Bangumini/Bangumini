import { useEffect, useState } from "react";
import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { getUsername } from "../api/oauth";
import { emptySubjectDetailData, loadSubjectDetailData, projectDetailCollection, type DetailResource, type DetailSnapshot, type SubjectDetailData } from "./subject-detail-loader";

const jobs = new WeakMap<QueryClient, Map<string, ReturnType<typeof loadSubjectDetailData>>>();
function loadOnce(subjectId: number, username: string | null, client: QueryClient) {
	let pending = jobs.get(client);
	if (!pending) { pending = new Map(); jobs.set(client, pending); }
	const key = JSON.stringify([username, subjectId]);
	const previous = pending.get(key);
	if (previous) return previous;
	const job = loadSubjectDetailData({ subjectId, username, queryClient: client });
	pending.set(key, job);
	const remove = () => { if (pending.get(key) === job) pending.delete(key); };
	void job.then(result => result.settled).then(remove, remove);
	return job;
}

function sameData(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
const resources: DetailResource[] = ["subject", "collection", "episodes", "persons", "characters", "relations"];

export function useSubjectDetailData(subjectId: number, queryClient: QueryClient) {
	const username = getUsername();
	const [data, setData] = useState<SubjectDetailData>(emptySubjectDetailData);
	useEffect(() => {
		let cancelled = false;
		let published = false;
		let publishing = false;
		let collectionChanged = false;
		const collectionKey = ["collection", subjectId] as const;
		const latestCollection = () => queryClient.getQueryData<SubjectDetailData["collection"]>(collectionKey);
		const unsubscribe = queryClient.getQueryCache().subscribe(event => {
			if (cancelled || publishing || event.type !== "updated" || event.action.type !== "success") return;
			if (event.query.queryKey[0] !== "collection" || event.query.queryKey[1] !== subjectId) return;
			collectionChanged = true;
			if (!published) return;
			const live = latestCollection();
			setData(current => {
				const collection = projectDetailCollection(current.collection, live);
				return collection === current.collection ? current : { ...current, collection };
			});
		});
		function publish(snapshot: DetailSnapshot, initial: boolean) {
			let next = snapshot.data;
			if (initial || collectionChanged) next = { ...next, collection: projectDetailCollection(next.collection, latestCollection()) };
			publishing = true;
			notifyManager.batch(() => {
				for (const resource of resources) {
					// worker 拥有其单条完整记录；只投影显示，不以旧响应替换其元数据或新鲜度。
					if (!initial && resource === "collection" && (collectionChanged || snapshot.collectionProtected)) continue;
					const key = [resource, subjectId] as const;
					const value = next[resource];
					if (initial && queryClient.getQueryData(key) !== undefined) continue;
					const current = queryClient.getQueryData(key);
					const equal = sameData(current, value);
					if (!equal || snapshot.updatedAt[resource] > (queryClient.getQueryState(key)?.dataUpdatedAt ?? 0)) {
						queryClient.setQueryData(key, equal ? current : value, { updatedAt: snapshot.updatedAt[resource] });
					}
				}
			});
			publishing = false;
			published = true;
			setData(current => sameData(current, next) ? current : next);
		}
		void loadOnce(subjectId, username, queryClient).then(async result => {
			if (!cancelled) publish(result.initial, true);
			const next = await result.settled;
			if (!cancelled) publish(next, false);
		}).catch(() => {
			// 各资源独立降级；未知加载错误也不得撤掉已经发布的本地首屏。
		});
		return () => { cancelled = true; unsubscribe(); };
	}, [subjectId, username, queryClient]);
	return data;
}
