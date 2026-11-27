import { describe, expect, it } from 'vitest';
import type { Row } from '../types.ts';
import { foldRanges, outlineFolded } from './folds.ts';
import { outline } from './outline.ts';

const rows = (...lines: string[]): Row[] => lines.map(text => ({ kind: 'ctx', text }));
const fold = (start: number, end: number, depth = 0, add = 0, del = 0) => ({ start, end, depth, add, del });

describe('foldRanges', () => {
  it('keeps closing braces visible and nests control flow', () => {
    expect(foldRanges(rows('function f() {', '  if (ok) {', '    run()', '  }', '}'), 'javascript'))
      .toEqual([fold(0, 3), fold(1, 2, 1)]);
  });

  it('trims trailing blanks from Python blocks', () => {
    expect(foldRanges(rows('def f():', '    if ok:', '        run()', '', '   ', 'next()'), 'python'))
      .toEqual([fold(0, 2), fold(1, 2, 1)]);
  });

  it('folds one hidden non-blank line but not deeper blanks', () => {
    expect(foldRanges(rows('open', '  body', 'next', '    ', ''), null)).toEqual([fold(0, 1)]);
    expect(foldRanges(rows('open', '    ', ''), null)).toEqual([]);
    expect(foldRanges([], null)).toEqual([]);
    expect(foldRanges(rows('only'), null)).toEqual([]);
  });

  it('uses four spaces per tab', () => {
    expect(foldRanges(rows('root', '\tchild', '   sibling', 'done'), null)).toEqual([fold(0, 2)]);
  });

  it.each(['`', '/*'])('ignores skipped structure inside %s without ending the outer fold', marker => {
    const rs = rows('function f() {', `  ${marker}`, 'text', '      nested', marker, '  run()', '}');
    expect(foldRanges(rs, 'javascript', i => i >= 1 && i <= 4)).toEqual([fold(0, 5)]);
    expect(foldRanges(rs, 'javascript').some(f => f.start === 2)).toBe(true);
  });

  it('contains skipped non-blank rows at the end of a block', () => {
    expect(foldRanges(rows('root', '  code', 'comment', '    ', 'done'), null, i => i === 2))
      .toEqual([fold(0, 2)]);
  });

  it('folds deleted functions and counts interleaved changes including openers', () => {
    const rs: Row[] = [
      { kind: 'ctx', text: 'function f() {' },
      { kind: 'add', text: '  fresh()' },
      { kind: 'del', text: '  old()' },
      { kind: 'ctx', text: '}' },
      { kind: 'del', text: 'function gone() {' },
      { kind: 'del', text: '  body()' },
      { kind: 'del', text: '}' },
    ];
    expect(foldRanges(rs, 'javascript')).toEqual([fold(0, 2, 0, 1, 1), fold(4, 5, 0, 0, 2)]);
  });

  it('uses only the new side for context openers', () => {
    const rs: Row[] = [
      { kind: 'ctx', text: 'root' },
      { kind: 'del', text: '  deleted body' },
      { kind: 'ctx', text: 'next' },
    ];
    expect(foldRanges(rs, null)).toEqual([]);
  });

  it('retains crossing ranges and counts all strict containers', () => {
    const rs = rows('root', '  old', '  fresh', '    nested', '      leaf', '    closeNested', '  closeOld', '    more', '    tail', '  closeNew', 'done');
    rs[1].kind = rs[6].kind = 'del';
    rs[2].kind = rs[9].kind = 'add';
    expect(foldRanges(rs, null)).toEqual([
      fold(0, 9, 0, 2, 2), fold(1, 5, 1, 1, 1), fold(2, 8, 1, 1, 1),
      fold(3, 4, 3), fold(6, 9, 1, 1, 1),
    ]);
  });

  it('folds markdown sections with nested headings and fenced content', () => {
    const rs = rows('# Title', 'intro', '## Section', '```js', '# not a heading', '~~~', '```',
      '### Child', 'body', '', '## Next', '~~~', '# also fenced', '~~~', 'tail', '', '# Last', '');
    expect(foldRanges(rs, 'markdown')).toEqual([fold(0, 14), fold(2, 8, 1), fold(7, 8, 2), fold(10, 14, 1)]);
  });

  it('applies markdown sections independently to deleted and added rows', () => {
    const rs: Row[] = [
      { kind: 'del', text: '# Old' }, { kind: 'del', text: 'old body' },
      { kind: 'add', text: '# New' }, { kind: 'add', text: 'new body' },
      { kind: 'ctx', text: '# End' },
    ];
    expect(foldRanges(rs, 'markdown')).toEqual([fold(0, 3, 0, 2, 2), fold(2, 3, 1, 2)]);
  });

  it('handles 20k rows within a generous time bound', () => {
    const rs = Array.from({ length: 20_000 }, (_, i): Row => ({ kind: 'ctx', text: ' '.repeat(i % 100) + 'line' }));
    const start = performance.now();
    const result = foldRanges(rs, null);
    const elapsed = performance.now() - start;
    expect(result).toHaveLength(19_800);
    expect(result[98]).toEqual(fold(98, 99, 98));
    expect(elapsed).toBeLessThan(300);
  });
});

describe('outlineFolded', () => {
  const folded = (rs: Row[], lang: string) => {
    const folds = foldRanges(rs, lang);
    const starts = outline(rs, lang).filter(e => !e.top).map(e => e.idx);
    return [...outlineFolded(folds, starts, rs.length)].map(i => rs[i].text.trim());
  };

  it('folds the leaf blocks of a Ruby DSL, not the file-wide wrapper', () => {
    const rs = rows(
      "application_v2 'onetap' do",
      '  architecture :arm64',
      "  env 'common' do",
      '    A 1',
      '    B 2',
      '    C 3',
      '  end',
      "  workers 'web' do",
      "    process 'main' do",
      '      resources do',
      '        cpu 1',
      '        memory 2',
      '        disk 3',
      '      end',
      '    end',
      '  end',
      'end',
    );
    expect(folded(rs, 'ruby')).toEqual(["env 'common' do", 'resources do']);
  });

  it('keeps a block wrapping most of the file open even with no sections inside', () => {
    const rs = rows('module Config', '  A = 1', '  B = 2', '  C = 3', '  D = 4', 'end');
    expect(folded(rs, 'ruby')).toEqual([]);
    const two = rows('module A', '  X = 1', '  Y = 2', '  Z = 3', 'end', 'module B', '  X = 1', '  Y = 2', '  Z = 3', 'end');
    expect(folded(two, 'ruby')).toEqual(['module A', 'module B']);
  });
});
