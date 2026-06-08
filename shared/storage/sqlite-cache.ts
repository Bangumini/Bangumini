import Database from "@tauri-apps/plugin-sql";
import type {
  Episode,
  PagedResponse,
  RelatedCharacter,
  RelatedPerson,
  Subject,
  SubjectSmall,
  UserCollection,
} from "@shared/api/types";

const DB_URL = "sqlite:bangumini.db";

type PayloadRow = {
  payload_json: string;
};

type ImageCacheRow = {
  local_path: string;
  updated_at: number;
};

type CacheEntryRow = {
  cache_key: string;
  payload_json: string;
};

export type CachedImageRecord = {
  remoteUrl: string;
  localPath: string;
  updatedAt: number;
};

let dbPromise: Promise<Database> | null = null;

const PLACEHOLDER_IMAGE_RE =
  /(^|[/_.-])(?:no[_\s-]?image|noimage|placeholder)([/_.-]|$)|[/_.-]default\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i;

export function isUsefulImageUrl(url?: string | null): boolean {
  if (!url) return false;
  const normalized = (() => {
    try {
      return decodeURIComponent(url);
    } catch {
      return url;
    }
  })();
  return !PLACEHOLDER_IMAGE_RE.test(normalized);
}

export function getPreferredSubjectCoverUrl(subject: Subject | SubjectSmall | null | undefined) {
  const images = subject?.images;
  if (!images) return null;
  return (
    [images.small, images.common, images.medium, images.large, images.grid].find(isUsefulImageUrl) ??
    null
  );
}

function mergeImageUrl(current: string, incoming: string): string {
  if (isUsefulImageUrl(incoming)) return incoming;
  if (isUsefulImageUrl(current)) return current;
  return incoming || current;
}

function mergeSubjectImages(current: Subject["images"], incoming: Subject["images"]) {
  return {
    large: mergeImageUrl(current?.large, incoming?.large),
    common: mergeImageUrl(current?.common, incoming?.common),
    medium: mergeImageUrl(current?.medium, incoming?.medium),
    small: mergeImageUrl(current?.small, incoming?.small),
    grid: mergeImageUrl(current?.grid, incoming?.grid),
  };
}

function mergeSubjectPreview(current: Subject | null, incoming: Subject): Subject {
  if (!current) return incoming;

  return {
    ...current,
    id: incoming.id,
    name: incoming.name || current.name,
    name_cn: incoming.name_cn || current.name_cn,
    type: incoming.type || current.type,
    images: mergeSubjectImages(current.images, incoming.images),
    summary: incoming.summary || current.summary,
    eps: incoming.eps || current.eps,
    total_episodes: incoming.total_episodes || current.total_episodes,
    rating: incoming.rating?.total ? incoming.rating : current.rating,
    rank: incoming.rank || current.rank,
    date: incoming.date || current.date,
    air_weekday: incoming.air_weekday ?? current.air_weekday,
    tags: current.tags ?? incoming.tags,
  };
}

function mergeSubjectFull(current: Subject | null, incoming: Subject): Subject {
  if (!current) return incoming;

  return {
    ...incoming,
    images: mergeSubjectImages(current.images, incoming.images),
    rating: incoming.rating?.total ? incoming.rating : current.rating,
    rank: incoming.rank || current.rank,
    air_weekday: incoming.air_weekday ?? current.air_weekday,
  };
}

