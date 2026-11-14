import { describe, expect, it } from 'vitest';
import { globToRegExp, matchGlob } from './glob.ts';

describe('glob', () => {
  it.each([
    ['*.ts', 'a/b.ts', true], ['*.ts', 'a/b.tsx', false],
    ['a/*/b', 'a/x/b', true], ['a/*/b', 'a/x/y/b', false],
    ['a/**/b', 'a/b', true], ['a/**/b', 'a/x/y/b', true],
    ['**/tests/**', 'tests/a.ts', true], ['**/tests/**', 'src/tests/a.ts', true],
    ['src/**', 'other/src/a', false], ['/src/**', 'src/a', true],
    ['file?.{js,ts}', 'src/file1.ts', true], ['file?.{js,ts}', 'file12.ts', false],
    ['a[1]+(x).ts', 'src/a[1]+(x).ts', true], ['a[1]+(x).ts', 'a1x.ts', false],
    ['**', 'a/b/c', true], ['{a,{b,c}}.ts', 'c.ts', true],
    ['a{b', 'a{b', true], ['foo', 'a/foo/bar', false],
  ])('%s matches %s = %s', (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });
});
