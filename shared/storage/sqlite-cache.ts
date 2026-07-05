import Database from "@tauri-apps/plugin-sql";
import type {
  Episode,
  PagedResponse,
  RelatedCharacter,
  RelatedPerson,
  Subject,
  SubjectRelation,
  SubjectSmall,
  UserCollection,
} from "@shared/api/types";

const DB_URL = "sqlite:bangumini.db";

type PayloadRow = {
  payload_json: string;
};

type TimedPayloadRow = PayloadRow & {
  updated_at: number;
  accessed_at?: number | null;
};

type ImageCacheRow = {
  local_path: string;
  updated_at: number;
  accessed_at?: number | null;
};

type CacheEntryRow = {
  cache_key: string;
  payload_json: string;
  updated_at: number;
  accessed_at?: number | null;
};

export type CachedValueEntry<T> = {
  payload: T;
  updatedAt: number;
  accessedAt: number;
};

export type CachedImageRecord = {
  remoteUrl: string;
  localPath: string;
  updatedAt: number;
};

let dbPromise: Promise<Database> | null = null;
export const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 100;

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

async function ensureAccessedAtColumn(db: Database, tableName: string) {
  const columns = await db.select<Array<{ name: string }>>(`PRAGMA table_info(${tableName})`);
  if (columns.some((column) => column.name === "accessed_at")) return;
  await db.execute(`ALTER TABLE ${tableName} ADD COLUMN accessed_at INTEGER NOT NULL DEFAULT 0`);
  await db.execute(`UPDATE ${tableName} SET accessed_at = updated_at WHERE accessed_at = 0`);
}

