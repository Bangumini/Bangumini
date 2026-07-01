import type { CalendarItem, UserCollection } from "./api/types";

export function getTodayBangumiWeekday(): number {
  const jsDay = new Date().getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function getTodayDateKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weekdayOffset(weekday: number, today: number): number {
  return (weekday - today + 7) % 7;
}

function getTotalEp(c: UserCollection): number {
  return c.subject.eps || c.subject.total_episodes || 0;
}

export type SortedGroup = "airing_not_caught" | "finished" | "completed" | "airing_caught" | "pre_air";

export interface CollectionMeta {
  group: SortedGroup;
  weekday: number;
  airedEp: number;
}

export function getCollectionMeta(
  c: UserCollection,
  airingMap: Map<number, number>,
  airedEpMap: Map<number, number>,
  today: number,
  airingTimeMap?: Map<number, { airingAt: number; episode: number }>,
): CollectionMeta {
  const weekday = airingMap.get(c.subject_id) ?? c.subject.air_weekday ?? 0;
  const isAiring = airingMap.has(c.subject_id);
  const totalEp = getTotalEp(c);
  const knownAiredEp = isAiring ? airedEpMap.get(c.subject_id) : totalEp;

  const airedEp = knownAiredEp ?? Math.max(1, c.ep_status);

  // Check if today's episode has actually aired yet
  let effectiveAiredEp = airedEp;
  if (isAiring && weekday === today && airingTimeMap) {
    const airingTime = airingTimeMap.get(c.subject_id);
    if (airingTime) {
      // Extract time-of-day from the stored airing time (assuming weekly same-time schedule)
      const airingDate = new Date(airingTime.airingAt * 1000);
      const airingMinutes = airingDate.getHours() * 60 + airingDate.getMinutes();

      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      if (nowMinutes < airingMinutes) {
        // Current time hasn't reached today's airing time yet
        effectiveAiredEp = Math.max(0, airedEp - 1);
      }
    }
  }

  let group: SortedGroup;
  const todayDateKey = getTodayDateKey();

  if (isAiring && c.subject.date && c.subject.date > todayDateKey) {
    group = "pre_air";
  } else if (totalEp > 0 && c.ep_status >= totalEp) {
    group = "completed";
  } else if (!isAiring && c.ep_status === 0) {
    group = "finished";
  } else if (isAiring && c.ep_status < effectiveAiredEp) {
    group = "airing_not_caught";
  } else if (isAiring) {
    group = "airing_caught";
  } else {
    group = "finished";
  }

  return { group, weekday, airedEp };
}

export function sortCollections(
  collections: UserCollection[],
  calendar: CalendarItem[],
  today: number,
  airedEpMap: Map<number, number>,
  airingTimeMap?: Map<number, { airingAt: number; episode: number }>,
): UserCollection[] {
  const airingMap = new Map<number, number>();
  for (const day of calendar) {
    for (const item of day.items) {
      airingMap.set(item.id, day.weekday.id);
    }
  }

  const groupI: UserCollection[] = [];
  const groupII: UserCollection[] = [];
  const groupIII: UserCollection[] = [];
  const groupIV: UserCollection[] = [];
  const groupV: UserCollection[] = [];

  for (const c of collections) {
    const { group } = getCollectionMeta(c, airingMap, airedEpMap, today, airingTimeMap);

    if (group === "airing_not_caught") {
      groupI.push(c);
    } else if (group === "completed") {
      groupIV.push(c);
    } else if (group === "airing_caught") {
      groupIII.push(c);
    } else if (group === "pre_air") {
      groupV.push(c);
    } else {
      groupII.push(c);
    }
  }

  groupI.sort((a, b) => {
    const wa = airingMap.get(a.subject_id) ?? 0;
    const wb = airingMap.get(b.subject_id) ?? 0;
    return weekdayOffset(wa, today) - weekdayOffset(wb, today);
  });

  groupIII.sort((a, b) => {
    const wa = airingMap.get(a.subject_id) ?? 0;
    const wb = airingMap.get(b.subject_id) ?? 0;
    return weekdayOffset(wa, today) - weekdayOffset(wb, today);
  });

  groupV.sort((a, b) => (a.subject.date || "").localeCompare(b.subject.date || ""));

  const groupIIa = groupII.filter((c) => c.ep_status > 0);
  const groupIIb = groupII.filter((c) => c.ep_status === 0);

  return [...groupI, ...groupIIa, ...groupIIb, ...groupIII, ...groupV, ...groupIV];
}

export function getDisplayLabel(
  c: UserCollection,
  airingMap: Map<number, number>,
  airedEpMap: Map<number, number>,
  today: number,
  airingTimeMap?: Map<number, { airingAt: number; episode: number }>,
): string | null {
  const { group } = getCollectionMeta(c, airingMap, airedEpMap, today, airingTimeMap);

  if (group === "pre_air") {
    if (c.subject.date) {
      const parts = c.subject.date.split("-");
      if (parts.length === 3) {
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        return `${m}月${d}日 开播`;
      }
    }
    return "即将开播";
  }

  if (group === "airing_caught") {
    const { weekday, airedEp } = getCollectionMeta(c, airingMap, airedEpMap, today, airingTimeMap);
    if (weekday <= 0) return "等待更新";

    let label: string;
    let showTodayAsNextWeek = false;

    // Check if today's episode has aired and user caught up - show next week instead
    if (weekday === today && airingTimeMap) {
      const airingTime = airingTimeMap.get(c.subject_id);
      if (airingTime) {
        // Compare time-of-day only (assuming weekly same-time schedule)
        const airingDate = new Date(airingTime.airingAt * 1000);
        const airingMinutes = airingDate.getHours() * 60 + airingDate.getMinutes();

        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        // If episode has aired today AND user has caught up to it, show next week
        if (nowMinutes >= airingMinutes && c.ep_status >= airedEp) {
          showTodayAsNextWeek = true;
        }
      }
    }

    if (weekday === today && !showTodayAsNextWeek) {
      label = "今日";
    } else {
      const tomorrow = today >= 7 ? 1 : today + 1;
      label = weekday === tomorrow ? "明日" : WEEKDAY_CN[weekday].replace("星期", "周");
    }

    const at = airingTimeMap?.get(c.subject_id);
    if (at) {
      const d = new Date(at.airingAt * 1000);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      if (showTodayAsNextWeek) {
        return `下周${label} ${hh}:${mm} 更新`;
      }
      return `${label} ${hh}:${mm} 更新`;
    }

    return `${label}更新`;
  }

  if (group === "airing_not_caught" || (group === "finished" && c.ep_status > 0)) {
    return `继续观看 ${c.ep_status + 1}`;
  }

  if (group === "completed") {
    return "已看完";
  }

  if (group === "finished" && c.ep_status === 0) {
    return "开始观看";
  }

  return null;
}

export { weekdayOffset };
export const WEEKDAY_CN: Record<number, string> = {
  1: "星期一",
  2: "星期二",
  3: "星期三",
  4: "星期四",
  5: "星期五",
  6: "星期六",
  7: "星期日",
};
