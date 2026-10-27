import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DEFAULT_OFFSET_SYNC_PREFIX, normalizeOffsetSyncConfig } from "@shared/offset-sync-config";
import type { OffsetSyncConfig } from "@shared/offset-sync-config";
import { formatAiringOffsetDays } from "@shared/airing-offset";
import { offsetSync } from "../api/airing-offset-sync";
import type { AiringOffsetSyncManager } from "../api/airing-offset-sync-types";
import useAiringOffsetSync from "../hooks/useAiringOffsetSync";

const buttonClass = "rounded-md border border-line bg-elevated px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent";
const detailClass = "text-[12px] text-fg-tertiary";

function emptyConfig(): OffsetSyncConfig {
	return { provider: "webdav", prefix: DEFAULT_OFFSET_SYNC_PREFIX, autoSync: true, url: "", username: "", password: "" };
}

function Field({ label, value, onChange, secret = false, url = false }: {
	label: string; value: string; onChange: (value: string) => void; secret?: boolean; url?: boolean;
}) {
	const id = useId();
	return <div className="min-w-0">
		<label htmlFor={id} className="block text-[12px] text-fg-tertiary mb-1">{label}</label>
		<input id={id} type={secret ? "password" : url ? "url" : "text"} value={value}
			onChange={event => onChange(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false}
			className="w-full min-w-0 px-3 py-1.5 text-[13px] bg-elevated rounded-md border border-line text-fg focus:border-accent focus:outline-none" />
	</div>;
}

function Toggle({ label, value, onChange, disabled = false, title = false }: {
	label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean; title?: boolean;
}) {
	const id = useId();
	return <div className="flex items-center justify-between gap-4">
		{title ? <h3 id={id} className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary">{label}</h3>
			: <span id={id} className="text-[13px] text-fg-secondary">{label}</span>}
		<button type="button" role="switch" aria-labelledby={id} aria-checked={value} disabled={disabled}
			onClick={() => onChange(!value)}
			className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent ${value ? "bg-accent" : "bg-line"}`}>
			<span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? "translate-x-4" : "translate-x-0"}`} />
		</button>
	</div>;
}

function sameConfig(left: OffsetSyncConfig, right: OffsetSyncConfig) {
	const a = left as unknown as Record<string, unknown>;
	const b = right as unknown as Record<string, unknown>;
	return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
}

type Result = { message: string; apply?: () => void };

function describeDays(days: number) {
	return `${formatAiringOffsetDays(days)}（${days > 0 ? "+" : ""}${days} 天）`;
}

