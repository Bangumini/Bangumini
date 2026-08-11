// 右下角堆叠容器：更新提示 / 同步队列等浮层自上而下排列，互不遮挡。
// 由 Layout 与详情页共用，保证 SyncQueueDock 在任意页面都固定于右下角。
import type { ReactNode } from "react";

export default function CornerStack({ children }: { children: ReactNode }) {
	return (
		<div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
			{children}
		</div>
	);
}
