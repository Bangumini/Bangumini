// 收藏 worker 重复跳组回归测试：只替换真实模块的外部依赖，不复制 worker 算法。
// 运行：node --experimental-strip-types scripts/test-collection-worker.mjs（Node >= 22.6）
// 当前生产实现可能失败；收集全部失败后退出非零，不把已知回退标成预期通过。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { sortCollections } from "../shared/sort-collections.ts";

const USER = "worker-test-user";
const SUBJECT = 7;
const TYPES = [1, 2, 3, 4, 5];
const BASE = { username: USER, subjectId: SUBJECT, subjectTitle: "测试条目", previousType: 3 };
const originalGlobals = new Map(["window", "document"].map((name) => [
  name, Object.getOwnPropertyDescriptor(globalThis, name),
]));
let tempDir;
let active;
let caseNumber = 0;
let passed = 0;
let failed = 0;

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function collection(type = 3, ep_status = 1) {
  return {
    subject_id: SUBJECT, subject_type: 2, type, ep_status, vol_status: 0,
    rate: 0, private: false, tags: [], comment: "", updated_at: "2020-01-01T00:00:00Z",
    subject: {
      id: SUBJECT, type: 2, name: "Worker fixture", name_cn: "测试条目",
      eps: 2, total_episodes: 2, date: "2020-01-01", air_weekday: 3,
    },
  };
}

function page(data) {
  return { data, total: data.length, limit: 30, offset: 0 };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// 没有 sleep 或真实 retry timer；有界 microtask 屏障只负责报告测试装配错误。
async function until(predicate, label) {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`未到达确定性屏障：${label}`);
}

function stateOf(value) {
  if (!value) return { type: null, ep_status: null, group: "absent" };
  // 不模拟分组：使用仓库真实排序器，空日历使 fixture 与当天日期/时区无关。
  const [{ group }] = sortCollections([value], [], 3, new Map());
  return { type: value.type, ep_status: value.ep_status, group };
}

function formatState(state) {
  return `type=${state.type ?? "∅"} ep_status=${state.ep_status ?? "∅"} group=${state.group}`;
}

function createHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  const events = new EventTarget();
  const tasks = new Map();
  const cacheValues = new Map();
  const expected = [];
  const unexpected = [];
  const trace = [];
  const updates = [];
  const taskEvents = [];
  const timers = new Map();
  const gates = [];
  const runs = [];
  let clock = 1_700_000_000_000;
  let timerId = 0;
  let recoveries = 0;
  let loggedIn = false;
  let stage = "初始化";
  const clone = (value) => structuredClone(value);
  const ordered = () => [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt);
  const taskAt = (id) => {
    assert.ok(tasks.has(id), `不存在的任务：${id}`);
    return tasks.get(id);
  };
  const sqlite = {
    async upsertPersistentCollectionTask(input) {
      const old = tasks.get(input.id);
      const now = ++clock;
      const task = {
        ...clone(input), status: "pending", attemptCount: 0, lastError: null,
        runAfter: 0, createdAt: old?.createdAt ?? now, updatedAt: now,
      };
      tasks.set(task.id, task);
      return clone(task);
    },
    async readPersistentCollectionTasks() { return clone(ordered()); },
    async readDuePersistentCollectionTask() {
      return clone(ordered().find((task) => ["pending", "failed"].includes(task.status) && task.runAfter <= Date.now()) ?? null);
    },
    async readNextPersistentCollectionTaskRunAt() {
      const pending = ordered().filter((task) => ["pending", "failed"].includes(task.status));
      return pending.length ? Math.min(...pending.map((task) => task.runAfter)) : null;
    },
    async markPersistentCollectionTaskRunning(id) {
      Object.assign(taskAt(id), { status: "running", updatedAt: ++clock });
    },
    async markPersistentCollectionTaskFailed(id, error, runAfter) {
      const task = taskAt(id);
      Object.assign(task, { status: "failed", attemptCount: task.attemptCount + 1, lastError: error, runAfter, updatedAt: ++clock });
      unexpected.push(`worker 失败：${error}`);
    },
    async completePersistentCollectionTask(id) { return tasks.delete(id); },
    async deletePersistentCollectionTask(id) { tasks.delete(id); },
    async retryPersistentCollectionTask(id) {
      Object.assign(taskAt(id), { status: "pending", runAfter: 0, lastError: null, updatedAt: ++clock });
    },
    async recoverRunningPersistentCollectionTasks() {
      for (const task of tasks.values()) {
        if (task.status === "running") Object.assign(task, { status: "pending", runAfter: 0, updatedAt: ++clock });
      }
      recoveries += 1;
    },
    async writeCachedCollection(username, value) { cacheValues.set(`collection:${username}:${value.subject_id}`, clone(value)); },
    async writeCachedEpisodes(id, value) { cacheValues.set(`episodes:${id}`, clone(value)); },
    async readCachedValueEntryAllowStale(key) {
      return cacheValues.has(key) ? { payload: clone(cacheValues.get(key)), isStale: false } : null;
    },
    async writeCachedValue(key, value) { cacheValues.set(key, clone(value)); },
  };
  const browser = {
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout(callback, delay) {
      // window timer 只登记，不运行/不持有 Node 句柄；成功场景不应安排重试。
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const h = {
    client, browser, sqlite, trace, updates, taskEvents, tasks, runs,
    isLoggedIn: () => loggedIn,
    setLoggedIn(value) { loggedIn = value; },
    async api(name, args) {
      trace.push(`API ${name} ${JSON.stringify(args)}`);
      const next = expected.shift();
      try {
        assert.ok(next, `未预期 API：${name}`);
        assert.equal(name, next.name, "API 顺序");
        assert.deepEqual(args, next.args, `API ${name} 参数`);
        if (next.gate) {
          next.gate.entered = true;
          trace.push(`屏障 ${next.gate.label}：响应已捕获，等待释放`);
          await next.gate.release.promise;
        }
        stage = `API ${name} 返回${next.value?.subject_id ? ` type=${next.value.type} ep_status=${next.value.ep_status}` : ""}`;
        return clone(next.value);
      } catch (error) {
        unexpected.push(error.message);
        throw error;
      }
    },
    async invoke(...args) {
      unexpected.push(`不应调用 Tauri API：${JSON.stringify(args)}`);
      throw new Error("测试禁止实际 IPC");
    },
    expect(name, args, value, gate) { expected.push({ name, args, value, gate }); },
    gate(label) {
      const gate = { label, entered: false, release: deferred() };
      gates.push(gate);
      return gate;
    },
    stage(label) { stage = label; trace.push(`阶段 ${label}`); },
    async start(worker) {
      events.addEventListener(worker.COLLECTION_TASK_EVENT, ({ detail }) => {
        taskEvents.push(clone(detail));
        trace.push(`TASK ${detail.status} ${detail.kind} nextType=${detail.nextType}`);
      });
      worker.startCollectionTaskWorker(client);
      await until(() => recoveries === 1, "启动恢复");
      // 等待 start 的 .then/kick 收尾；登录门关闭，没有 API/worker 竞争。
      await Promise.resolve();
    },
    kick(worker) {
      loggedIn = true;
      const run = worker.kickCollectionTaskWorker();
      runs.push(run);
      return run;
    },
    checkInfrastructure() {
      assert.deepEqual(unexpected, [], "隔离环境/worker 不应有额外错误");
      assert.equal(expected.length, 0, "应消费全部 API 预期");
      assert.equal(tasks.size, 0, "成功后任务队列应排空");
      assert.equal(timers.size, 0, "成功场景不应遗留重试 timer");
      assert.equal(taskEvents.filter((event) => event.status === "failed").length, 0);
    },
    async cleanup() {
      loggedIn = false;
      for (const gate of gates) gate.release.resolve();
      await Promise.allSettled(runs);
      unsubscribe();
      client.clear();
      timers.clear();
    },
  };
  const initial = collection();
  client.setQueryData(["collection", SUBJECT], initial);
  for (const type of TYPES) {
    const value = page(type === initial.type ? [initial] : []);
    client.setQueryData(["collections", String(type), USER], value);
    cacheValues.set(`collections-${type}-${USER}`, clone(value));
  }
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const key = event.query.queryKey;
    if (!["collection", "collections"].includes(key[0])) return;
    const value = event.query.state.data;
    const item = key[0] === "collection" ? value : value?.data.find((entry) => entry.subject_id === SUBJECT);
    const update = { index: updates.length + 1, key: [...key], action: event.action.type, stage, ...stateOf(item) };
    updates.push(update);
    trace.push(`CACHE #${update.index} ${key[0] === "collection" ? "单条" : `列表${key[1]}`} ${formatState(update)} [${stage}; ${update.action}]`);
  });
  return h;
}