function AccountSettings({ manager, account }: { manager: AiringOffsetSyncManager; account: string }) {
	const status = useAiringOffsetSync(manager);
	const [draft, setDraft] = useState<OffsetSyncConfig>(emptyConfig);
	const [saved, setSaved] = useState<OffsetSyncConfig | null>(null);
	const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
	const [attempt, setAttempt] = useState(0);
	const [pending, setPending] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<{ message: string; error?: boolean } | null>(null);
	const mounted = useRef(false);
	const lock = useRef(false);
	const current = useCallback(() => {
		const latest = manager.getSnapshot();
		return mounted.current && latest.account === account && latest.ready && latest.enabled;
	}, [manager, account]);
	useEffect(() => {
		let active = true;
		mounted.current = true;
		void manager.getConfig().then(config => {
			if (!active || !current()) return;
			const base = config ? normalizeOffsetSyncConfig(config) : null;
			setDraft(base ?? emptyConfig());
			setSaved(base);
			setLoad("ready");
		}).catch(() => {
			if (active && current()) setLoad("error");
		});
		return () => { active = false; mounted.current = false; };
	}, [manager, account, current, attempt]);

	let normalized: OffsetSyncConfig | null = null;
	try { normalized = normalizeOffsetSyncConfig(draft); } catch { /* 不渲染可能含凭证的异常对象。 */ }
	const dirty = !normalized || !saved || !sameConfig(normalized, saved);
	const busy = load !== "ready" || pending !== null || status.phase === "syncing";
	function update(patch: Partial<OffsetSyncConfig>) {
		setDraft(previous => ({ ...previous, ...patch } as OffsetSyncConfig));
		setFeedback(null);
	}
	function selectProvider(provider: OffsetSyncConfig["provider"]) {
		if (busy || draft.provider === provider) return;
		setDraft(provider === "webdav" ? { ...emptyConfig(), prefix: draft.prefix, autoSync: draft.autoSync }
			: { provider: "s3", prefix: draft.prefix, autoSync: draft.autoSync, endpoint: "", region: "auto", bucket: "", accessKeyId: "", secretAccessKey: "", forcePathStyle: true });
		setFeedback(null);
	}
	async function run(label: string, work: () => Promise<Result>) {
		// 同步上锁，防止 disabled 提交前的重复点击；卸载后拒绝迟到反馈。
		if (lock.current || busy || !current() || manager.getSnapshot().phase === "syncing") return;
		lock.current = true;
		setPending(label);
		setFeedback(null);
		try {
			const result = await work();
			if (current()) { result.apply?.(); setFeedback({ message: result.message }); }
		} catch {
			if (current()) setFeedback({ message: `${label}失败，请检查配置或网络后重试。`, error: true });
		} finally {
			lock.current = false;
			if (current()) setPending(null);
		}
	}
	function save() {
		const config = normalized;
		if (!config || !dirty) return;
		void run("保存配置", async () => {
			await manager.saveConfig(config);
			return { message: "配置已保存。", apply: () => setSaved(config) };
		});
	}
	function test() {
		const config = normalized;
		if (!config) return;
		void run("读取连接", async () => {
			const result = await manager.testConnection(config);
			return { message: result.exists ? "已读取偏置文件；未验证写权限。" : "连接可用，未找到偏置文件；未验证写权限。" };
		});
	}
	if (load === "loading") return <p role="status" className={detailClass}>正在读取当前账号安全配置…</p>;
	if (load === "error") return <div className="space-y-2">
		<p role="alert" className="text-[12px] text-danger">读取安全配置失败，请重试。</p>
		<button type="button" className={buttonClass} onClick={() => { setLoad("loading"); setAttempt(value => value + 1); }}>重试读取配置</button>
	</div>;
	return <div className="space-y-3">
		<fieldset disabled={busy} className="min-w-0 space-y-3">
			<legend className="sr-only">同步存储配置</legend>
			<div className="flex flex-wrap gap-2" role="group" aria-label="存储协议">
				{(["webdav", "s3"] as const).map(provider => <button key={provider} type="button"
					aria-pressed={draft.provider === provider} onClick={() => selectProvider(provider)}
					className={`${buttonClass} ${draft.provider === provider ? "border-accent text-accent" : ""}`}>
					{provider === "webdav" ? "WebDAV" : "S3 / R2"}
				</button>)}
			</div>
			{draft.provider === "webdav" ? <>
				<Field label="WebDAV 地址" value={draft.url} url onChange={url => update({ url })} />
				<div className="grid grid-cols-2 gap-2">
					<Field label="WebDAV 用户名" value={draft.username} secret onChange={username => update({ username })} />
					<Field label="WebDAV 密码" value={draft.password} secret onChange={password => update({ password })} />
				</div>
			</> : <>
				<Field label="S3 Endpoint" value={draft.endpoint} url onChange={endpoint => update({ endpoint })} />
				<div className="grid grid-cols-2 gap-2">
					<Field label="S3 Region" value={draft.region} onChange={region => update({ region })} />
					<Field label="S3 Bucket" value={draft.bucket} onChange={bucket => update({ bucket })} />
				</div>
				<Field label="S3 Access Key ID" value={draft.accessKeyId} secret onChange={accessKeyId => update({ accessKeyId })} />
				<Field label="S3 Secret Access Key" value={draft.secretAccessKey} secret onChange={secretAccessKey => update({ secretAccessKey })} />
				<Field label="S3 Session Token（可选）" value={draft.sessionToken ?? ""} secret onChange={sessionToken => update({ sessionToken })} />
				<Toggle label="S3 forcePathStyle" value={draft.forcePathStyle} disabled={busy} onChange={forcePathStyle => update({ forcePathStyle })} />
			</>}
			<Field label="存储目录前缀" value={draft.prefix} onChange={prefix => update({ prefix })} />
			<Toggle label="自动同步" value={draft.autoSync} disabled={busy} onChange={autoSync => update({ autoSync })} />
		</fieldset>
		{!normalized ? <p className={detailClass}>请填写完整配置，存储地址须使用 HTTPS。</p>
			: dirty ? <p className={detailClass}>草稿未保存；请先保存后再立即同步。</p> : null}
		<div className="flex flex-wrap gap-2">
			<button type="button" className={`${buttonClass} text-accent`} disabled={busy || !normalized || !dirty} onClick={save}>保存配置</button>
			<button type="button" className={buttonClass} disabled={busy || !normalized} onClick={test}>测试读取连接（只读）</button>
			<button type="button" className={buttonClass} disabled={busy || !status.configured || dirty} onClick={() => {
				if (dirty || !status.configured) return;
				void run("立即同步", async () => { await manager.syncNow(); return { message: "同步请求已完成，请查看同步状态。" }; });
			}}>立即同步</button>
			<button type="button" className={`${buttonClass} text-danger`} disabled={busy || !status.configured} onClick={() => {
				void run("断开同步", async () => {
					await manager.disconnect();
					return { message: "已断开同步；本地偏置和远端文件均保留。", apply: () => { setSaved(null); setDraft(emptyConfig()); } };
				});
			}}>断开同步</button>
		</div>
		<div role="status" className={`${detailClass} space-y-1`}>
			<p>{status.phase === "syncing" ? "同步中…" : status.configured ? "已配置同步" : "尚未配置同步"} · 冲突：{status.conflicts.length} 条</p>
			<p>上次成功：{status.lastSyncedAt === null ? "暂无" : new Date(status.lastSyncedAt).toLocaleString("zh-CN", { hour12: false })}</p>
		</div>
		{status.error && <p role="alert" className="text-[12px] text-danger">同步未完成，请检查配置或网络后重试。</p>}
		{status.conflicts.map(conflict => <div key={conflict.subjectId} className="rounded-md border border-line p-2 space-y-2 text-[12px]">
			<p className="text-fg-secondary">条目 {conflict.subjectId}</p>
			<p className="text-fg-tertiary">本机：{describeDays(conflict.local.days)} · 远端：{describeDays(conflict.remote.days)}</p>
			<div className="flex flex-wrap gap-2">
				{(["local", "remote"] as const).map(choice => <button key={choice} type="button" className={buttonClass}
					aria-label={`条目 ${conflict.subjectId}：${choice === "local" ? "保留本机" : "采用远端"}`}
					disabled={busy || dirty || !status.configured} onClick={() => {
						if (dirty || !status.configured) return;
						void run("解决冲突", async () => {
							await manager.resolveConflict(conflict.subjectId, choice);
							return { message: "已提交冲突选择，请查看同步状态。" };
						});
					}}>{choice === "local" ? "保留本机" : "采用远端"}</button>)}
			</div>
		</div>)}
		{pending && <p role="status" className={detailClass}>{pending}中…</p>}
		{feedback && <p role={feedback.error ? "alert" : "status"} className={`text-[12px] ${feedback.error ? "text-danger" : "text-fg-tertiary"}`}>{feedback.message}</p>}
	</div>;
}

