import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../api/tauri-fetch";
import { PinIcon } from "./icons";

export default function WindowPinToggle() {
	const [pinned, setPinned] = useState(false);

	useEffect(() => {
		if (!isTauri()) return;

		let active = true;
		getCurrentWindow()
			.isAlwaysOnTop()
			.then((value) => {
				if (active) setPinned(value);
			})
			.catch(() => {});

		return () => {
			active = false;
		};
	}, []);

	if (!isTauri()) return null;

	const handleToggle = async () => {
		const next = !pinned;
		try {
			await getCurrentWindow().setAlwaysOnTop(next);
			setPinned(next);
		} catch {
			// 置顶失败时保持当前状态，避免控件与窗口实际状态不一致。
		}
	};

	return (
		<button
			type="button"
			onClick={() => void handleToggle()}
			className={`fixed top-2 right-2 z-[60] flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
				pinned
					? "bg-accent-soft text-accent"
					: "text-fg-tertiary hover:bg-hover hover:text-fg"
			}`}
			title={pinned ? "取消临时置顶" : "临时置顶窗口"}
			aria-label={pinned ? "取消临时置顶" : "临时置顶窗口"}
			aria-pressed={pinned}
		>
			<PinIcon size={15} />
		</button>
	);
}
