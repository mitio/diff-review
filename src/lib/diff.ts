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

const wordCache = new Map<string, { a: Seg[]; b: Seg[] }>();
export function wordDiff(a: string, b: string): { a: Seg[]; b: Seg[] } | null {
  if (a.length > 500 || b.length > 500) return null;
  const key = a + '\0' + b;
  const cached = wordCache.get(key);
  if (cached) return cached;
  const result: { a: Seg[]; b: Seg[] } = { a: [], b: [] };
  for (const part of diffWordsWithSpace(a, b)) {
    if (!part.added) result.a.push({ text: part.value, changed: !!part.removed });
    if (!part.removed) result.b.push({ text: part.value, changed: !!part.added });
  }
  if (wordCache.size >= 5000) wordCache.delete(wordCache.keys().next().value!);
  wordCache.set(key, result);
  return result;
}

export function validRange(model: FileModel, aIdx: number, bIdx: number): { ok: true; side: Side; startLine: number; line: number; startSide: Side } | { ok: false; reason: string } {
  const a = model.rows[aIdx];
  const b = model.rows[bIdx];
  if (!a || !b || a.hunk === undefined || b.hunk === undefined) return { ok: false, reason: 'Select lines inside the GitHub diff.' };
  if (a.hunk !== b.hunk) return { ok: false, reason: 'Select lines in the same hunk.' };
  const side: Side = a.kind === 'del' && b.kind === 'del' ? 'LEFT' : 'RIGHT';
  const first = side === 'LEFT' ? a.oldNo : a.newNo;
  const last = side === 'LEFT' ? b.oldNo : b.newNo;
  if (first === undefined || last === undefined) return { ok: false, reason: 'Select lines on the same side.' };
  return { ok: true, side, startSide: side, startLine: Math.min(first, last), line: Math.max(first, last) };
}

export function lineAnchor(row: Row): { side: Side; line: number } | null {
  if (row.hunk === undefined) return null;
  const side = row.kind === 'del' ? 'LEFT' : 'RIGHT';
  const line = side === 'LEFT' ? row.oldNo : row.newNo;
  return line === undefined ? null : { side, line };
}

export function threadRowIndex(model: FileModel, thread: Thread): number {
  if (thread.subjectType === 'FILE' || thread.isOutdated || thread.line === null) return -1;
  if (thread.side === 'RIGHT') return model.rows.findIndex(r => r.kind !== 'del' && r.newNo === thread.line);
  const removed = model.rows.findIndex(r => r.kind === 'del' && r.oldNo === thread.line);
  return removed >= 0 ? removed : model.rows.findIndex(r => r.kind === 'ctx' && r.oldNo === thread.line);
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
