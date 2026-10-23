import { readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 挂载真实页面和快捷键系统，只替换 SQLite、网络和原生窗口边界。
const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import Layout from "/src/components/Layout.tsx";
import CollectionsPage from "/src/pages/CollectionsPage.tsx";
import { refreshQueryDataIfChanged } from "/src/api/stale-cache-refresh.ts";
import "/src/index.css";
const SubjectDetailPage = React.lazy(() => import("/src/pages/SubjectDetailPage.tsx"));

const errors = [];
const originalError = console.error;
console.error = (...args) => {
  if (errors.length < 4) errors.push(args.map(String).join(" "));
  // 无限循环的诊断不能再通过 Vite 转发成无限增长的日志。
  if (!String(args[0]).includes("Maximum update depth")) originalError(...args);
};
window.addEventListener("error", event => errors.push(event.message));
const now = Date.now();
const subject = (id, title) => ({ id, type: 2, name: title, name_cn: title,
  date: "2026-01-01", air_weekday: 6, total_episodes: 12, eps: 12,
  images: {}, summary: "已保存的本地详情", rating: { score: 7.1, total: 10 }, rank: 1000 });
const subjects = [subject(616808, "目标条目"), subject(8, "其他条目"), subject(9, "想看条目")];
const collections = subjects.map((s, index) => ({ subject_id: s.id, subject: s,
  type: index === 2 ? 1 : 3, ep_status: 1, vol_status: 0 }));
const episodes = [
  { id: 1, ep: 1, sort: 1, type: 0, airdate: "2026-01-01" },
  { id: 2, ep: 2, sort: 2, type: 0, airdate: "2026-01-08" },
];
const calendar = [{ weekday: { id: 6, en: "Saturday", cn: "星期六", ja: "土曜日" },
  items: subjects.map(s => ({ ...s, air_date: s.date })) }];
const page = data => ({ data, total: data.length, limit: 100, offset: 0 });
const entries = {
  calendar,
  "collections-3-fixture-user": page(collections.filter(c => c.type === 3)),
  "collections-1-fixture-user": page(collections.filter(c => c.type === 1)),
};
for (const s of subjects) {
  entries["anilist-airing-v2-" + s.id] = { status: "no_schedule", fetchedAt: now };
  entries["episodes-schedule-v2-" + s.id] = { episodes, checkedAt: now - 3600000 };
}
const scenario = new URLSearchParams(location.search).get("scenario");
if (scenario === "stale-airing" || ["atomic-network", "atomic-local", "atomic-failure", "atomic-unchanged", "atomic-reverse", "atomic-members", "atomic-shared"].includes(scenario)) {
  for (const k of Object.keys(entries)) if (k.startsWith("anilist-")) entries[k].fetchedAt -= 172800000;
}
if (scenario === "missing-airing") {
  for (const k of Object.keys(entries)) if (k.startsWith("anilist-")) delete entries[k];
}
if (scenario === "missing-episodes") {
  for (const k of Object.keys(entries)) if (k.startsWith("episodes-")) delete entries[k];
}
const detail = scenario?.startsWith("detail-") ? {
  hydrated: new Set(), writes: [],
  persons: [{ id: 201, name: "本地制作人员", relation: "导演", type: 1, career: [], images: {} }],
  characters: [{ id: 202, name: "本地角色", type: 1, images: {}, actors: [] }],
  relations: [{ id: 777, type: 3, name: "本地歌曲", name_cn: "本地歌曲", relation: "片头曲" }],
  artist: { ...subject(777, "歌曲"), type: 3, infobox: [{ key: "艺术家", value: "本地歌手" }] },
} : null;
const storageKey = "startup-fixture-disk-" + scenario;
const restored = localStorage.getItem(storageKey) !== null;
if (!restored) localStorage.setItem(storageKey, JSON.stringify(entries));
const disk = new Map(Object.entries(JSON.parse(localStorage.getItem(storageKey))));
const client = new QueryClient({ defaultOptions: { queries: {
  retry: false, gcTime: Infinity, refetchOnWindowFocus: false,
} } });
window.__fixture = { client, disk, subjects, collections, episodes, scenario, detail, networkCalls: [], pending: [], hydrated: new Set(),
  persistDisk: () => localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(disk))),
  offline: restored && scenario === "atomic-network",
};
const frames = [];
const expectedOfflineKeys = [616808, 8].flatMap(id => ["anilist-airing-v2-" + id, "episodes-schedule-v2-" + id]);
const offlineReady = () => detail
  ? ["subject", "collection", "episodes", "persons", "characters", "relations", "artist"].every(key => detail.hydrated.has(key))
  : expectedOfflineKeys.every(key => window.__fixture.hydrated.has(key));
