import { diffWordsWithSpace } from 'diff';
import type { Expansions, FileModel, Hunk, Item, ParsedPatch, PrFile, Row, Seg, Side, SplitItem, Thread } from '../types.ts';

function textFields(text: string): Pick<Row, 'text' | 'cr'> {
  return text.endsWith('\r') ? { text: text.slice(0, -1), cr: true } : { text };
}

export function parsePatch(patch: string): ParsedPatch {
  const hunks: Hunk[] = [];
  const lines = patch.split('\n');
  let current: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldUsed = 0;
  let newUsed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/.exec(line);
    if (match) {
      current = { oldStart: +match[1], oldLines: +(match[2] ?? 1), newStart: +match[3], newLines: +(match[4] ?? 1), header: match[5] ?? '', rows: [] };
      hunks.push(current);
      oldNo = current.oldStart;
      newNo = current.newStart;
      oldUsed = newUsed = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\ No newline at end of file')) {
      const previous = current.rows.at(-1);
      if (previous) previous.noEol = true;
      continue;
    }
    if (oldUsed >= current.oldLines && newUsed >= current.newLines) continue;
    if (line === '' && i === lines.length - 1) continue;
    const sign = line[0] ?? ' ';
    if (![' ', '+', '-'].includes(sign)) continue;
    const row: Row = { kind: sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx', ...textFields(line === '' ? '' : line.slice(1)), hunk: hunks.length - 1 };
    if (sign !== '+') { row.oldNo = oldNo++; oldUsed++; }
    if (sign !== '-') { row.newNo = newNo++; newUsed++; }
    current.rows.push(row);
  }
  return { hunks };
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function buildModel(file: PrFile, parsed: ParsedPatch, headText: string | null): FileModel {
  const patchRows = parsed.hunks.flatMap(h => h.rows);
  if (file.status === 'added' || file.status === 'removed') return { rows: patchRows, complete: true };
  if (headText === null) return { rows: patchRows, complete: false };
  const lines = splitLines(headText);
  if (patchRows.some(r => r.newNo !== undefined && (r.newNo < 1 || r.newNo > lines.length || lines[r.newNo - 1] !== r.text + (r.cr ? '\r' : '')))) {
    return { rows: patchRows, complete: false };
  }
  const rows: Row[] = [];
  let cursor = 1;
  const fill = (end: number, offset: number) => {
    for (; cursor < end && cursor <= lines.length; cursor++) {
      rows.push({ kind: 'ctx', oldNo: cursor - offset, newNo: cursor, ...textFields(lines[cursor - 1]), ...(cursor === lines.length && !headText.endsWith('\n') ? { noEol: true as const } : {}) });
    }
  };
  for (const hunk of parsed.hunks) {
    const newStart = hunk.newStart + (hunk.newLines === 0 ? 1 : 0);
    const oldStart = hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0);
    fill(newStart, newStart - oldStart);
    rows.push(...hunk.rows);
    cursor = hunk.newStart + hunk.newLines + (hunk.newLines === 0 ? 1 : 0);
  }
  const last = parsed.hunks.at(-1);
  const offset = last ? last.newStart + last.newLines + (last.newLines === 0 ? 1 : 0) - last.oldStart - last.oldLines - (last.oldLines === 0 ? 1 : 0) : 0;
  fill(lines.length + 1, offset);
  return { rows, complete: true };
}