async function initializeSchema(db: Database) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS subject_collections (
      username TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (username, subject_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS subject_cache_entries (
      subject_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subject_id, kind)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      cache_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS image_cache (
      remote_url TEXT PRIMARY KEY,
      local_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

async function getDatabase() {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL).then(async (db) => {
      await initializeSchema(db);
      return db;
    });
  }
  return dbPromise;
}

async function withDatabase<T>(fn: (db: Database) => Promise<T>, fallback: T): Promise<T> {
  try {
    const db = await getDatabase();
    return await fn(db);
  } catch (error) {
    console.warn("[sqlite-cache] storage unavailable", error);
    return fallback;
  }
}

function parsePayload<T>(rows: PayloadRow[]): T | null {
  const raw = rows[0]?.payload_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function subjectFromSmall(subject: SubjectSmall): Subject {
  return {
    id: subject.id,
    name: subject.name,
    name_cn: subject.name_cn,
    type: subject.type,
    images: subject.images,
    summary: subject.summary,
    eps: 0,
    total_episodes: 0,
    rating: subject.rating ?? { total: 0, count: {}, score: 0 },
    rank: subject.rank,
    date: subject.air_date,
    air_weekday: subject.air_weekday,
  };
}

function findSubjectInPayload(subjectId: number, payload: unknown): Subject | null {
  if (!payload || typeof payload !== "object") return null;

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findSubjectInPayload(subjectId, item);
      if (found) return found;
    }
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (record.id === subjectId && typeof record.name === "string") {
    if ("air_date" in record) return subjectFromSmall(record as unknown as SubjectSmall);
    return record as unknown as Subject;
  }

  if (record.subject && typeof record.subject === "object") {
    const found = findSubjectInPayload(subjectId, record.subject);
    if (found) return found;
  }

  if (Array.isArray(record.data)) {
    const found = findSubjectInPayload(subjectId, record.data);
    if (found) return found;
  }

  if (Array.isArray(record.items)) {
    const found = findSubjectInPayload(subjectId, record.items);
    if (found) return found;
  }

  return null;
}

async function readSubjectEntry<T>(subjectId: number, kind: string): Promise<T | null> {
  return withDatabase(async (db) => {
    const rows = await db.select<PayloadRow[]>(
      "SELECT payload_json FROM subject_cache_entries WHERE subject_id = $1 AND kind = $2 LIMIT 1",
      [subjectId, kind],
    );
    return parsePayload<T>(rows);
  }, null);
}

async function writeSubjectEntry(subjectId: number, kind: string, payload: unknown) {
  await withDatabase(async (db) => {
    await db.execute(
      `INSERT INTO subject_cache_entries (subject_id, kind, payload_json, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(subject_id, kind) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [subjectId, kind, JSON.stringify(payload), Date.now()],
    );
  }, undefined);
}

export async function readCachedSubject(subjectId: number): Promise<Subject | null> {
  return withDatabase(async (db) => {
    const rows = await db.select<PayloadRow[]>(
      "SELECT payload_json FROM subjects WHERE id = $1 LIMIT 1",
      [subjectId],
    );
    return parsePayload<Subject>(rows);
  }, null);
}

export async function writeCachedSubject(subject: Subject): Promise<Subject> {
  const current = await readCachedSubject(subject.id);
  const payload = mergeSubjectFull(current, subject);

  await withDatabase(async (db) => {
    await db.execute(
      `INSERT INTO subjects (id, payload_json, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(id) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [payload.id, JSON.stringify(payload), Date.now()],
    );
  }, undefined);

  return payload;
}

export async function writeCachedSubjectPreview(subject: Subject | SubjectSmall) {
  const incoming = "air_date" in subject ? subjectFromSmall(subject) : subject;
  const current = await readCachedSubject(incoming.id);
  const merged = mergeSubjectPreview(current, incoming);

  if ("air_date" in subject) {
    await writeCachedSubject(merged);
    return;
  }
  await writeCachedSubject(merged);
}

export async function writeCachedSubjectPreviews(subjects: Array<Subject | SubjectSmall>) {
  await Promise.all(subjects.map((subject) => writeCachedSubjectPreview(subject)));
}

export async function readCachedSubjectDeep(subjectId: number): Promise<Subject | null> {
  const cached = await readCachedSubject(subjectId);
  if (cached) return cached;

  return withDatabase(async (db) => {
    const rows = await db.select<CacheEntryRow[]>(
      "SELECT cache_key, payload_json FROM cache_entries",
    );

    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        const subject = findSubjectInPayload(subjectId, payload);
        if (subject) {
          await writeCachedSubject(subject);
          return subject;
        }
      } catch {
        // Ignore malformed cache entries.
      }
    }

    return null;
  }, null);
}

export async function readCachedCollection(
  username: string,
  subjectId: number,
): Promise<UserCollection | null> {
  if (!username) return null;
  return withDatabase(async (db) => {
    const rows = await db.select<PayloadRow[]>(
      "SELECT payload_json FROM subject_collections WHERE username = $1 AND subject_id = $2 LIMIT 1",
      [username, subjectId],
    );
    return parsePayload<UserCollection>(rows);
  }, null);
}