function SyncSection({ manager }: { manager: AiringOffsetSyncManager }) {
	const status = useAiringOffsetSync(manager);
	const [changing, setChanging] = useState(false);
	const [failure, setFailure] = useState(false);
	const mounted = useRef(false);
	const lock = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	async function toggle(enabled: boolean) {
		const before = manager.getSnapshot();
		if (lock.current || !before.ready || !before.account || enabled === before.enabled) return;
		const account = before.account;
		lock.current = true;
		setChanging(true);
		setFailure(false);
		try { await manager.setEnabled(enabled); }
		catch {
			const latest = manager.getSnapshot();
			if (mounted.current && latest.account === account) {
				// 开关可能已保存而后续恢复失败，不误报为开关持久化失败。
				setFailure(latest.enabled !== enabled || !latest.error);
			}
		} finally {
			lock.current = false;
			if (mounted.current) setChanging(false);
		}
	}
	return <>
		<Toggle title label="同步" value={status.enabled} disabled={changing || !status.account || !status.ready}
			onChange={enabled => { void toggle(enabled); }} />
		{!status.account ? <p className={detailClass}>请登录后配置同步。</p>
			: !status.ready ? <p role="status" className={detailClass}>正在恢复当前账号同步配置…</p>
				: status.enabled ? <AccountSettings manager={manager} account={status.account} /> : null}
		{changing && <p role="status" className={detailClass}>正在保存同步开关…</p>}
		{failure && <p role="alert" className="text-[12px] text-danger">同步开关保存失败，请重试。</p>}
	</>;
}

export default function AiringOffsetSyncSettings({ manager = offsetSync }: { manager?: AiringOffsetSyncManager }) {
	const status = useAiringOffsetSync(manager);
	const [identity, setIdentity] = useState({ manager, version: 0 });
	if (identity.manager !== manager) setIdentity({ manager, version: identity.version + 1 });
	// 切账号或更换 manager 立即卸载旧状态；关闭与恢复期间不挂载凭证表单。
	return <section aria-label="同步" className="space-y-3" onKeyDown={event => event.stopPropagation()}>
		<SyncSection key={JSON.stringify([identity.version, status.account])} manager={manager} />
	</section>;
}