function assertNoRegression(h, begin, target) {
  const relevant = h.updates.slice(begin).filter((update) => update.type !== null);
  assert.ok(relevant.some((update) => update.key[0] === "collection"), "应观察到 worker 更新单条缓存");
  assert.ok(relevant.some((update) => update.key[0] === "collections"), "应观察到 worker 更新列表缓存");
  const regressions = h.updates.slice(begin).filter((update) => {
    const shouldContain = update.key[0] === "collection" || update.key[1] === String(target.type);
    return shouldContain
      ? Object.entries(target).some(([key, value]) => update[key] !== value)
      : update.type !== null;
  });
  assert.equal(regressions.length, 0, `乐观目标被覆盖（${regressions.length} 次），首次 CACHE #${regressions[0]?.index}：${regressions[0] ? formatState(regressions[0]) : "无"}`);
}

async function test(name, run) {
  const h = createHarness();
  active = h;
  caseNumber += 1;
  try {
    // 每个用例重新加载真实 worker，隔离 queryClient/workerRunning 等模块状态。
    const worker = await import(pathToFileURL(join(tempDir, "collection-tasks.ts")).href + `?case=${caseNumber}`);
    await h.start(worker);
    await run(h, worker);
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`\n✗ ${name}\n${h.trace.join("\n")}\n断言失败：${error.stack}`);
  } finally {
    await h.cleanup();
    active = undefined;
  }
}

