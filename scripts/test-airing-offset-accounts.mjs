// 通过真实公开 store 验证账号隔离；仅替换浏览器 localStorage 边界。
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url);
const disk = new Map();
const io = { failReads:false, failReadKey:null, failWrites:false, failAt:0, writes:0, active:0, max:0 };
const storageListeners = new Set();
const storage = {
 getItem(key) { if(io.failReads || io.failReadKey===key) throw Error('read failed'); return disk.get(key)??null; },
 setItem(key,value) { io.writes++; io.active++; io.max=Math.max(io.max,io.active); try { if(io.failWrites || io.writes===io.failAt) throw Error('write failed'); disk.set(key,String(value)); } finally { io.active--; } },
};
globalThis.window = { localStorage:storage, addEventListener(type,listener) { if(type==='storage')storageListeners.add(listener); } };
let restart = 0;
const load = () => import(new URL("src/api/airing-offset.ts", root).href + `?restart=${restart++}`);
const store = await load();
assert.equal(typeof store.setAiringOffsetAccount, "function", "公开账号切换 API");
const legacy = store.AIRING_OFFSETS_STORAGE_KEY;
const backup = '{"10":-2,"20":3,"30":0,"bad":1}';
disk.set(legacy, backup);
await store.initializeAiringOffsets();
assert.equal(store.getAiringOffsetAccount(), null);
assert.equal((await store.readAiringOffsetAccountState(null)).syncEnabled, false, "新账号默认关闭同步");
assert.deepEqual(store.getAiringOffsetsSnapshot(), {}, "guest 不读取旧账号偏置");
await store.setAiringOffsetDays(99, 1);
await store.setAiringOffsetAccount("alice");
assert.deepEqual(store.getAiringOffsetsSnapshot(), { 10:-2, 20:3, 99:1 }, "仅首个正式账号继承 legacy 和迁移前 guest 编辑");
assert.equal(disk.get(legacy), backup, "legacy 备份绝不改写");
assert.deepEqual((await store.readAiringOffsetAccountState(null)).records, {}, "首次迁移清空 guest");
assert.equal(store.getAiringOffsetAccount(), "alice");
const migrated = await store.readAiringOffsetAccountState("alice");
assert.equal(migrated.syncEnabled, false, "迁移旧偏置不自动启用同步");
assert.equal(migrated.records[10].days, -2);
assert.match(migrated.records[10].revision, /^[0-9a-f-]{36}$/i);
assert(Number.isSafeInteger(migrated.records[10].updatedAt));
await store.setAiringOffsetAccount("bob");
assert.deepEqual(store.getAiringOffsetsSnapshot(), {});
await store.setAiringOffsetDays(10, 5);
await store.setAiringOffsetAccount(null);
assert.deepEqual(store.getAiringOffsetsSnapshot(), {}, "登出不泄露刚登出账号数据");
await store.setAiringOffsetDays(77, 7);
await store.setAiringOffsetAccount("alice");
assert.deepEqual(store.getAiringOffsetsSnapshot(), { 10:-2, 20:3, 99:1 });
await store.setAiringOffsetAccount("bob");
assert.deepEqual(store.getAiringOffsetsSnapshot(), { 10:5 });
const reopened = await load();
await reopened.setAiringOffsetAccount("alice");
assert.deepEqual(reopened.getAiringOffsetsSnapshot(), { 10:-2, 20:3, 99:1 }, "重启恢复账号数据和 legacy owner");
await reopened.setAiringOffsetAccount(null);
assert.deepEqual(reopened.getAiringOffsetsSnapshot(), { 77:7 }, "guest 保持独立");
assert.equal(disk.get(legacy), backup);
for (const username of ["Alice", "alice ", "__proto__"]) {
  await reopened.setAiringOffsetAccount(username);
  assert.deepEqual(reopened.getAiringOffsetsSnapshot(), {}, "username 精确隔离，不 trim、改大小写或按昵称归并");
  reopened.setAiringOffsetDays(10, 12);
}
await reopened.setAiringOffsetAccount("alice");
assert.equal(reopened.getAiringOffsetsSnapshot()[10], -2);
// 零值是可同步的删除意图，缺失 record 也必须产生版本。
await store.setAiringOffsetAccount("alice");
const flatBeforeZero = store.getAiringOffsetsSnapshot();
let flatEvents = 0;
let stateEvents = 0;
const stopFlat = store.subscribeAiringOffsets(() => flatEvents++);
const stopState = store.subscribeAiringOffsetState(() => stateEvents++);
const beforeZero = Date.now();
await store.setAiringOffsetDays(123, 0);
const tombstone = (await store.readAiringOffsetAccountState("alice")).records[123];
assert.equal(tombstone.days, 0);
assert.match(tombstone.revision, /^[0-9a-f-]{36}$/i);
assert(tombstone.updatedAt >= beforeZero && tombstone.updatedAt <= Date.now());
assert.strictEqual(store.getAiringOffsetsSnapshot(), flatBeforeZero, "新增 tombstone 不改变 UI map 引用");
assert.equal(flatEvents, 0);
assert.equal(stateEvents, 1, "metadata-only 更新通知同步订阅者");
await store.setAiringOffsetDays(123, 0);
assert.notEqual((await store.readAiringOffsetAccountState("alice")).records[123].revision, tombstone.revision, "再次恢复默认产生新的删除意图");
stopFlat(); stopState();
// 同步确认可原子写 records/base/time，不能替换远端 revision 或让无关账号污染 UI。
let metadataEvents = 0;
const stopMetadata = store.subscribeAiringOffsetState(() => metadataEvents++);
const beforeMetadata = store.getAiringOffsetsSnapshot();
const remoteRecord = { days: -2, revision: "remote-confirmed", updatedAt: 12 };
const proposed = { records: { 10: remoteRecord }, bases: { endpoint1: { 10: remoteRecord } }, syncedAt: { endpoint1: 42 } };
await store.updateAiringOffsetAccountState("alice", () => proposed);
assert.deepEqual(store.getAiringOffsetsSnapshot(), { 10:-2 });
const sameProjection = store.getAiringOffsetsSnapshot();
const state1 = await store.readAiringOffsetAccountState("alice");
assert.equal(state1.records[10].revision, "remote-confirmed");
assert.equal(state1.syncedAt.endpoint1, 42);
assert.equal(state1.bases.endpoint1[10].revision, "remote-confirmed");
remoteRecord.days = 100;
proposed.syncedAt.endpoint1 = 900;
assert.equal((await store.readAiringOffsetAccountState("alice")).records[10].days, -2, "输入对象不可在保存后修改数据库");
assert.equal(state1.syncedAt.endpoint1, 42);
for (const mutate of [
  () => { state1.records[10].days = 20; },
  () => { state1.bases.endpoint1[10].revision = "changed"; },
  () => { state1.syncedAt.endpoint1 = 100; },
  () => { state1.records = {}; },
]) assert.throws(mutate, TypeError, "公开状态深层不可变");
await store.updateAiringOffsetAccountState("alice", current => ({ ...current, syncedAt: { endpoint1: 43 } }));
assert.strictEqual(store.getAiringOffsetsSnapshot(), sameProjection, "确认时间变化不改变 UI map 引用");
assert.equal(metadataEvents, 2);
const savedWrites = io.writes;
await store.updateAiringOffsetAccountState("alice", current => current);
assert.equal(metadataEvents, 2, "无变化同步确认不重复通知");
assert.equal(io.writes, savedWrites);
await store.updateAiringOffsetAccountState("bob", current => ({ ...current, syncedAt: { endpoint2: 60 } }));
assert.strictEqual(store.getAiringOffsetsSnapshot(), sameProjection, "其他账号 metadata 不改变当前 UI");
const persisted = await load();
assert.deepEqual(await persisted.readAiringOffsetAccountState("alice"), await store.readAiringOffsetAccountState("alice"), "重启后 records/base/time 一起恢复");
const afterMetadata = await store.readAiringOffsetAccountState("alice");
io.failWrites = true;
await assert.rejects(store.updateAiringOffsetAccountState("alice", current => ({ ...current, records: {}, bases: {}, syncedAt: {} })), /write/);
assert.deepEqual(await store.readAiringOffsetAccountState("alice"), afterMetadata, "失败不能半提交 metadata 或 records");
assert.strictEqual(store.getAiringOffsetsSnapshot(), sameProjection);
assert.equal(metadataEvents, 3);
io.failWrites = false;
stopMetadata();
assert.notStrictEqual(beforeMetadata, sameProjection);