export async function writeCachedCollection(username: string, collection: UserCollection | null) {
  if (!username || !collection) return;
  await withDatabase(async (db) => {
    await db.execute(
      `INSERT INTO subject_collections (username, subject_id, payload_json, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(username, subject_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [username, collection.subject_id, JSON.stringify(collection), Date.now()],
    );
  }, undefined);
}

export async function deleteCachedCollection(username: string, subjectId: number) {
  if (!username) return;
  await withDatabase(async (db) => {
    await db.execute(
      "DELETE FROM subject_collections WHERE username = $1 AND subject_id = $2",
      [username, subjectId],
    );
  }, undefined);
}

export function readCachedEpisodes(subjectId: number): Promise<PagedResponse<Episode> | null> {
  return readSubjectEntry<PagedResponse<Episode>>(subjectId, "episodes");
}

export function writeCachedEpisodes(subjectId: number, episodes: PagedResponse<Episode>) {
  return writeSubjectEntry(subjectId, "episodes", episodes);
}

export function readCachedPersons(subjectId: number): Promise<RelatedPerson[] | null> {
  return readSubjectEntry<RelatedPerson[]>(subjectId, "persons");
}

export function writeCachedPersons(subjectId: number, persons: RelatedPerson[]) {
  return writeSubjectEntry(subjectId, "persons", persons);
}

export function readCachedCharacters(subjectId: number): Promise<RelatedCharacter[] | null> {
  return readSubjectEntry<RelatedCharacter[]>(subjectId, "characters");
}

export function writeCachedCharacters(subjectId: number, characters: RelatedCharacter[]) {
  return writeSubjectEntry(subjectId, "characters", characters);
}

export async function readCachedValue<T>(cacheKey: string): Promise<T | null> {
  return withDatabase(async (db) => {
    const rows = await db.select<PayloadRow[]>(
      "SELECT payload_json FROM cache_entries WHERE cache_key = $1 LIMIT 1",
      [cacheKey],
    );
    return parsePayload<T>(rows);
  }, null);
}

export async function readCachedValueWithLegacy<T>(
  cacheKey: string,
  readLegacy: () => T | null,
): Promise<T | null> {
  const cached = await readCachedValue<T>(cacheKey);
  if (cached) return cached;

  const legacy = readLegacy();
  if (legacy) {
    await writeCachedValue(cacheKey, legacy);
  }
  return legacy;
}

export function readLegacyHttpCache<T>(cacheKey: string): T | null {
  try {
    const raw = localStorage.getItem(`bangumini-http-${cacheKey}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { data?: T };
    return cached.data ?? null;
  } catch {
    return null;
  }
}

export async function writeCachedValue(cacheKey: string, payload: unknown) {
  await withDatabase(async (db) => {
    await db.execute(
      `INSERT INTO cache_entries (cache_key, payload_json, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(cache_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [cacheKey, JSON.stringify(payload), Date.now()],
    );
  }, undefined);
}

export async function deleteCachedValue(cacheKey: string) {
  await withDatabase(async (db) => {
    await db.execute("DELETE FROM cache_entries WHERE cache_key = $1", [cacheKey]);
  }, undefined);
}

export async function deleteCachedValuesByPrefix(cacheKeyPrefix: string) {
  await withDatabase(async (db) => {
    await db.execute("DELETE FROM cache_entries WHERE cache_key LIKE $1", [`${cacheKeyPrefix}%`]);
  }, undefined);
}

export async function deleteCachedValuesByPrefixExcept(cacheKeyPrefix: string, keepCacheKey: string) {
  await withDatabase(async (db) => {
    await db.execute(
      "DELETE FROM cache_entries WHERE cache_key LIKE $1 AND cache_key != $2",
      [`${cacheKeyPrefix}%`, keepCacheKey],
    );
  }, undefined);
}

export async function readCachedImage(remoteUrl: string): Promise<CachedImageRecord | null> {
  if (!remoteUrl) return null;
  return withDatabase(async (db) => {
    const rows = await db.select<ImageCacheRow[]>(
      "SELECT local_path, updated_at FROM image_cache WHERE remote_url = $1 LIMIT 1",
      [remoteUrl],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      remoteUrl,
      localPath: row.local_path,
      updatedAt: row.updated_at,
    };
  }, null);
}

export async function writeCachedImage(record: CachedImageRecord) {
  await withDatabase(async (db) => {
    await db.execute(
      `INSERT INTO image_cache (remote_url, local_path, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(remote_url) DO UPDATE SET
         local_path = excluded.local_path,
         updated_at = excluded.updated_at`,
      [record.remoteUrl, record.localPath, record.updatedAt],
    );
  }, undefined);
}
