import { useSyncExternalStore } from "react";
import {
	getAiringOffsetsSnapshot,
	subscribeAiringOffsets,
} from "../api/airing-offset.ts";

export function useAiringOffsets(): Readonly<Record<number, number>> {
	return useSyncExternalStore(
		subscribeAiringOffsets,
		getAiringOffsetsSnapshot,
		getAiringOffsetsSnapshot,
	);
}
