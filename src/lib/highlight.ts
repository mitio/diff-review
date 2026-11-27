import { createLowlight, common } from 'lowlight';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import elixir from 'highlight.js/lib/languages/elixir';
import erb from 'highlight.js/lib/languages/erb';
import nginx from 'highlight.js/lib/languages/nginx';
import protobuf from 'highlight.js/lib/languages/protobuf';
import scala from 'highlight.js/lib/languages/scala';
import type { Row } from '../types.ts';
import hcl from './hcl.ts';
export { languageOf } from './languages.ts';

export type { Tok } from './languages.ts';
import { languageOf, type Tok } from './languages.ts';

let lowlight: ReturnType<typeof createLowlight> | null = null;
function ll() {
  if (!lowlight) {
    lowlight = createLowlight(common);
    lowlight.register({ dockerfile, elixir, erb, hcl, nginx, protobuf, scala });
  }
  return lowlight;
}

interface HNode { type: string; value?: string; properties?: { className?: string[] }; children?: HNode[] }

/** Highlights `text` as a whole and returns one token list per line ('\n'-separated). */
export function tokenizeLines(text: string, lang: string): Tok[][] {
  const tree = ll().highlight(lang, text) as unknown as HNode;
  const lines: Tok[][] = [[]];
  const emit = (value: string, cls: string) => {
    let start = 0;
    for (;;) {
      const nl = value.indexOf('\n', start);
      const end = nl < 0 ? value.length : nl;
      if (end > start) {
        const line = lines[lines.length - 1];
        const last = line[line.length - 1];
        if (last && last[1] === cls) last[0] += end - start;
        else line.push([end - start, cls]);
      }
      if (nl < 0) break;
      lines.push([]);
      start = nl + 1;
    }
  };
  const walk = (n: HNode, cls: string) => {
    if (n.type === 'text') emit(n.value ?? '', cls);
    else if (n.children) {
      const own = n.properties?.className?.join(' ');
      for (const c of n.children) walk(c, own || cls);
    }
  };
  walk(tree, '');
  return lines;
}

export const MAX_HL_CHARS = 512 * 1024;

/** Per row: `a` = tokens in the old file (ctx + del rows), `b` = tokens in the new file (ctx + add rows). */
export interface RowToks { a: Array<Tok[] | null>; b: Array<Tok[] | null> }

/**
 * Each side is highlighted as one text so multi-line strings and comments carry over. Context rows get tokens from
 * both sides: an unchanged line can be code in one version and inside a comment in the other.
 */
export function highlightRows(rows: Pick<Row, 'kind' | 'text'>[], lang: string): RowToks | null {
  const oldIdx: number[] = [];
  const newIdx: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind !== 'add') oldIdx.push(i);
    if (r.kind !== 'del') newIdx.push(i);
  });
  const oldText = oldIdx.map(i => rows[i].text).join('\n');
  const newText = newIdx.map(i => rows[i].text).join('\n');
  if (oldText.length + newText.length > MAX_HL_CHARS) return null;
  const a: Array<Tok[] | null> = new Array(rows.length).fill(null);
  const b: Array<Tok[] | null> = new Array(rows.length).fill(null);
  const newLines = tokenizeLines(newText, lang);
  newIdx.forEach((i, j) => { b[i] = newLines[j] ?? null; });
  if (oldText === newText) {
    // same text on both sides (e.g. only line endings changed): reuse line by line
    oldIdx.forEach((i, j) => { a[i] = b[newIdx[j]]; });
  } else if (oldIdx.length) {
    const oldLines = tokenizeLines(oldText, lang);
    oldIdx.forEach((i, j) => { a[i] = oldLines[j] ?? null; });
  }
  return { a, b };
}

const MAX_BLOCK_CHARS = 20_000;

/**
 * A fence's language: the one its info string names (null if unknown), else the commented
 * file's, else 'auto' (guess). `suggestion` is the file's.
 */
export function resolveLang(info: string | null | undefined, path?: string): string | null {
  const name = info?.trim().split(/[\s{,]/)[0].toLowerCase();
  if (name && name !== 'suggestion') return ll().registered(name) ? name : languageOf(`x.${name}`);
  return (path && languageOf(path)) || 'auto';
}

/** Highlighted HTML (highlight.js classes) for a code block in `lang` from resolveLang(). */
export function highlightHtml(code: string, lang: string | null): string | null {
  if (!lang || !code.trim() || code.length > MAX_BLOCK_CHARS) return null;
  let tree: HNode & { data?: { relevance?: number } };
  try {
    tree = (lang === 'auto' ? ll().highlightAuto(code) : ll().highlight(lang, code)) as unknown as typeof tree;
  } catch {
    return null;
  }
  if (lang === 'auto' && (tree.data?.relevance ?? 0) < 5) return null;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = (n: HNode): string => {
    if (n.type === 'text') return esc(n.value ?? '');
    const inner = (n.children ?? []).map(html).join('');
    const cls = n.properties?.className?.join(' ');
    return n.type === 'element' && cls ? `<span class="${esc(cls)}">${inner}</span>` : inner;
  };
  return html(tree);
}
