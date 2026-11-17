import { describe, expect, it } from 'vitest';
import type { LocalThread, ReviewDoc } from '../types.ts';
import { exportMarkdown, sourceLine } from './export.ts';

const thread = (overrides: Partial<LocalThread> = {}): LocalThread => ({
  id: 't', path: 'x.ts', subjectType: 'LINE', side: 'RIGHT', line: 5, startSide: null, startLine: null,
  quote: [], outdated: false, resolved: false, comments: [{ id: 'c', body: 'Check this', createdAt: '' }], ...overrides,
});
const doc = (threads: LocalThread[]): ReviewDoc => ({ key: 'k', ref: { kind: 'paste', id: 'a' }, title: 'Title', version: 1, updatedAt: '', viewed: {}, threads });
describe('Markdown export', () => {
  it('prints the exact empty review', () => {
    expect(exportMarkdown(doc([thread({ resolved: true }), thread({ comments: [] })]), { source: 'source' })).toBe('# Review: Title\n\nSource: source\n\nNo comments.\n');
  });
  it('orders paths, then file threads, then line and start line', () => {
    const output = exportMarkdown(doc([
      thread({ path: 'b', line: 8 }), thread({ path: 'a' }), thread({ path: 'z' }),
      thread({ path: 'b', subjectType: 'FILE' }), thread({ path: 'b', line: 3, startLine: 1 }),
    ]), { source: 's', order: ['b'] });
    expect([...output.matchAll(/^## (.*)$/gm)].map(m => m[1])).toEqual(['b', 'a', 'z']);
    expect([...output.matchAll(/^### (.*)$/gm)].map(m => m[1])).toEqual(['b (file)', 'b:1-3', 'b:8', 'a:5', 'z:5']);
  });
  it('renders sides, safe fences, gaps, flags and multiline replies', () => {
    const output = exportMarkdown(doc([thread({
      startLine: 2, startSide: 'LEFT', line: 5, outdated: true, resolved: true,
      quote: [{ kind: 'ctx', text: '```' }, { kind: 'del', text: 'old' }, { kind: 'gap', text: '' }, { kind: 'add', text: 'new' }],
      comments: [{ id: 'c', body: 'First', createdAt: '' }, { id: 'r', body: 'one\ntwo', createdAt: '' }],
    })]), { source: 's', includeResolved: true });
    expect(output).toBe('# Review: Title\n\nSource: s\n\n## x.ts\n\n### x.ts:2 (old)-5 (outdated: code changed since) (resolved)\n````typescript\n ```\n-old\n…\n+new\n````\nFirst\n\n> reply: one\n> two\n');
    expect(exportMarkdown(doc([thread({ side: 'LEFT' })]), { source: 's' })).toContain('### x.ts:5 (old)');
    expect(exportMarkdown(doc([thread({ side: 'LEFT', startSide: 'LEFT', startLine: 2 })]), { source: 's' })).toContain('### x.ts:2-5 (old)');
  });
});
it('describes each source reproducibly', () => {
  expect(sourceLine({ kind: 'local', repo: '/repo', range: '' })).toBe('uncommitted changes in `/repo`');
  expect(sourceLine({ kind: 'local', repo: '/repo', range: 'HEAD^!' })).toBe('commit `HEAD` in `/repo`');
  expect(sourceLine({ kind: 'local', repo: '/repo', range: 'a..b' })).toBe('`git diff a..b` in `/repo`');
  expect(sourceLine({ kind: 'paste', id: 'a' })).toBe('a pasted diff');
  expect(sourceLine({ kind: 'commit', owner: 'o', repo: 'r', sha: 'abcdef0' })).toBe('https://github.com/o/r/commit/abcdef0');
});
it('handles quotes containing many separate backtick runs', () => {
  const quote = '` '.repeat(150000);
  expect(exportMarkdown(doc([thread({ quote: [{ kind: 'ctx', text: quote }] })]), { source: 's' })).toContain('```typescript\n ' + quote + '\n```');
});
