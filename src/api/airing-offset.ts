import { isValidAiringOffsetDays } from "../../shared/airing-offset.ts";

export const AIRING_OFFSETS_STORAGE_KEY = "bangumini_airing_offsets";

type AiringOffsets = Readonly<Record<number, number>>;
const EMPTY_OFFSETS: AiringOffsets = Object.freeze({});
let snapshot = EMPTY_OFFSETS;
let initialized = false;
const listeners = new Set<() => void>();

function isValidSubjectId(subjectId: number) {
	return Number.isSafeInteger(subjectId) && subjectId > 0;
}

function parseOffsets(raw: string | null): AiringOffsets {
	if (!raw) return EMPTY_OFFSETS;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return EMPTY_OFFSETS;
		}
		const result: Record<number, number> = {};
		for (const [key, value] of Object.entries(parsed)) {
			const subjectId = Number(key);
			if (
				String(subjectId) === key &&
				isValidSubjectId(subjectId) &&
				isValidAiringOffsetDays(value) &&
				value !== 0
			) {
				result[subjectId] = value;
			}
		}
		return Object.freeze(result);
	} catch {
		return EMPTY_OFFSETS;
	}
}

function publish(next: AiringOffsets) {
	const keys = Object.keys(next);
	if (
		keys.length === Object.keys(snapshot).length &&
		keys.every((key) => next[Number(key)] === snapshot[Number(key)])
	) return;
	snapshot = next;
	for (const listener of listeners) listener();
}

function initialize() {
	if (initialized || typeof window === "undefined") return;
	initialized = true;
	try {
		snapshot = parseOffsets(window.localStorage.getItem(AIRING_OFFSETS_STORAGE_KEY));
	} catch {
		// 存储不可读时仍可展示默认值；保存时必须向调用方报告失败。
	}
	window.addEventListener("storage", (event: StorageEvent) => {
		if (event.key !== AIRING_OFFSETS_STORAGE_KEY && event.key !== null) return;
		try {
			if (event.storageArea && event.storageArea !== window.localStorage) return;
			// 排队中的旧 storage 事件可能晚于本窗口写入；以磁盘最新状态为准。
			publish(parseOffsets(window.localStorage.getItem(AIRING_OFFSETS_STORAGE_KEY)));
		} catch {
			// 不可访问的其他存储区域不应影响当前偏好。
		}
	});
}

export function getAiringOffsetsSnapshot(): AiringOffsets {
	initialize();
	return snapshot;
}

export function subscribeAiringOffsets(listener: () => void): () => void {
	initialize();
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function setAiringOffsetDays(subjectId: number, days: number): void {
	if (!isValidSubjectId(subjectId) || !isValidAiringOffsetDays(days)) {
		throw new RangeError("放送偏置必须为 -365 至 365 的整数天，且条目 ID 必须有效");
	}
	initialize();
	if (typeof window === "undefined") throw new Error("无法访问本机存储");

	// 写入前合并磁盘上的其他条目，避免覆盖其他窗口刚保存的偏好。
	const next = { ...parseOffsets(window.localStorage.getItem(AIRING_OFFSETS_STORAGE_KEY)) };
	if (days === 0) delete next[subjectId];
	else next[subjectId] = days;

	// 只有持久化成功才发布新快照；配额/权限错误交给 UI 显示，旧值保持不变。
	window.localStorage.setItem(AIRING_OFFSETS_STORAGE_KEY, JSON.stringify(next));
	publish(Object.freeze(next));
}