const visibleText = () => (detail ? document.getElementById("root") : document.querySelector("main"))?.innerText ?? "";
const frameObserver = scenario?.startsWith("atomic-") || detail ? new MutationObserver(() => {
  const content = visibleText();
  if (!content.includes("目标条目")) return;
  const previous = frames.at(-1);
  if (previous?.content !== content) frames.push({ content, offlineReady: offlineReady() });
}) : null;
frameObserver?.observe(document.body, { subtree: true, childList: true, characterData: true });
if (scenario === "atomic-shared") {
  client.setQueryData(["calendar"], calendar);
  void refreshQueryDataIfChanged({ queryClient: client, queryKey: ["calendar"], refreshKey: "calendar", currentData: calendar,
    refresh: () => window.__requestFixture("getCalendar", []),
  });
}
function Observer() { window.__fixture.location = useLocation(); return null; }
const root = createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode><QueryClientProvider client={client}><MemoryRouter initialEntries={[detail ? "/subject/616808" : "/collections"]}>
    <Observer /><Routes>
      <Route element={<Layout />}><Route path="/collections" element={<CollectionsPage />} /></Route>
      <Route path="/subject/:id" element={<React.Suspense fallback={<p>加载中…</p>}><SubjectDetailPage /></React.Suspense>} />
    </Routes>
  </MemoryRouter></QueryClientProvider></React.StrictMode>
);

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const key = (name, modifiers = {}) => (document.activeElement ?? document).dispatchEvent(
  new KeyboardEvent("keydown", { key: name, bubbles: true, ...modifiers })
);
const filter = value => {
  const input = document.querySelector('input[placeholder="筛选收藏…"]');
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const text = () => document.body.innerText;
(async () => {
  const result = document.createElement("pre");
  result.id = "startup-test-result";
  try {
    if (scenario === "atomic-network" && restored) {
      await waitFor(() => visibleText().includes("网络目标条目"), "新进程离线重启没有使用上一轮最终缓存");
      if (!frames[0]?.offlineReady) throw new Error("重启时再次显示了不完整的本地帧");
      filter("网络目标");
      await waitFor(() => !visibleText().includes("其他条目"), "离线重启后筛选阻塞");
      key("Enter");
      await waitFor(() => text().includes("已保存的本地详情"), "离线重启无法进入详情");
      if (errors.length) throw new Error(errors.join("; "));
      result.dataset.status = "passed";
      result.textContent = JSON.stringify({ scenario, restored, atomicVerified: true, frames });
      return;
    }
    if (scenario === "atomic-members") {
      const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const pending = (name, id) => window.__fixture.pending.find(r => !r.settled && r.name === name && (id === undefined || r.args[0] === id));
      await waitFor(() => visibleText().includes("目标条目") && pending("getAiringAt") && pending("getEpisodes", 616808), "初始批次未启动");
      await paint();
      const baseline = visibleText();
      frames.splice(0, frames.length, { content: baseline, offlineReady: true });
      const heldEpisode = pending("getEpisodes", 616808), heldAiring = pending("getAiringAt");
      const added = { ...collections[0], subject_id: 10, subject: subject(10, "新成员") };
      pending("getAllUserCollections").resolve(page([...collections.filter(c => c.type === 3), added]));
      pending("getCalendar").resolve(calendar);
      await waitFor(() => pending("getEpisodes", 10), "新增成员没有纳入本轮排期请求");
      const drain = () => {
        for (const request of window.__fixture.pending) {
          if (request.settled || request === heldEpisode || request === heldAiring) continue;
          if (request.name === "getEpisodes") request.resolve(page(episodes));
          else if (request.name === "getAiringAt") request.resolve({ status: "no_schedule" });
        }
      };
      const checkpoint = Date.now() + 2300;
      while (Date.now() < checkpoint) { drain(); await new Promise(resolve => setTimeout(resolve, 20)); }
      if (visibleText() !== baseline) throw new Error("旧批次的相关请求仍挂起时已提交新增成员：" + JSON.stringify(frames));
      heldEpisode.resolve(page(episodes)); heldAiring.resolve({ status: "no_schedule" });
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        drain(); await new Promise(resolve => setTimeout(resolve, 20));
        if (visibleText().includes("新成员") && !client.getQueryCache().getAll().some(q => q.state.fetchStatus === "fetching")) break;
      }
      await paint();
      if (!visibleText().includes("新成员") || frames.length !== 2) throw new Error("动态成员批次没有统一收敛：" + JSON.stringify(frames));
      if (window.__fixture.networkCalls.filter(c => c.name === "getEpisodes" && c.args[0] === 616808).length !== 1) throw new Error("组合 key 变更时重复发起了同一分集请求");
      if (errors.length) throw new Error(errors.join("; "));
      result.dataset.status = "passed";
      result.textContent = JSON.stringify({ scenario, restored, atomicVerified: true, frames });
      return;
    }
    if (detail) {
      const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await waitFor(() => text().includes("已保存的本地详情"), "详情离线首屏没有显示");
      await waitFor(offlineReady, "详情未汇总全部本地数据");
      if (!frames[0]?.offlineReady || !frames[0].content.includes("本地歌手")) throw new Error("详情初版不完整，出现渐进缓存帧：" + JSON.stringify(frames));
      await waitFor(() => window.__fixture.pending.some(r => r.name === "getSubjectPersons"), "详情未开始过期数据刷新");
      const pending = (name, id = 616808) => window.__fixture.pending.find(r => !r.settled && r.name === name && (name === "getUserCollection" ? r.args[1] : r.args[0]) === id);
      if (scenario === "detail-local") {
        const updated = { ...collections[0], ep_status: 2 };
        client.setQueryData(["collection", 616808], updated);
        window.__fixture.collections = [updated, ...collections.slice(1)];
        await paint();
      }
      const baseline = visibleText();
      frames.splice(0, frames.length, { content: baseline, offlineReady: true });
      pending("getSubject").resolve({ ...subjects[0], summary: "网络整批详情" });
      await paint();
      if (visibleText() !== baseline) throw new Error("详情只完成一个接口就提前显示新元数据");
      pending("getUserCollection").resolve(collections[0]);
      pending("getEpisodes").resolve(page(episodes));
      pending("getSubjectPersons").resolve([{ ...detail.persons[0], name: "网络制作人员" }]);
      pending("getSubjectCharacters").resolve(detail.characters);
      pending("getSubjectRelations").resolve([{ ...detail.relations[0], id: 778, name: "网络歌曲", name_cn: "网络歌曲" }]);
      await waitFor(() => pending("getSubject", 778), "没有等待网络关系衍生的艺术家请求");
      await paint();
      if (visibleText() !== baseline) throw new Error("艺术家请求未结束时详情提前提交");
      pending("getSubject", 778).resolve({ ...detail.artist, id: 778, infobox: [{ key: "艺术家", value: "网络歌手" }] });
      await waitFor(() => visibleText().includes("网络整批详情") && visibleText().includes("网络歌手"), "详情没有合并整批元数据");
      await paint();
      if (frames.length !== 2) throw new Error("详情不是两个稳定状态：" + JSON.stringify(frames));
      if (scenario === "detail-local") {
        if (client.getQueryData(["collection", 616808]).ep_status !== 2) throw new Error("详情回滚最新进度");
        if (window.__fixture.collections[0].ep_status !== 2) throw new Error("详情旧响应覆盖持久化进度");
      }
      if (errors.length) throw new Error(errors.join("; "));
      result.dataset.status = "passed";
      result.textContent = JSON.stringify({ scenario, restored, atomicVerified: true, frames });
      return;
    }
    if (["atomic-network", "atomic-local", "atomic-failure", "atomic-unchanged", "atomic-reverse", "atomic-shared"].includes(scenario)) {
      await waitFor(() => text().includes("目标条目") && window.__fixture.pending.some(r => r.name === "getAiringAt") && window.__fixture.pending.some(r => r.name === "getEpisodes"), "没有开始刷新完整的网络数据源");
      const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await paint();
      if (scenario === "atomic-local") {
        const updated = { ...collections[0], ep_status: 2 };
        client.setQueryData(["collection", 616808], updated);
        const localPage = page([updated, collections[1]]);
        client.setQueryData(["collections", "3", "fixture-user"], localPage);
        // 模拟 worker 已确认并落盘、队列已经移除，而列表刷新仍拿着旧响应。
        window.__fixture.collections = [updated, ...collections.slice(1)];
        disk.set("collections-3-fixture-user", structuredClone(localPage));
        window.__fixture.persistDisk();
        await waitFor(() => document.querySelector("main").innerText.includes("已追上进度"), "网络未完成时用户进度不能立即显示");
        await paint();
      }
      const baseline = document.querySelector("main").innerText;
      frames.splice(0, frames.length, { content: baseline, offlineReady: true });
      const pending = (name, predicate = () => true) => window.__fixture.pending.find(r => !r.settled && r.name === name && predicate(r));
      const unchanged = scenario === "atomic-unchanged";
      const networkCollections = page(collections.filter(c => c.type === 3).map(c => c.subject_id === 616808 && !unchanged ? { ...c, subject: { ...c.subject, name_cn: "网络目标条目" } } : c));
      const reverse = scenario === "atomic-reverse";
      const lateCalendar = reverse || scenario === "atomic-shared";
      if (!reverse) pending("getAllUserCollections").resolve(networkCollections);
      await paint();
      if (document.querySelector("main").innerText !== baseline) throw new Error("其余网络未完成，收藏结果已提前显示：" + JSON.stringify(frames));
      if (!lateCalendar) pending("getCalendar").resolve(calendar);
      if (scenario === "atomic-failure") pending("getEpisodes", r => r.args[0] === 616808).reject(new Error("fixture partial failure"));
      else pending("getEpisodes", r => r.args[0] === 616808).resolve(page(episodes));
      pending("getAiringAt").resolve({ status: "no_schedule" });
      await waitFor(() => pending("getAiringAt"), "没有等待后续 AniList 节流请求");
      pending("getAiringAt").resolve({ status: "no_schedule" });
      await waitFor(() => !client.getQueryCache().findAll({ queryKey: ["anilist-airing-times-v2"] }).some(q => q.state.fetchStatus === "fetching"), "AniList 刷新没有完成");
      await paint();
      if (document.querySelector("main").innerText !== baseline) throw new Error("最后一个网络请求未完成，排期结果已提前显示：" + JSON.stringify(frames));
      pending("getEpisodes", r => r.args[0] === 8).resolve(page(episodes));
      if (lateCalendar) {
        if (reverse) pending("getAllUserCollections").resolve(networkCollections);
        await paint();
        if (document.querySelector("main").innerText !== baseline) throw new Error("日历最后返回前已提前提交");
        pending("getCalendar").resolve(calendar);
      }
      await waitFor(() => !client.getQueryCache().getAll().some(q => q.state.fetchStatus === "fetching"), "整批请求没有结束");
      if (!unchanged) await waitFor(() => document.querySelector("main").innerText.includes("网络目标条目"), "整批网络完成后没有合并元数据与最新本地意图");
      await paint();
      const expectedFrames = unchanged ? 1 : 2;
      if (frames.length !== expectedFrames) throw new Error("预期仅缓存/整批网络两阶段（无变化不更新）：" + JSON.stringify(frames));
      if (scenario === "atomic-local") {
        if (frames.some(f => !f.content.includes("已追上进度"))) throw new Error("旧响应覆盖了用户进度");
        if (disk.get("collections-3-fixture-user").data.find(c => c.subject_id === 616808).ep_status !== 2) throw new Error("迟到刷新回滚了已确认的持久化进度");
      }
      if (errors.length) throw new Error(errors.join("; "));
      result.dataset.status = "passed";
      result.textContent = JSON.stringify({ scenario, restored, atomicVerified: true, frames });
      return;
    }
    if (scenario === "atomic-cache") {
      await waitFor(() => text().includes("目标条目"), "网络未完成时没有显示本地收藏");
      await waitFor(offlineReady, "没有汇总所有离线可用的排期缓存");
      if (!frames.length || !frames[0].offlineReady) throw new Error("首屏早于本地数据汇总，产生不完整的缓存中间态：" + JSON.stringify(frames));
      if (errors.length) throw new Error(errors.join("; "));
      result.dataset.status = "passed";
      result.textContent = JSON.stringify({ scenario, restored, atomicVerified: true, frames });
      return;
    }
    await waitFor(() => text().includes("其他条目"), "网络未完成时没有显示本地收藏");
    await waitFor(() => window.__fixture.networkCalls.some(c => c.name === "getEpisodes"), "未开始剧集刷新");
    if (scenario === "stale-airing" || scenario === "missing-airing") {
      await waitFor(() => window.__fixture.networkCalls.some(c => c.name === "getAiringAt"), "未开始放送刷新");
    }
    filter("目标");
    await waitFor(() => window.__fixture.location.search.includes("filter=") && !text().includes("其他条目"), "后台加载阻塞文字筛选");
    key("Enter");
    await waitFor(() => window.__fixture.location.pathname === "/subject/616808", "后台加载阻塞 Enter 打开详情");
    await waitFor(() => text().includes("已保存的本地详情"), "未显示本地详情");
    key("Escape");
    await waitFor(() => window.__fixture.location.pathname === "/collections" && text().includes("目标条目"), "后台加载阻塞返回收藏");
    filter("其他");
    await waitFor(() => text().includes("其他条目") && !text().includes("目标条目"), "切页返回后筛选阻塞");
    const title = [...document.querySelectorAll("*")].find(el => !el.childElementCount && el.textContent === "其他条目");
    title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await waitFor(() => window.__fixture.location.pathname === "/subject/8", "后台加载阻塞双击打开详情");
    const pendingRequests = window.__fixture.pending.length;
    window.__fixture.offline = true;
    for (const request of window.__fixture.pending) request.reject(new Error("fixture offline"));
    key("Escape");
    await waitFor(() => window.__fixture.location.pathname === "/collections" && text().includes("其他条目"), "离线返回时没有保留缓存列表");
    filter("目标");
    await waitFor(() => !text().includes("其他条目") && text().includes("目标条目"), "离线切页后筛选阻塞");
    key("Enter");
    await waitFor(() => window.__fixture.location.pathname === "/subject/616808" && text().includes("已保存的本地详情"), "离线无法进入缓存详情");
    if (errors.length) throw new Error(errors.join("; "));
    result.dataset.status = "passed";
    result.textContent = JSON.stringify({ scenario, restored, pendingRequests, offlineVerified: true });
  } catch (error) {
    result.dataset.status = "failed";
    result.textContent = JSON.stringify({ scenario, message: error.message, errors, location: window.__fixture.location, text: text().slice(0, 2400), queries: client.getQueryCache().getAll().map(q => ({ key: q.queryKey, status: q.state.status, fetching: q.state.fetchStatus })) });
  } finally {
    frameObserver?.disconnect();
    root.unmount();
    client.clear();
    document.body.append(result);
    window.reportStartupTest(JSON.stringify({ status: result.dataset.status, detail: JSON.parse(result.textContent) }));
  }
})();
`;

const mocks = {
  "/src/hooks/useAutoUpdateCheck.ts": "export const useAutoUpdateCheck = () => ({ latestVersion: null, dismissUpdate() {}, skipVersion() {} });",
  "/src/components/SyncQueueDock.tsx": "export default function SyncQueueDock() { return null; }",
  "/src/api/oauth.ts": 'export const getUsername = () => "fixture-user";',
  "/src/api/collection-tasks.ts": `
    export const COLLECTION_TASK_EVENT = "test-task";
    export const COLLECTION_TASK_QUEUE_EVENT = "test-queue";
    export const getCollectionTaskQueue = async () => [];
    export const getOptimisticCollectionPatchForSubject = () => null;
    export const mergePendingCollectionTasks = ({ data }) => data;
    export const enqueueCompleteProgressTask = () => {};
    export const enqueueSetCollectionTypeTask = () => {};
  `,
};
const sqlite = `
  const copy = value => value == null ? value : structuredClone(value);
  function read(name, args) {
    const f = window.__fixture;
    const value = key => copy(f.disk.get(key) ?? null);
    if (f.detail) {
      if (name.startsWith("readCached") && name.endsWith("Within")) return null;
      if (name === "readCachedSubjectDeep" && args[0] === 777) return copy(f.detail.artist);
      if (name === "readCachedPersons") return copy(f.detail.persons);
      if (name === "readCachedCharacters") return copy(f.detail.characters);
      if (name === "readCachedRelations") return copy(f.detail.relations);
      if (name.startsWith("write") || name === "deleteCachedCollection") f.detail.writes.push({ name, args });
      if (name === "writeCachedCollection") {
        f.collections = f.collections.map(c => c.subject_id === args[1].subject_id ? copy(args[1]) : c);
      }
    }
    if (name === "isUsefulImageUrl") return false;
    if (name === "getPreferredSubjectCoverUrl" || name === "readLegacyHttpCache") return null;
    if (name === "readCachedValueEntryAllowStale") {
      const payload = value(args[0]);
      return payload ? { payload, updatedAt: Date.now() - 3600000, isStale: true } : null;
    }
    if (name === "readCachedValuesAllowStale") return new Map(args[0].flatMap(k => f.disk.has(k) ? [[k, value(k)]] : []));
    if (name === "readAllCachedCollections") return copy(f.collections);
    if (name.startsWith("readCachedValue")) return value(args[0]);
    if (name.startsWith("readCachedSubject")) return copy(f.subjects.find(x => x.id === args[0]) ?? null);
    if (name.startsWith("readCachedCollection")) return copy(f.collections.find(x => x.subject_id === args[1]) ?? null);
    if (name.startsWith("readCachedEpisodes")) return { data: copy(f.episodes), total: 2, limit: 100, offset: 0 };
    if (name.startsWith("readCachedPersons") || name.startsWith("readCachedCharacters") || name.startsWith("readCachedRelations")) return [];
    if (name === "writeCachedValue") { f.disk.set(args[0], copy(args[1])); f.persistDisk(); return args[1]; }
    if (name.startsWith("write")) return args.at(-1);
    return null;
  }
  function readAsync(name, args) {
    const value = read(name, args);
    const f = window.__fixture;
    const detailKeys = { readCachedSubjectDeep: args[0] === 777 ? "artist" : args[0] === 616808 ? "subject" : null,
      readCachedCollection: "collection", readCachedEpisodes: "episodes", readCachedPersons: "persons", readCachedCharacters: "characters", readCachedRelations: "relations" };
    if (f.detail && detailKeys[name]) {
      return new Promise(resolve => setTimeout(() => { f.detail.hydrated.add(detailKeys[name]); resolve(value); }, name === "readCachedPersons" ? 180 : 0));
    }
    const keys = name.startsWith("readCachedValue") ? (Array.isArray(args[0]) ? args[0] : [args[0]]) : [];
    const scheduleKeys = keys.filter(key => typeof key === "string" && (key.startsWith("anilist-airing-v2-") || key.startsWith("episodes-schedule-v2-")));
    if (window.__fixture.scenario === "atomic-cache" && scheduleKeys.length) {
      return new Promise(resolve => setTimeout(() => {
        for (const key of scheduleKeys) window.__fixture.hydrated.add(key);
        resolve(value);
      }, scheduleKeys[0].startsWith("anilist-") ? 100 : 250));
    }
    for (const key of scheduleKeys) window.__fixture.hydrated.add(key);
    return Promise.resolve(value);
  }
