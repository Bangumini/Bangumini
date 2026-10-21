import { useId, useState } from "react";
import {
	MAX_AIRING_OFFSET_DAYS,
	formatAiringOffsetDays,
	isValidAiringOffsetDays,
	shiftAiringDate,
	shiftAiringWeekday,
} from "@shared/airing-offset";
import { setAiringOffsetDays } from "../api/airing-offset";

type Props = {
	subjectId: number;
	appliedDays: number;
	originalDate?: string;
	airWeekday?: number;
	previewEpisode?: { sort: number; airdate: string };
};

function hasValidDate(date: string | undefined): date is string {
	if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const parsed = new Date(`${date}T00:00:00Z`);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function weekdayLabel(weekday: number | undefined) {
	return weekday ? ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][weekday] : undefined;
}

export default function AiringOffsetControl({
	subjectId,
	appliedDays,
	originalDate,
	airWeekday,
	previewEpisode,
}: Props) {
	const inputId = useId();
	const [draft, setDraft] = useState({ base: appliedDays, value: String(appliedDays) });
	const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
	// 跨窗口更新时同步草稿基准；即使之后回到旧值，也不能复活旧草稿。
	if (draft.base !== appliedDays) {
		setDraft({ base: appliedDays, value: String(appliedDays) });
		setFeedback(null);
	}
	const value = draft.base === appliedDays ? draft.value : String(appliedDays);
	const days = value.trim() === "" ? NaN : Number(value);
	const valid = isValidAiringOffsetDays(days);
	const dirty = !valid || days !== appliedDays;
	const dateAvailable = hasValidDate(originalDate);
	const episodeAvailable = hasValidDate(previewEpisode?.airdate);
	const previewWeekday = valid ? weekdayLabel(shiftAiringWeekday(airWeekday, days)) : undefined;
	const buttonClass = "rounded-md border border-line bg-elevated px-2 py-1 text-[12px] hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed";

	function updateDraft(next: string) {
		setDraft({ base: appliedDays, value: next });
		setFeedback(null);
	}

	function save(next: number) {
		try {
			setAiringOffsetDays(subjectId, next);
			setDraft({ base: next, value: String(next) });
			setFeedback({ error: false, text: next === 0 ? "已恢复默认" : "已保存" });
		} catch {
			setFeedback({ error: true, text: "保存失败，本机存储不可用；原设置未改变" });
		}
	}

	return (
		<section
			data-airing-offset-control
			aria-label="条目放送日期偏置"
			className="rounded-card border border-line bg-surface/60 p-3 space-y-2 text-[12px]"
			onKeyDown={(event) => event.stopPropagation()}
		>
			<div className="flex items-start justify-between gap-2">
				<h3 className="font-medium text-fg">放送日期偏置</h3>
				<span
					className="text-accent"
					aria-label={`已应用：${formatAiringOffsetDays(appliedDays)}`}
					title="仅保存在本机，不修改 Bangumi 数据；排期更新后请复核"
				>
					{formatAiringOffsetDays(appliedDays)}
				</span>
			</div>
			<label htmlFor={inputId} className="block text-fg-secondary">偏置天数（负数提前，正数延后）</label>
			<input
				id={inputId}
				type="number"
				step={1}
				min={-MAX_AIRING_OFFSET_DAYS}
				max={MAX_AIRING_OFFSET_DAYS}
				value={value}
				aria-invalid={!valid}
				aria-describedby={!valid ? `${inputId}-hint` : undefined}
				onChange={(event) => updateDraft(event.target.value)}
				className="w-full rounded-md border border-line bg-elevated px-2 py-1.5 text-fg tabular-nums"
			/>
			{!valid && (
				<p id={`${inputId}-hint`} role="alert" className="text-danger">
					请输入 -{MAX_AIRING_OFFSET_DAYS} 至 {MAX_AIRING_OFFSET_DAYS} 之间的整数天
				</p>
			)}
			<div className="flex gap-2">
				<button type="button" className={buttonClass} disabled={!valid || days <= -MAX_AIRING_OFFSET_DAYS} onClick={() => updateDraft(String(days - 1))}>提前1天</button>
				<button type="button" className={buttonClass} disabled={!valid || days >= MAX_AIRING_OFFSET_DAYS} onClick={() => updateDraft(String(days + 1))}>延后1天</button>
			</div>
			<div className="text-fg-secondary break-words">
				{dateAvailable ? (
					<p title={previewWeekday}>首播：{originalDate} → {valid ? shiftAiringDate(originalDate, days) : "—"}</p>
				) : episodeAvailable && previewEpisode ? (
					<p>第 {previewEpisode.sort} 集：{previewEpisode.airdate} → {valid ? shiftAiringDate(previewEpisode.airdate, days) : "—"}</p>
				) : (
					<p className="text-fg-tertiary">暂无放送日期</p>
				)}
			</div>
			<div className="flex items-center gap-2">
				<button type="button" disabled={!valid} onClick={() => save(days)} className={`${buttonClass} text-accent`}>保存</button>
				<button type="button" onClick={() => save(0)} className={buttonClass}>恢复默认</button>
				{dirty && <span className="text-fg-tertiary">未保存</span>}
			</div>
			{feedback && <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "text-danger" : "text-success"}>{feedback.text}</p>}
		</section>
	);
}
