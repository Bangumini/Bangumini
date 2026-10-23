// 通过真实聚合 loader 的接缝控制外部 IO，验证两个阶段及迟到响应保护。
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { QueryClient } from "@tanstack/react-query";

const directory = await mkdtemp(path.join(tmpdir(), "bangumini-detail-batch-"));
const clients = [];
try {
  const source = await readFile(new URL("../src/hooks/subject-detail-loader.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("loader.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set();
  let isolated = source;
  const mocksUrl = pathToFileURL(path.join(directory, "mocks.mjs")).href;
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    for (const binding of statement.importClause?.namedBindings?.elements ?? []) {
      if (!binding.isTypeOnly) names.add(binding.propertyName?.text ?? binding.name.text);
    }
    isolated = isolated.replaceAll(JSON.stringify(statement.moduleSpecifier.text), JSON.stringify(mocksUrl));
  }
  await writeFile(path.join(directory, "mocks.mjs"), [...names].map(name => `export const ${name} = () => { throw new Error("未替换外部 IO: ${name}"); };`).join("\n"));
  await writeFile(path.join(directory, "loader.mjs"), ts.transpileModule(isolated, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText);
  const { loadSubjectDetailData, DETAIL_CACHE_MAX_AGE } = await import(pathToFileURL(path.join(directory, "loader.mjs")).href);
  const subject = (id, title = "缓存条目") => ({ id, type: 2, name: title, name_cn: title, summary: "简介", infobox: [], images: {}, eps: 12, total_episodes: 12 });
  const base = { subject: subject(1), collection: { subject_id: 1, type: 3, ep_status: 2, subject: subject(1) },
    episodes: { data: [{ id: 1, ep: 1, sort: 1, type: 0, airdate: "2026-01-01" }], total: 1, limit: 100, offset: 0 },
    persons: [{ id: 2, name: "缓存制作人员", relation: "导演" }], characters: [],
    relations: [{ id: 3, type: 3, name: "OP", relation: "片头曲" }] };
  const artist = (id, text) => ({ ...subject(id), type: 3, infobox: [{ key: "艺术家", value: text }] });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  function harness() {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    clients.push(client);
    const calls = [], writes = [], pending = new Map();
    let diskCollection = structuredClone(base.collection);
    const request = (name, args) => {
      const key = JSON.stringify([name, ...args]);
      assert.ok(!pending.has(key), `重复请求 ${key}`);
      let resolve, reject;
      const promise = new Promise((a, b) => { resolve = a; reject = b; });
      pending.set(key, { resolve, reject }); calls.push(key);
      return promise;
    };
    const respond = (name, args, value, failure = false) => {
      const key = JSON.stringify([name, ...args]);
      const gate = pending.get(key);
      assert.ok(gate, `没有对应的挂起请求 ${key}`);
      pending.delete(key); gate[failure ? "reject" : "resolve"](value);
    };
    const deps = {
      readSubjectWithin: async () => null, readSubject: async id => id === 1 ? structuredClone(base.subject) : id === 3 ? artist(3, "缓存歌手") : null,
      readCollectionWithin: async () => null, readCollection: async () => structuredClone(diskCollection),
      readEpisodesWithin: async () => null, readEpisodes: async () => structuredClone(base.episodes),
      readPersonsWithin: async () => null, readPersons: async () => structuredClone(base.persons),
      readCharactersWithin: async () => null, readCharacters: async () => [],
      readRelationsWithin: async () => null, readRelations: async () => structuredClone(base.relations),
      readPendingPatch: async () => null,
      getSubject: id => request("subject", [id]), getCollection: (u, id) => request("collection", [id]),
      getEpisodes: id => request("episodes", [id]), getPersons: id => request("persons", [id]),
      getCharacters: id => request("characters", [id]), getRelations: id => request("relations", [id]),
      writeSubject: async value => { writes.push(["subject", value]); return value; },
      writeCollection: async (_u, value) => { writes.push(["collection", value]); diskCollection = value; },
      deleteCollection: async () => { writes.push(["delete-collection"]); diskCollection = null; },
      writeEpisodes: async (_id, value) => { writes.push(["episodes", value]); },
      writePersons: async (_id, value) => { writes.push(["persons", value]); },
      writeCharacters: async (_id, value) => { writes.push(["characters", value]); },
      writeRelations: async (_id, value) => { writes.push(["relations", value]); },
    };
    return { client, calls, writes, deps, respond, pending,
      setConfirmed(value) { diskCollection = value; client.setQueryData(["collection", 1], value); },
      get diskCollection() { return diskCollection; },
      load: () => loadSubjectDetailData({ subjectId: 1, username: "fixture", queryClient: client, deps }),
      resolveRoots(changes = {}, failures = {}) {
        for (const name of ["subject", "collection", "episodes", "persons", "characters", "relations"]) {
          respond(name, [1], failures[name] ?? changes[name] ?? base[name], Boolean(failures[name]));
        }
      },
    };
  }

  const h = harness();
  h.client.setQueryData(["collection", 1], base.collection, { updatedAt: 0 });
  const batch = await h.load();
  assert.equal(batch.initial.data.artistMap[3], "缓存歌手", "艺术家离线数据也必须进入首版");
  assert.equal(batch.initial.data.persons[0].name, "缓存制作人员");
  let completed = false;
  void batch.settled.then(() => { completed = true; });
  h.respond("subject", [1], subject(1, "网络条目"));
  await tick();
  assert.equal(completed, false, "分集等真实挂起请求必须阻止整批提交");
  assert.equal(h.writes.length, 0, "不能逐个持久化半成品");
  h.respond("collection", [1], base.collection);
  h.respond("persons", [1], []); h.respond("characters", [1], []);
  h.respond("relations", [1], [{ id: 4, type: 3, name: "新OP", relation: "片头曲" }]);
  h.respond("episodes", [1], base.episodes);
  await tick();
  assert.ok(h.pending.has(JSON.stringify(["subject", 4])), "关系产生的艺术家请求必须真实开始");
  assert.equal(completed, false, "派生请求也属于同一批次");
  const confirmed = { ...base.collection, type: 2, ep_status: 12 };
  h.setConfirmed(confirmed);
  h.respond("subject", [4], artist(4, "网络歌手"));
  const final = await batch.settled;
  assert.equal(final.data.artistMap[4], "网络歌手");
  assert.equal(final.data.subject.name_cn, "网络条目");
  assert.equal(final.data.collection.ep_status, 12);
  assert.equal(h.writes.some(([name]) => name === "collection"), false, "旧响应不能落盘覆盖已确认进度");
  assert.equal(h.diskCollection.ep_status, 12);

  const failed = harness();
  const partial = await failed.load();
  failed.resolveRoots({ subject: subject(1, "部分成功") }, { persons: new Error("offline") });
  const fallback = await partial.settled;
  assert.equal(fallback.data.subject.name_cn, "部分成功");
  assert.deepEqual(fallback.data.persons, base.persons, "失败字段保留原值，而非撤回整个初版");

  for (const changed of [false, true]) {
    const notFound = harness();
    notFound.client.setQueryData(["collection", 1], base.collection, { updatedAt: 0 });
    const removing = await notFound.load();
    if (changed) notFound.setConfirmed(confirmed);
    notFound.resolveRoots({}, { collection: new Error("Bangumi API error 404") });
    const result = await removing.settled;
    assert.equal(result.data.collection?.ep_status ?? null, changed ? 12 : null);
    assert.equal(notFound.writes.some(([name]) => name === "delete-collection"), !changed, "404 不能删除刷新期间的新收藏");
  }

  const queued = harness();
  queued.client.setQueryData(["collection", 1], confirmed, { updatedAt: 0 });
  queued.deps.readPendingPatch = async () => ({ type: 2, ep_status: 12 });
  const queuedBatch = await queued.load();
  queued.resolveRoots();
  assert.equal((await queuedBatch.settled).data.collection.ep_status, 12, "请求开始前已存在的 pending 意图同样优先");
  assert.equal(queued.writes.some(([name]) => name === "collection"), false);

  const bootQueued = harness();
  bootQueued.deps.readPendingPatch = async () => ({ type: 2, ep_status: 12 });
  const boot = await bootQueued.load();
  assert.equal(boot.initial.data.collection.ep_status, 12, "没有内存缓存时，首版也必须包含持久化 pending 意图");
  bootQueued.resolveRoots(); await boot.settled;

  const sameReference = harness();
  sameReference.client.setQueryData(["collection", 1], base.collection, { updatedAt: 0 });
  const confirming = await sameReference.load();
  sameReference.client.setQueryData(["collection", 1], value => value);
  sameReference.resolveRoots({ collection: { ...base.collection, ep_status: 1 } });
  assert.equal((await confirming.settled).data.collection.ep_status, 2, "相同引用的 worker 确认也不能被旧读取覆盖");
  assert.equal(sameReference.writes.some(([name]) => name === "collection"), false);

  const expired = harness();
  expired.client.setQueryData(["subject", 1], base.subject, { updatedAt: Date.now() - DETAIL_CACHE_MAX_AGE - 1 });
  const refresh = await expired.load();
  assert.ok(expired.pending.has(JSON.stringify(["subject", 1])), "内存缓存不能永久跳过新鲜度判断");
  expired.resolveRoots(); await refresh.settled;
  console.log("subject detail two-phase: 离线汇总、乱序/派生请求、部分失败、404 和最新意图保护全部通过 ✓");
} finally {
  for (const client of clients) client.clear();
  await rm(directory, { recursive: true, force: true });
}
