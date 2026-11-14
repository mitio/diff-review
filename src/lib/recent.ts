import type { PrRef, User } from '../types.ts';

export interface RecentPr {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: User | null;
  state: string;
  isDraft: boolean;
  files: number;
  additions: number;
  deletions: number;
  viewed: number;
  headOid: string;
  openedAt: number;
}

const KEY = 'ghr:recent';
export const MAX_RECENT = 50;
export const recentId = (r: PrRef) => `${r.owner}/${r.repo}#${r.number}`;

export function listRecent(): RecentPr[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(e => e && typeof e.owner === 'string' && typeof e.number === 'number') : [];
  } catch {
    return [];
  }
}
function save(list: RecentPr[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch { /* quota */ }
}

/** Opening a PR moves it to the front. */
export function touchRecent(ref: PrRef, now = Date.now()) {
  const list = listRecent();
  const id = recentId(ref);
  const old = list.find(e => recentId(e) === id);
  const entry: RecentPr = old ?? {
    owner: ref.owner, repo: ref.repo, number: ref.number, title: id, author: null, state: 'OPEN', isDraft: false,
    files: 0, additions: 0, deletions: 0, viewed: 0, headOid: '', openedAt: now,
  };
  save([{ ...entry, openedAt: now }, ...list.filter(e => recentId(e) !== id)]);
}

/** Refreshes an entry's metadata without reordering. */
export function updateRecent(ref: PrRef, patch: Partial<Omit<RecentPr, 'owner' | 'repo' | 'number' | 'openedAt'>>) {
  const list = listRecent();
  const id = recentId(ref);
  const i = list.findIndex(e => recentId(e) === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch };
  save(list);
}

/** Shifts the stored viewed count (for a PR that is no longer open, whose full state isn't at hand). */
export function adjustRecentViewed(ref: PrRef, delta: number) {
  const e = listRecent().find(x => recentId(x) === recentId(ref));
  if (e && delta) updateRecent(ref, { viewed: Math.max(0, Math.min(e.files || Infinity, e.viewed + delta)) });
}

export function removeRecent(ref: PrRef) {
  const id = recentId(ref);
  save(listRecent().filter(e => recentId(e) !== id));
}
