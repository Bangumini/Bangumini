// stale-while-revalidate 刷新保护回归测试
import assert from "node:assert/strict";
import {
  refreshQueryDataIfChanged, hasCacheRefreshInFlight, subscribeCacheRefresh,
  waitForCacheRefresh, getLastCacheRefreshAt, beginCacheRefresh,
} from "../src/api/stale-cache-refresh.ts";

function createQueryClient(initial) {
	let data = initial;
	let writes = 0;
	return {
		getQueryData: () => data,
		setQueryData: (_key, next) => {
			data = next;
			writes += 1;
		},
		get data() {
			return data;
		},
		get writes() {
			return writes;
		},
	};
}

const freshClient = createQueryClient({ value: 1 });
const freshChanged = await refreshQueryDataIfChanged({
	queryClient: freshClient,
	queryKey: ["fresh-cache"],
	refreshKey: "fresh-cache",
	currentData: { value: 1 },
	refresh: async () => ({ value: 2 }),
});
assert.equal(freshChanged, true);
assert.deepEqual(freshClient.data, { value: 2 });
assert.equal(freshClient.writes, 1);

let resolveRefresh;
const pendingRefresh = new Promise((resolve) => {
	resolveRefresh = resolve;
});
const localClient = createQueryClient({ value: 1 });
const protectedRefresh = refreshQueryDataIfChanged({
	queryClient: localClient,
	queryKey: ["protected-cache"],
	refreshKey: "protected-cache",
	currentData: { value: 1 },
	refresh: () => pendingRefresh,
});
localClient.setQueryData(["protected-cache"], { value: 99 });
resolveRefresh({ value: 2 });
const protectedChanged = await protectedRefresh;
assert.equal(protectedChanged, false);
assert.deepEqual(localClient.data, { value: 99 });
assert.equal(localClient.writes, 1);

// 跨页面重挂载时也必须能等待已在进行的同一刷新，不能把它误判为已完成。
let finishShared;
const sharedClient = createQueryClient({ value: 1 });
const sharedOptions = {
  queryClient: sharedClient, queryKey: ["shared"], refreshKey: "shared", currentData: { value: 1 },
  refresh: () => new Promise(resolve => { finishShared = resolve; }),
};
const observed = [];
const unsubscribe = subscribeCacheRefresh(sharedClient, () => observed.push(hasCacheRefreshInFlight(sharedClient, ["shared"])));
const first = refreshQueryDataIfChanged(sharedOptions);
assert.equal(hasCacheRefreshInFlight(sharedClient, ["shared"]), true, "跨页消费者可直接读取既有刷新状态");
const second = refreshQueryDataIfChanged(sharedOptions);
assert.equal(second, first, "去重只去掉重复网络请求，不能丢掉完成屏障");
const otherClient = createQueryClient({ value: 1 });
const independent = refreshQueryDataIfChanged({ ...sharedOptions, queryClient: otherClient, refresh: async () => ({ value: 3 }) });
assert.ok(independent, "不同 QueryClient 不能共享刷新锁");
finishShared({ value: 2 });
assert.equal(await first, true);
assert.equal(await second, true);
assert.equal(await independent, true);
assert.equal(sharedClient.writes, 1);
assert.equal(otherClient.data.value, 3);
assert.deepEqual(observed, [true, false], "只在整批任务注册和完成时通知，其他 QueryClient 不串扰");
unsubscribe();
assert.equal(hasCacheRefreshInFlight(sharedClient, ["shared"]), false);

let finishMerged;
const mergeClient = createQueryClient({ title: "旧", progress: 1 });
const merging = refreshQueryDataIfChanged({
  queryClient: mergeClient, queryKey: ["merged"], refreshKey: "merged", currentData: mergeClient.data,
  refresh: () => new Promise(resolve => { finishMerged = resolve; }),
  mergeLatest: (next, live, original) => ({ ...next, progress: live.progress !== original.progress ? live.progress : next.progress }),
});
mergeClient.setQueryData(["merged"], { title: "旧", progress: 2 });
finishMerged({ title: "新", progress: 1 });
await merging;
assert.deepEqual(mergeClient.data, { title: "新", progress: 2 }, "合并远端元数据时必须重读并保留最新用户目标");

console.log("stale cache refresh: 全部通过 ✓");

// 自动刷新用它判断“这一轮是不是已经被页面自己的 SWR 完成了”：
// 必须按 key 区分，并且能等正在跑的刷新结束。
{
  const waitClient = createQueryClient({ value: 1 });
  assert.equal(getLastCacheRefreshAt(waitClient, ["collections"]), 0, "未刷新过时为 0");
  let finish;
  const running = refreshQueryDataIfChanged({
    queryClient: waitClient, queryKey: ["collections"], refreshKey: "collections",
    currentData: { value: 1 }, refresh: () => new Promise(resolve => { finish = resolve; }),
  });
  let waited = false;
  const waiting = waitForCacheRefresh(waitClient, ["collections"]).then(() => { waited = true; });
  await Promise.resolve();
  assert.equal(waited, false, "等不到刷新结束不能提前返回");
  const before = Date.now();
  finish({ value: 2 });
  await running;
  await waiting;
  assert.equal(waited, true);
  const finishedAt = getLastCacheRefreshAt(waitClient, ["collections"]);
  assert.ok(finishedAt >= before, "完成时刻必须晚于发起时刻");
  assert.equal(getLastCacheRefreshAt(waitClient, ["calendar"]), 0, "其它 key 不能被标记为已刷新");
  // 没有刷新在跑时立即完成。
  await waitForCacheRefresh(waitClient, ["collections"]);
  // 外部整批刷新（Ctrl+R / 自动刷新）也计入完成时刻。
  const externalClient = createQueryClient({ value: 1 });
  const end = beginCacheRefresh(externalClient, "calendar");
  let externalDone = false;
  const externalWait = waitForCacheRefresh(externalClient, ["calendar"]).then(() => { externalDone = true; });
  await Promise.resolve();
  assert.equal(externalDone, false);
  end();
  await externalWait;
  assert.ok(getLastCacheRefreshAt(externalClient, ["calendar"]) > 0, "整批刷新也要记录完成时刻");
}
