/**
 * 本地缓存键的字面量常量。
 *
 * 单独成文件是为了让收藏页、日历页与刷新流程共用同一份键名，
 * 同时保持无依赖（便于页面级渲染测试直接加载真实模块）。
 */
export const COLLECTIONS_CACHE_PREFIX = "collections-";
export const CALENDAR_CACHE_KEY = "calendar";

export function getCollectionsCacheKey(
	collectionType: string,
	username: string,
) {
	return `${COLLECTIONS_CACHE_PREFIX}${collectionType}-${username}`;
}
