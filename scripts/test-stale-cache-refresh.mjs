// stale-while-revalidate 刷新保护回归测试
import assert from "node:assert/strict";
import { refreshQueryDataIfChanged } from "../src/api/stale-cache-refresh.ts";

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

console.log("stale cache refresh: 全部通过 ✓");
