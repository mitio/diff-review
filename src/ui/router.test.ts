import { describe, expect, it } from 'vitest';
import { parseRoute, routeUrl } from './router.ts';

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

  it('parses focus and ignores junk', () => {
    expect(parseRoute('/o/r/pull/1', '?only=dir:3:a/b').focus).toEqual({ kind: 'folder', depth: 3, key: 'a/b' });
    expect(parseRoute('/o/r/pull/1', '?only=cat:nope').focus).toBeNull();
    expect(parseRoute('/', '').ref).toBeNull();
    expect(parseRoute('/o/r/pull/1/bogus', '').ref).toBeNull();
    expect(parseRoute('/o/r/pull/1/overview', '?file=x').file).toBe('x');
    expect(routeUrl({ ...parseRoute('/o/r/pull/1/overview', '?file=x') })).toBe('/o/r/pull/1/overview');
  });
});
