// 只经同步公开接口验证协议和纯三路合并，不替换内部实现。
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import {
	MAX_OFFSET_SYNC_BYTES,
	parseOffsetSyncDocument,
	createOffsetSyncDocument,
	sameOffsetSyncRecord,
	sameOffsetSyncRecords,
	mergeOffsetSyncRecords,
} from '../shared/airing-offset-sync.ts';

const record = (days, revision = 'edit-1', updatedAt = 1) => ({ days, revision, updatedAt });
const document = (records = {}, account = 'alice') => ({
	schemaVersion: 1, kind: 'bangumini-airing-offsets', account, records,
});

test('同步文档往返保留偏置、恢复默认 tombstone 和精确账号', () => {
	const expected = document({ 1: record(-365), 2: record(0), 9007199254740991: record(365) });
	const created = createOffsetSyncDocument('alice', expected.records);
	assert.deepEqual(created, expected);
	assert.deepEqual(parseOffsetSyncDocument(JSON.stringify(created), 'alice'), expected);
});

test('坏文档或任何非法记录整体拒绝，不能留下可上传的部分成功结果', () => {
	for (const raw of ['', '{', 'null', '[]', 'true']) {
		assert.throws(() => parseOffsetSyncDocument(raw, 'alice'));
	}
	for (const patch of [
		{ schemaVersion: 2 }, { schemaVersion: '1' }, { kind: 'other' },
		{ account: 'Alice' }, { account: 'alice ' }, { account: '昵称' },
		{ records: null }, { records: [] }, { records: 1 },
	]) {
		assert.throws(() => parseOffsetSyncDocument(JSON.stringify({ ...document(), ...patch }), 'alice'));
	}
	for (const key of ['0', '-1', '01', '1.0', '1e2', ' 1', '9007199254740992', '__proto__', 'constructor', 'prototype']) {
		const raw = JSON.stringify(document({ 1: record(1), [key]: record(2) }));
		assert.throws(() => parseOffsetSyncDocument(raw, 'alice'), key);
	}
	for (const invalid of [
		null, [], {}, record(366), record(-366), record(0.5), record('1'),
		record(1, ''), record(1, 'x'.repeat(129)), record(1, 1),
		record(1, 'r', -1), record(1, 'r', 0.5), record(1, 'r', Number.MAX_SAFE_INTEGER + 1),
	]) {
		const raw = JSON.stringify(document({ 1: record(1), 2: invalid }));
		assert.throws(() => parseOffsetSyncDocument(raw, 'alice'));
		assert.throws(() => createOffsetSyncDocument('alice', { 1: record(1), 2: invalid }));
	}
	assert.equal({}.days, undefined, '原型未被污染');
});

test('文档限制是 UTF-8 原始字节与 10000 条记录，创建也拒绝无法安全上传的文档', () => {
	assert.equal(MAX_OFFSET_SYNC_BYTES, 2 * 1024 * 1024);
	const raw = JSON.stringify(document());
	const atLimit = raw + ' '.repeat(MAX_OFFSET_SYNC_BYTES - Buffer.byteLength(raw));
	assert.deepEqual(parseOffsetSyncDocument(atLimit, 'alice'), document());
	assert.throws(() => parseOffsetSyncDocument(atLimit + ' ', 'alice'));
	const unicode = JSON.stringify(document({}, '汉😀'));
	const tooLarge = unicode + ' '.repeat(MAX_OFFSET_SYNC_BYTES - unicode.length);
	assert.throws(() => parseOffsetSyncDocument(tooLarge, '汉😀'), '不能按 UTF-16 string.length 限流');
	const many = Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [String(index + 1), record(0)]));
	assert.equal(Object.keys(createOffsetSyncDocument('alice', many).records).length, 10000);
	assert.equal(Object.keys(parseOffsetSyncDocument(JSON.stringify(document(many)), 'alice').records).length, 10000);
	const excess = { ...many, 10001: record(1) };
	assert.throws(() => createOffsetSyncDocument('alice', excess));
	assert.throws(() => parseOffsetSyncDocument(JSON.stringify(document(excess)), 'alice'));
	const multibyte = Object.fromEntries(Object.keys(many).map((key) => [key, record(1, '汉'.repeat(128))]));
	assert.throws(() => createOffsetSyncDocument('alice', multibyte), '条数合法但编码超过 2MiB 仍拒绝');
});

