// AniList 排期查询回归测试（零网络、零依赖）
// 运行：node --experimental-strip-types scripts/test-anilist-airing.mjs
import assert from "node:assert/strict";
import { getAiringAt, setFetchFunction } from "../shared/api/anilist.ts";

function jsonResponse(body, init = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

let capturedBody;
setFetchFunction(async (_url, init) => {
	try {
		capturedBody = JSON.parse(String(init?.body ?? ""));
	} catch {
		throw new Error("AniList request body must be valid JSON");
	}
	return jsonResponse({
		data: {
			Page: {
				media: [
					{
						id: 1,
						nextAiringEpisode: { airingAt: 1787362200, episode: 8 },
					},
				],
			},
		},
	});
});
const scheduled = await getAiringAt('标题含有"引号"');
assert.deepEqual(scheduled, {
	status: "scheduled",
	value: { airingAt: 1787362200, episode: 8 },
});
assert.equal(capturedBody.variables.search, '标题含有"引号"');
assert.match(capturedBody.query, /\$search/);

setFetchFunction(async () => jsonResponse({ data: { Page: { media: [] } } }));
assert.deepEqual(await getAiringAt("不存在"), { status: "not_found" });

setFetchFunction(async () =>
	jsonResponse({
		data: { Page: { media: [{ id: 2, nextAiringEpisode: null }] } },
	}),
);
assert.deepEqual(await getAiringAt("无排期"), { status: "no_schedule" });

let attempts = 0;
setFetchFunction(async () => {
	attempts += 1;
	if (attempts === 1) {
		return new Response("rate limited", {
			status: 429,
			headers: { "Retry-After": "0.001" },
		});
	}
	return jsonResponse({
		data: {
			Page: {
				media: [
					{
						id: 3,
						nextAiringEpisode: { airingAt: 1787365800, episode: 9 },
					},
				],
			},
		},
	});
});
const retryResult = await getAiringAt("限流重试");
assert.equal(retryResult.status, "scheduled");
assert.equal(attempts, 2, "429 后应按 Retry-After 自动重试");

process.stdout.write("anilist airing lookup: 全部通过 ✓\n");
