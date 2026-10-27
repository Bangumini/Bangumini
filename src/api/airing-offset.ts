import { isValidAiringOffsetDays, type AiringOffsets } from "../../shared/airing-offset.ts";
import type { OffsetSyncRecord, OffsetSyncRecords } from "../../shared/airing-offset-sync.ts";

/** 仅作旧数据备份，任何路径都不再写入或删除此 key。 */
export const AIRING_OFFSETS_STORAGE_KEY = "bangumini_airing_offsets";
export const AIRING_OFFSET_ACCOUNTS_STORAGE_KEY = "bangumini_airing_offset_accounts_v1";

export type AiringOffsetAccountState = {
  syncEnabled: boolean;
  records: OffsetSyncRecords;
  bases: Readonly<Record<string, OffsetSyncRecords>>;
  syncedAt: Readonly<Record<string, number>>;
};
type Database = {
  version: 1;
  legacyOwner: string | null;
  accounts: Readonly<Record<string, AiringOffsetAccountState>>;
};
const EMPTY_OFFSETS: AiringOffsets = Object.freeze({});
const EMPTY_STATE: AiringOffsetAccountState = Object.freeze({
  syncEnabled: false, records: Object.freeze({}), bases: Object.freeze({}), syncedAt: Object.freeze({}),
});
let snapshot = EMPTY_OFFSETS;
let account: string | null = null;
let scopeVersion = 0;
let database: Database | undefined;
let initialized = false;
let ioQueue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const stateListeners = new Set<() => void>();

function isValidSubjectId(subjectId: number) {
  return Number.isSafeInteger(subjectId) && subjectId > 0;
}
function scopeKey(value: string | null): string {
  return value === null ? "guest" : `account:${value}`;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function copyRecords(value: unknown): OffsetSyncRecords {
  if (!object(value)) throw new Error("偏置 records 格式无效");
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, record]) => {
    if (String(Number(key)) !== key || !isValidSubjectId(Number(key)) || !object(record)
      || !isValidAiringOffsetDays(record.days) || typeof record.revision !== "string"
      || record.revision.length === 0 || record.revision.length > 128
      || !Number.isSafeInteger(record.updatedAt) || (record.updatedAt as number) < 0) {
      throw new Error("偏置 record 格式无效");
    }
    return [key, Object.freeze({ days: record.days, revision: record.revision, updatedAt: record.updatedAt }) as OffsetSyncRecord];
  })));
}
/** 防止调用方在保存后修改传入对象，或通过快照间接修改内存数据库。 */
function copyState(value: unknown): AiringOffsetAccountState {
  if (!object(value) || !object(value.bases) || !object(value.syncedAt)) throw new Error("偏置账号状态无效");
  const syncEnabled = "syncEnabled" in value ? value.syncEnabled : false;
  if (typeof syncEnabled !== "boolean") throw new Error("偏置同步开关格式无效");
  const bases = Object.freeze(Object.fromEntries(Object.entries(value.bases).map(([key, records]) => [key, copyRecords(records)])));
  const syncedAt = Object.freeze(Object.fromEntries(Object.entries(value.syncedAt).map(([key, time]) => {
    if (!Number.isSafeInteger(time) || (time as number) < 0) throw new Error("偏置同步时间无效");
    return [key, time as number];
  })));
  return Object.freeze({ syncEnabled, records: copyRecords(value.records), bases, syncedAt });
}
function stateFor(value: string | null): AiringOffsetAccountState {
  return database?.accounts[scopeKey(value)] ?? EMPTY_STATE;
}
function publish(next: OffsetSyncRecords) {
  const flat = Object.fromEntries(Object.entries(next).filter(([, record]) => record.days !== 0).map(([key, record]) => [key, record.days]));
  const keys = Object.keys(flat);
  if (keys.length === Object.keys(snapshot).length && keys.every(key => flat[key] === snapshot[Number(key)])) return;
  snapshot = Object.freeze(flat);
  for (const listener of listeners) listener();
}
function notifyState() {
  for (const listener of stateListeners) listener();
}
function storage(): Storage {
  if (typeof window === "undefined") throw new Error("无法访问本机存储");
  return window.localStorage;
}
/** 每次操作重读 canonical；任何损坏都整体拒绝，绝不能把未知磁盘数据空覆盖。 */
function restore(): void {
  const raw = storage().getItem(AIRING_OFFSET_ACCOUNTS_STORAGE_KEY);
  if (raw === null) {
    database = { version: 1, legacyOwner: null, accounts: Object.freeze({}) };
    return;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!object(parsed) || parsed.version !== 1 || !object(parsed.accounts)
    || (parsed.legacyOwner !== null && typeof parsed.legacyOwner !== "string")) throw new Error("偏置账号数据库格式无效");
  database = {
    version: 1, legacyOwner: parsed.legacyOwner,
    accounts: Object.freeze(Object.fromEntries(Object.entries(parsed.accounts).map(([key, state]) => [key, copyState(state)]))),
  };
}
function initialize() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  try { restore(); publish(stateFor(account).records); } catch { /* 显式保存与账号切换报告错误，展示保留最后确认值。 */ }
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== AIRING_OFFSET_ACCOUNTS_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== storage()) return;
      const previous = JSON.stringify(database);
      // 旧事件可能晚于本窗口的写入；永远读最新 canonical，而不是 event.newValue。
      restore();
      publish(stateFor(account).records);
      if (JSON.stringify(database) !== previous) notifyState();
    } catch { /* 不可访问或损坏的存储不改变最后成功发布的展示。 */ }
  });
}
function enqueue<T>(run: () => T): Promise<T> {
  const operation = ioQueue.then(run);
  ioQueue = operation.catch(() => {});
  return operation;
}
function commit(next: Database): void {
  // 整个 read/modify/write 不允许 await；同步控件必须在此返回前确认落盘。
  storage().setItem(AIRING_OFFSET_ACCOUNTS_STORAGE_KEY, JSON.stringify(next));
  database = next;
}
function parseLegacy(raw: string | null): OffsetSyncRecords {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? "null"); } catch { return EMPTY_STATE.records; }
  if (!object(parsed)) return EMPTY_STATE.records;
  return Object.freeze(Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
    String(Number(key)) === key && isValidSubjectId(Number(key)) && isValidAiringOffsetDays(value) && value !== 0
  ).map(([key, days]) => [key, Object.freeze({ days: days as number, revision: crypto.randomUUID(), updatedAt: Date.now() })])));
}