// 异步切账号尚未提交时，本地同步保存仍属于调用时账号；快速切换只发布最后 scope。
const switching = store.setAiringOffsetAccount("bob");
assert.equal(store.setAiringOffsetDays(999, 8), undefined);
assert.equal(JSON.parse(disk.get(store.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY)).accounts["account:alice"].records[999].days, 8, "同步保存返回前落盘，不等待账号切换队列");
await switching;
assert.equal(store.getAiringOffsetAccount(), "bob");
assert.deepEqual(store.getAiringOffsetsSnapshot(), { 10:5 });
assert.equal((await store.readAiringOffsetAccountState("alice")).records[999].days, 8);
assert.equal((await store.readAiringOffsetAccountState("bob")).records[999], undefined);
assert.deepEqual(store.getAiringOffsetsSnapshot(), { 10:5 }, "迟到保存不能发布旧账号到当前 UI");
const visible = [];
const stopScope = store.subscribeAiringOffsets(() => visible.push(store.getAiringOffsetAccount()));
await Promise.all([store.setAiringOffsetAccount("alice"), store.setAiringOffsetAccount("bob"), store.setAiringOffsetAccount(null)]);
assert.equal(store.getAiringOffsetAccount(), null);
assert.deepEqual(store.getAiringOffsetsSnapshot(), { 77:7 });
assert.deepEqual(visible, [null], "A→B→guest 不能中途发布过期账号");
stopScope();
assert.equal(io.max, 1, "跨账号更新也串行持久化");

