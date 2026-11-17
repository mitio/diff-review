import type { FileModel, QuoteLine, Row, Side, Thread } from '../types';
import { anchorIndex, threadRowIndex } from './diff';

export function quoteRows(model: FileModel, startIdx: number, endIdx: number): QuoteLine[] {
  const quote: QuoteLine[] = [];
  let oldNo: number | undefined, newNo: number | undefined;
  for (const row of model.rows.slice(startIdx, endIdx + 1)) {
    const jump = Math.max(oldNo === undefined || row.oldNo === undefined ? 0 : row.oldNo - oldNo - 1,
      newNo === undefined || row.newNo === undefined ? 0 : row.newNo - newNo - 1);
    if (!model.complete && jump > 0) {
      quote.push({kind:'gap',text:''});
      if (oldNo !== undefined) oldNo += jump;
      if (newNo !== undefined) newNo += jump;
    }
    quote.push({kind:row.kind,text:row.text});
    oldNo = row.oldNo ?? oldNo; newNo = row.newNo ?? newNo;
  }
  return quote;
}

const same = (a: QuoteLine, b: QuoteLine) => a.kind === b.kind && a.text === b.text;

function literalEnds(rows: QuoteLine[], pattern: QuoteLine[]): Int32Array {
  const ends = new Int32Array(rows.length + 1).fill(-1);
  if (!pattern.length) return ends.map((_, i) => i);
  const prefix = new Int32Array(pattern.length);
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j && !same(pattern[i], pattern[j])) j = prefix[j - 1];
    if (same(pattern[i], pattern[j])) j++;
    prefix[i] = j;
  }
  for (let i = 0, j = 0; i < rows.length; i++) {
    while (j && !same(rows[i], pattern[j])) j = prefix[j - 1];
    if (same(rows[i], pattern[j])) j++;
    if (j === pattern.length) {
      ends[i - j + 1] = i + 1;
      j = prefix[j - 1];
    }
  }
  return ends;
}

function matchingEnds(rows: QuoteLine[], quote: QuoteLine[], requiredEnd?: number): Int32Array {
  const segments: QuoteLine[][] = [[]];
  for (const part of quote) {
    if (part.kind === 'gap') segments.push([]);
    else segments[segments.length - 1].push(part);
  }
  let ends = literalEnds(rows, segments[segments.length - 1]);
  if (requiredEnd !== undefined) for (let i = 0; i < ends.length; i++) if (ends[i] !== requiredEnd) ends[i] = -1;
  for (let s = segments.length - 2; s >= 0; s--) {
    const next = new Int32Array(ends.length);
    for (let i = ends.length - 1, nearest = -1; i >= 0; i--) {
      if (ends[i] >= 0) nearest = ends[i];
      next[i] = nearest;
    }
    const starts = literalEnds(rows, segments[s]);
    ends = starts.map(end => end < 0 ? -1 : next[end]);
  }
  return ends;
}

const onSide = (row: Row, side: Side) => side === 'LEFT' ? row.oldNo !== undefined : row.newNo !== undefined;

function locate(model: FileModel, t: Thread): {index: number; status: 'ok' | 'moved' | 'outdated' | 'unknown'} {
  if (t.subjectType === 'FILE') return {index:-1,status:t.isOutdated ? 'outdated' : 'ok'};
  if (!t.quote?.length) {
    const index = threadRowIndex(model, t);
    return {index, status:index >= 0 ? 'ok' : t.isOutdated || model.complete ? 'outdated' : 'unknown'};
  }
  const start = t.line === null ? -1 : anchorIndex(model, {side:t.startSide ?? t.side,line:t.startLine ?? t.line});
  const end = t.line === null ? -1 : anchorIndex(model, {side:t.side,line:t.line});
  if (start >= 0 && end >= start) {
    const rows = quoteRows(model, start, end);
    if (matchingEnds(rows, t.quote, rows.length)[0] >= 0) return {index:end,status:'ok'};
  }
  if (!model.complete) return {index:-1,status:'unknown'};
  let found = -1;
  const matches = matchingEnds(model.rows, t.quote);
  for (let i = 0; i < model.rows.length; i++) {
    if (!onSide(model.rows[i], t.startSide ?? t.side)) continue;
    const next = matches[i];
    if (next <= i || !onSide(model.rows[next - 1], t.side)) continue;
    if (found >= 0) return {index:-1,status:'outdated'};
    found = next - 1;
  }
  return {index:found,status:found < 0 ? 'outdated' : 'moved'};
}

export function locateThread(model: FileModel, t: Thread): number { return locate(model, t).index; }
export function anchorStatus(model: FileModel, t: Thread): 'ok' | 'moved' | 'outdated' | 'unknown' { return locate(model, t).status; }
