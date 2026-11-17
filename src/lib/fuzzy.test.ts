import { expect, test } from 'vitest';
import { fuzzyFind } from './fuzzy';

test('prefers the basename, consecutive runs and word starts', () => {
  expect(fuzzyFind(['src/lib/restore-helpers/index.ts', 'docs/stories/overview.md', 'src/ui/store.ts'], 'store', 3)[0].path).toBe('src/ui/store.ts');
  expect(fuzzyFind(['src/lib/fields.ts', 'afoo/bard.ts', 'src/ui/FileDiff.tsx'], 'fd', 3)[0].path).toBe('src/ui/FileDiff.tsx');
});

test('matches subsequences across directories and returns the chosen indices', () => {
  const path = 'src/ui/store.ts';
  expect(fuzzyFind([path], 'store', 1)[0].hits).toEqual([7,8,9,10,11]);
  expect(fuzzyFind([path], 'ui/sto', 1)[0].hits).toEqual([4,5,6,7,8,9]);
  expect(fuzzyFind([path], 'UI STO', 1)).toEqual(fuzzyFind([path], 'uisto', 1));
  expect(fuzzyFind([path], 'xyz', 1)).toEqual([]);
  const hit = fuzzyFind(['src/ui/FileDiff.tsx'], 'fd', 1)[0];
  expect(hit.hits).toEqual([7,11]);
});

test('respects limits and handles empty queries and input', () => {
  for (const query of ['', ' ', '   ']) expect(fuzzyFind(['a'], query, 10)).toEqual([]);
  expect(fuzzyFind([], 'a', 10)).toEqual([]);
  expect(fuzzyFind(['a','ab','ac'], 'a', 2)).toHaveLength(2);
  expect(fuzzyFind(['a'], 'a', 0)).toEqual([]);
  expect(fuzzyFind(['a'], 'a', -1)).toEqual([]);
});

test('breaks score ties by length then code-unit order', () => {
  expect(fuzzyFind(['z/a.ts','b/a.ts','A/a.ts','a.ts'], 'a', 10).map(hit => hit.path)).toEqual(['a.ts','A/a.ts','b/a.ts','z/a.ts']);
});

test('finds the best alignment when an earlier match is scattered', () => {
  const path = 's/t/o/r/e/store.ts';
  const hit = fuzzyFind([path], 'store', 1)[0];
  expect(hit.hits).toEqual([10,11,12,13,14]);
  expect(hit.hits.map(i => path[i]).join('')).toBe('store');
});

test('keeps hit indices valid for repeated letters and Unicode case folds', () => {
  for (const [path, query] of [['a/b/banana.ts','bana'], ['src/İtem.ts','item'], ['src/Äpfel.ts','äpf']]) {
    const hit = fuzzyFind([path], query, 1)[0];
    expect(hit.hits).toHaveLength(query.length);
    expect(hit.hits.every((pos, i) => pos >= 0 && pos < path.length && (i === 0 || pos > hit.hits[i - 1]))).toBe(true);
    expect(hit.hits.map(pos => path[pos].toLowerCase()[0]).join('')).toBe(query);
  }
});

test.each([false, true])('searches 100k paths within 200 ms (dense: %s)', dense => {
  const paths = Array.from({length:100_000}, (_, i) => `src/components/section-${i}/${dense ? 'store' : 'component'}-${i}.tsx`);
  paths[50_000] = 'src/ui/store.ts';
  fuzzyFind(paths.slice(0, 1000), 'store', 10);
  const start = performance.now();
  const hits = fuzzyFind(paths, 'store', 10);
  const elapsed = performance.now() - start;
  expect(hits[0].path).toBe('src/ui/store.ts');
  expect(elapsed).toBeLessThan(200);
});
