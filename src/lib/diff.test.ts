import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModel, diffInWorker, lineAnchor, parsePatch, splitPairs, threadRowIndex, validRange, view, wordDiff } from './diff.ts';
import type { FileModel, PrFile, Row, Thread } from '../types.ts';

const file: PrFile = { path: 'f', status: 'modified', additions: 1, deletions: 1, viewed: 'UNVIEWED' };
const model = (rows: Row[], complete = true): FileModel => ({ rows, complete });
const thread = (props: Partial<Thread>): Thread => ({ id: 't', path: 'f', line: 2, startLine: null, originalLine: null, side: 'RIGHT', startSide: null, isResolved: false, isOutdated: false, subjectType: 'LINE', viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true, comments: [], ...props });

describe('parsePatch', () => {
  it.each([
    ['-old\n\\ No newline at end of file\n+new\n', [true, undefined]],
    ['-old\n+new\n\\ No newline at end of file\n', [undefined, true]],
    ['-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n', [true, true]],
  ])('attaches EOF markers only to preceding rows', (body, flags) => {
    expect(parsePatch('@@ -1 +1 @@\n' + body).hunks[0].rows.map(r => r.noEol)).toEqual(flags);
  });
  it('handles CRLF, omitted counts, zero counts, empty body lines, and no phantom final line', () => {
    const p = parsePatch('@@ -0,0 +1,2 @@ title\n+one\r\n+\n@@ -4 +6 @@\n\n');
    expect(p.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, header: 'title' });
    expect(p.hunks[0].rows).toEqual([{ kind: 'add', newNo: 1, text: 'one', cr: true, hunk: 0 }, { kind: 'add', newNo: 2, text: '', hunk: 0 }]);
    expect(p.hunks[1].rows).toEqual([{ kind: 'ctx', oldNo: 4, newNo: 6, text: '', hunk: 1 }]);
    expect(parsePatch('@@ -1 +1 @@\n a\n').hunks[0].rows).toHaveLength(1);
  });
});

