// 设置页分区展开/收起状态的本地持久化。
// SettingsPage 的通用分区与同步卡片共用同一份数据，键为分区标识
// （account / shortcut / proxy / general / update / sync）。
// 未记录的分区回退到各自的默认值（同步默认收起，其余默认展开）。

const STORAGE_KEY = "bangumini_settings_sections_v1";

type SectionStateMap = Record<string, boolean>;

function readStateMap(): SectionStateMap {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return {};
		return parsed as SectionStateMap;
	} catch {
		return {};
	}
}

/** 读取分区展开状态；未记录或数据异常时返回 defaultExpanded。 */
export function readSectionExpanded(
	key: string,
	defaultExpanded: boolean,
): boolean {
	const value = readStateMap()[key];
	return typeof value === "boolean" ? value : defaultExpanded;
}

/** 写入单个分区的展开状态；写失败静默忽略（仅影响偏好记忆）。 */
export function writeSectionExpanded(key: string, expanded: boolean): void {
	try {
		const state = readStateMap();
		state[key] = expanded;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		/* ignore */
	}
}
