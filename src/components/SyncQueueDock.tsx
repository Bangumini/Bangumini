import { useCallback, useEffect, useRef, useState } from "react";
import {
	COLLECTION_TASK_QUEUE_EVENT,
	getCollectionTaskQueue,
	getCollectionTaskSummary,
	ignoreCollectionTask,
	retryCollectionTask,
	type CollectionTask,
} from "../api/collection-tasks";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

function sortTasks(tasks: CollectionTask[]) {
	return tasks.slice().sort((a, b) => {
		const pa = a.status === "failed" ? 0 : a.status === "running" ? 1 : 2;
		const pb = b.status === "failed" ? 0 : b.status === "running" ? 1 : 2;
		return pa - pb || a.createdAt - b.createdAt;
	});
}

function getTaskStatusLabel(task: CollectionTask) {
	if (task.status === "failed") return "同步失败";
	if (task.status === "running") return "同步中";
	return "等待同步";
}

function SyncIcon() {
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
			className="animate-spin"
		>
			<path d="M21 12a9 9 0 0 1-13.34 7.61M3 12a9 9 0 0 1 13.34-7.61" />
			<path d="m20 4v4h-4M4 20v-4h4" />
		</svg>
	);
}

function ClockIcon() {
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
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 3" />
		</svg>
	);
}

function AlertCircleIcon() {
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
			<circle cx="12" cy="12" r="9" />
			<path d="M12 8v4M12 16h.01" />
		</svg>
	);
}

function XIcon() {
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
			<path d="M18 6 6 18M6 6l12 12" />
		</svg>
	);
}

function CopyIcon() {
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
			<rect x="9" y="9" width="12" height="12" rx="2" />
			<path d="M5 15V5a2 2 0 0 1 2-2h10" />
		</svg>
	);
}

