import {
  createOffsetSyncDocument, mergeOffsetSyncRecords, parseOffsetSyncDocument,
  sameOffsetSyncRecord, sameOffsetSyncRecords, type OffsetSyncRecords,
} from "../../shared/airing-offset-sync.ts";
import { normalizeOffsetSyncConfig, offsetSyncTargetKey, type OffsetSyncConfig } from "../../shared/offset-sync-config.ts";
import type { AiringOffsetAccountState } from "./airing-offset.ts";
import type { AiringOffsetSyncManager, OffsetSyncStatus } from "./airing-offset-sync-types.ts";
import type { OffsetSyncStorage } from "./offset-sync-storage.ts";

type SyncDeps = {
  setAccount(account: string | null): Promise<void>;
  readLocal(account: string | null): Promise<AiringOffsetAccountState>;
  updateLocal(account: string | null, update: (state: AiringOffsetAccountState) => AiringOffsetAccountState): Promise<AiringOffsetAccountState>;
  subscribeLocal(listener: () => void): () => void;
  configs: {
    get(account: string): Promise<OffsetSyncConfig | null>;
    set(account: string, config: OffsetSyncConfig): Promise<void>;
    delete(account: string): Promise<void>;
  };
  createStorage(config: OffsetSyncConfig, account: string): OffsetSyncStorage;
  isPreconditionError(error: unknown): boolean;
  formatStorageError(error: unknown): string;
  newRevision(): string;
  now?: () => number;
  debounceMs?: number;
  retryDelays?: number[];
  timeoutMs?: number;
};
class SafeSyncError extends Error {}
const EMPTY_RECORDS: OffsetSyncRecords = Object.freeze({});

