import { check } from "@tauri-apps/plugin-updater";

/**
 * 检查更新时要求中间代理和 CDN 不复用旧的 latest.json。
 * GitHub 的 releases/latest/download 是重定向到 Release 资源的动态地址，
 * 短时间内发布新版本时，缓存层可能仍返回旧的重定向结果。
 */
export function checkForUpdate() {
	return check({
		headers: {
			"Cache-Control": "no-cache, no-store, max-age=0",
			Pragma: "no-cache",
		},
	});
}
