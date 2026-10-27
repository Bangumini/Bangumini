/** 缓存快照的稳定比较；与既有刷新去重口径一致，序列化失败时视为不同。 */
export function isSameJsonPayload(left: unknown, right: unknown) {
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}
