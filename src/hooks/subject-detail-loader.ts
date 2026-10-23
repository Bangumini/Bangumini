import type { QueryClient } from "@tanstack/react-query";
import { getEpisodes, getSubject, getSubjectCharacters, getSubjectPersons, getSubjectRelations, getUserCollection } from "@shared/api/client";
import type { Episode, PagedResponse, RelatedCharacter, RelatedPerson, Subject, SubjectRelation, UserCollection } from "@shared/api/types";
import type { CollectionPatch } from "@shared/collection-cache";
import {
	deleteCachedCollection, readCachedCharacters, readCachedCharactersWithin, readCachedCollection, readCachedCollectionWithin,
	readCachedEpisodes, readCachedEpisodesWithin, readCachedPersons, readCachedPersonsWithin, readCachedRelations,
	readCachedRelationsWithin, readCachedSubjectDeep, readCachedSubjectDeepWithin, writeCachedCharacters,
	writeCachedCollection, writeCachedEpisodes, writeCachedPersons, writeCachedRelations, writeCachedSubject,
} from "@shared/storage/sqlite-cache";
import { getCollectionTaskQueue, getOptimisticCollectionPatchForSubject } from "../api/collection-tasks";

export const DETAIL_CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
export type SubjectDetailData = {
	subject: Subject | null;
	collection: UserCollection | null;
	episodes: PagedResponse<Episode> | null;
	persons: RelatedPerson[];
	characters: RelatedCharacter[];
	relations: SubjectRelation[];
	artistMap: Record<number, string | null>;
};
export type DetailResource = "subject" | "collection" | "episodes" | "persons" | "characters" | "relations";
export type DetailTimes = Record<DetailResource, number>;
export type DetailSnapshot = { data: SubjectDetailData; updatedAt: DetailTimes; collectionProtected?: boolean };

// 缓存与第三方 API 的内部测试接缝；调用页只需要 subjectId、账号和 QueryClient。
const defaultDeps = {
	readSubjectWithin: readCachedSubjectDeepWithin, readSubject: readCachedSubjectDeep,
	readCollectionWithin: readCachedCollectionWithin, readCollection: readCachedCollection,
	readEpisodesWithin: readCachedEpisodesWithin, readEpisodes: readCachedEpisodes,
	readPersonsWithin: readCachedPersonsWithin, readPersons: readCachedPersons,
	readCharactersWithin: readCachedCharactersWithin, readCharacters: readCachedCharacters,
	readRelationsWithin: readCachedRelationsWithin, readRelations: readCachedRelations,
	getSubject, getCollection: getUserCollection, getEpisodes, getPersons: getSubjectPersons,
	getCharacters: getSubjectCharacters, getRelations: getSubjectRelations,
	writeSubject: writeCachedSubject, writeCollection: writeCachedCollection, deleteCollection: deleteCachedCollection,
	writeEpisodes: writeCachedEpisodes, writePersons: writeCachedPersons,
	writeCharacters: writeCachedCharacters, writeRelations: writeCachedRelations,
	readPendingPatch: async (subjectId: number, username: string): Promise<CollectionPatch | null> =>
		getOptimisticCollectionPatchForSubject(subjectId, (await getCollectionTaskQueue()).filter(task => task.payload.username === username)),
};
export type SubjectDetailLoaderDeps = typeof defaultDeps;

export function emptySubjectDetailData(): SubjectDetailData {
	return { subject: null, collection: null, episodes: null, persons: [], characters: [], relations: [], artistMap: {} };
}

export function projectDetailCollection(base: UserCollection | null, live: UserCollection | null | undefined) {
	if (live === undefined) return base;
	if (live === null || base === null) return live;
	return base.type === live.type && base.ep_status === live.ep_status
		? base : { ...base, type: live.type, ep_status: live.ep_status };
}

async function safeLocal<T>(read: () => Promise<T | null>) {
	try { return await read(); } catch { return null; }
}

