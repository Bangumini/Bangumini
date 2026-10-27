export type OffsetSyncRecord = { days: number; revision: string; updatedAt: number };
export type OffsetSyncRecords = Readonly<Record<string, OffsetSyncRecord>>;
export type OffsetSyncDocument = {
	schemaVersion: 1;
	kind: 'bangumini-airing-offsets';
	account: string;
	records: OffsetSyncRecords;
};
export type OffsetSyncConflict = {
	subjectId: number;
	local: OffsetSyncRecord;
	remote: OffsetSyncRecord;
};

export const MAX_OFFSET_SYNC_BYTES = 2 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function assertByteLimit(raw: string): void {
	// 不依赖 Node Buffer 或移动端可能缺失的 TextEncoder；孤立代理项按 UTF-8 替换字符计数。
	let bytes = 0;
	for (let index = 0; index < raw.length; index++) {
		const code = raw.charCodeAt(index);
		if (code <= 0x7f) bytes++;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff
			&& raw.charCodeAt(index + 1) >= 0xdc00 && raw.charCodeAt(index + 1) <= 0xdfff) {
			bytes += 4;
			index++;
		} else bytes += 3;
		if (bytes > MAX_OFFSET_SYNC_BYTES) throw new Error('Offset sync document exceeds 2 MiB');
	}
}

function validateRecords(value: unknown): OffsetSyncRecords {
	if (!isObject(value)) throw new Error('Invalid offset sync records');
	if (Object.keys(value).length > 10000) throw new Error('Too many offset sync records');
	const records: Record<string, OffsetSyncRecord> = {};
	for (const key of Object.keys(value)) {
		const subjectId = Number(key);
		if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(subjectId) || String(subjectId) !== key) {
			throw new Error('Invalid offset sync subject ID');
		}
		const record = value[key];
		if (!isObject(record) || !hasExactKeys(record, ['days', 'revision', 'updatedAt'])
			|| !Number.isInteger(record.days) || (record.days as number) < -365 || (record.days as number) > 365
			|| typeof record.revision !== 'string' || record.revision.length === 0 || record.revision.length > 128
			|| !Number.isSafeInteger(record.updatedAt) || (record.updatedAt as number) < 0) {
			throw new Error('Invalid offset sync record');
		}
		records[key] = { days: record.days as number, revision: record.revision, updatedAt: record.updatedAt as number };
	}
	return records;
}

export function parseOffsetSyncDocument(raw: string, account: string): OffsetSyncDocument {
	if (typeof raw !== 'string') throw new Error('Invalid offset sync document');
	assertByteLimit(raw);
	const value: unknown = JSON.parse(raw);
	if (!isObject(value) || !hasExactKeys(value, ['schemaVersion', 'kind', 'account', 'records'])
		|| value.schemaVersion !== 1 || value.kind !== 'bangumini-airing-offsets'
		|| typeof account !== 'string' || value.account !== account) {
		throw new Error('Invalid offset sync document or account');
	}
	return { schemaVersion: 1, kind: 'bangumini-airing-offsets', account, records: validateRecords(value.records) };
}

export function createOffsetSyncDocument(account: string, records: OffsetSyncRecords): OffsetSyncDocument {
	if (typeof account !== 'string') throw new Error('Invalid offset sync account');
	const document: OffsetSyncDocument = { schemaVersion: 1, kind: 'bangumini-airing-offsets', account, records: validateRecords(records) };
	assertByteLimit(JSON.stringify(document));
	return document;
}

export function sameOffsetSyncRecord(a: OffsetSyncRecord | undefined, b: OffsetSyncRecord | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined
		&& a.days === b.days && a.revision === b.revision && a.updatedAt === b.updatedAt);
}

export function sameOffsetSyncRecords(a: OffsetSyncRecords, b: OffsetSyncRecords): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length
		&& keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameOffsetSyncRecord(a[key], b[key]));
}

export function mergeOffsetSyncRecords(
	base: OffsetSyncRecords,
	local: OffsetSyncRecords,
	remote: OffsetSyncRecords,
): { local: OffsetSyncRecords; remote: OffsetSyncRecords; base: OffsetSyncRecords; conflicts: OffsetSyncConflict[] } {
	const oldBase = validateRecords(base);
	const localRecords = validateRecords(local);
	const remoteRecords = validateRecords(remote);
	const nextLocal: Record<string, OffsetSyncRecord> = {};
	const nextRemote: Record<string, OffsetSyncRecord> = {};
	const nextBase: Record<string, OffsetSyncRecord> = {};
	const conflicts: OffsetSyncConflict[] = [];
	const keys = new Set([...Object.keys(oldBase), ...Object.keys(localRecords), ...Object.keys(remoteRecords)]);
	for (const key of keys) {
		// 缺失 key 从不表示删除；恢复默认也必须携带永久保留的 days=0 记录。
		const previous = oldBase[key];
		const localRecord = localRecords[key] ?? previous;
		const remoteRecord = remoteRecords[key] ?? previous;
		// revision 表达编辑意图；updatedAt 仅显示，不参与修改检测或胜负判定。
		const localChanged = localRecord?.days !== previous?.days || localRecord?.revision !== previous?.revision;
		const remoteChanged = remoteRecord?.days !== previous?.days || remoteRecord?.revision !== previous?.revision;
		if (localRecord !== undefined && remoteRecord !== undefined
			&& localChanged && remoteChanged && localRecord.days !== remoteRecord.days) {
			nextLocal[key] = { ...localRecord };
			nextRemote[key] = { ...remoteRecord };
			// 冲突必须保留旧基线，包括首次同步时没有基线这一事实。
			if (previous !== undefined) nextBase[key] = { ...previous };
			conflicts.push({ subjectId: Number(key), local: { ...localRecord }, remote: { ...remoteRecord } });
			continue;
		}
		// 值已相同则直接采用远端版本，避免仅 revision 不同引发来回写入。
		const sameDays = localRecord !== undefined && remoteRecords[key] !== undefined && localRecord.days === remoteRecords[key].days;
		const merged = sameDays ? remoteRecord : localChanged ? localRecord : remoteRecord;
		if (merged !== undefined) {
			nextLocal[key] = { ...merged };
			nextRemote[key] = { ...merged };
			nextBase[key] = { ...merged };
		}
	}
	return { local: nextLocal, remote: nextRemote, base: nextBase, conflicts };
}
