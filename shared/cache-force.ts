/**
 * 手动刷新（Ctrl+R）的强制语义窗口。
 *
 * 一次按键会发起一批请求，其中 AniList 侧按 700ms 串行节流，整轮可能持续数分钟；
 * 因此“本轮是否已刷新过”不能按固定分钟数判断，而要记录本轮起点：
 * 早于起点的记录一律视为过期（强制重查），晚于起点说明本轮已经拿到过，直接复用。
 */
export const FORCE_WINDOW_MS = 1000 * 60 * 10;

export type ForceWindow = {
	/** 标记一轮刷新的开始，返回本轮起点。 */
	request: (now?: number) => number;
	/** 本轮是否仍在进行（让同一批 query 复用强制语义）。 */
	isActive: (now?: number) => boolean;
	/** 当前轮次起点；0 表示从未手动刷新过。 */
	current: () => number;
};

export function createForceWindow(durationMs = FORCE_WINDOW_MS): ForceWindow {
	let roundStart = 0;
	return {
		request(now = Date.now()) {
			roundStart = now;
			return roundStart;
		},
		isActive(now = Date.now()) {
			return roundStart > 0 && now - roundStart < durationMs;
		},
		current() {
			return roundStart;
		},
	};
}

/** 页面取用：本轮进行中返回起点，否则返回 0（回落到常规新鲜度规则）。 */
export function getForcedRoundStart(
	window: ForceWindow,
	now = Date.now(),
): number {
	return window.isActive(now) ? window.current() : 0;
}