// 首次迁移的失败可重试：绝不能改写旧备份或把 owner 半提交到内存。
disk.clear(); disk.set(legacy, backup);
const migration = await load();
await migration.setAiringOffsetDays(50, 2);
const beforeMigration = new Map(disk);
io.failWrites = true;
await assert.rejects(migration.setAiringOffsetAccount("first-attempt"), /write/);
assert.equal(migration.getAiringOffsetAccount(), null);
assert.deepEqual(migration.getAiringOffsetsSnapshot(), { 50:2 });
assert.deepEqual(disk, beforeMigration, "单次失败不能留下半迁移磁盘状态");
io.failWrites = false;
io.failReadKey = legacy;
await assert.rejects(migration.setAiringOffsetAccount("retry"), /read/);
await assert.rejects(migration.setAiringOffsetAccount("retry"), /read/);
assert.deepEqual(disk, beforeMigration, "旧数据未读到时不能以空 records 完成迁移");
io.failReadKey = null;
await migration.setAiringOffsetAccount("retry");
assert.deepEqual(migration.getAiringOffsetsSnapshot(), { 10:-2, 20:3, 50:2 });
assert.deepEqual((await migration.readAiringOffsetAccountState(null)).records, {});
assert.equal(disk.get(legacy), backup);
assert.equal(disk.size, 2, "全部 metadata 和 owner 只需一个 canonical key");
const canonicalKey = migration.AIRING_OFFSET_ACCOUNTS_STORAGE_KEY;
assert.equal(JSON.parse(disk.get(canonicalKey)).legacyOwner, "retry");
const migratedRestart = await load();
await migratedRestart.setAiringOffsetAccount("first-attempt");
assert.deepEqual(migratedRestart.getAiringOffsetsSnapshot(), {}, "失败的首次账号不是 legacy owner，重启不重复迁移");

