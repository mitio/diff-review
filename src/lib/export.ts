import type { LocalThread, ReviewDoc, ReviewRef } from '../types.ts';
import { githubUrl } from './refs.ts';
import { languageOf } from './languages.ts';

export function sourceLine(ref: ReviewRef): string {
  if (ref.kind === 'paste') return 'a pasted diff';
  if (ref.kind !== 'local') return githubUrl(ref)!;
  if (!ref.range) return `uncommitted changes in \`${ref.repo}\``;
  if (ref.range.endsWith('^!')) return `commit \`${ref.range.slice(0, -2)}\` in \`${ref.repo}\``;
  return `\`git diff ${ref.range}\` in \`${ref.repo}\``;
}

function heading(t: LocalThread): string {
  let anchor = `${t.path} (file)`;
  if (t.subjectType !== 'FILE') {
    const start = t.startLine;
    const mixed = start !== null && t.startSide !== null && t.startSide !== t.side;
    anchor = `${t.path}:`;
    if (start !== null) anchor += `${start}${mixed && t.startSide === 'LEFT' ? ' (old)' : ''}-`;
    anchor += `${t.line ?? 0}`;
    if (t.side === 'LEFT') anchor += ' (old)';
  }
  if (t.outdated) anchor += ' (outdated: code changed since)';
  if (t.resolved) anchor += ' (resolved)';
  return `### ${anchor}`;
}

export function exportMarkdown(doc: ReviewDoc, opts: { source: string; order?: string[]; includeResolved?: boolean }): string {
  const threads = doc.threads.filter(t => t.comments.length && (!t.resolved || opts.includeResolved));
  const blocks = [`# Review: ${doc.title}`, `Source: ${opts.source}`];
  if (!threads.length) return `${blocks.join('\n\n')}\n\nNo comments.\n`;
  const paths = [...new Set(threads.map(t => t.path))];
  const order = new Map<string, number>();
  for (const path of opts.order ?? []) if (!order.has(path)) order.set(path, order.size);
  paths.sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0));
  for (const path of paths) {
    blocks.push(`## ${path}`);
    const entries = threads.filter(t => t.path === path).sort((a, b) =>
      Number(a.subjectType !== 'FILE') - Number(b.subjectType !== 'FILE') || (a.line ?? 0) - (b.line ?? 0) || (a.startLine ?? 0) - (b.startLine ?? 0));
    for (const t of entries) {
      let text = heading(t) + '\n';
      if (t.quote.length) {
        const quote = t.quote.map(q => q.kind === 'gap' ? '…' : ({ ctx: ' ', del: '-', add: '+' }[q.kind]) + q.text).join('\n');
        let longest = 0;
        for (const match of quote.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
        const fence = '`'.repeat(Math.max(3, longest + 1));
        text += `${fence}${languageOf(path) ?? ''}\n${quote}\n${fence}\n`;
      }
      text += t.comments[0].body;
      for (const reply of t.comments.slice(1)) text += '\n\n> reply: ' + reply.body.split('\n').join('\n> ');
      blocks.push(text);
    }
  }
  return blocks.join('\n\n') + '\n';
}
