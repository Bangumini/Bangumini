// 右下角「发现新版本」提醒卡片。
// 与 SyncQueueDock 同处右下角容器（更新提示在上方），视觉风格保持一致。
import type { ReactNode } from "react";

interface UpdatePromptProps {
	latestVersion: string;
	onUpdate: () => void;
	onDismiss: () => void;
	onSkip: (version: string) => void;
}

function UpdateIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M12 3v12" />
			<path d="m7 10 5 5 5-5" />
			<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
		</svg>
	);
}

function XIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M18 6 6 18M6 6l12 12" />
		</svg>
	);
}

export default function UpdatePrompt({
	latestVersion,
	onUpdate,
	onDismiss,
	onSkip,
}: UpdatePromptProps): ReactNode {
	return (
		<div className="w-72 bg-elevated rounded-xl border border-line-strong shadow-pop overflow-hidden">
			<div className="flex items-center justify-between pl-4 pr-3 pt-3">
				<div className="flex items-center gap-2">
					<span className="text-accent">
						<UpdateIcon />
					</span>
					<span className="text-[12px] font-semibold text-fg">
						发现新版本 v{latestVersion}
					</span>
				</div>
				<button
					onClick={onDismiss}
					title="关闭"
					className="text-fg-tertiary hover:text-fg transition-colors"
				>
					<XIcon />
				</button>
			</div>
			<div className="px-4 pt-2 pb-3">
				<p className="text-[12px] text-fg-secondary leading-relaxed">
					有新版本可用，前往设置页查看更新内容并决定是否下载。
				</p>
				<div className="flex gap-2 mt-2.5">
					<button
						onClick={onUpdate}
						className="flex-1 px-3 py-1.5 text-[12px] font-medium bg-accent text-accent-fg rounded-md hover:opacity-90 transition-opacity"
					>
						去更新
					</button>
					<button
						onClick={() => onSkip(latestVersion)}
						className="px-3 py-1.5 text-[12px] font-medium bg-elevated text-fg-tertiary rounded-md border border-line hover:bg-hover hover:text-fg-secondary transition-colors"
					>
						跳过此版本
					</button>
				</div>
			</div>
		</div>
	);
}
