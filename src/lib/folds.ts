import type { Row } from '../types.ts';
import { indent } from './outline.ts';

export interface Fold {
  /** Opener row, which stays visible. */
  start: number;
  /** Last hidden row. */
  end: number;
  depth: number;
  add: number;
  del: number;
}

interface Range { start: number; end: number; side: number }

/** Foldable blocks, sorted by start then by end descending. */
export function foldRanges(rows: Row[], lang: string | null, skip?: (i: number) => boolean): Fold[] {
  const sides: number[][] = [[], []];
  const adds = new Int32Array(rows.length + 1);
  const dels = new Int32Array(rows.length + 1);
  const lastContent = new Int32Array(rows.length);
  const ignored = new Uint8Array(rows.length);
  let last = -1;
  rows.forEach((row, i) => {
    if (row.kind !== 'add') sides[0].push(i);
    if (row.kind !== 'del') sides[1].push(i);
    adds[i + 1] = adds[i] + Number(row.kind === 'add');
    dels[i + 1] = dels[i] + Number(row.kind === 'del');
    if (row.text.trim()) last = i;
    lastContent[i] = last;
    ignored[i] = Number(!!skip?.(i));
  });

  const ranges = new Map<number, Range>();
  sides.forEach((side, sideIndex) => {
    const lines: Array<{ i: number; level: number }> = [];
    let fence = '';
    let fenceLength = 0;
    for (const i of side) {
      const text = rows[i].text;
      if (lang === 'markdown') {
        const marker = /^(`{3,}|~{3,})(.*)$/.exec(text);
        if (marker) {
          if (!fence) {
            fence = marker[1][0];
            fenceLength = marker[1].length;
          } else if (marker[1][0] === fence && marker[1].length >= fenceLength && !marker[2].trim()) {
            fence = '';
          }
        }
        const heading = !fence && !ignored[i] && /^(#{1,6})\s/.exec(text);
        if (heading) lines.push({ i, level: heading[1].length });
      } else if (!ignored[i] && text.trim()) {
        lines.push({ i, level: indent(text) });
      }
    }

    const stack: Array<{ i: number; level: number }> = [];
    const close = (boundary: number) => {
      const opener = stack.pop()!;
      const end = lastContent[boundary - 1];
      if (end > opener.i && (sideIndex === 1 || rows[opener.i].kind === 'del')) {
        ranges.set(opener.i, { start: opener.i, end, side: sideIndex });
      }
    };
    lines.forEach((line, j) => {
      while (stack.length && stack[stack.length - 1].level >= line.level) close(line.i);
      if (lang === 'markdown' || (lines[j + 1]?.level ?? -1) > line.level) stack.push(line);
    });
    while (stack.length) close(rows.length);
  });

  const sorted = [...ranges.values()].sort((a, b) => a.start - b.start || b.end - a.end);
  const stacks: Range[][] = [[], []];
  return sorted.map(range => {
    let depth = 0;
    // Each side nests; crossings only occur between sides.
    for (const stack of stacks) {
      while (stack.length && stack[stack.length - 1].end < range.start) stack.pop();
      let lo = 0, hi = stack.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (stack[mid].end >= range.end) lo = mid + 1;
        else hi = mid;
      }
      depth += lo;
    }
    stacks[range.side].push(range);
    return {
      start: range.start, end: range.end, depth,
      add: adds[range.end + 1] - adds[range.start],
      del: dels[range.end + 1] - dels[range.start],
    };
  });
}

/** an outline leaves shorter blocks open */
const OUTLINE_MIN = 3;
/** a block this share of the file wraps it (`module M`, Kuby's `application 'x' do`) and stays open */
const WRAPPER = 0.8;

/**
 * The folds an outline folds by default: blocks holding no outline section (from `starts`, ascending), but not short
 * ones or one wrapping the whole file.
 */
export function outlineFolded(folds: Fold[], starts: number[], rowCount: number): Set<number> {
  const out = new Set<number>();
  for (const f of folds) {
    if (f.end - f.start < OUTLINE_MIN || f.end - f.start + 1 >= rowCount * WRAPPER) continue;
    let lo = 0, hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= f.start) lo = mid + 1;
      else hi = mid;
    }
    if (!(lo < starts.length && starts[lo] <= f.end)) out.add(f.start);
  }
  return out;
}
