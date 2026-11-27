import type { Row } from '../types.ts';

/** One outline line: the section runs from row `idx` to row `end` (inclusive) and holds `add`/`del` changed rows. */
export interface OutlineEntry { idx: number; end: number; add: number; del: number; depth: number; top?: true }

const DATA = new Set(['yaml', 'json', 'ini', 'css', 'scss', 'less', 'xml']);
const NOISE = /^\s*(?:[\])}>,;:({[`'"]*$|\/\/|\/\*|\*|#|<!--|--\s|(?:import|from|use|require|package|using)\b|#include)/;
const MODS = '(?:(?:export|default|public|private|protected|internal|static|async|abstract|override|final|virtual|open|sealed|data|inline|suspend|unsafe|local|pub(?:\\([^)]*\\))?)\\s+)*';
const DEF = new RegExp(
  `^\\s*${MODS}(?:(?:def(?:p|module|macro)?|fn|fun|func|function\\*?|class|module|interface|struct|enum|impl|trait|object|record|namespace|protocol|extension|type)\\s|(?:await\\s+)?(?:[\\w$]+\\.)?(?:describe|context|it|test)(?:\\.\\w+)?\\s*\\()`,
);
/** A Ruby DSL block on a bare call (`workers 'web' do`, `describe X do`), not `list.each do` */
const RUBY_DSL = /^\s*[A-Za-z_]\w*[?!]?(?:[\s(].*)?\sdo(?:\s*\|[^|]*\|)?\s*$/;
const RUBY_DEF = /^\s*def\s/;
const METHOD = /^\s*([\w$<>[\]?,.\s]*?)\b([A-Za-z_$][\w$]*)\s*\(.*\{\s*$/;
const CONTROL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'else', 'do', 'try', 'return', 'with', 'elif', 'unless', 'until', 'case',
  'when', 'new', 'await', 'yield', 'throw', 'typeof', 'function',
]);

export function indent(text: string) {
  let n = 0;
  for (const ch of text) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function isMethod(text: string) {
  if (text.includes('=>')) return false;
  const m = METHOD.exec(text);
  if (!m || m[1].includes('=') || m[1].includes('.')) return false;
  return ![...m[1].split(/\s+/), m[2]].some(w => CONTROL.has(w));
}

function accept(text: string, depth: number, lang: string | null, inDef: boolean) {
  if (NOISE.test(text)) return false;
  if (lang && DATA.has(lang)) return depth <= 2;
  if (depth === 0) return true;
  return !!lang && depth <= 3 && (DEF.test(text) || isMethod(text) || (lang === 'ruby' && !inDef && RUBY_DSL.test(text)));
}

/** Block openers (a line followed by a more indented one) on one side of the diff, keyed by row index. */
function sideEntries(rows: Row[], side: number[], lang: string | null, out: Map<number, number>, skip?: (i: number) => boolean) {
  if (skip) side = side.filter(i => !skip(i));
  const nextIndent = new Array<number>(side.length).fill(-1);
  for (let j = side.length - 1, next = -1; j >= 0; j--) {
    nextIndent[j] = next;
    const t = rows[side[j]].text;
    if (t.trim()) next = indent(t);
  }
  const stack: Array<{ ind: number; def: boolean }> = [];
  side.forEach((i, j) => {
    const t = rows[i].text;
    if (!t.trim()) return;
    const ind = indent(t);
    while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
    if (nextIndent[j] <= ind) return;
    const inDef = stack.some(b => b.def);
    if (accept(t, stack.length, lang, inDef)) out.set(i, stack.length);
    stack.push({ ind, def: inDef || (lang === 'ruby' && RUBY_DEF.test(t)) });
  });
}

function markdownEntries(rows: Row[], side: number[], out: Map<number, number>) {
  let fenced = false;
  for (const i of side) {
    const t = rows[i].text;
    if (/^(?:```|~~~)/.test(t)) fenced = !fenced;
    const h = !fenced && /^(#{1,6})\s/.exec(t);
    if (h) out.set(i, h[1].length - 1);
  }
}

/** `skip(i)`: row i is not code (inside a string or comment) and is ignored when finding structure. */
export function outline(rows: Row[], lang: string | null, skip?: (i: number) => boolean): OutlineEntry[] {
  if (!rows.length) return [];
  const oldSide: number[] = [];
  const newSide: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind !== 'add') oldSide.push(i);
    if (r.kind !== 'del') newSide.push(i);
  });
  const fromOld = new Map<number, number>();
  const fromNew = new Map<number, number>();
  for (const [side, out] of [[oldSide, fromOld], [newSide, fromNew]] as const) {
    if (lang === 'markdown') markdownEntries(rows, side, out);
    else sideEntries(rows, side, lang, out, skip);
  }
  const starts: Array<[number, number]> = [];
  rows.forEach((r, i) => {
    const d = r.kind === 'del' ? fromOld.get(i) : fromNew.get(i) ?? (r.kind === 'ctx' ? fromOld.get(i) : undefined);
    if (d !== undefined) starts.push([i, d]);
  });
  const entries: OutlineEntry[] = [];
  const section = (idx: number, end: number, depth: number, top?: true) => {
    let add = 0, del = 0;
    for (let i = idx; i <= end; i++) {
      if (rows[i].kind === 'add') add++;
      else if (rows[i].kind === 'del') del++;
    }
    entries.push({ idx, end, add, del, depth, ...(top ? { top } : {}) });
  };
  const first = starts.length ? starts[0][0] : rows.length;
  if (first > 0 && rows.slice(0, first).some(r => r.text.trim())) section(0, first - 1, 0, true);
  starts.forEach(([idx, depth], k) => section(idx, k + 1 < starts.length ? starts[k + 1][0] - 1 : rows.length - 1, depth));
  return entries;
}
