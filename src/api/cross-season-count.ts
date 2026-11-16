export { getCrossSeasonEpisodeOffset } from "../../shared/cross-season.ts";

export const CROSS_SEASON_COUNT_STORAGE_KEY = "bangumini_cross_season_count";

export function isCrossSeasonCountEnabled() {
	try {
		return localStorage.getItem(CROSS_SEASON_COUNT_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

export function setCrossSeasonCountEnabled(enabled: boolean) {
	localStorage.setItem(CROSS_SEASON_COUNT_STORAGE_KEY, String(enabled));
}