/** 单账号单轮协调：所有网络片段与 CAS 重读完成后才一次提交本机；用户保存始终独立。 */
export function createAiringOffsetSyncManager(deps: SyncDeps): AiringOffsetSyncManager & { dispose(): void } {
  const now = deps.now ?? Date.now;
  let status: OffsetSyncStatus = Object.freeze({ account: null, ready: false, enabled: false, configured: false, autoSync: false, phase: "idle", conflicts: [], lastSyncedAt: null, error: null });
  let config: OffsetSyncConfig | null = null;
  let enabledChangePending = false;
  let enabledChangeTarget = false;
  let localReadVersion = 0;
  const probes = new Set<AbortController>();
  let generation = 0;
  let active = false;
  let disposed = false;
  let observed: OffsetSyncRecords = EMPTY_RECORDS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let rerun = false;
  let inFlight: { generation: number; controller: AbortController; promise: Promise<void> } | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<OffsetSyncStatus>) => {
    const next = { ...status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = Object.freeze({ ...next, conflicts: Object.freeze([...next.conflicts]) });
    for (const listener of listeners) listener();
  };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const invalidate = () => {
    generation++;
    enabledChangePending = false;
    clearTimer();
    inFlight?.controller.abort();
    for (const controller of probes) controller.abort();
    probes.clear();
    inFlight = null;
    rerun = false;
    retries = 0;
    return generation;
  };
  const current = (version: number, account: string | null) => !disposed && generation === version && status.account === account;
  const requireAccount = () => {
    if (!status.ready || !status.account) throw new SafeSyncError("请先登录 Bangumi 账号后配置偏置同步");
    return status.account;
  };
  const requireEnabled = () => {
    const account = requireAccount();
    if (!status.enabled || enabledChangePending) throw new SafeSyncError("请先开启偏置同步");
    return account;
  };
  const auto = () => !disposed && !enabledChangePending && status.enabled && active && status.ready && Boolean(status.account) && Boolean(config?.autoSync);
  const schedule = (delay = deps.debounceMs ?? 1000) => {
    if (!auto()) return;
    if (inFlight) { rerun = true; return; }
    clearTimer();
    timer = setTimeout(() => { timer = undefined; void manager.syncNow().catch(() => {}); }, delay);
  };
  const timed = async <T>(controller: AbortController, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw new SafeSyncError("同步请求已取消或超时，请重试");
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new SafeSyncError("同步请求已取消或超时，请重试"));
      if (controller.signal.aborted) abort();
      else controller.signal.addEventListener("abort", abort, { once: true });
    });
    const deadline = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);
    try { return await Promise.race([cancelled, operation(controller.signal)]); }
    finally { clearTimeout(deadline); controller.signal.removeEventListener("abort", abort); }
  };
  const parse = (content: string, account: string) => {
    try { return parseOffsetSyncDocument(content, account); }
    catch { throw new SafeSyncError("远端偏置文件无效、版本不支持或账号不匹配，未覆盖任何数据"); }
  };
  const unsubscribe = deps.subscribeLocal(() => {
    const version = generation, account = status.account, readVersion = ++localReadVersion;
    if (!status.ready || !account) return;
    void deps.readLocal(account).then(async state => {
      if (!current(version, account) || readVersion !== localReadVersion) return;
      const enabled = state.syncEnabled === true;
      // 本窗口保存可能先通知、后返回；同一目标的通知不能取消自己的持久化或配置恢复。
      if (enabledChangePending && enabled === enabledChangeTarget) return;
      if (enabled !== status.enabled || enabledChangePending) {
        const restoredVersion = invalidate();
        observed = state.records;
        publish({ enabled, phase: "idle", conflicts: [], error: null });
        if (!enabled) return;
        // 外部开启不再次写库；重新读取安全配置，期间相反偏好仍可立即使本轮失效。
        enabledChangePending = true;
        enabledChangeTarget = enabled;
        try {
          const restored = await deps.configs.get(account);
          if (!current(restoredVersion, account)) return;
          config = restored;
          publish({ configured: config !== null, autoSync: config?.autoSync ?? false,
            lastSyncedAt: config ? state.syncedAt[offsetSyncTargetKey(config, account)] ?? null : null });
        } catch {
          if (current(restoredVersion, account)) {
            enabledChangePending = false;
            config = null;
            publish({ configured: false, autoSync: false, phase: "error", error: "同步已开启，但无法读取安全存储中的配置，请重试" });
          }
          return;
        }
        enabledChangePending = false;
        schedule(0);
        return;
      }
      if (sameOffsetSyncRecords(observed, state.records)) return;
      observed = state.records;
      retries = 0;
      schedule();
    }).catch(() => { if (current(version, account) && readVersion === localReadVersion) publish({ phase: "error", error: "无法读取本机偏置，请稍后重试" }); });
  });

  const manager: AiringOffsetSyncManager & { dispose(): void } = {
    getSnapshot: () => status,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async setAccount(account) {
      const version = invalidate();
      config = null;
      enabledChangePending = false;
      observed = EMPTY_RECORDS;
      publish({ account, ready: false, enabled: false, configured: false, autoSync: false, phase: "idle", conflicts: [], lastSyncedAt: null, error: null });
      try {
        await deps.setAccount(account);
        if (!current(version, account)) return;
        const state = await deps.readLocal(account);
        if (!current(version, account)) return;
        observed = state.records;
        publish({ enabled: state.syncEnabled === true });
        let restored: OffsetSyncConfig | null;
        try { restored = account ? await deps.configs.get(account) : null; }
        catch { if (current(version, account)) publish({ ready: true, phase: "error", error: "无法读取安全存储中的同步配置，可重新保存配置或断开同步" }); return; }
        if (!current(version, account)) return;
        config = restored;
        publish({ ready: true, configured: config !== null, autoSync: config?.autoSync ?? false, lastSyncedAt: account && config ? state.syncedAt[offsetSyncTargetKey(config, account)] ?? null : null });
        schedule(0);
      } catch {
        if (current(version, account)) publish({ ready: false, phase: "error", error: "无法恢复本账号的本地偏置，请重试" });
        throw new SafeSyncError("无法恢复本账号的本地偏置，请重试");
      }
    },
    async setEnabled(enabled) {
      const account = requireAccount();
      if (typeof enabled !== "boolean") throw new SafeSyncError("偏置同步开关值无效");
      // 先阻断所有入口；只有本地持久化成功后才确认开关，排队写入始终使用调用时账号。
      const previous = status.enabled, version = invalidate();
      enabledChangePending = true;
      enabledChangeTarget = enabled;
      publish({ phase: "idle", error: null });
      let state: AiringOffsetAccountState;
      try {
        state = await deps.updateLocal(account, latest => ({ ...latest, syncEnabled: enabled }));
      } catch {
        // 连续切换时，前一次持久化可能已成功但尚未发布；以磁盘确认值恢复而非过期快照。
        let restored = previous;
        try { restored = (await deps.readLocal(account)).syncEnabled === true; } catch { /* 保留最后确认的开关 */ }
        if (current(version, account)) {
          enabledChangePending = false;
          publish({ enabled: restored, phase: "error", error: "同步开关保存失败，原开关未改变，请重试" });
        }
        throw new SafeSyncError("同步开关保存失败，原开关未改变，请重试");
      }
      if (!current(version, account)) return;
      publish({ enabled, phase: "idle", conflicts: [], error: null });
      if (enabled) {
        try {
          const restored = await deps.configs.get(account);
          if (!current(version, account)) return;
          config = restored;
          publish({ configured: config !== null, autoSync: config?.autoSync ?? false,
            lastSyncedAt: config ? state.syncedAt[offsetSyncTargetKey(config, account)] ?? null : null });
        } catch {
          if (current(version, account)) {
            enabledChangePending = false;
            config = null;
            publish({ configured: false, autoSync: false, phase: "error", error: "同步已开启，但无法读取安全存储中的配置，请重试" });
          }
          throw new SafeSyncError("同步已开启，但无法读取安全存储中的配置，请重试");
        }
      }
      enabledChangePending = false;
      schedule(0);
    },
    setAppActive(value) {
      if (disposed || active === value) return;
      active = value;
      if (!value) {
        // 前后台变化只取消网络，不使正在读取的本地账号或安全配置失效。
        clearTimer();
        rerun = false;
        inFlight?.controller.abort();
        for (const controller of probes) controller.abort();
        probes.clear();
        publish({ phase: status.conflicts.length ? "conflict" : "idle" });
      } else { retries = 0; schedule(0); }
    },
    async getConfig() {
      const account = requireAccount(), version = generation;
      const result = await deps.configs.get(account);
      if (!current(version, account)) throw new SafeSyncError("账号或配置已变化，请重试");
      return result;
    },
    async saveConfig(input) {
      const next = normalizeOffsetSyncConfig(input);
      const account = requireAccount(), previous = config, version = invalidate();
      config = null;
      try {
        await deps.configs.set(account, next);
        if (!current(version, account)) return;
        config = next;
        const state = await deps.readLocal(account);
        if (!current(version, account)) return;
        publish({ configured: true, autoSync: next.autoSync, phase: "idle", conflicts: [], error: null, lastSyncedAt: state.syncedAt[offsetSyncTargetKey(next, account)] ?? null });
        schedule(0);
      } catch {
        if (current(version, account)) { config = previous; publish({ phase: "error", error: "同步配置保存失败，原配置未改变" }); }
        throw new SafeSyncError("同步配置保存失败，原配置未改变");
      }
    },
    async disconnect() {
      const account = requireAccount(), previous = config, version = invalidate();
      config = null;
      try {
        await deps.configs.delete(account);
        if (current(version, account)) publish({ configured: false, autoSync: false, phase: "idle", conflicts: [], lastSyncedAt: null, error: null });
      } catch {
        if (current(version, account)) { config = previous; publish({ phase: "error", error: "无法删除安全存储中的同步配置，请重试" }); }
        throw new SafeSyncError("无法删除安全存储中的同步配置，请重试");
      }
    },
    syncNow() {
      let account: string;
      try { account = requireEnabled(); } catch (error) { return Promise.reject(error); }
      if (!config) return Promise.reject(new SafeSyncError("请先保存 WebDAV 或 S3 同步配置"));
      if (inFlight?.generation === generation) return inFlight.promise;
      clearTimer();
      const version = generation, captured = config, target = offsetSyncTargetKey(captured, account);
      const controller = new AbortController();
      publish({ phase: "syncing", error: null });
      const work = (async () => {
        const storage = deps.createStorage(captured, account);
        for (let attempt = 0; attempt < 4; attempt++) {
          const file = await timed(controller, signal => storage.read(signal));
          if (!current(version, account)) return;
          const remote = file ? parse(file.content, account).records : EMPTY_RECORDS;
          const before = await deps.readLocal(account);
          if (!current(version, account)) return;
          const base = before.bases[target] ?? EMPTY_RECORDS;
          const merged = mergeOffsetSyncRecords(base, before.records, remote);
          if (!sameOffsetSyncRecords(merged.remote, remote)) {
            const content = JSON.stringify(createOffsetSyncDocument(account, merged.remote));
            try { await timed(controller, signal => storage.write(content, file?.etag ?? null, signal)); }
            catch (error) { if (deps.isPreconditionError(error) && attempt < 3) continue; throw error; }
          }
          if (!current(version, account)) return;
          let committed: AiringOffsetAccountState;
          try {
            committed = await deps.updateLocal(account, latest => {
              if (!current(version, account)) return latest;
              const records = { ...latest.records };
              for (const [id, record] of Object.entries(merged.local)) {
                // 上传期间的新本地意图优先；基线仍确认实际已写入远端的旧版本。
                if (sameOffsetSyncRecord(latest.records[id], before.records[id])) records[id] = record;
              }
              observed = records;
              return { ...latest, records, bases: { ...latest.bases, [target]: merged.base }, syncedAt: { ...latest.syncedAt, [target]: now() } };
            });
          } catch { throw new SafeSyncError("本机同步状态保存失败，原本地设置保留，请重试"); }
          if (!current(version, account)) return;
          const final = mergeOffsetSyncRecords(committed.bases[target] ?? EMPTY_RECORDS, committed.records, merged.remote);
          publish({ phase: final.conflicts.length ? "conflict" : "idle", conflicts: final.conflicts, error: null, lastSyncedAt: committed.syncedAt[target] ?? null });
          retries = 0;
          if (!sameOffsetSyncRecords(final.remote, merged.remote)) rerun = true;
          return;
        }
      })().catch(error => {
        if (!current(version, account)) return;
        const message = error instanceof SafeSyncError ? error.message : deps.formatStorageError(error);
        publish({ phase: "error", error: message });
        const delays = deps.retryDelays ?? [5000, 15000, 45000, 120000, 300000];
        if (auto() && retries < delays.length) {
          const delay = delays[retries++];
          clearTimer();
          timer = setTimeout(() => { timer = undefined; void manager.syncNow().catch(() => {}); }, delay);
        }
        throw new SafeSyncError(message);
      }).finally(() => {
        if (inFlight?.generation === version) inFlight = null;
        if (current(version, account) && rerun) { rerun = false; schedule(); }
      });
      inFlight = { generation: version, controller, promise: work };
      return work;
    },
    async testConnection(input) {
      const account = requireEnabled(), version = generation;
      const storage = deps.createStorage(normalizeOffsetSyncConfig(input), account);
      const controller = new AbortController();
      probes.add(controller);
      try {
        const file = await timed(controller, signal => storage.read(signal));
        if (!current(version, account)) throw new SafeSyncError("账号或配置已变化，请重试");
        if (file) parse(file.content, account);
        return { exists: file !== null };
      } catch (error) { throw new SafeSyncError(error instanceof SafeSyncError ? error.message : deps.formatStorageError(error)); }
      finally { probes.delete(controller); }
    },
    async resolveConflict(subjectId, choice) {
      const account = requireEnabled();
      if (!config) throw new SafeSyncError("请先配置同步");
      const conflict = status.conflicts.find(item => item.subjectId === subjectId);
      if (!conflict) throw new SafeSyncError("冲突状态已变化，请重新同步");
      const target = offsetSyncTargetKey(config, account), version = invalidate();
      let saved = false;
      try {
        await deps.updateLocal(account, latest => {
          if (!current(version, account) || !sameOffsetSyncRecord(latest.records[subjectId], conflict.local)) throw new SafeSyncError("本机偏置已变化，请重新同步后选择");
          // 选择也是一次新的用户意图；不能复用 remote revision，否则未展示的新远端值会被当成单边更新。
          const chosen = choice === "remote" ? conflict.remote : conflict.local;
          const records = { ...latest.records, [subjectId]: { days: chosen.days, revision: deps.newRevision(), updatedAt: now() } };
          observed = records;
          return { ...latest, records, bases: { ...latest.bases, [target]: { ...latest.bases[target], [subjectId]: conflict.remote } } };
        });
        if (!current(version, account)) return;
        saved = true;
        publish({ conflicts: status.conflicts.filter(item => item.subjectId !== subjectId) });
        await manager.syncNow();
      } catch (error) {
        const message = saved
          ? "选择已保存在本机，但远端同步未完成；请重试同步"
          : error instanceof SafeSyncError ? error.message : "冲突选择保存失败，请重试";
        if (current(version, account)) publish({ phase: "error", error: message });
        throw new SafeSyncError(message);
      }
    },
    dispose() { disposed = true; invalidate(); unsubscribe(); listeners.clear(); },
  };
  return manager;
}
