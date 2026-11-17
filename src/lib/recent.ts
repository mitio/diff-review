import type { ReviewRef, User } from '../types.ts';
import { refKey } from './refs.ts';

export interface RecentPr {
  ref: ReviewRef;
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
export const recentId = (r: { ref: ReviewRef }) => refKey(r.ref);

/** Entries written before v3 were PR-only and had owner/repo/number instead of `ref`. */
function migrate(e: any): RecentPr | null {
  if (!e || typeof e !== 'object') return null;
  if (e.ref && typeof e.ref.kind === 'string') return e;
  if (typeof e.owner === 'string' && typeof e.repo === 'string' && typeof e.number === 'number') {
    const { owner, repo, number, ...rest } = e;
    return { ...rest, ref: { kind: 'pr', owner, repo, number } };
  }
  return null;
}

export function listRecent(): RecentPr[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.map(migrate).filter((e): e is RecentPr => !!e) : [];
  } catch {
    return [];
  }
}
function save(list: RecentPr[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch { /* quota */ }
}

/** Opening a review moves it to the front. */
export function touchRecent(ref: ReviewRef, now = Date.now()) {
  const list = listRecent();
  const id = refKey(ref);
  const old = list.find(e => recentId(e) === id);
  const entry: RecentPr = old ?? {
    ref, title: id, author: null, state: ref.kind === 'pr' ? 'OPEN' : '', isDraft: false,
    files: 0, additions: 0, deletions: 0, viewed: 0, headOid: '', openedAt: now,
  };
  save([{ ...entry, openedAt: now }, ...list.filter(e => recentId(e) !== id)]);
}

/** Refreshes an entry's metadata without reordering. */
export function updateRecent(ref: ReviewRef, patch: Partial<Omit<RecentPr, 'ref' | 'openedAt'>>) {
  const list = listRecent();
  const id = refKey(ref);
  const i = list.findIndex(e => recentId(e) === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch };
  save(list);
}

export function removeRecent(ref: ReviewRef) {
  const id = refKey(ref);
  save(listRecent().filter(e => recentId(e) !== id));
}