describe('buildModel', () => {
  it('fills gaps using the next hunk offset, and the final hunk end offset', () => {
    const parsed = parsePatch('@@ -3 +3,2 @@\n-c\n+C\n+X\n@@ -6 +7 @@\n-f\n+F\n');
    const full = buildModel(file, parsed, 'a\nb\nC\nX\nd\ne\nF\ng\n');
    expect(full.complete).toBe(true);
    expect(full.rows.filter(r => r.kind === 'ctx').map(r => [r.oldNo, r.newNo, r.text])).toEqual([[1, 1, 'a'], [2, 2, 'b'], [4, 5, 'd'], [5, 6, 'e'], [7, 8, 'g']]);
    expect(full.rows.filter(r => r.kind === 'ctx').every(r => r.hunk === undefined)).toBe(true);
    expect(buildModel(file, parsed, 'wrong\n').complete).toBe(false);
    expect(buildModel(file, parsed, null).complete).toBe(false);
    expect(buildModel({ ...file, status: 'added' }, parsed, null).complete).toBe(true);
    expect(buildModel({ ...file, status: 'removed' }, parsed, null).complete).toBe(true);
  });
  it('fills around pure insertion and deletion hunks with zero counts', () => {
    const inserted = buildModel(file, parsePatch('@@ -1,0 +2 @@\n+b\n'), 'a\nb\nc\n');
    expect(inserted.rows.map(r => [r.oldNo, r.newNo])).toEqual([[1, 1], [undefined, 2], [2, 3]]);
    const deleted = buildModel(file, parsePatch('@@ -2 +1,0 @@\n-b\n'), 'a\nc\n');
    expect(deleted.rows.map(r => [r.oldNo, r.newNo])).toEqual([[1, 1], [2, undefined], [3, 2]]);
  });
  it('matches a real git diff with full context', () => {
    try { execFileSync('git', ['--version']); } catch { return; }
    const dir = mkdtempSync(join(tmpdir(), 'ghr-diff-'));
    try {
      const before = Array.from({ length: 70 }, (_, i) => `line ${i + 1}`);
      const after = [...before];
      after.splice(10, 1, 'replacement', 'insertion');
      after.splice(50, 2, 'later');
      writeFileSync(join(dir, 'old'), before.join('\n') + '\n');
      writeFileSync(join(dir, 'new'), after.join('\n') + '\n');
      const run = (n: number) => {
        try { return execFileSync('git', ['diff', '--no-index', `-U${n}`, 'old', 'new'], { cwd: dir, encoding: 'utf8' }); }
        catch (error) { return (error as { stdout: string }).stdout; }
      };
      const built = buildModel(file, parsePatch(run(3)), after.join('\n') + '\n');
      const withoutHunk = (rows: Row[]) => rows.map(({ hunk: _h, ...r }) => r);
      expect(built.complete).toBe(true);
      expect(withoutHunk(built.rows)).toEqual(withoutHunk(parsePatch(run(99999)).hunks.flatMap(h => h.rows)));
      const zeroContext = buildModel(file, parsePatch(run(0)), after.join('\n') + '\n');
      expect(withoutHunk(zeroContext.rows)).toEqual(withoutHunk(built.rows));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('view', () => {
  const rows: Row[] = Array.from({ length: 31 }, (_, i) => ({ kind: i === 10 || i === 20 ? 'add' : 'ctx', text: `${i}`, newNo: i + 1, oldNo: i + 1 }));
  it.each([[0, 2], [3, 14], [10, 31], [Infinity, 31]])('selects context %s', (context, count) => {
    expect(view(model(rows), context, []).filter(i => i.kind === 'row')).toHaveLength(count);
  });
  it('merges context and expansions into expandable hidden runs', () => {
    const items = view(model(rows), 0, [[0, 5], [4, 9]]);
    expect(items.slice(0, 11)).toEqual(Array.from({ length: 11 }, (_, idx) => ({ kind: 'row', idx })));
    expect(items[11]).toEqual({ kind: 'gap', from: 11, to: 19, count: 9, expandable: true });
  });
  it('shows all incomplete rows and unexpandable unknown gaps', () => {
    const rows = parsePatch('@@ -5 +5 @@\n-a\n+b\n@@ -10 +10 @@\n c\n').hunks.flatMap(h => h.rows);
    expect(view(model(rows, false), 0, [])).toEqual([
      { kind: 'gap', from: -1, to: -1, count: 4, expandable: false },
      { kind: 'row', idx: 0 }, { kind: 'row', idx: 1 },
      { kind: 'gap', from: -1, to: -1, count: 4, expandable: false },
      { kind: 'row', idx: 2 }, { kind: 'gap', from: -1, to: -1, count: -1, expandable: false },
    ]);
    expect(view(model([], false), 0, [])).toEqual([]);
  });
});

it('pairs delete/add runs and preserves context and gaps', () => {
  const rows: Row[] = ['ctx', 'del', 'del', 'add', 'add', 'add', 'ctx'].map(kind => ({ kind: kind as Row['kind'], text: '' }));
  const items = rows.map((_, idx) => ({ kind: 'row' as const, idx }));
  expect(splitPairs(items, rows)).toEqual([{ kind: 'pair', left: 0, right: 0 }, { kind: 'pair', left: 1, right: 3 }, { kind: 'pair', left: 2, right: 4 }, { kind: 'pair', left: null, right: 5 }, { kind: 'pair', left: 6, right: 6 }]);
  const gap = { kind: 'gap' as const, from: 1, to: 2, count: 2, expandable: true };
  expect(splitPairs([gap], rows)).toEqual([gap]);
});

it('validates same-hunk and same-side ranges, anchors and threads', () => {
  const rows = parsePatch('@@ -1,3 +1,3 @@\n c\n-d\n+e\n f\n@@ -7 +7 @@\n g\n').hunks.flatMap(h => h.rows);
  const m = model([...rows, { kind: 'ctx', oldNo: 8, newNo: 8, text: 'gap' }]);
  const R = (line: number) => ({ side: 'RIGHT' as const, line });
  const L = (line: number) => ({ side: 'LEFT' as const, line });
  expect(validRange(m, R(3), R(1))).toEqual({ ok: true, startSide: 'RIGHT', startLine: 1, side: 'RIGHT', line: 3, startIdx: 0, endIdx: 3 });
  expect(validRange(m, L(2), L(2))).toMatchObject({ ok: true, startSide: 'LEFT', startLine: 2, side: 'LEFT', line: 2 });
  expect(validRange(m, L(1), L(2))).toMatchObject({ ok: true, startSide: 'LEFT', startLine: 1, side: 'LEFT', line: 2 });
  expect(validRange(m, L(2), R(2))).toMatchObject({ ok: true, startSide: 'LEFT', startLine: 2, side: 'RIGHT', line: 2 });
  expect(validRange(m, R(1), R(7)).ok).toBe(false);
  expect(validRange(m, R(1), R(8)).ok).toBe(false);
  expect(validRange(m, R(1), R(900)).ok).toBe(false);
  expect(lineAnchor(rows[1])).toEqual({ side: 'LEFT', line: 2 });
  expect(lineAnchor(rows[2])).toEqual({ side: 'RIGHT', line: 2 });
  expect(lineAnchor(rows[0], 'LEFT')).toEqual({ side: 'LEFT', line: 1 });
  expect(lineAnchor(rows[0])).toEqual({ side: 'RIGHT', line: 1 });
  expect(lineAnchor(m.rows[5])).toBeNull();
  expect(threadRowIndex(m, thread({}))).toBe(2);
  expect(threadRowIndex(m, thread({ side: 'LEFT' }))).toBe(1);
  expect(threadRowIndex(m, thread({ side: 'LEFT', line: 1 }))).toBe(0);
  expect(threadRowIndex(m, thread({ isOutdated: true }))).toBe(-1);
  expect(threadRowIndex(m, thread({ subjectType: 'FILE' }))).toBe(-1);
  expect(threadRowIndex(m, thread({ line: 900 }))).toBe(-1);
});

it('highlights word differences and bounds long inputs', () => {
  const result = wordDiff('hello old world', 'hello new world');
  expect(result?.a.filter(s => s.changed).map(s => s.text).join('')).toBe('old');
  expect(result?.b.filter(s => s.changed).map(s => s.text).join('')).toBe('new');
  expect(wordDiff('x'.repeat(501), 'x')).toBeNull();
  expect(wordDiff('a', 'b')).toBe(wordDiff('a', 'b'));
});

it('shares a worker, correlates requests, and resolves failures as null', async () => {
  const workers: Array<{ onmessage: ((e: { data: unknown }) => void) | null; onerror: (() => void) | null; sent: Array<{ id: number }> }> = [];
  vi.stubGlobal('Worker', class {
    onmessage = null;
    onerror = null;
    sent: Array<{ id: number }> = [];
    constructor() { workers.push(this); }
    postMessage(value: { id: number }) { this.sent.push(value); }
    terminate() {}
  });
  try {
    const a = diffInWorker('a', 'b');
    const b = diffInWorker('c', 'd');
    expect(workers).toHaveLength(1);
    const rows: Row[] = [{ kind: 'add', text: 'b', newNo: 1 }];
    workers[0].onmessage?.({ data: { id: workers[0].sent[1].id, rows: null } });
    workers[0].onmessage?.({ data: { id: workers[0].sent[0].id, rows } });
    expect(await a).toEqual(rows);
    expect(await b).toBeNull();
    const c = diffInWorker('e', 'f');
    workers[0].onerror?.();
    expect(await c).toBeNull();
    const d = diffInWorker('g', 'h');
    expect(workers).toHaveLength(2);
    workers[1].onmessage?.({ data: { id: workers[1].sent[0].id, rows: [] } });
    expect(await d).toEqual([]);
  } finally { vi.unstubAllGlobals(); }
});


it('worker preserves EOF-only differences, CR markers, and line numbers without hunks', async () => {
  const messages: Array<{ id: number; rows: Row[] | null }> = [];
  const scope = { onmessage: null as ((event: { data: { id: number; oldText: string; newText: string } }) => void) | null, postMessage: (data: { id: number; rows: Row[] | null }) => messages.push(data) };
  vi.stubGlobal('self', scope);
  try {
    await import('./diff.worker.ts');
    scope.onmessage?.({ data: { id: 1, oldText: 'x', newText: 'x\n' } });
    expect(messages[0]).toEqual({ id: 1, rows: [{ kind: 'del', oldNo: 1, text: 'x', noEol: true }, { kind: 'add', newNo: 1, text: 'x' }] });
    scope.onmessage?.({ data: { id: 2, oldText: 'a\r\nb', newText: 'a\r\nc' } });
    expect(messages[1].rows).toEqual([{ kind: 'ctx', oldNo: 1, newNo: 1, text: 'a', cr: true }, { kind: 'del', oldNo: 2, text: 'b', noEol: true }, { kind: 'add', newNo: 2, text: 'c', noEol: true }]);
    scope.onmessage?.({ data: { id: 3, oldText: 'x\n', newText: 'x' } });
    expect(messages[2].rows).toEqual([{ kind: 'del', oldNo: 1, text: 'x' }, { kind: 'add', newNo: 1, text: 'x', noEol: true }]);
  } finally { vi.unstubAllGlobals(); }
});
it('preserves missing EOF newline on a filled trailing context line', () => {
  const parsed = parsePatch('@@ -1 +1 @@\n-old\n+new\n');
  const full = buildModel(file, parsed, 'new\nlast');
  expect(full.rows.at(-1)).toEqual({kind:'ctx',oldNo:2,newNo:2,text:'last',noEol:true});
});
