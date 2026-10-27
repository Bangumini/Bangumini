import type { CalendarItem, SubjectSmall } from "./api/types.ts";
import { isSameJsonPayload } from "./payload-equality.ts";

export type CalendarDiff = {
	calendar: CalendarItem[];
	changed: boolean;
	/** 新增或有字段变化的条目，用于只回写受影响的 subject 预览。 */
	changedSubjects: SubjectSmall[];
};

/**
 * 对比服务端日历与内存快照：
 * 未变化的条目复用原对象，避免整页因一次刷新全部重建。
 */
export function diffCalendar(
	current: CalendarItem[] | undefined,
	incoming: CalendarItem[],
): CalendarDiff {
	if (!current) {
		return {
			calendar: incoming,
			changed: true,
			changedSubjects: incoming.flatMap((day) => day.items),
		};
	}
	if (isSameJsonPayload(current, incoming)) {
		return { calendar: current, changed: false, changedSubjects: [] };
	}

	const currentById = new Map<number, SubjectSmall>();
	for (const day of current) {
		for (const item of day.items) currentById.set(item.id, item);
	}

	const changedSubjects: SubjectSmall[] = [];
	const calendar = incoming.map((day) => ({
		...day,
		items: day.items.map((item) => {
			const previous = currentById.get(item.id);
			if (previous && isSameJsonPayload(previous, item)) return previous;
			changedSubjects.push(item);
			return item;
		}),
	}));

	return { calendar, changed: true, changedSubjects };
}