async function initializeSchema(db: Database) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS subject_collections (
      username TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      PRIMARY KEY (username, subject_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS subject_cache_entries (
      subject_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      PRIMARY KEY (subject_id, kind)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      cache_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS image_cache (
      remote_url TEXT PRIMARY KEY,
      local_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `);

  await ensureAccessedAtColumn(db, "subjects");
  await ensureAccessedAtColumn(db, "subject_collections");
  await ensureAccessedAtColumn(db, "subject_cache_entries");
  await ensureAccessedAtColumn(db, "cache_entries");
  await ensureAccessedAtColumn(db, "image_cache");
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

function getAccessedAt(row: { updated_at: number; accessed_at?: number | null }) {
  return row.accessed_at ?? row.updated_at;
}

function isFresh(row: { updated_at: number; accessed_at?: number | null }, now = Date.now()) {
  return now - getAccessedAt(row) <= CACHE_TTL_MS;
}

function isUpdatedWithin(row: { updated_at: number }, maxAgeMs: number, now = Date.now()) {
  return now - row.updated_at <= maxAgeMs;
}

function parseFreshPayload<T>(rows: TimedPayloadRow[]): T | null {
  const row = rows[0];
  if (!row || !isFresh(row)) return null;
  return parsePayload<T>(rows);
}

function parseRecentlyUpdatedPayload<T>(rows: TimedPayloadRow[], maxAgeMs: number): T | null {
  const row = rows[0];
  if (!row || !isUpdatedWithin(row, maxAgeMs)) return null;
  return parsePayload<T>(rows);
}

async function touchSubject(db: Database, subjectId: number) {
  await db.execute("UPDATE subjects SET accessed_at = $1 WHERE id = $2", [Date.now(), subjectId]);
}

async function touchSubjectEntry(db: Database, subjectId: number, kind: string) {
  await db.execute(
    "UPDATE subject_cache_entries SET accessed_at = $1 WHERE subject_id = $2 AND kind = $3",
    [Date.now(), subjectId, kind],
  );
}

async function touchCollection(db: Database, username: string, subjectId: number) {
  await db.execute(
    "UPDATE subject_collections SET accessed_at = $1 WHERE username = $2 AND subject_id = $3",
    [Date.now(), username, subjectId],
  );
}

async function touchCacheEntry(db: Database, cacheKey: string) {
  await db.execute("UPDATE cache_entries SET accessed_at = $1 WHERE cache_key = $2", [
    Date.now(),
    cacheKey,
  ]);
}

async function touchImage(db: Database, remoteUrl: string) {
  await db.execute("UPDATE image_cache SET accessed_at = $1 WHERE remote_url = $2", [
    Date.now(),
    remoteUrl,
  ]);
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
    const rows = await db.select<TimedPayloadRow[]>(
      "SELECT payload_json, updated_at, accessed_at FROM subject_cache_entries WHERE subject_id = $1 AND kind = $2 LIMIT 1",
      [subjectId, kind],
    );
    const payload = parseFreshPayload<T>(rows);
    if (payload) await touchSubjectEntry(db, subjectId, kind);
    return payload;
  }, null);
}

async function readSubjectEntryWithin<T>(
  subjectId: number,
  kind: string,
  maxAgeMs: number,
): Promise<T | null> {
  return withDatabase(async (db) => {
    const rows = await db.select<TimedPayloadRow[]>(
      "SELECT payload_json, updated_at, accessed_at FROM subject_cache_entries WHERE subject_id = $1 AND kind = $2 LIMIT 1",
      [subjectId, kind],
    );
    const payload = parseRecentlyUpdatedPayload<T>(rows, maxAgeMs);
    if (payload) await touchSubjectEntry(db, subjectId, kind);
    return payload;
  }, null);
}

async function writeSubjectEntry(subjectId: number, kind: string, payload: unknown) {
  await withDatabase(async (db) => {
    await db.execute(
      `INSERT INTO subject_cache_entries (subject_id, kind, payload_json, updated_at, accessed_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT(subject_id, kind) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at,
         accessed_at = excluded.updated_at`,
      [subjectId, kind, JSON.stringify(payload), Date.now()],
    );
  }, undefined);
}

export async function readCachedSubject(subjectId: number): Promise<Subject | null> {
  return withDatabase(async (db) => {
    const rows = await db.select<TimedPayloadRow[]>(
      "SELECT payload_json, updated_at, accessed_at FROM subjects WHERE id = $1 LIMIT 1",
      [subjectId],
    );
    const payload = parseFreshPayload<Subject>(rows);
    if (payload) await touchSubject(db, subjectId);
    return payload;
  }, null);
}

export async function readCachedSubjectWithin(
  subjectId: number,
  maxAgeMs: number,
): Promise<Subject | null> {
  return withDatabase(async (db) => {
    const rows = await db.select<TimedPayloadRow[]>(
      "SELECT payload_json, updated_at, accessed_at FROM subjects WHERE id = $1 LIMIT 1",
      [subjectId],
    );
    const payload = parseRecentlyUpdatedPayload<Subject>(rows, maxAgeMs);
    if (payload) await touchSubject(db, subjectId);
    return payload;
  }, null);
}

export async function writeCachedSubject(subject: Subject): Promise<Subject> {
  const current = await readCachedSubject(subject.id);
  const payload = mergeSubjectFull(current, subject);

  await withDatabase(async (db) => {
    await db.execute(
      `INSERT INTO subjects (id, payload_json, updated_at, accessed_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT(id) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at,
         accessed_at = excluded.updated_at`,
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
      "SELECT cache_key, payload_json, updated_at, accessed_at FROM cache_entries",
    );

    for (const row of rows) {
      if (!isFresh(row)) continue;
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        const subject = findSubjectInPayload(subjectId, payload);
        if (subject) {
          await touchCacheEntry(db, row.cache_key);
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

export async function readCachedSubjectDeepWithin(
  subjectId: number,
  maxAgeMs: number,
): Promise<Subject | null> {
  const cached = await readCachedSubjectWithin(subjectId, maxAgeMs);
  if (cached) return cached;

  return withDatabase(async (db) => {
    const rows = await db.select<CacheEntryRow[]>(
      "SELECT cache_key, payload_json, updated_at, accessed_at FROM cache_entries WHERE updated_at >= $1",
      [Date.now() - maxAgeMs],
    );

    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        const subject = findSubjectInPayload(subjectId, payload);
        if (subject) {
          await touchCacheEntry(db, row.cache_key);
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
    const rows = await db.select<TimedPayloadRow[]>(
      "SELECT payload_json, updated_at, accessed_at FROM subject_collections WHERE username = $1 AND subject_id = $2 LIMIT 1",
      [username, subjectId],
    );
    const payload = parseFreshPayload<UserCollection>(rows);
    if (payload) await touchCollection(db, username, subjectId);
    return payload;
  }, null);
}

export async function readCachedCollectionWithin(
  username: string,
  subjectId: number,
  maxAgeMs: number,
): Promise<UserCollection | null> {
  if (!username) return null;
  return withDatabase(async (db) => {
    const rows = await db.select<TimedPayloadRow[]>(
      "SELECT payload_json, updated_at, accessed_at FROM subject_collections WHERE username = $1 AND subject_id = $2 LIMIT 1",
      [username, subjectId],
    );
    const payload = parseRecentlyUpdatedPayload<UserCollection>(rows, maxAgeMs);
    if (payload) await touchCollection(db, username, subjectId);
    return payload;
  }, null);
}

export async function writeCachedCollection(username: string, collection: UserCollection | null) {
  if (!username || !collection) return;
  await withDatabase(async (db) => {
    await db.execute(
      `INSERT INTO subject_collections (username, subject_id, payload_json, updated_at, accessed_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT(username, subject_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at,
         accessed_at = excluded.updated_at`,
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

export function readCachedEpisodesWithin(
  subjectId: number,
  maxAgeMs: number,
): Promise<PagedResponse<Episode> | null> {
  return readSubjectEntryWithin<PagedResponse<Episode>>(subjectId, "episodes", maxAgeMs);
}

export function writeCachedEpisodes(subjectId: number, episodes: PagedResponse<Episode>) {
  return writeSubjectEntry(subjectId, "episodes", episodes);
}

export function readCachedPersons(subjectId: number): Promise<RelatedPerson[] | null> {
  return readSubjectEntry<RelatedPerson[]>(subjectId, "persons");
}

export function readCachedPersonsWithin(
  subjectId: number,
  maxAgeMs: number,
): Promise<RelatedPerson[] | null> {
  return readSubjectEntryWithin<RelatedPerson[]>(subjectId, "persons", maxAgeMs);
}

export function writeCachedPersons(subjectId: number, persons: RelatedPerson[]) {
  return writeSubjectEntry(subjectId, "persons", persons);
}

export function readCachedCharacters(subjectId: number): Promise<RelatedCharacter[] | null> {
  return readSubjectEntry<RelatedCharacter[]>(subjectId, "characters");
}

export function readCachedCharactersWithin(
  subjectId: number,
  maxAgeMs: number,
): Promise<RelatedCharacter[] | null> {
  return readSubjectEntryWithin<RelatedCharacter[]>(subjectId, "characters", maxAgeMs);
}

export function writeCachedCharacters(subjectId: number, characters: RelatedCharacter[]) {
  return writeSubjectEntry(subjectId, "characters", characters);
}

export function readCachedRelations(subjectId: number): Promise<SubjectRelation[] | null> {
  return readSubjectEntry<SubjectRelation[]>(subjectId, "relations");
}

export function readCachedRelationsWithin(
  subjectId: number,
  maxAgeMs: number,
): Promise<SubjectRelation[] | null> {
  return readSubjectEntryWithin<SubjectRelation[]>(subjectId, "relations", maxAgeMs);
}

export function writeCachedRelations(subjectId: number, relations: SubjectRelation[]) {
  return writeSubjectEntry(subjectId, "relations", relations);
}

export async function readCachedValue<T>(cacheKey: string): Promise<T | null> {
  return withDatabase(async (db) => {
    const rows = await db.select<TimedPayloadRow[]>(
      "SELECT payload_json, updated_at, accessed_at FROM cache_entries WHERE cache_key = $1 LIMIT 1",
      [cacheKey],
    );
    const payload = parseFreshPayload<T>(rows);
    if (payload) await touchCacheEntry(db, cacheKey);
    return payload;
  }, null);
}

export async function readCachedValueEntry<T>(
  cacheKey: string,
): Promise<CachedValueEntry<T> | null> {
  return withDatabase(async (db) => {
    const rows = await db.select<TimedPayloadRow[]>(
      "SELECT payload_json, updated_at, accessed_at FROM cache_entries WHERE cache_key = $1 LIMIT 1",
      [cacheKey],
    );
    const row = rows[0];
    if (!row || !isFresh(row)) return null;

    const payload = parsePayload<T>(rows);
    if (payload === null) return null;

    await touchCacheEntry(db, cacheKey);
    return {
      payload,
      updatedAt: row.updated_at,
      accessedAt: getAccessedAt(row),
    };
  }, null);
}

export async function readCachedValueWithin<T>(
  cacheKey: string,
  maxAgeMs: number,
): Promise<T | null> {
  return withDatabase(async (db) => {
    const rows = await db.select<TimedPayloadRow[]>(
      "SELECT payload_json, updated_at, accessed_at FROM cache_entries WHERE cache_key = $1 LIMIT 1",
      [cacheKey],
    );
    const payload = parseRecentlyUpdatedPayload<T>(rows, maxAgeMs);
    if (payload) await touchCacheEntry(db, cacheKey);
    return payload;
  }, null);
}

export async function readCachedValuesWithin<T>(
  cacheKeys: string[],
  maxAgeMs: number,
): Promise<Map<string, T>> {
  const uniqueKeys = [...new Set(cacheKeys)].filter(Boolean);
  if (uniqueKeys.length === 0) return new Map();

  return withDatabase(async (db) => {
    const placeholders = uniqueKeys.map((_, index) => `$${index + 1}`).join(", ");
    const rows = await db.select<Array<TimedPayloadRow & { cache_key: string }>>(
      `SELECT cache_key, payload_json, updated_at, accessed_at
       FROM cache_entries
       WHERE cache_key IN (${placeholders})`,
      uniqueKeys,
    );

    const now = Date.now();
    const result = new Map<string, T>();
    const touchedKeys: string[] = [];

    for (const row of rows) {
      if (!isUpdatedWithin(row, maxAgeMs, now)) continue;
      const payload = parsePayload<T>([row]);
      if (payload === null) continue;
      result.set(row.cache_key, payload);
      touchedKeys.push(row.cache_key);
    }

    if (touchedKeys.length > 0) {
      const touchPlaceholders = touchedKeys.map((_, index) => `$${index + 2}`).join(", ");
      await db.execute(
        `UPDATE cache_entries SET accessed_at = $1 WHERE cache_key IN (${touchPlaceholders})`,
        [now, ...touchedKeys],
      );
    }

    return result;
  }, new Map());
}

export async function readCachedValues<T>(cacheKeys: string[]): Promise<Map<string, T>> {
  const uniqueKeys = [...new Set(cacheKeys)].filter(Boolean);
  if (uniqueKeys.length === 0) return new Map();

  return withDatabase(async (db) => {
    const placeholders = uniqueKeys.map((_, index) => `$${index + 1}`).join(", ");
    const rows = await db.select<Array<TimedPayloadRow & { cache_key: string }>>(
      `SELECT cache_key, payload_json, updated_at, accessed_at
       FROM cache_entries
       WHERE cache_key IN (${placeholders})`,
      uniqueKeys,
    );

    const now = Date.now();
    const result = new Map<string, T>();
    const touchedKeys: string[] = [];

    for (const row of rows) {
      if (!isFresh(row, now)) continue;
      const payload = parsePayload<T>([row]);
      if (payload === null) continue;
      result.set(row.cache_key, payload);
      touchedKeys.push(row.cache_key);
    }

    if (touchedKeys.length > 0) {
      const touchPlaceholders = touchedKeys.map((_, index) => `$${index + 2}`).join(", ");
      await db.execute(
        `UPDATE cache_entries SET accessed_at = $1 WHERE cache_key IN (${touchPlaceholders})`,
        [now, ...touchedKeys],
      );
    }

    return result;
  }, new Map());
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
      `INSERT INTO cache_entries (cache_key, payload_json, updated_at, accessed_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT(cache_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at,
         accessed_at = excluded.updated_at`,
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
      "SELECT local_path, updated_at, accessed_at FROM image_cache WHERE remote_url = $1 LIMIT 1",
      [remoteUrl],
    );
    const row = rows[0];
    if (!row) return null;
    if (!isFresh(row)) return null;
    await touchImage(db, remoteUrl);
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
      `INSERT INTO image_cache (remote_url, local_path, updated_at, accessed_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT(remote_url) DO UPDATE SET
         local_path = excluded.local_path,
         updated_at = excluded.updated_at,
         accessed_at = excluded.updated_at`,
      [record.remoteUrl, record.localPath, record.updatedAt],
    );
  }, undefined);
}

export async function cleanupExpiredCache(): Promise<string[]> {
  return withDatabase(async (db) => {
    const cutoff = Date.now() - CACHE_TTL_MS;
    const expiredImages = await db.select<Array<{ local_path: string }>>(
      "SELECT local_path FROM image_cache WHERE accessed_at < $1",
      [cutoff],
    );

    await db.execute("DELETE FROM subjects WHERE accessed_at < $1", [cutoff]);
    await db.execute("DELETE FROM subject_collections WHERE accessed_at < $1", [cutoff]);
    await db.execute("DELETE FROM subject_cache_entries WHERE accessed_at < $1", [cutoff]);
    await db.execute("DELETE FROM cache_entries WHERE accessed_at < $1", [cutoff]);
    await db.execute("DELETE FROM image_cache WHERE accessed_at < $1", [cutoff]);

    return expiredImages.map((row) => row.local_path);
  }, []);
}
