// AniList 下季度请求回归测试（零网络、零依赖）
// 运行：node --experimental-strip-types scripts/test-anilist-next-season.mjs
import assert from "node:assert/strict";
import { getNextSeason, setFetchFunction } from "../shared/api/anilist.ts";

function jsonResponse(body, init = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

setFetchFunction(async () => new Response("rate limited", { status: 429 }));
await assert.rejects(() => getNextSeason(), /AniList HTTP 429/);

setFetchFunction(async () =>
	jsonResponse({ errors: [{ message: "季度参数无效" }] }),
);
await assert.rejects(() => getNextSeason(), /季度参数无效/);

setFetchFunction(async () => jsonResponse({ data: { Page: null } }));
await assert.rejects(() => getNextSeason(), /missing Page/);

setFetchFunction(async () =>
	jsonResponse({
		data: { Page: { pageInfo: { hasNextPage: false }, media: [] } },
	}),
);
assert.deepEqual(await getNextSeason(), []);

let capturedQuery = "";
setFetchFunction(async (_url, init) => {
	const body = JSON.parse(String(init?.body ?? ""));
	capturedQuery = body.query;
	return jsonResponse({
		data: {
			Page: {
				pageInfo: { hasNextPage: false },
				media: [
					{
						id: 123,
						title: { native: "テスト", romaji: "Test" },
						coverImage: { large: "https://example.com/cover.jpg" },
						startDate: { year: 2027, month: 1, day: null },
						nextAiringEpisode: null,
						episodes: 12,
						format: "TV",
					},
				],
			},
		},
	});
});
const items = await getNextSeason();
assert.equal(items.length, 1);
assert.equal(items[0].id, 123);
assert.match(capturedQuery, /season:/);
assert.match(capturedQuery, /seasonYear:/);

process.stdout.write("anilist next-season: 全部通过 ✓\n");