/** 可供启动恢复 await；getSnapshot 仍同步恢复，不引入首屏网络依赖。 */
export async function initializeAiringOffsets(): Promise<void> {
  initialize();
  try { restore(); publish(stateFor(account).records); } catch { /* 保存及显式账号切换向调用者报告错误。 */ }
}
export function getAiringOffsetsSnapshot(): AiringOffsets { initialize(); return snapshot; }
export function getAiringOffsetAccount(): string | null { return account; }
export function subscribeAiringOffsets(listener: () => void): () => void {
  initialize();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function subscribeAiringOffsetState(listener: () => void): () => void {
  initialize();
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}
export function setAiringOffsetAccount(nextAccount: string | null): Promise<void> {
  initialize();
  const version = ++scopeVersion;
  return enqueue(() => {
    restore();
    if (nextAccount !== null && database!.legacyOwner === null) {
      const records = parseLegacy(storage().getItem(AIRING_OFFSETS_STORAGE_KEY));
      const current = stateFor(nextAccount);
      // guest 新编辑（含零值）覆盖 legacy，目标账号记录优先。一次写入确认 owner 和清空 guest。
      const migrated = copyState({ ...current, records: { ...records, ...stateFor(null).records, ...current.records } });
      commit({ version: 1, legacyOwner: nextAccount, accounts: Object.freeze({
        ...database!.accounts, guest: EMPTY_STATE, [scopeKey(nextAccount)]: migrated,
      }) });
    }
    if (version !== scopeVersion) return;
    account = nextAccount;
    publish(stateFor(account).records);
    notifyState();
  });
}
export function readAiringOffsetAccountState(value: string | null): Promise<AiringOffsetAccountState> {
  initialize();
  return enqueue(() => { restore(); return stateFor(value); });
}
function updateState(
  value: string | null,
  update: (current: AiringOffsetAccountState) => AiringOffsetAccountState,
): AiringOffsetAccountState {
  restore();
  const current = stateFor(value);
  const next = copyState(update(current));
  if (JSON.stringify(next) === JSON.stringify(current)) {
    if (account === value) publish(current.records);
    return current;
  }
  commit({ ...database!, accounts: Object.freeze({ ...database!.accounts, [scopeKey(value)]: next }) });
  if (account === value) publish(next.records);
  notifyState();
  return next;
}
export function updateAiringOffsetAccountState(
  value: string | null,
  update: (current: AiringOffsetAccountState) => AiringOffsetAccountState,
): Promise<AiringOffsetAccountState> {
  initialize();
  return enqueue(() => updateState(value, update));
}
/** 保持既有控件约定：同步落盘、立即发布，错误同步抛出，不改变调用方。 */
export function setAiringOffsetDays(subjectId: number, days: number): void {
  if (!isValidSubjectId(subjectId) || !isValidAiringOffsetDays(days)) {
    throw new RangeError("放送偏置必须为 -365 至 365 的整数天，且条目 ID 必须有效");
  }
  initialize();
  updateState(account, current => {
    if (days !== 0 && current.records[subjectId]?.days === days) return current;
    return { ...current, records: { ...current.records,
      [subjectId]: { days, revision: crypto.randomUUID(), updatedAt: Date.now() },
    } };
  });
}
