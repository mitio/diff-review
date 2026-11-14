import { beforeEach, describe, expect, it } from 'vitest';
import { listRecent, MAX_RECENT, removeRecent, touchRecent, updateRecent } from './recent.ts';

const mem = new Map<string, string>();
globalThis.localStorage = {
  getItem: k => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: k => void mem.delete(k),
  clear: () => mem.clear(), key: () => null, length: 0,
} as Storage;

const ref = (n: number) => ({ owner: 'o', repo: 'r', number: n });

describe('recent PRs', () => {
  beforeEach(() => mem.clear());

  it('orders by last opened and caps the list', () => {
    for (let i = 1; i <= MAX_RECENT + 5; i++) touchRecent(ref(i), i);
    touchRecent(ref(10), 1000);
    const l = listRecent();
    expect(l).toHaveLength(MAX_RECENT);
    expect(l[0].number).toBe(10);
    expect(l[1].number).toBe(MAX_RECENT + 5);
    expect(l.some(e => e.number === 1)).toBe(false);
  });

  it('updates in place and removes', () => {
    touchRecent(ref(1), 1);
    touchRecent(ref(2), 2);
    updateRecent(ref(1), { title: 'T', viewed: 3 });
    expect(listRecent().map(e => [e.number, e.title, e.viewed])).toEqual([[2, 'o/r#2', 0], [1, 'T', 3]]);
    updateRecent(ref(9), { title: 'x' });
    expect(listRecent()).toHaveLength(2);
    removeRecent(ref(2));
    expect(listRecent().map(e => e.number)).toEqual([1]);
  });
});