`;

export async function startStartupFixture(root, cacheDir) {
  const entryId = path.join(root, "__startup_entry.jsx").replaceAll("\\", "/");
  const plugin = {
    name: "startup-fixture-io",
    enforce: "pre",
    resolveId: id => id === "/__startup_entry.jsx" ? entryId : undefined,
    async load(id) {
      if (id === entryId) return entry;
      const name = id.replaceAll("\\", "/");
      if (name.endsWith("/src/pages/SubjectDetailPage.tsx") && process.env.BANGUMINI_TEST_LEGACY_DETAIL) {
        return readFile(process.env.BANGUMINI_TEST_LEGACY_DETAIL, "utf8");
      }
      for (const [suffix, code] of Object.entries(mocks)) if (name.endsWith(suffix)) return code;
      if (name.endsWith("/shared/api/anilist.ts")) return 'export const getAiringAt = (...args) => window.__requestFixture("getAiringAt", args);';
      if (!name.endsWith("/shared/api/client.ts") && !name.endsWith("/shared/storage/sqlite-cache.ts")) return;
      const source = await readFile(id, "utf8");
      const names = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/g)].map(m => m[1] || m[2]);
      if (name.endsWith("/shared/api/client.ts")) {
        return `window.__requestFixture = (name, args) => {
          window.__fixture.networkCalls.push({ name, args });
          if (window.__fixture.offline) return Promise.reject(new Error("fixture offline"));
          return new Promise((resolve, reject) => {
            const request = { name, args, settled: false,
              resolve(value) { request.settled = true; resolve(value); },
              reject(error) { request.settled = true; reject(error); },
            };
            window.__fixture.pending.push(request);
          });
        };\n` + names.map(n => `export const ${n} = (...args) => window.__requestFixture(${JSON.stringify(n)}, args);`).join("\n");
      }
      const sync = new Set(["isUsefulImageUrl", "getPreferredSubjectCoverUrl", "readLegacyHttpCache"]);
      return sqlite + names.map(n => `export const ${n} = (...args) => ${sync.has(n) ? "read" : "readAsync"}(${JSON.stringify(n)}, args);`).join("\n");
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__startup_test") return next();
        try {
          const html = await server.transformIndexHtml(req.url, '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="root"></div><script type="module" src="/__startup_entry.jsx"></script></html>');
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
        } catch (error) { next(error); }
      });
    },
  };
  const server = await createServer({
    configFile: false, root, cacheDir, plugins: [plugin, react(), tailwindcss()],
    // 虚拟入口不扫描整个仓库（尤其是 Tauri target 下生成的 HTML），避免冷启动扫描和优化器重载干扰断言。
    optimizeDeps: { entries: [], noDiscovery: true, include: [
      "react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "react-router-dom", "@tanstack/react-query",
      "pinyin-pro", "@tauri-apps/api/core", "@tauri-apps/api/window", "@tauri-apps/plugin-opener",
    ] },
    resolve: { alias: { "@shared": path.join(root, "shared") } },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${server.httpServer.address().port}/__startup_test` };
}
