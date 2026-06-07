import Database from "@tauri-apps/plugin-sql";
import type {
  Episode,
  PagedResponse,
  RelatedCharacter,
  RelatedPerson,
  Subject,
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

export type CachedImageRecord = {
  remoteUrl: string;
  localPath: string;
  updatedAt: number;
};

let dbPromise: Promise<Database> | null = null;

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

export async function writeCachedSubject(subject: Subject) {
  await withDatabase(async (db) => {
    await db.execute(
      `INSERT INTO subjects (id, payload_json, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(id) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [subject.id, JSON.stringify(subject), Date.now()],
    );
  }, undefined);
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
