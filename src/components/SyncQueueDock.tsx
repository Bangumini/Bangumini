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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
      <path d="M21 12a9 9 0 0 1-13.34 7.61M3 12a9 9 0 0 1 13.34-7.61" />
      <path d="m20 4v4h-4M4 20v-4h4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function AlertCircleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

const TASK_LIST_MAX_HEIGHT = 320;

export default function SyncQueueDock() {
  const [tasks, setTasks] = useState<CollectionTask[]>([]);
  const [expanded, setExpanded] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const sync = useCallback(() => {
    getCollectionTaskQueue().then((next) => {
      if (!mountedRef.current) return;
      setTasks(next);
      if (next.length === 0) setExpanded(false);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    sync();
    window.addEventListener(COLLECTION_TASK_QUEUE_EVENT, sync);
    return () => window.removeEventListener(COLLECTION_TASK_QUEUE_EVENT, sync);
  }, [sync]);

  useKeyboardShortcuts([
    {
      key: "Escape",
      when: () => expanded,
      stopPropagation: true,
      handler: () => setExpanded(false),
    },
  ]);

  if (tasks.length === 0) return null;

  const sorted = sortTasks(tasks);
  const first = sorted[0];
  const statusIcon = first.status === "failed"
    ? <AlertCircleIcon />
    : first.status === "running"
      ? <SyncIcon />
      : <ClockIcon />;

  return (
    <>
      {expanded && (
        <div className="fixed inset-0 z-40" onClick={() => setExpanded(false)} />
      )}

      <div className="fixed bottom-4 right-4 z-50">
        {!expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="flex items-center gap-2.5 px-3.5 py-2 bg-elevated border border-line rounded-full shadow-pop hover:border-line-strong transition-colors"
          >
            <span className={`shrink-0 ${first.status === "failed" ? "text-danger" : first.status === "running" ? "text-accent" : "text-fg-tertiary"}`}>
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
                const taskIcon = task.status === "failed"
                  ? <AlertCircleIcon />
                  : task.status === "running"
                    ? <SyncIcon />
                    : <ClockIcon />;

                return (
                  <div
                    key={task.id}
                    className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-surface hover:bg-hover transition-colors"
                  >
                    <span className={`shrink-0 ${task.status === "failed" ? "text-danger" : task.status === "running" ? "text-accent" : "text-fg-tertiary"}`}>
                      {taskIcon}
                    </span>

                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] text-fg font-medium truncate">
                        {getCollectionTaskSummary(task)}
                      </p>
                      <p className={`text-[11px] ${task.status === "failed" ? "text-danger" : "text-fg-tertiary"}`}>
                        {task.status === "failed" && task.lastError
                          ? `同步失败: ${task.lastError}`
                          : getTaskStatusLabel(task)}
                      </p>
                    </div>

                    {task.status === "failed" && (
                      <button
                        onClick={() => { void retryCollectionTask(task.id); }}
                        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full border border-line hover:bg-hover hover:text-fg text-fg-tertiary transition-colors"
                        title="重试"
                      >
                        <SyncIcon />
                      </button>
                    )}
                    {task.status !== "running" && (
                      <button
                        onClick={() => { void ignoreCollectionTask(task.id); }}
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
