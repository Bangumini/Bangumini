/**
 * 收藏页自动刷新的触发闸门与触发节点。
 *
 * 触发节点只有两个：应用启动（每个进程一次）与窗口重新显示
 * （全局快捷键呼出、托盘点击、失焦后重新聚焦）。刷新流程本身与 Ctrl+R 完全一致
 * （见 ./collections-refresh），这里只决定“这一轮该不该跑”：
 *
 * - 排队请求带时间戳：页面消费时如果发现该时刻之后已经有数据落地
 *   （例如冷启动时页面自己的 SWR 刚拉完），就跳过这一轮，避免一次启动发两批请求；
 * - 同一范围（账号 + 收藏分类）在冷却窗口内不重复自动刷新，冷却对齐页面原有的
 *   staleTime（30s）；更细的节流仍由 AniList 5 分钟 / 剧集 30 分钟的新鲜度窗口负责；
 * - 整批刷新是独占的：手动与自动共用同一把锁，避免两轮同时写盘。
 */
export const AUTO_REFRESH_MIN_INTERVAL = 30_000;

export type AutoRefreshGate = {
	/** 该范围是否已过冷却窗口。 */
	canAutoRefresh: (scope: string, now?: number) => boolean;
	/** 记录一轮刷新开始，手动与自动都计入冷却。 */
	markStarted: (scope: string, now?: number) => void;
	/** 抢占刷新锁；已有一轮在跑时返回 false。 */
	tryBegin: () => boolean;
	/** 释放刷新锁。 */
	end: () => void;
	readonly inFlight: boolean;
};

export function createAutoRefreshGate(
	minInterval = AUTO_REFRESH_MIN_INTERVAL,
): AutoRefreshGate {
	const lastStarted = new Map<string, number>();
	let inFlight = false;
	return {
		canAutoRefresh(scope, now = Date.now()) {
			const previous = lastStarted.get(scope);
			return previous === undefined || now - previous >= minInterval;
		},
		markStarted(scope, now = Date.now()) {
			lastStarted.set(scope, now);
		},
		tryBegin() {
			if (inFlight) return false;
			inFlight = true;
			return true;
		},
		end() {
			inFlight = false;
		},
		get inFlight() {
			return inFlight;
		},
	};
}

/** 页面模块级实例：跨组件挂载复用，进程重启后自动重置。 */
export const collectionsAutoRefreshGate = createAutoRefreshGate();

type AutoRefreshListener = () => void;

const listeners = new Set<AutoRefreshListener>();
/** 排队中的请求时刻；0 表示没有排队请求（保留最早时刻，便于“之后已有数据”判定）。 */
let pendingRequestAt = 0;
let lifecycleStarted = false;
let appVisible = true;

function notify() {
	for (const listener of listeners) listener();
}

/** 排队一次自动刷新，返回本次请求时刻。 */
export function requestCollectionsAutoRefresh(now = Date.now()) {
	if (pendingRequestAt === 0) pendingRequestAt = now;
	notify();
	return pendingRequestAt;
}

/**
 * 消费排队中的请求；返回请求时刻（毫秒），没有请求时返回 0。
 * 调用方用这个时刻判断“排队之后是否已经有数据落地”，从而跳过重复刷新。
 */
export function consumeCollectionsAutoRefreshRequest() {
	const requestedAt = pendingRequestAt;
	pendingRequestAt = 0;
	return requestedAt;
}

/** 不消费、只观察队列状态（调试/测试用）。 */
export function hasCollectionsAutoRefreshRequest() {
	return pendingRequestAt !== 0;
}

export function subscribeCollectionsAutoRefresh(listener: AutoRefreshListener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function isWindowVisible() {
	if (typeof document === "undefined") return true;
	if (document.visibilityState === "hidden") return false;
	return typeof document.hasFocus !== "function" || document.hasFocus();
}

function updateVisible(next: boolean) {
	if (next === appVisible) return;
	appVisible = next;
	// 只有从隐藏/失焦回到可见/聚焦才算“重新显示”，持续可见时不重复排队。
	if (next) requestCollectionsAutoRefresh();
}

/**
 * 原生窗口焦点（Tauri 全局快捷键/托盘强制 show 时不触发浏览器 focus 事件）：
 * 由 main.tsx 的 onFocusChanged 桥接进来。
 */
export function notifyNativeWindowVisibility(visible: boolean) {
	updateVisible(visible);
}

/**
 * 在应用根节点调用一次：启动时排队一轮，之后监听窗口显示/聚焦。
 * 返回的解绑函数会移除监听（应用根节点通常不需要）。
 */
export function startCollectionsAutoRefreshLifecycle() {
	if (lifecycleStarted) return () => {};
	lifecycleStarted = true;
	appVisible = isWindowVisible();
	// 每次打开软件都要刷新一次，即使窗口一启动就是可见的。
	requestCollectionsAutoRefresh();

	const onFocus = () => updateVisible(true);
	const onBlur = () => updateVisible(false);
	const onVisibilityChange = () => updateVisible(!document.hidden);

	if (typeof window !== "undefined") {
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
	}
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", onVisibilityChange);
	}

	return () => {
		lifecycleStarted = false;
		if (typeof window !== "undefined") {
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
		}
		if (typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", onVisibilityChange);
		}
	};
}