function CheckIcon() {
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
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

const TASK_LIST_MAX_HEIGHT = 320;

export default function SyncQueueDock() {
	const [tasks, setTasks] = useState<CollectionTask[]>([]);
	const [expanded, setExpanded] = useState(false);
	const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
	const mountedRef = useRef(true);
	const copyTimerRef = useRef<number | null>(null);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (copyTimerRef.current !== null)
				window.clearTimeout(copyTimerRef.current);
		};
	}, []);

	const sync = useCallback(() => {
		getCollectionTaskQueue()
			.then((next) => {
				if (!mountedRef.current) return;
				setTasks(next);
				if (next.length === 0) setExpanded(false);
			})
			.catch(() => {});
	}, []);

	// 复制错误信息到剪贴板：成功后按钮图标短暂切换为 ✓，失败则直接复原
	const handleCopyError = useCallback((task: CollectionTask) => {
		if (!task.lastError) return;
		if (copyTimerRef.current !== null)
			window.clearTimeout(copyTimerRef.current);
		void navigator.clipboard.writeText(task.lastError).then(
			() => {
				if (!mountedRef.current) return;
				setCopiedTaskId(task.id);
				copyTimerRef.current = window.setTimeout(() => {
					if (mountedRef.current) setCopiedTaskId(null);
				}, 1200);
			},
			() => {
				// 复制失败：不打扰用户，按钮直接复原
				if (mountedRef.current) setCopiedTaskId(null);
			},
		);
	}, []);

	useEffect(() => {
		sync();
		window.addEventListener(COLLECTION_TASK_QUEUE_EVENT, sync);
		return () => window.removeEventListener(COLLECTION_TASK_QUEUE_EVENT, sync);
	}, [sync]);

	useKeyboardShortcuts(
		[
			{
				key: "Escape",
				when: () => expanded,
				stopPropagation: true,
				handler: () => setExpanded(false),
			},
		],
		// 队列展开时必须优先消费 Esc：priority 需高于 Layout 的全局 Esc（20），
		// 否则 Layout 会先清空搜索框/隐藏窗口，队列永远无法用 Esc 收起
		{ priority: 30 },
	);

	if (tasks.length === 0) return null;

	const sorted = sortTasks(tasks);
	const first = sorted[0];
	const statusIcon =
		first.status === "failed" ? (
			<AlertCircleIcon />
		) : first.status === "running" ? (
			<SyncIcon />
		) : (
			<ClockIcon />
		);

	return (
		<>
			{expanded && (
				<div
					className="fixed inset-0 z-40"
					onClick={() => setExpanded(false)}
				/>
			)}

			<div className="fixed bottom-4 right-4 z-50">
				{!expanded && (
					<button
						onClick={() => setExpanded(true)}
						className="flex items-center gap-2.5 px-3.5 py-2 bg-elevated border border-line rounded-full shadow-pop hover:border-line-strong transition-colors"
					>
						<span
							className={`shrink-0 ${first.status === "failed" ? "text-danger" : first.status === "running" ? "text-accent" : "text-fg-tertiary"}`}
						>
							{statusIcon}
						</span>
						<span className="text-[12px] text-fg-secondary font-medium truncate max-w-48">
							{getCollectionTaskSummary(first)}
						</span>
						{sorted.length > 1 && (
							<span className="shrink-0 min-w-5 h-5 flex items-center justify-center px-1 rounded-full bg-hover text-[11px] font-semibold text-fg-tertiary">
								{sorted.length}
							</span>
						)}
					</button>
				)}

				{expanded && (
					<div
						className="w-80 bg-elevated rounded-xl border border-line-strong shadow-pop overflow-hidden"
						onMouseDown={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between px-4 pt-3 pb-2">
							<span className="text-[12px] font-semibold text-fg">
								同步队列 · {sorted.length} 个任务
							</span>
							<button
								onClick={() => setExpanded(false)}
								className="text-fg-tertiary hover:text-fg transition-colors"
							>
								<XIcon />
							</button>
						</div>

						<div
							className="overflow-y-auto px-2 pb-2 space-y-1"
							style={{ maxHeight: `${TASK_LIST_MAX_HEIGHT}px` }}
						>
							{sorted.map((task) => {
								const taskIcon =
									task.status === "failed" ? (
										<AlertCircleIcon />
									) : task.status === "running" ? (
										<SyncIcon />
									) : (
										<ClockIcon />
									);

								return (
									<div
										key={task.id}
										className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-surface hover:bg-hover transition-colors"
									>
										<span
											className={`shrink-0 ${task.status === "failed" ? "text-danger" : task.status === "running" ? "text-accent" : "text-fg-tertiary"}`}
										>
											{taskIcon}
										</span>

										<div className="flex-1 min-w-0">
											<p className="text-[12px] text-fg font-medium truncate">
												{getCollectionTaskSummary(task)}
											</p>
											<p
												className={`text-[11px] line-clamp-2 break-words ${task.status === "failed" ? "text-danger" : "text-fg-tertiary"}`}
											>
												{task.status === "failed" && task.lastError
													? `同步失败: ${task.lastError}`
													: getTaskStatusLabel(task)}
											</p>
										</div>

										{task.status === "failed" && (
											<button
												onClick={() => {
													void retryCollectionTask(task.id);
												}}
												className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full border border-line hover:bg-hover hover:text-fg text-fg-tertiary transition-colors"
												title="重试"
											>
												<SyncIcon />
											</button>
										)}
										{task.status === "failed" && (
											<button
												onClick={() => void handleCopyError(task)}
												className={`shrink-0 w-7 h-7 flex items-center justify-center rounded-full border transition-colors ${
													copiedTaskId === task.id
														? "border-line-strong text-accent"
														: "border-line hover:bg-hover hover:text-fg text-fg-tertiary"
												}`}
												title={
													copiedTaskId === task.id ? "已复制" : "复制错误信息"
												}
											>
												{copiedTaskId === task.id ? (
													<CheckIcon />
												) : (
													<CopyIcon />
												)}
											</button>
										)}
										{task.status !== "running" && (
											<button
												onClick={() => {
													void ignoreCollectionTask(task.id);
												}}
												className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full border border-line hover:bg-hover hover:text-fg text-fg-tertiary transition-colors"
												title="忽略"
											>
												<XIcon />
											</button>
										)}
									</div>
								);
							})}
						</div>

						<div className="px-3 py-1.5 text-[11px] text-fg-tertiary border-t border-line/50">
							Esc 关闭
						</div>
					</div>
				)}
			</div>
		</>
	);
}
