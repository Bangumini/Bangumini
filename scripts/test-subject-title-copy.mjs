// 条目名季度剥离回归测试（零依赖，需要 Node ≥ 22.6）
// 运行：node --experimental-strip-types scripts/test-subject-title-copy.mjs
import assert from "node:assert/strict";
import { stripSubjectTitleSeason } from "../src/api/subject-title-copy.ts";

const cases = [
	["葬送的芙莉莲 第2季", "葬送的芙莉莲"],
	["碧蓝航线：微速前行！第二季", "碧蓝航线：微速前行"],
	["咒术回战 第2期 怀玉・玉折", "咒术回战 怀玉・玉折"],
	["第三季 反击篇", "反击篇"],
	["第2期 某某动画", "某某动画"],
	[
		"無職転生 II ～異世界行ったら本気だす～ 第2クール",
		"無職転生 II ～異世界行ったら本気だす",
	],
	[
		"Re:ゼロから始める異世界生活 3rd season 反撃編",
		"Re:ゼロから始める異世界生活 反撃編",
	],
	["Some Anime Season 2", "Some Anime"],
	["Some Anime Season 2 Part 1", "Some Anime"],
	["3rd Season Some Anime", "Some Anime"],
	["夏目友人帐", "夏目友人帐"],
	["22/7", "22/7"],
	["Season of the Witch", "Season of the Witch"],
];

for (const [input, expected] of cases) {
	assert.equal(stripSubjectTitleSeason(input), expected, input);
}

console.log("条目名季度剥离测试全部通过 ✓");
