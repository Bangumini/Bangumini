import { useCallback, useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../api/tauri-fetch";

// ---- localStorage keys（沿用 bangumini_ 前缀约定）----
export const AUTO_CHECK_UPDATE_KEY = "bangumini_auto_check_update";
// 仅模块内部使用（getLastUpdateCheckTime / runCheck 节流）
const LAST_UPDATE_CHECK_KEY = "bangumini_last_update_check";
// 仅模块内部使用（getSkippedUpdateVersion / setSkippedUpdateVersion）
const SKIPPED_UPDATE_VERSION_KEY = "bangumini_skipped_update_version";

// 自动检查节流窗口：30 分钟内不重复检查，避免频繁请求 GitHub
const CHECK_THROTTLE_MS = 30 * 60 * 1000;

/** 是否启用自动检查更新（默认开启；仅 localStorage 存 "0" 表示关闭） */
export function isAutoCheckUpdateEnabled(): boolean {
	return localStorage.getItem(AUTO_CHECK_UPDATE_KEY) !== "0";
}

/** 上次成功检查的时间戳（毫秒）；无记录返回 null */
export function getLastUpdateCheckTime(): number | null {
	const raw = localStorage.getItem(LAST_UPDATE_CHECK_KEY);
	if (!raw) return null;
	const t = Number(raw);
	return Number.isFinite(t) && t > 0 ? t : null;
}

/** 被用户跳过的版本号；无则返回 null */
export function getSkippedUpdateVersion(): string | null {
	return localStorage.getItem(SKIPPED_UPDATE_VERSION_KEY);
}

/** 写入 / 清除跳过的版本号 */
export function setSkippedUpdateVersion(version: string | null): void {
	if (version) {
		localStorage.setItem(SKIPPED_UPDATE_VERSION_KEY, version);
	} else {
		localStorage.removeItem(SKIPPED_UPDATE_VERSION_KEY);
	}
}

export interface AutoUpdateCheckState {
	/** 当前发现且未被跳过的可用新版本；null 表示无（含已关闭/已跳过） */
	latestVersion: string | null;
	/** 关闭本次提醒（直到下一次成功检查到新版本才重新出现） */
	dismissUpdate: () => void;
	/** 跳过指定版本：写入 localStorage，该版本之后不再自动提醒 */
	skipVersion: (version: string) => void;
}

/**
 * 自动检查更新 hook：
 * - 挂载时检查一次（覆盖应用启动场景）
 * - 窗口获得焦点（显示）时补查一次，受 30 分钟节流控制
 * - 只做提醒，不自动下载 / 安装；是否更新由用户决定
 */
export function useAutoUpdateCheck(): AutoUpdateCheckState {
	const [latestVersion, setLatestVersion] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState(false);
	// 防止并发重复检查（StrictMode 双挂载、焦点事件密集触发）
	const checkingRef = useRef(false);

	const runCheck = useCallback(async () => {
		if (!isTauri()) return;
		if (!isAutoCheckUpdateEnabled()) return;
		// 节流：距上次成功检查不足 30 分钟则跳过
		const last = getLastUpdateCheckTime();
		if (last && Date.now() - last < CHECK_THROTTLE_MS) return;
		if (checkingRef.current) return;
		checkingRef.current = true;
		try {
			const update = await check();
			// 无论有无更新，成功检查都刷新节流时间戳（失败不刷新，便于下次重试）
			localStorage.setItem(LAST_UPDATE_CHECK_KEY, String(Date.now()));
			if (update && update.version !== getSkippedUpdateVersion()) {
				setLatestVersion(update.version);
				setDismissed(false);
			} else {
				setLatestVersion(null);
			}
		} catch {
			// 静默失败：无网络 / GitHub 不可达时不打扰用户
		} finally {
			checkingRef.current = false;
		}
	}, []);

	// 启动时检查（组件挂载即触发）
	useEffect(() => {
		// 安全：runCheck 内所有 setState 都发生在 await check() 之后（异步回调），
		// 不会同步触发级联渲染；此处是 eslint 静态分析的误报
		// eslint-disable-next-line react-hooks/set-state-in-effect
		runCheck();
	}, [runCheck]);

	// 窗口显示时补查：窗口失焦自动隐藏，呼出（快捷键 / 托盘）时重新获得焦点
	useEffect(() => {
		if (!isTauri()) return;
		let unlisten: (() => void) | undefined;
		getCurrentWindow()
			.onFocusChanged(({ payload: focused }) => {
				if (focused) runCheck();
			})
			.then((fn) => (unlisten = fn))
			.catch(() => {});
		return () => unlisten?.();
	}, [runCheck]);

	const dismissUpdate = useCallback(() => setDismissed(true), []);
	const skipVersion = useCallback((version: string) => {
		setSkippedUpdateVersion(version);
		setLatestVersion(null);
		setDismissed(false);
	}, []);

	// 关闭（dismiss）状态折叠进返回值：关闭后视为无新版本，卡片随之隐藏
	return {
		latestVersion: dismissed ? null : latestVersion,
		dismissUpdate,
		skipVersion,
	};
}
