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
import SubjectDetailPage from "/src/pages/SubjectDetailPage.tsx";
import "/src/index.css";

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
if (scenario === "stale-airing") {
  for (const k of Object.keys(entries)) if (k.startsWith("anilist-")) entries[k].fetchedAt -= 172800000;
}
if (scenario === "missing-airing") {
  for (const k of Object.keys(entries)) if (k.startsWith("anilist-")) delete entries[k];
}
if (scenario === "missing-episodes") {
  for (const k of Object.keys(entries)) if (k.startsWith("episodes-")) delete entries[k];
}
const storageKey = "startup-fixture-disk-" + scenario;
const restored = localStorage.getItem(storageKey) !== null;
if (!restored) localStorage.setItem(storageKey, JSON.stringify(entries));
const disk = new Map(Object.entries(JSON.parse(localStorage.getItem(storageKey))));
const client = new QueryClient({ defaultOptions: { queries: {
  retry: false, gcTime: Infinity, refetchOnWindowFocus: false,
} } });
window.__fixture = { client, disk, subjects, collections, episodes, networkCalls: [], pending: [] };
function Observer() { window.__fixture.location = useLocation(); return null; }
const root = createRoot(document.getElementById("root"));
root.render(
  <QueryClientProvider client={client}><MemoryRouter initialEntries={["/collections"]}>
    <Observer /><Routes>
      <Route element={<Layout />}><Route path="/collections" element={<CollectionsPage />} /></Route>
      <Route path="/subject/:id" element={<SubjectDetailPage />} />
    </Routes>
  </MemoryRouter></QueryClientProvider>
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
    result.textContent = JSON.stringify({ scenario, message: error.message, errors });
  } finally {
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
    if (name === "writeCachedValue") { f.disk.set(args[0], copy(args[1])); return args[1]; }
    if (name.startsWith("write")) return args.at(-1);
    return null;
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
      for (const [suffix, code] of Object.entries(mocks)) if (name.endsWith(suffix)) return code;
      if (name.endsWith("/shared/api/anilist.ts")) return 'export const getAiringAt = (...args) => window.__requestFixture("getAiringAt", args);';
      if (!name.endsWith("/shared/api/client.ts") && !name.endsWith("/shared/storage/sqlite-cache.ts")) return;
      const source = await readFile(id, "utf8");
      const names = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/g)].map(m => m[1] || m[2]);
      if (name.endsWith("/shared/api/client.ts")) {
        return `window.__requestFixture = (name, args) => {
          window.__fixture.networkCalls.push({ name, args });
          if (window.__fixture.offline) return Promise.reject(new Error("fixture offline"));
          return new Promise((resolve, reject) => window.__fixture.pending.push({ name, args, resolve, reject }));
        };\n` + names.map(n => `export const ${n} = (...args) => window.__requestFixture(${JSON.stringify(n)}, args);`).join("\n");
      }
      const sync = new Set(["isUsefulImageUrl", "getPreferredSubjectCoverUrl", "readLegacyHttpCache"]);
      return sqlite + names.map(n => `export const ${n} = (...args) => ${sync.has(n) ? "" : "Promise.resolve("}read(${JSON.stringify(n)}, args)${sync.has(n) ? "" : ")"};`).join("\n");
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
    resolve: { alias: { "@shared": path.join(root, "shared") } },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${server.httpServer.address().port}/__startup_test` };
}