export function view(model: FileModel, context: number, expansions: Expansions): Item[] {
  const { rows, complete } = model;
  if (!rows.length) return [];
  const items: Item[] = [];
  if (!complete) {
    let oldNo = 0;
    let newNo = 0;
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const jump = Math.max(row.oldNo === undefined ? 0 : row.oldNo - oldNo - 1, row.newNo === undefined ? 0 : row.newNo - newNo - 1);
      if (jump > 0) {
        items.push({ kind: 'gap', from: -1, to: -1, count: jump, expandable: false });
        oldNo += jump;
        newNo += jump;
      }
      items.push({ kind: 'row', idx });
      if (row.oldNo !== undefined) oldNo = row.oldNo;
      if (row.newNo !== undefined) newNo = row.newNo;
    }
    items.push({ kind: 'gap', from: -1, to: -1, count: -1, expandable: false });
    return items;
  }
  const visible = new Uint8Array(rows.length);
  const reveal = (from: number, to: number) => visible.fill(1, Math.max(0, from), Math.min(rows.length, to + 1));
  if (context === Infinity) visible.fill(1);
  else {
    const radius = Math.max(0, Math.floor(context));
    for (let i = 0; i < rows.length; i++) if (rows[i].kind !== 'ctx') reveal(i - radius, i + radius);
  }
  for (const [from, to] of expansions) reveal(from, to);
  for (let idx = 0; idx < rows.length;) {
    if (visible[idx]) { items.push({ kind: 'row', idx: idx++ }); continue; }
    const from = idx;
    while (idx < rows.length && !visible[idx]) idx++;
    items.push({ kind: 'gap', from, to: idx - 1, count: idx - from, expandable: true });
  }
  return items;
}

export function splitPairs(items: Item[], rows: Row[]): SplitItem[] {
  const result: SplitItem[] = [];
  for (let i = 0; i < items.length;) {
    const item = items[i];
    if (item.kind === 'gap') { result.push(item); i++; continue; }
    if (rows[item.idx].kind === 'ctx') { result.push({ kind: 'pair', left: item.idx, right: item.idx }); i++; continue; }
    const left: number[] = [];
    const right: number[] = [];
    while (i < items.length) {
      const next = items[i];
      if (next.kind !== 'row' || rows[next.idx].kind !== 'del') break;
      left.push(next.idx); i++;
    }
    while (i < items.length) {
      const next = items[i];
      if (next.kind !== 'row' || rows[next.idx].kind !== 'add') break;
      right.push(next.idx); i++;
    }
    for (let j = 0; j < Math.max(left.length, right.length); j++) result.push({ kind: 'pair', left: left[j] ?? null, right: right[j] ?? null });
  }
  return result;
}

const wordCache = new Map<string, { a: Seg[]; b: Seg[] } | null>();
const MIN_SHARED = 0.4;

/** Null when the lines share too little for word highlights to help. */
export function wordDiff(a: string, b: string): { a: Seg[]; b: Seg[] } | null {
  if (a.length > 500 || b.length > 500) return null;
  const key = a + '\0' + b;
  if (wordCache.has(key)) return wordCache.get(key)!;
  const parts = diffWordsWithSpace(a, b);
  const solid = (t: string) => t.replace(/\s+/g, '').length;
  const shared = parts.reduce((n, p) => (p.added || p.removed ? n : n + solid(p.value)), 0);
  let result: { a: Seg[]; b: Seg[] } | null = null;
  if (shared >= MIN_SHARED * Math.max(solid(a), solid(b))) {
    result = { a: [], b: [] };
    for (const part of parts) {
      if (!part.added) result.a.push({ text: part.value, changed: !!part.removed });
      if (!part.removed) result.b.push({ text: part.value, changed: !!part.added });
    }
    result = { a: joinGaps(result.a), b: joinGaps(result.b) };
  }
  if (wordCache.size >= 5000) wordCache.delete(wordCache.keys().next().value!);
  wordCache.set(key, result);
  return result;
}

