import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PrData, Thread } from '../types.ts';

const gh = vi.hoisted(() => ({
  loadPr: vi.fn(), currentOids: vi.fn(), setViewed: vi.fn(), refreshPr: vi.fn(), fetchBlobs: vi.fn(),
  fetchPatches: vi.fn(), ensurePendingReview: vi.fn(), addThread: vi.fn(), replyThread: vi.fn(),
  updateComment: vi.fn(), deleteComment: vi.fn(), resolveThread: vi.fn(), submitReview: vi.fn(), discardReview: vi.fn(),
}));
vi.mock('../lib/github.ts', () => gh);
vi.mock('../lib/cache.ts', () => ({ getPr: async () => null, putPr: async () => {} }));

import { createThread, load, markViewed, refresh, removeComment, useStore } from './store.ts';

const ref = { owner: 'o', repo: 'r', number: 1 };
const thread = (id: string, path = 'a.ts', commentId = `${id}-c`): Thread => ({
  id, path, line: 1, startLine: null, originalLine: 1, side: 'RIGHT', startSide: null, isResolved: false,
  isOutdated: false, subjectType: 'LINE', viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
  comments: [{ id: commentId, body: 'x', bodyHTML: '', createdAt: '', author: null, state: 'PENDING', url: '', viewerCanUpdate: true, viewerCanDelete: true }],
});
const pr = (over: Partial<PrData> = {}): PrData => ({
  ref, id: 'PR', title: 't', url: '', state: 'OPEN', isDraft: false, author: null, viewer: { login: 'me', avatarUrl: '' },
  baseRefName: 'main', headRefName: 'x', baseOid: 'b', headOid: 'h', mergeBaseOid: 'm', additions: 1, deletions: 0,
  changedFiles: 2, pendingReviewId: null, threads: [],
  files: [
    { path: 'a.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+a', viewed: 'UNVIEWED' },
    { path: 'constructor', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+c', viewed: 'UNVIEWED' },
  ],
  ...over,
});
const deferred = <T,>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = () => vi.advanceTimersByTimeAsync(1);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  for (const f of Object.values(gh)) f.mockReset();
  gh.currentOids.mockResolvedValue({ baseOid: 'b', headOid: 'h' });
  gh.fetchBlobs.mockResolvedValue(new Map());
  gh.ensurePendingReview.mockResolvedValue('R');
});
afterEach(() => vi.useRealTimers());

async function loaded(p = pr()) {
  gh.loadPr.mockResolvedValue(p);
  await load(ref);
}

test('paths that shadow Object.prototype keys load and track state', async () => {
  await loaded(pr({ threads: [thread('t1', 'constructor')] }));
  const s = useStore.getState();
  expect(s.error).toBeNull();
  expect(s.threadsByPath['constructor']).toHaveLength(1);
  expect(s.collapsed['constructor']).toBeUndefined();
});

test('toggling back within the debounce sends nothing', async () => {
  await loaded();
  markViewed(['a.ts'], true);
  markViewed(['a.ts'], false);
  await vi.advanceTimersByTimeAsync(200);
  expect(gh.setViewed).not.toHaveBeenCalled();
  expect(useStore.getState().viewed['a.ts']).toBe('UNVIEWED');
});

test('a failed write rolls back to the GitHub-confirmed state', async () => {
  await loaded();
  gh.setViewed.mockResolvedValue([{ path: 'a.ts', ok: false }]);
  markViewed(['a.ts'], true);
  await vi.advanceTimersByTimeAsync(200);
  await flush();
  expect(useStore.getState().viewed['a.ts']).toBe('UNVIEWED');
});

test('a second toggle waits for the in-flight write of the same path', async () => {
  await loaded();
  const first = deferred<Array<{ path: string; ok: boolean }>>();
  gh.setViewed.mockReturnValueOnce(first.promise).mockResolvedValueOnce([{ path: 'a.ts', ok: true }]);
  markViewed(['a.ts'], true);
  await vi.advanceTimersByTimeAsync(200);
  markViewed(['a.ts'], false);
  await vi.advanceTimersByTimeAsync(200);
  expect(gh.setViewed).toHaveBeenCalledTimes(1);
  first.resolve([{ path: 'a.ts', ok: true }]);
  await flush();
  await vi.advanceTimersByTimeAsync(200);
  expect(gh.setViewed).toHaveBeenCalledTimes(2);
  expect(gh.setViewed.mock.calls[1][1]).toEqual([{ path: 'a.ts', viewed: false }]);
  expect(useStore.getState().viewed['a.ts']).toBe('UNVIEWED');
});

test('a refresh that raced a comment write does not drop the new thread', async () => {
  await loaded();
  const add = deferred<Thread>();
  gh.addThread.mockReturnValue(add.promise);
  const refreshed = deferred<unknown>();
  gh.refreshPr.mockReturnValue(refreshed.promise);
  const creating = createThread({ path: 'a.ts', body: 'hi', subjectType: 'LINE', line: 1, side: 'RIGHT' });
  const r = refresh();
  await flush();
  add.resolve(thread('T'));
  await creating;
  refreshed.resolve({ changed: false, threads: [], viewed: {}, pendingReviewId: null });
  await r;
  const s = useStore.getState();
  expect(s.threads.map(t => t.id)).toEqual(['T']);
  expect(s.pendingReviewId).toBe('R');
});

test('a temp thread is not duplicated when a refresh already brought in the real one', async () => {
  await loaded();
  const add = deferred<Thread>();
  gh.addThread.mockReturnValue(add.promise);
  const creating = createThread({ path: 'a.ts', body: 'hi', subjectType: 'LINE', line: 1, side: 'RIGHT' });
  await flush();
  useStore.setState(s => ({ threads: [...s.threads, thread('T')] }));
  add.resolve(thread('T'));
  await creating;
  expect(useStore.getState().threads.map(t => t.id)).toEqual(['T']);
});

test('a failed delete restores only that comment', async () => {
  await loaded(pr({ threads: [thread('A')] }));
  const del = deferred<void>();
  gh.deleteComment.mockReturnValue(del.promise);
  const removing = removeComment('A-c');
  useStore.setState(s => ({ threads: [...s.threads, thread('B')] }));
  del.reject(new Error('nope'));
  await removing;
  expect(useStore.getState().threads.map(t => t.id).sort()).toEqual(['A', 'B']);
});