try {
  tempDir = await mkdtemp(join(tmpdir(), "bangumini-collection-worker-test-"));
  let source = await readFile(new URL("../src/api/collection-tasks.ts", import.meta.url), "utf8");
  const stubNames = new Set();
  // 所有运行时依赖都必须显式分类；新增依赖时失败关闭，避免悄悄接入真实 API/DB。
  source = source.replace(/import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/g, (statement, typeOnly, bindings, dependency) => {
    if (typeOnly) return statement;
    if (dependency === "@shared/collection-cache") {
      return statement.replace(`"${dependency}"`, JSON.stringify(new URL("../shared/collection-cache.ts", import.meta.url).href));
    }
    assert.ok(["@tauri-apps/api/core", "./oauth", "@shared/api/client", "@shared/storage/sqlite-cache"].includes(dependency), `未分类的运行时依赖：${dependency}`);
    for (const name of bindings.replace(/[{}]/g, "").split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!name.startsWith("type ")) stubNames.add(name);
    }
    return statement.replace(`"${dependency}"`, '"./stubs.mjs"');
  });
  const exports = [...stubNames].map((name) => `export const ${name} = (...args) => dispatch(${JSON.stringify(name)}, args);`).join("\n");
  await Promise.all([
    writeFile(join(tempDir, "package.json"), '{"type":"module"}\n'),
    writeFile(join(tempDir, "collection-tasks.ts"), source),
    writeFile(join(tempDir, "stubs.mjs"), `let dispatch;\nexport function connect(value) { dispatch = value; }\n${exports}\n`),
  ]);
  const stubs = await import(pathToFileURL(join(tempDir, "stubs.mjs")).href);
  stubs.connect((name, args) => {
    assert.ok(active, `用例外的依赖调用：${name}`);
    if (name === "isLoggedIn") return active.isLoggedIn();
    if (name === "invoke") return active.invoke(...args);
    if (Object.hasOwn(active.sqlite, name)) return active.sqlite[name](...args);
    assert.ok(["getEpisodes", "getUserCollection", "patchSubjectEpisodes", "postUserCollection"].includes(name), `未支持的 stub：${name}`);
    return active.api(name, args);
  });
  // globals 只覆盖 window/document；不读取宿主凭据，也不加载真实 OAuth/IPC/SQLite。
  // 每次 start 使用独立 EventTarget，online/focus listener 不会跨用例残留。
  // 在导入/启动前安装 globals，使用当前用例对象分发。
  setGlobal("window", {
    addEventListener: (...args) => active.browser.addEventListener(...args),
    dispatchEvent: (...args) => active.browser.dispatchEvent(...args),
    setTimeout: (...args) => active.browser.setTimeout(...args),
    clearTimeout: (...args) => active.browser.clearTimeout(...args),
  });
  setGlobal("document", { hasFocus: () => true });

  await test("markWatched：乐观 type=2 不得被 worker 的 type=3 中间结果覆盖", async (h, worker) => {
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("getEpisodes", [SUBJECT], page([{ id: 101, type: 0, sort: 1 }, { id: 102, type: 0, sort: 2 }]));
    h.expect("patchSubjectEpisodes", [SUBJECT, { episode_id: [102], type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 2));
    h.expect("postUserCollection", [SUBJECT, { type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 2));
    h.stage("enqueue complete-progress，目标 type=2 ep_status=2");
    const task = await worker.enqueueCompleteProgressTask({ ...BASE, targetEp: 2, totalEp: 2, ensureWatching: false, markWatched: true });
    assert.equal(task.status, "pending");
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", SUBJECT])), { type: 2, ep_status: 2, group: "completed" });
    const begin = h.updates.length;
    await h.kick(worker);
    h.checkInfrastructure();
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", SUBJECT])), { type: 2, ep_status: 2, group: "completed" });
    assertNoRegression(h, begin, { type: 2, ep_status: 2, group: "completed" });
  });

  await test("ensureWatching：旧进度不得把 completed 拉回 finished_started", async (h, worker) => {
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("getEpisodes", [SUBJECT], page([{ id: 101, type: 0, sort: 1 }, { id: 102, type: 0, sort: 2 }]));
    h.expect("patchSubjectEpisodes", [SUBJECT, { episode_id: [102], type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 2));
    h.stage("enqueue complete-progress，目标 type=3 ep_status=2，ensureWatching=true");
    await worker.enqueueCompleteProgressTask({ ...BASE, targetEp: 2, totalEp: 2, ensureWatching: true, markWatched: false });
    const target = { type: 3, ep_status: 2, group: "completed" };
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", SUBJECT])), target);
    const begin = h.updates.length;
    await h.kick(worker);
    h.checkInfrastructure();
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", SUBJECT])), target);
    assertNoRegression(h, begin, target);
  });

  await test("运行旧任务时新任务入队：迟到 type=2 响应不得覆盖新目标 type=5", async (h, worker) => {
    const oldResponse = h.gate("旧任务最终 GET");
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("postUserCollection", [SUBJECT, { type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 1), oldResponse);
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 1));
    h.expect("postUserCollection", [SUBJECT, { type: 5 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(5, 1));
    h.stage("enqueue 旧目标 type=2");
    const oldTask = await worker.enqueueSetCollectionTypeTask({ ...BASE, nextType: 2 });
    const running = h.kick(worker);
    await until(() => oldResponse.entered, "旧任务已 running 且 GET 响应未交付");
    assert.equal((await worker.getCollectionTaskQueue()).find((task) => task.id === oldTask.id)?.status, "running");
    h.stage("旧响应被屏障阻塞时 enqueue 新目标 type=5");
    const newTask = await worker.enqueueSetCollectionTypeTask({ ...BASE, previousType: 2, nextType: 5 });
    assert.notEqual(newTask.id, oldTask.id, "running 任务的新目标必须独立入队");
    assert.equal(newTask.status, "pending");
    assert.equal((await worker.getCollectionTaskQueue()).length, 2);
    const target = { type: 5, ep_status: 1, group: "finished_started" };
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", SUBJECT])), target);
    const begin = h.updates.length;
    h.stage("释放旧任务 type=2 响应；新任务仍 pending");
    oldResponse.release.resolve();
    await running;
    h.checkInfrastructure();
    assert.equal(h.taskEvents.filter((event) => event.status === "finished").length, 2);
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", SUBJECT])), target);
    assertNoRegression(h, begin, target);
  });

  await test("对照：单个收藏类型任务在服务端确认同一目标时不发生回退", async (h, worker) => {
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("postUserCollection", [SUBJECT, { type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 1));
    h.stage("enqueue 单个目标 type=2");
    await worker.enqueueSetCollectionTypeTask({ ...BASE, nextType: 2 });
    const target = { type: 2, ep_status: 1, group: "finished_started" };
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", SUBJECT])), target);
    const begin = h.updates.length;
    await h.kick(worker);
    h.checkInfrastructure();
    assertNoRegression(h, begin, target);
  });

  console.log(`\nCollection worker：${passed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
} finally {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
