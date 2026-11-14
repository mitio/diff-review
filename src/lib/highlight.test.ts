import { describe, expect, it } from 'vitest';
import { highlightRows, languageOf, tokenizeLines } from './highlight.ts';

const text = (toks: [number, string][], line: string) => {
  let at = 0;
  return toks.map(([n, c]) => [line.slice(at, (at += n)), c]);
};

describe('highlight', () => {
  it('detects languages by extension and name', () => {
    expect(languageOf('src/a.tsx')).toBe('typescript');
    expect(languageOf('Gemfile')).toBe('ruby');
    expect(languageOf('docker/Dockerfile.prod')).toBe('dockerfile');
    expect(languageOf('LICENSE')).toBeNull();
    expect(languageOf('.gitignore')).toBeNull();
  });

  it('splits multi-line tokens per line and covers every character', () => {
    const src = 'const a = `x\n y`; // hi\nlet b = 1;';
    const lines = tokenizeLines(src, 'typescript');
    expect(lines).toHaveLength(3);
    src.split('\n').forEach((l, i) => expect(lines[i].reduce((s, t) => s + t[0], 0)).toBe(l.length));
    expect(text(lines[1], ' y`; // hi')[0]).toEqual([' y`', 'hljs-string']);
  });

  it('maps old and new streams onto rows', () => {
    const rows = [
      { kind: 'ctx' as const, text: '/* start' },
      { kind: 'del' as const, text: 'old */ x = 1' },
      { kind: 'add' as const, text: 'still comment' },
      { kind: 'add' as const, text: '*/ y = 2' },
    ];
    const t = highlightRows(rows, 'javascript')!;
    expect(t.a[1]![0]).toEqual([6, 'hljs-comment']);
    expect(t.b[2]).toEqual([[13, 'hljs-comment']]);
    expect(t.b[3]![0]).toEqual([2, 'hljs-comment']);
    expect(t.a[2]).toBeNull();
    expect(t.b[1]).toBeNull();
  });

  it('highlights the old side of addition-only changes on its own', () => {
    const rows = [
      { kind: 'add' as const, text: '/*' },
      { kind: 'ctx' as const, text: 'doThing();' },
      { kind: 'add' as const, text: '*/' },
    ];
    const t = highlightRows(rows, 'javascript')!;
    expect(t.b[1]).toEqual([[10, 'hljs-comment']]);
    expect(t.a[1]).not.toEqual([[10, 'hljs-comment']]);
  });

  it('gives context rows tokens from each side', () => {
    const rows = [
      { kind: 'del' as const, text: '/*' },
      { kind: 'ctx' as const, text: 'doThing();' },
      { kind: 'del' as const, text: '*/' },
    ];
    const t = highlightRows(rows, 'javascript')!;
    expect(t.a[1]).toEqual([[10, 'hljs-comment']]);
    expect(t.b[1]).not.toEqual([[10, 'hljs-comment']]);
  });
});