// 初始化失败、损坏数据库与迟到读取：不允许用空数据覆盖未知磁盘数据。
const validDatabase = disk.get(canonicalKey);
const initialFailure = await load();
io.failReads = true;
await initialFailure.initializeAiringOffsets();
assert.throws(() => initialFailure.setAiringOffsetDays(1, 1), /read/);
assert.equal(disk.get(canonicalKey), validDatabase);
io.failReads = false;
await initialFailure.setAiringOffsetAccount("retry");
assert.deepEqual(initialFailure.getAiringOffsetsSnapshot(), { 10:-2, 20:3, 50:2 });
for (const corrupt of ["broken", "[]", '{"version":2,"accounts":{},"legacyOwner":null}', '{"version":1,"accounts":{"guest":{"records":{},"bases":{}}},"legacyOwner":null}']) {
  disk.set(canonicalKey, corrupt);
  const damaged = await load();
  await damaged.initializeAiringOffsets();
  assert.throws(() => damaged.setAiringOffsetDays(1, 1));
  await assert.rejects(damaged.setAiringOffsetAccount("retry"));
  assert.equal(disk.get(canonicalKey), corrupt, "格式损坏不允许空覆盖");
  disk.set(canonicalKey, validDatabase);
  await damaged.setAiringOffsetAccount("retry");
  assert.deepEqual(damaged.getAiringOffsetsSnapshot(), { 10:-2, 20:3, 50:2 }, "格式恢复后仍可重试");
}
const coldRace = await load();
const warm = coldRace.initializeAiringOffsets();
const accounts = [coldRace.setAiringOffsetAccount("retry"), coldRace.setAiringOffsetAccount(null), coldRace.setAiringOffsetAccount("final")];
const guestSave = coldRace.setAiringOffsetDays(80, -8);
await Promise.all([warm, ...accounts, guestSave]);
assert.equal(coldRace.getAiringOffsetAccount(), "final");
assert.deepEqual(coldRace.getAiringOffsetsSnapshot(), {}, "迟到初始化和旧 scope 保存均不能回滚当前账号");
assert.equal((await coldRace.readAiringOffsetAccountState(null)).records[80].days, -8);
assert.equal((await coldRace.readAiringOffsetAccountState("final")).records[80], undefined);
// 首次登录前的 guest 编辑也必须迁入；优先级按来源，不比较时间戳。
disk.clear();
const guestLegacy = '{"1":1,"3":1,"4":1,"5":1}';
disk.set(legacy, guestLegacy);
const guestMigration = await load();
await guestMigration.setAiringOffsetDays(1, 2);
await guestMigration.setAiringOffsetDays(2, 2);
await guestMigration.setAiringOffsetDays(3, 0);
await guestMigration.setAiringOffsetDays(4, 2);
const guestEdits = await guestMigration.readAiringOffsetAccountState(null);
const targetExisting = {
  records: {
    4: { days: 4, revision: "existing-alice-four", updatedAt: 1 },
    5: { days: 0, revision: "existing-alice-zero", updatedAt: 1 },
  },
  bases: { endpoint: { 4: { days: 4, revision: "existing-base", updatedAt: 1 } } },
  syncedAt: { endpoint: 1 },
};
await guestMigration.updateAiringOffsetAccountState("alice", () => targetExisting);
const writesBeforeGuestMigration = io.writes;
await guestMigration.setAiringOffsetAccount("alice");
assert.deepEqual(guestMigration.getAiringOffsetsSnapshot(), { 1:2, 2:2, 4:4 }, "guest 新建和修改覆盖 legacy；目标账号已有记录优先");
const mergedGuest = await guestMigration.readAiringOffsetAccountState("alice");
assert.deepEqual(mergedGuest.records[1], guestEdits.records[1], "guest 修改保留原 revision 和时间");
assert.deepEqual(mergedGuest.records[2], guestEdits.records[2], "guest 新建条目迁入账号");
assert.deepEqual(mergedGuest.records[3], guestEdits.records[3], "guest 零值 tombstone 覆盖 legacy 非零值");
assert.deepEqual(mergedGuest.records[4], targetExisting.records[4], "已有目标账号记录覆盖 guest");
assert.deepEqual(mergedGuest.records[5], targetExisting.records[5], "已有目标账号 tombstone 覆盖 legacy");
assert.deepEqual(mergedGuest.bases, targetExisting.bases);
assert.deepEqual(mergedGuest.syncedAt, targetExisting.syncedAt);
assert.deepEqual((await guestMigration.readAiringOffsetAccountState(null)).records, {});
assert.equal(io.writes - writesBeforeGuestMigration, 1, "guest 合并、清空和 owner 仍一次原子提交");
assert.equal(disk.get(legacy), guestLegacy, "合并 guest 不改旧备份");
const guestRestart = await load();
await guestRestart.setAiringOffsetAccount("alice");
assert.deepEqual(await guestRestart.readAiringOffsetAccountState("alice"), mergedGuest, "guest 编辑和 tombstone 重启仍保留");
await guestRestart.setAiringOffsetAccount(null);
assert.deepEqual(guestRestart.getAiringOffsetsSnapshot(), {}, "首次迁移后 guest 为空且登出不显示 Alice 数据");
assert.equal(JSON.parse(disk.get(canonicalKey)).legacyOwner, "alice");
// 本地开关向后兼容旧数据库；纯元数据保存不重发 offsetMap，且与 records/base/time 一起保留。
disk.clear();
const oldState = { records: { 1: { days: 2, revision: "old-record", updatedAt: 1 } }, bases: { oldTarget: {} }, syncedAt: { oldTarget: 5 } };
disk.set(canonicalKey, JSON.stringify({ version: 1, legacyOwner: "alice", accounts: { "account:alice": oldState } }));
const preferenceStore = await load();
await preferenceStore.setAiringOffsetAccount("alice");
assert.equal((await preferenceStore.readAiringOffsetAccountState("alice")).syncEnabled, false, "缺失开关字段的旧账号默认关闭");
assert.equal((await preferenceStore.readAiringOffsetAccountState("bob")).syncEnabled, false);
const preferenceMap = preferenceStore.getAiringOffsetsSnapshot();
let preferenceFlatEvents = 0, preferenceStateEvents = 0;
const stopPreferenceFlat = preferenceStore.subscribeAiringOffsets(() => preferenceFlatEvents++);
const stopPreferenceState = preferenceStore.subscribeAiringOffsetState(() => preferenceStateEvents++);
await preferenceStore.updateAiringOffsetAccountState("alice", current => ({ ...current, syncEnabled: true }));
assert.strictEqual(preferenceStore.getAiringOffsetsSnapshot(), preferenceMap, "纯开关不改变 offsetMap 引用");
assert.equal(preferenceFlatEvents, 0);
assert.equal(preferenceStateEvents, 1);
assert.deepEqual(await preferenceStore.readAiringOffsetAccountState("alice"), { ...oldState, syncEnabled: true });
const preferenceRestart = await load();
assert.equal((await preferenceRestart.readAiringOffsetAccountState("alice")).syncEnabled, true, "重启恢复账号开关");
assert.equal((await preferenceRestart.readAiringOffsetAccountState("bob")).syncEnabled, false, "开关不跨账号");
io.failWrites = true;
await assert.rejects(preferenceStore.updateAiringOffsetAccountState("alice", current => ({ ...current, syncEnabled: false })), /write/);
io.failWrites = false;
assert.equal((await preferenceStore.readAiringOffsetAccountState("alice")).syncEnabled, true, "开关写入失败不改变内存");
assert.equal(preferenceStateEvents, 1);
assert.strictEqual(preferenceStore.getAiringOffsetsSnapshot(), preferenceMap);
for (const syncEnabled of [null, 1, "true", {}, [], undefined]) {
  await assert.rejects(preferenceStore.updateAiringOffsetAccountState("alice", current => ({ ...current, syncEnabled })), /开关/, "非法开关类型拒绝落盘");
}
stopPreferenceFlat(); stopPreferenceState();
for (const syncEnabled of [null, 1, "true", {}, []]) {
  const malformed = JSON.stringify({ version: 1, legacyOwner: "alice", accounts: { "account:alice": { ...oldState, syncEnabled } } });
  disk.set(canonicalKey, malformed);
  const invalidPreference = await load();
  await assert.rejects(invalidPreference.readAiringOffsetAccountState("alice"), /开关/);
  assert.throws(() => invalidPreference.setAiringOffsetDays(1, 1), /开关/);
  assert.equal(disk.get(canonicalKey), malformed, "非法开关数据库不能被覆盖");
}
console.log("airing offset accounts: 隔离、原子迁移、guest 编辑、tombstone、metadata、并发、失败重试与本地开关通过 ✓");