test('未知字段、继承记录和非有限数值不被悄悄清洗为可上传数据', () => {
	assert.throws(() => parseOffsetSyncDocument(JSON.stringify({ ...document(), future: 1 }), 'alice'));
	assert.throws(() => createOffsetSyncDocument('alice', { 1: { ...record(1), future: 1 } }));
	assert.throws(() => createOffsetSyncDocument('alice', Object.create({ 1: record(1) })));
	assert.throws(() => createOffsetSyncDocument('alice', { 1: Object.create(record(1)) }));
	for (const value of [NaN, Infinity, -Infinity]) {
		assert.throws(() => createOffsetSyncDocument('alice', { 1: record(value) }));
		assert.throws(() => createOffsetSyncDocument('alice', { 1: record(1, 'r', value) }));
	}
	const records = { 1: record(1, 'r'.repeat(128), Number.MAX_SAFE_INTEGER) };
	const created = createOffsetSyncDocument('alice', records);
	records[1].days = 2;
	assert.equal(created.records[1].days, 1, '创建的上传快照不跟随调用方后续编辑');
});

test('同步相等比较包含 revision 和显示时间，不依赖对象引用或 key 顺序', () => {
	assert.equal(sameOffsetSyncRecord(undefined, undefined), true);
	assert.equal(sameOffsetSyncRecord(record(0), undefined), false);
	assert.equal(sameOffsetSyncRecord(undefined, record(0)), false);
	assert.equal(sameOffsetSyncRecord(record(1), record(1)), true);
	assert.equal(sameOffsetSyncRecord(record(1), record(2)), false);
	assert.equal(sameOffsetSyncRecord(record(1), record(1, 'new-edit')), false);
	assert.equal(sameOffsetSyncRecord(record(1), record(1, 'edit-1', 2)), false);
	assert.equal(sameOffsetSyncRecords({}, {}), true);
	assert.equal(sameOffsetSyncRecords({ 1: record(0) }, {}), false);
	assert.equal(sameOffsetSyncRecords({}, { 1: record(0) }), false);
	assert.equal(sameOffsetSyncRecords({ 1: record(0) }, { 2: record(0) }), false);
	assert.equal(sameOffsetSyncRecords({ 2: record(0), 1: record(1) }, { 1: record(1), 2: record(0) }), true);
	assert.equal(sameOffsetSyncRecords({ 1: record(0) }, { 1: record(0, 'new-edit') }), false);
});

test('不同条目以及单边改动自动合并为共同基线，不修改输入', () => {
	const base = { 1: record(1, 'base-1'), 2: record(2, 'base-2') };
	const local = { 1: record(-1, 'local-1'), 2: record(2, 'base-2'), 3: record(0, 'local-3') };
	const remote = { 1: record(1, 'base-1'), 2: record(3, 'remote-2'), 4: record(4, 'remote-4') };
	const before = structuredClone({ base, local, remote });
	for (const records of [base, local, remote]) {
		Object.values(records).forEach(Object.freeze);
		Object.freeze(records);
	}
	const expected = { 1: record(-1, 'local-1'), 2: record(3, 'remote-2'), 3: record(0, 'local-3'), 4: record(4, 'remote-4') };
	assert.deepEqual(mergeOffsetSyncRecords(base, local, remote), {
		local: expected, remote: expected, base: expected, conflicts: [],
	});
	assert.deepEqual({ base, local, remote }, before);
	const first = mergeOffsetSyncRecords({}, { 1: record(1) }, { 2: record(2) });
	assert.deepEqual(first, {
		local: { 1: record(1), 2: record(2) },
		remote: { 1: record(1), 2: record(2) },
		base: { 1: record(1), 2: record(2) }, conflicts: [],
	});
});

test('同条目双边不同值保留冲突和旧基线，时钟再大也不自动胜出', () => {
	for (const [base, local, remote] of [
		[{ 1: record(1, 'base') }, { 1: record(2, 'local', 0) }, { 1: record(3, 'remote', Number.MAX_SAFE_INTEGER) }],
		[{}, { 1: record(0, 'restore-default', 999) }, { 1: record(7, 'old-remote', 0) }],
		[{ 1: record(1, 'base') }, { 1: record(1, 'changed-back') }, { 1: record(2, 'remote') }],
		[{ 1: record(1, 'base') }, { 1: record(2, 'local') }, { 1: record(1, 'remote-changed-back') }],
	]) {
		const expected = {
			local, remote, base,
			conflicts: [{ subjectId: 1, local: local[1], remote: remote[1] }],
		};
		const merged = mergeOffsetSyncRecords(base, local, remote);
		assert.deepEqual(merged, expected);
		assert.deepEqual(mergeOffsetSyncRecords(merged.base, merged.local, merged.remote), expected,
			'下一轮不可把冲突伪装成单边修改而覆盖另一端');
	}
	const merged = mergeOffsetSyncRecords(
		{ 1: record(1, 'base') },
		{ 1: record(2, 'local'), 2: record(4, 'new-local') },
		{ 1: record(3, 'remote'), 3: record(5, 'new-remote') },
	);
	assert.deepEqual(merged.base, { 1: record(1, 'base'), 2: record(4, 'new-local'), 3: record(5, 'new-remote') });
	assert.deepEqual(merged.remote, { 1: record(3, 'remote'), 2: record(4, 'new-local'), 3: record(5, 'new-remote') });
	assert.deepEqual(merged.local, { 1: record(2, 'local'), 2: record(4, 'new-local'), 3: record(5, 'new-remote') });
});