/** Merges whitespace-only gaps between changed segments so a changed run reads as one block. */
function joinGaps(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const gap = !s.changed && /^\s+$/.test(s.text) && out.at(-1)?.changed && segs[i + 1]?.changed;
    const last = out.at(-1);
    if ((gap || s.changed) && last?.changed) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

export interface Anchor { side: Side; line: number }

/** Anchor for a gutter click. del/add rows have one side; ctx rows take the side of the gutter that was clicked. */
export function lineAnchor(row: Row, clicked: Side = 'RIGHT'): Anchor | null {
  if (row.hunk === undefined) return null;
  const side: Side = row.kind === 'del' ? 'LEFT' : row.kind === 'add' ? 'RIGHT' : clicked;
  const line = side === 'LEFT' ? row.oldNo : row.newNo;
  return line === undefined ? null : { side, line };
}

export function anchorIndex(model: FileModel, a: Anchor): number {
  if (a.side === 'RIGHT') return model.rows.findIndex(r => r.kind !== 'del' && r.newNo === a.line);
  const removed = model.rows.findIndex(r => r.kind === 'del' && r.oldNo === a.line);
  return removed >= 0 ? removed : model.rows.findIndex(r => r.kind === 'ctx' && r.oldNo === a.line);
}

export type RangeCheck =
  | { ok: true; startSide: Side; startLine: number; side: Side; line: number; startIdx: number; endIdx: number }
  | { ok: false; reason: string };

/** GitHub accepts a range when both ends are in the same patch hunk; the sides may differ. */
export function validRange(model: FileModel, a: Anchor, b: Anchor): RangeCheck {
  const ia = anchorIndex(model, a);
  const ib = anchorIndex(model, b);
  if (ia < 0 || ib < 0) return { ok: false, reason: 'Select lines inside the GitHub diff.' };
  const ha = model.rows[ia].hunk;
  const hb = model.rows[ib].hunk;
  if (ha === undefined || hb === undefined) return { ok: false, reason: 'Select lines inside the GitHub diff.' };
  if (ha !== hb) return { ok: false, reason: 'GitHub only accepts a range inside one diff hunk.' };
  const [s, e] = ia <= ib ? [a, b] : [b, a];
  return { ok: true, startSide: s.side, startLine: s.line, side: e.side, line: e.line, startIdx: Math.min(ia, ib), endIdx: Math.max(ia, ib) };
}

export function threadRowIndex(model: FileModel, thread: Thread): number {
  if (thread.subjectType === 'FILE' || thread.isOutdated || thread.line === null) return -1;
  return anchorIndex(model, { side: thread.side, line: thread.line });
}

let worker: Worker | undefined;
let requestId = 0;
const pending = new Map<number, (rows: Row[] | null) => void>();
export function diffInWorker(oldText: string, newText: string): Promise<Row[] | null> {
  return new Promise(resolve => {
    try {
      if (!worker) {
        worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ id: number; rows: Row[] | null }>) => {
          pending.get(event.data.id)?.(event.data.rows);
          pending.delete(event.data.id);
        };
        worker.onerror = () => {
          worker?.terminate();
          worker = undefined;
          for (const done of pending.values()) done(null);
          pending.clear();
        };
      }
      const id = ++requestId;
      pending.set(id, resolve);
      worker.postMessage({ id, oldText, newText });
    } catch {
      pending.delete(requestId);
      resolve(null);
    }
  });
}

function unquoteGitPath(q: string): string {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 1; i < q.length - 1; i++) {
    const c = q[i];
    if (c !== '\\') { bytes.push(...enc.encode(c)); continue; }
    const n = q[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(q.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function gitPath(raw: string, prefix: string): string | null {
  let p = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"')) p = unquoteGitPath(p);
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Split a multi-file `git diff` (GitHub's .diff) into path -> patch body (from the first @@). */
export function splitUnifiedDiff(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) { i++; continue; }
    let oldP: string | null = null;
    let newP: string | null = null;
    i++;
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
      const l = lines[i];
      if (l.startsWith('--- ')) oldP = gitPath(l.slice(4), 'a/');
      else if (l.startsWith('+++ ')) newP = gitPath(l.slice(4), 'b/');
      i++;
    }
    const start = i;
    while (i < lines.length && !lines[i].startsWith('diff --git ')) i++;
    const path = newP ?? oldP;
    if (path && start < i) {
      const body = lines.slice(start, i);
      if (body.at(-1) === '') body.pop();
      out.set(path, body.join('\n'));
    }
  }
  return out;
}
