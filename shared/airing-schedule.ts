export const LATE_NIGHT_CUTOFF_MINUTES = 6 * 60;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type ScheduleConfidence = "aligned" | "track_conflict";

export type AiringEpisode = {
	ep: number;
	airdate: string;
};

export type AiringObservation = {
	airingAt: number;
	episode: number;
	fetchedAt: number;
};

export type AiringSchedule = {
	minuteOfDayJst: number;
	dayOffset: 0 | 1;
	confidence: ScheduleConfidence;
	observedAiringAt: number;
	observedEpisode: number;
	fetchedAt: number;
};

type TokyoDateTime = {
	dateKey: string;
	weekday: number;
	hour: number;
	minute: number;
};

function getTokyoDateTime(unixSeconds: number): TokyoDateTime {
	const date = new Date(unixSeconds * 1000 + JST_OFFSET_MS);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const jsWeekday = date.getUTCDay();

	return {
		dateKey: `${year}-${month}-${day}`,
		weekday: jsWeekday === 0 ? 7 : jsWeekday,
		hour: date.getUTCHours(),
		minute: date.getUTCMinutes(),
	};
}

function addDateKeyDays(dateKey: string, days: number): string {
	const [year, month, day] = dateKey.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day + days));
	return [
		date.getUTCFullYear(),
		String(date.getUTCMonth() + 1).padStart(2, "0"),
		String(date.getUTCDate()).padStart(2, "0"),
	].join("-");
}

function nextWeekday(weekday: number): number {
	return weekday >= 7 ? 1 : weekday + 1;
}

export function getTokyoDateKey(nowMs: number): string {
	return getTokyoDateTime(nowMs / 1000).dateKey;
}

export function deriveAiringSchedule(
	bgmWeekday: number | undefined,
	episodes: AiringEpisode[],
	observation: AiringObservation,
): AiringSchedule {
	const observed = getTokyoDateTime(observation.airingAt);
	const minuteOfDayJst = observed.hour * 60 + observed.minute;
	const isLateNightRollover =
		bgmWeekday !== undefined &&
		observed.weekday === nextWeekday(bgmWeekday) &&
		minuteOfDayJst < LATE_NIGHT_CUTOFF_MINUTES;
	const dayOffset = isLateNightRollover ? 1 : 0;
	const nominalDate = addDateKeyDays(observed.dateKey, -dayOffset);
	const episodeAligned = episodes.some(
		(episode) =>
			episode.airdate === nominalDate && episode.ep === observation.episode,
	);
	const weekdayAligned =
		bgmWeekday !== undefined &&
		(observed.weekday === bgmWeekday || isLateNightRollover);

	return {
		minuteOfDayJst,
		dayOffset,
		confidence: weekdayAligned && episodeAligned ? "aligned" : "track_conflict",
		observedAiringAt: observation.airingAt,
		observedEpisode: observation.episode,
		fetchedAt: observation.fetchedAt,
	};
}

export function getEffectiveAiringAt(
	episode: AiringEpisode,
	schedule: AiringSchedule,
): number {
	const [year, month, day] = episode.airdate.split("-").map(Number);
	const hour = Math.floor(schedule.minuteOfDayJst / 60);
	const minute = schedule.minuteOfDayJst % 60;

	return Date.UTC(year, month - 1, day + schedule.dayOffset, hour - 9, minute);
}

export function deriveAiredEpisodeCount(
	episodes: AiringEpisode[],
	schedule: AiringSchedule | null,
	nowMs: number,
): number {
	if (!schedule) {
		const today = getTokyoDateKey(nowMs);
		return episodes.filter(
			(episode) => episode.airdate && episode.airdate <= today,
		).length;
	}

	return episodes.filter(
		(episode) =>
			episode.airdate && getEffectiveAiringAt(episode, schedule) <= nowMs,
	).length;
}

export function getNextEpisodeAiringAt(
	episodes: AiringEpisode[],
	schedule: AiringSchedule | null,
	nowMs: number,
): number | null {
	if (!schedule) return null;

	let nextAiringAt: number | null = null;
	for (const episode of episodes) {
		if (!episode.airdate) continue;
		const airingAt = getEffectiveAiringAt(episode, schedule);
		if (airingAt <= nowMs) continue;
		if (nextAiringAt === null || airingAt < nextAiringAt) {
			nextAiringAt = airingAt;
		}
	}
	return nextAiringAt;
}
