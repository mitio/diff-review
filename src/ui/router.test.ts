import { describe, expect, it } from 'vitest';
import { parseRoute, routeUrl } from './router.ts';
import { parseReviewInput } from '../lib/refs.ts';

describe('routes', () => {
  it('round-trips PR routes', () => {
    for (const u of [
      '/o/r/pull/12',
      '/o/r/pull/12/overview',
      '/o/r/pull/12/conversation',
      '/o/r/pull/12?only=cat%3Atests&q=foo+bar&file=src%2Fa+b.ts',
      '/o/r/pull/12?only=dir%3A2%3Asrc%2Fui',
    ]) {
      const [p, q] = u.split('?');
      expect(routeUrl(parseRoute(p, q ? `?${q}` : ''))).toBe(u);
    }
  });

  it('round-trips non-PR routes', () => {
    for (const u of [
      '/o/r/commit/abc1234',
      '/o/r/commit/abc1234?tab=overview',
      '/o/r/compare/main...feature/overview',
      '/o/r/compare/main...feature/x?tab=overview&q=a',
      '/local?repo=%2FUsers%2Fme%2Frepo&range=',
      '/local?repo=%2Fr&range=main...HEAD&tab=overview&only=cat%3Atests',
      `/paste/${'a'.repeat(64)}?file=x`,
    ]) {
      const [p, q] = u.split('?');
      expect(routeUrl(parseRoute(p, q ? `?${q}` : ''))).toBe(u);
    }
    expect(parseRoute('/o/r/compare/main...feature/overview', '').ref).toEqual({ kind: 'compare', owner: 'o', repo: 'r', base: 'main', head: 'feature/overview' });
    expect(parseRoute('/o/r/commit/abc1234', '?tab=conversation').tab).toBe('diff');
    expect(parseRoute('/o/r/compare/a..b', '').ref).toBeNull();
    expect(parseReviewInput('https://github.com/o/r/compare/main...feature/files')).toEqual({ kind: 'compare', owner: 'o', repo: 'r', base: 'main', head: 'feature/files' });
    expect(parseReviewInput('https://github.com/o/r/pull/3/files')).toEqual({ kind: 'pr', owner: 'o', repo: 'r', number: 3 });
    expect(parseRoute('/o/r/pull/3/changes', '').ref).toBeNull();
  });

  it('accepts any GitHub URL inside a PR or commit', () => {
    const pr = { kind: 'pr', owner: 'dext', repo: 'application', number: 17502 };
    for (const u of [
      'https://github.com/dext/application/pull/17502/changes#diff-e4858c04cf1eb077b623b6cd2e09e548e115cdcff4e421cced2c3866dd1ae162',
      'https://github.com/dext/application/pull/17502/files/abc123..def456',
      'https://github.com/dext/application/pull/17502/commits/abc1234',
      'https://github.com/dext/application/pull/17502.diff',
      'https://github.com/dext/application/pull/17502?w=1#discussion_r1',
      'https://www.github.com/dext/application/pulls/17502',
      'http://github.com/dext/application/pull/17502',
      'github.com/dext/application/pull/17502/changes',
      '<https://github.com/dext/application/pull/17502>',
      '  dext/application/pull/17502/checks ',
    ]) expect(parseReviewInput(u), u).toEqual(pr);
    expect(parseReviewInput('https://github.com/o/r/commit/ABC1234.patch')).toEqual({ kind: 'commit', owner: 'o', repo: 'r', sha: 'abc1234' });
    expect(parseReviewInput('https://github.com/o/r/commit/abc1234#diff-1')).toEqual({ kind: 'commit', owner: 'o', repo: 'r', sha: 'abc1234' });
    expect(parseReviewInput('https://gitlab.com/o/r/pull/1')).toBeNull();
    expect(parseReviewInput('https://github.com/o/r/issues/1')).toBeNull();
    expect(parseRoute('/local', '?repo=relative').ref).toBeNull();
  });

  it('parses focus and ignores junk', () => {
    expect(parseRoute('/o/r/pull/1', '?only=dir:3:a/b').focus).toEqual({ kind: 'folder', depth: 3, key: 'a/b' });
    expect(parseRoute('/o/r/pull/1', '?only=cat:nope').focus).toBeNull();
    expect(parseRoute('/', '').ref).toBeNull();
    expect(parseRoute('/o/r/pull/1/bogus', '').ref).toBeNull();
    expect(parseRoute('/o/r/pull/1/overview', '?file=x').file).toBe('x');
    expect(routeUrl({ ...parseRoute('/o/r/pull/1/overview', '?file=x') })).toBe('/o/r/pull/1/overview');
  });
});