async function localValue<T>(client: QueryClient | undefined, key: readonly unknown[], fresh: () => Promise<T | null>, stale: () => Promise<T | null>) {
	const freshValue = await safeLocal(fresh);
	const disk = freshValue ?? await safeLocal(stale);
	// 必须在异步磁盘读取后重新取内存，不能返回读取期间已被 worker 替换的旧值。
	const memory = client?.getQueryData<T | null>(key);
	const memoryTime = client?.getQueryState(key)?.dataUpdatedAt ?? 0;
	const updatedAt = memory !== undefined ? memoryTime : freshValue !== null ? Date.now() : 0;
	return { value: memory !== undefined ? memory : disk, updatedAt, needsRefresh: Date.now() - updatedAt >= DETAIL_CACHE_MAX_AGE };
}

function extractArtist(subject: Subject | null) {
	const value = (key: string) => subject?.infobox?.find(item => item.key === key)?.value;
	const artist = value("艺术家");
	if (typeof artist === "string") return artist;
	const parts = [value("作词"), value("作曲")].filter((item): item is string => typeof item === "string");
	return [...new Set(parts)].join(" / ") || null;
}

export async function loadSubjectDetailData({ subjectId, username, queryClient, deps: overrides }: {
	subjectId: number; username?: string | null; queryClient?: QueryClient; deps?: Partial<SubjectDetailLoaderDeps>;
}): Promise<{ initial: DetailSnapshot; settled: Promise<DetailSnapshot> }> {
	const deps = { ...defaultDeps, ...overrides };
	const [subject, collection, episodes, persons, characters, relations] = await Promise.all([
		localValue(queryClient, ["subject", subjectId], () => deps.readSubjectWithin(subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readSubject(subjectId)),
		username ? localValue(queryClient, ["collection", subjectId], () => deps.readCollectionWithin(username, subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readCollection(username, subjectId))
			: Promise.resolve({ value: null, updatedAt: Date.now(), needsRefresh: false }),
		localValue(queryClient, ["episodes", subjectId], () => deps.readEpisodesWithin(subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readEpisodes(subjectId)),
		localValue(queryClient, ["persons", subjectId], () => deps.readPersonsWithin(subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readPersons(subjectId)),
		localValue(queryClient, ["characters", subjectId], () => deps.readCharactersWithin(subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readCharacters(subjectId)),
		localValue(queryClient, ["relations", subjectId], () => deps.readRelationsWithin(subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readRelations(subjectId)),
	]);
	const data: SubjectDetailData = { subject: subject.value, collection: collection.value, episodes: episodes.value,
		persons: persons.value ?? [], characters: characters.value ?? [], relations: relations.value ?? [], artistMap: {} };
	const updatedAt: DetailTimes = { subject: subject.updatedAt, collection: collection.updatedAt, episodes: episodes.updatedAt,
		persons: persons.updatedAt, characters: characters.updatedAt, relations: relations.updatedAt };
	const artists = new Map<number, Subject | null>();
	const readArtist = async (id: number) => {
		if (artists.has(id)) return artists.get(id) ?? null;
		const cached = queryClient?.getQueryData<Subject>(["subject", id]) ?? await safeLocal(() => deps.readSubject(id));
		artists.set(id, cached);
		return cached;
	};
	await Promise.all(data.relations.filter(item => item.type === 3).map(async item => {
		const cached = await readArtist(item.id);
		if (cached?.infobox) data.artistMap[item.id] = extractArtist(cached);
	}));
	const initialPatch = username ? await deps.readPendingPatch(subjectId, username) : null;
	if (username) data.collection = projectDetailCollection(data.collection, queryClient?.getQueryData(["collection", subjectId]));
	if (initialPatch && data.collection) data.collection = { ...data.collection, ...initialPatch };
	const baselineCollection = queryClient?.getQueryData<UserCollection | null>(["collection", subjectId]);
	const baselineRevision = queryClient?.getQueryState(["collection", subjectId])?.dataUpdateCount ?? 0;
	const shouldRefreshCollection = Boolean(username) && (collection.needsRefresh || data.collection === null);

	const settled = (async (): Promise<DetailSnapshot> => {
		const load = <T>(needs: boolean, cached: T, fetch: () => Promise<T>) => needs ? fetch() : Promise.resolve(cached);
		const results = await Promise.allSettled([
			load(subject.needsRefresh || !data.subject?.summary?.trim(), data.subject, () => deps.getSubject(subjectId)),
			load(shouldRefreshCollection, data.collection, async () => {
				try { return await deps.getCollection(username!, subjectId); }
				catch (error) {
					if (error instanceof Error && error.message.includes("Bangumi API error 404")) return null;
					throw error;
				}
			}),
			load(episodes.needsRefresh, data.episodes, () => deps.getEpisodes(subjectId)),
			load(persons.needsRefresh, data.persons, () => deps.getPersons(subjectId)),
			load(characters.needsRefresh, data.characters, () => deps.getCharacters(subjectId)),
			load(relations.needsRefresh, data.relations, () => deps.getRelations(subjectId)),
		] as const);
		const value = <T>(index: number, fallback: T): T => results[index].status === "fulfilled" ? results[index].value as T : fallback;
		const next: SubjectDetailData = { subject: value(0, data.subject), collection: value(1, data.collection),
			episodes: value(2, data.episodes), persons: value(3, data.persons), characters: value(4, data.characters),
			relations: value(5, data.relations), artistMap: {} };
		const artistWrites: Subject[] = [];
		await Promise.allSettled(next.relations.filter(item => item.type === 3).map(async item => {
			let cached = await readArtist(item.id);
			if (!cached?.infobox) {
				cached = await deps.getSubject(item.id);
				artistWrites.push(cached);
			}
			next.artistMap[item.id] = extractArtist(cached);
		}));
		const needs = [subject.needsRefresh || !data.subject?.summary?.trim(), shouldRefreshCollection,
			episodes.needsRefresh, persons.needsRefresh, characters.needsRefresh, relations.needsRefresh];
		const resources: DetailResource[] = ["subject", "collection", "episodes", "persons", "characters", "relations"];
		const times = { ...updatedAt };
		for (const [index, resource] of resources.entries()) {
			if (needs[index] && results[index].status === "fulfilled") times[resource] = Date.now();
		}
		const pendingPatch = username ? await deps.readPendingPatch(subjectId, username) : null;
		const live = queryClient?.getQueryData<UserCollection | null>(["collection", subjectId]);
		// Hook 将初版填入单条缓存不算用户变化；其他引用变化（含改回原值）必须优先。
		const liveRevision = queryClient?.getQueryState(["collection", subjectId])?.dataUpdateCount ?? 0;
		const initialWrite = baselineCollection === undefined && live === data.collection ? 1 : 0;
		const localChanged = live !== undefined && ((live !== baselineCollection && live !== data.collection)
			|| liveRevision > baselineRevision + initialWrite);
		const confirmed = next.collection;
		if (localChanged) next.collection = projectDetailCollection(next.collection, live);
		if (pendingPatch) {
			const base = next.collection ?? live ?? data.collection;
			if (base) next.collection = { ...base, ...pendingPatch };
		}
		const writes: Promise<unknown>[] = artistWrites.map(item => deps.writeSubject(item));
		if (needs[0] && results[0].status === "fulfilled" && next.subject) writes.push(deps.writeSubject(next.subject));
		if (needs[2] && results[2].status === "fulfilled" && next.episodes) writes.push(deps.writeEpisodes(subjectId, next.episodes));
		if (needs[3] && results[3].status === "fulfilled") writes.push(deps.writePersons(subjectId, next.persons));
		if (needs[4] && results[4].status === "fulfilled") writes.push(deps.writeCharacters(subjectId, next.characters));
		if (needs[5] && results[5].status === "fulfilled") writes.push(deps.writeRelations(subjectId, next.relations));
		// 有新意图时既不落盘旧响应，也不把乐观目标当成服务端确认值写入。
		if (username && needs[1] && results[1].status === "fulfilled" && !localChanged && !pendingPatch) {
			writes.push(confirmed ? deps.writeCollection(username, confirmed) : deps.deleteCollection(username, subjectId));
		}
		await Promise.allSettled(writes);
		return { data: next, updatedAt: times, collectionProtected: localChanged || Boolean(pendingPatch) };
	})();
	return { initial: { data, updatedAt }, settled };
}