test('相同 days 即使 revision 不同也选远端版本收敛，而不按时间排序', () => {
	for (const base of [{}, { 1: record(1, 'base') }, { 1: record(2, 'base') }]) {
		const remote = { 1: record(2, 'remote', 0) };
		const merged = mergeOffsetSyncRecords(base, { 1: record(2, 'local', 999999) }, remote);
		assert.deepEqual(merged, { local: remote, remote, base: remote, conflicts: [] });
		assert.deepEqual(mergeOffsetSyncRecords(merged.base, merged.local, merged.remote), merged);
	}
	const tombstone = { 1: record(0, 'remote-reset', 0) };
	assert.deepEqual(mergeOffsetSyncRecords({}, { 1: record(0, 'local-reset', 100) }, tombstone), {
		local: tombstone, remote: tombstone, base: tombstone, conflicts: [],
	});
});

test('冲突选择以所见 remote 为新基线，保留本地后遇到新远端意图再次冲突', () => {
	const original = mergeOffsetSyncRecords(
		{ 1: record(1, 'old-base') }, { 1: record(2, 'local') }, { 1: record(3, 'seen-remote') },
	);
	const seen = original.conflicts[0].remote;
	const selectedBase = { ...original.base, 1: seen };
	const keepLocal = mergeOffsetSyncRecords(selectedBase, original.local, original.remote);
	assert.deepEqual(keepLocal, {
		local: { 1: record(2, 'local') }, remote: { 1: record(2, 'local') },
		base: { 1: record(2, 'local') }, conflicts: [],
	});
	const changedRemote = { 1: record(4, 'new-remote') };
	const retry = mergeOffsetSyncRecords(selectedBase, original.local, changedRemote);
	assert.deepEqual(retry.conflicts, [{ subjectId: 1, local: record(2, 'local'), remote: record(4, 'new-remote') }]);
	assert.deepEqual(retry.base, { 1: seen });
	const adoptRemote = mergeOffsetSyncRecords(selectedBase, { 1: seen }, original.remote);
	assert.deepEqual(adoptRemote, { local: { 1: seen }, remote: { 1: seen }, base: { 1: seen }, conflicts: [] });
	// 手动选择即使值与基线相同，也能通过新 revision 表达“选择这个值”的意图。
	const explicitChoice = record(3, 'adopt-remote-choice');
	assert.deepEqual(mergeOffsetSyncRecords(selectedBase, { 1: explicitChoice }, changedRemote).conflicts,
		[{ subjectId: 1, local: explicitChoice, remote: changedRemote[1] }]);
});

test('updatedAt 只供展示，单独改变时间不代表新的编辑意图', () => {
	const base = { 1: record(1, 'base', 1) };
	const remote = { 1: record(2, 'remote-edit', 0) };
	assert.deepEqual(mergeOffsetSyncRecords(base, { 1: record(1, 'base', 99999) }, remote), {
		local: remote, remote, base: remote, conflicts: [],
	});
	const local = { 1: record(2, 'local-edit', 0) };
	assert.deepEqual(mergeOffsetSyncRecords(base, local, { 1: record(1, 'base', 99999) }), {
		local, remote: local, base: local, conflicts: [],
	});
});

test('空远端或缺失 key 不删除已有数据，也不抹掉本地改回原值的新 revision', () => {
	for (const [base, local, remote, expected] of [
		[{}, { 1: record(7, 'local') }, {}, { 1: record(7, 'local') }],
		[{ 1: record(7, 'base') }, { 1: record(0, 'reset') }, {}, { 1: record(0, 'reset') }],
		[{ 1: record(7, 'base') }, { 1: record(7, 'changed-back') }, {}, { 1: record(7, 'changed-back') }],
		[{ 1: record(0, 'reset') }, {}, {}, { 1: record(0, 'reset') }],
		[{ 1: record(7, 'base') }, {}, { 1: record(8, 'remote') }, { 1: record(8, 'remote') }],
	]) {
		assert.deepEqual(mergeOffsetSyncRecords(base, local, remote), {
			local: expected, remote: expected, base: expected, conflicts: [],
		});
	}
});
