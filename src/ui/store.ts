import { create } from 'zustand';
import type {
  BlobResult, Category, Comment, HideRule, NewThread, PrData, PrFile, PrRef, ReviewEvent, Row, Thread, ViewedState,
} from '../types.ts';
import {
  addThread, currentOids, deleteComment, fetchPatches, discardReview, ensurePendingReview, fetchBlobs, loadPr, refreshPr, replyThread,
  resolveThread, setViewed, submitReview, updateComment,
} from '../lib/github.ts';
import { categorize, folderKey, isHidden } from '../lib/categorize.ts';
import { diffInWorker } from '../lib/diff.ts';
import { getPr, putPr } from '../lib/cache.ts';

export type ViewMode = 'unified' | 'split';
export type Grouping = 'tree' | 'category' | 'flat';
export interface Settings {
  viewMode: ViewMode;
  context: number;
  fontSize: number;
  grouping: Grouping;
  folderDepth: number;
  showHidden: boolean;
  sidebarWidth: number;
}
export const ALL = 1e9;
const DEFAULT_SETTINGS: Settings = {
  viewMode: 'unified', context: 10, fontSize: 12, grouping: 'tree', folderDepth: 2, showHidden: false, sidebarWidth: 300,
};

export type ComposerTarget =
  | { kind: 'line'; aIdx: number; bIdx: number }
  | { kind: 'file'; quote?: string };

export type Focus = { kind: 'category'; key: Category } | { kind: 'folder'; depth: number; key: string } | null;

export interface Toast { id: number; text: string; error?: boolean }

export type BigDiff = 'loading' | { rows: Row[] } | { error: string };

interface State {
  ref: PrRef | null;
  pr: PrData | null;
  loading: boolean;
  error: string | null;
  viewed: Record<string, ViewedState>;
  threads: Thread[];
  threadsByPath: Record<string, Thread[]>;
  pendingReviewId: string | null;
  blobs: Record<string, BlobResult | 'loading'>;
  bigDiffs: Record<string, BigDiff>;
  repoRules: HideRule[];
  prRules: HideRule[];
  collapsed: Record<string, boolean>;
  expansions: Record<string, Array<[number, number]>>;
  composers: Record<string, ComposerTarget>;
  selAnchor: { path: string; idx: number } | null;
  tab: 'overview' | 'diff';
  current: string | null;
  filter: string;
  focus: Focus;
  toasts: Toast[];
  stale: boolean;
  revalidating: boolean;
  busy: number;
  help: boolean;
  settings: Settings;
}

const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
};
const readArr = <T,>(key: string): T[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const write = (key: string, v: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota */ }
};

const repoKey = (r: PrRef) => `ghr:rules:${r.owner}/${r.repo}`;
const prKey = (r: PrRef) => `ghr:rules:${r.owner}/${r.repo}#${r.number}`;

const byPath = (threads: Thread[]) => {
  const m: Record<string, Thread[]> = {};
  for (const t of threads) (m[t.path] ||= []).push(t);
  return m;
};

export const useStore = create<State>(() => ({
  ref: null, pr: null, loading: false, error: null, viewed: {}, threads: [], threadsByPath: {}, pendingReviewId: null,
  blobs: {}, bigDiffs: {}, repoRules: [], prRules: [], collapsed: {}, expansions: {}, composers: {}, selAnchor: null,
  tab: 'diff', current: null, filter: '', focus: null, toasts: [], stale: false, revalidating: false, busy: 0, help: false,
  settings: read('ghr:settings', DEFAULT_SETTINGS),
}));

const set = useStore.setState;
const get = useStore.getState;

let toastId = 0;
export function toast(text: string, error = false) {
  const id = ++toastId;
  set(s => ({ toasts: [...s.toasts, { id, text, error }] }));
  setTimeout(() => dismissToast(id), error ? 9000 : 3500);
}
export const dismissToast = (id: number) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function busy<T>(fn: () => Promise<T>): Promise<T> {
  set(s => ({ busy: s.busy + 1 }));
  try { return await fn(); } finally { set(s => ({ busy: s.busy - 1 })); }
}

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...get().settings, ...patch };
  set({ settings });
  write('ghr:settings', settings);
}

// ---------- derived helpers ----------

export function allRules(s: Pick<State, 'repoRules' | 'prRules'>) {
  return [...s.repoRules, ...s.prRules];
}

export function fileHidden(s: Pick<State, 'repoRules' | 'prRules'>, f: PrFile) {
  return isHidden(f, allRules(s));
}

export function matchesFocus(focus: Focus, f: PrFile) {
  if (!focus) return true;
  if (focus.kind === 'category') return categorize(f.path) === focus.key;
  return folderKey(f.path, focus.depth) === focus.key;
}

export function matchesFilter(filter: string, f: PrFile) {
  if (!filter) return true;
  const p = f.path.toLowerCase();
  return filter.toLowerCase().split(/\s+/).filter(Boolean).every(t => p.includes(t));
}

/** Files shown in the diff stream, in order. */
export function streamFiles(s: State): PrFile[] {
  if (!s.pr) return [];
  return s.pr.files.filter(f =>
    (s.settings.showHidden || !fileHidden(s, f)) && matchesFocus(s.focus, f) && matchesFilter(s.filter, f));
}

export const isViewed = (v: ViewedState | undefined) => v === 'VIEWED';

export function pendingCount(s: Pick<State, 'threads' | 'pr'>) {
  const me = s.pr?.viewer.login;
  let n = 0;
  for (const t of s.threads) for (const c of t.comments) if (c.state === 'PENDING' && c.author?.login === me) n++;
  return n;
}

// ---------- loading ----------

let loadSeq = 0;
export async function load(ref: PrRef) {
  const seq = ++loadSeq;
  set({
    ref, loading: true, error: null, pr: null, blobs: {}, bigDiffs: {}, collapsed: {}, expansions: {}, composers: {},
    stale: false, revalidating: false, repoRules: readArr<HideRule>(repoKey(ref)), prRules: readArr<HideRule>(prKey(ref)),
  });
  const key = `${ref.owner}/${ref.repo}#${ref.number}`;
  const freshP = loadPr(ref);
  freshP.catch(() => {});
  const cached = await getPr(key);
  if (seq !== loadSeq) return;
  if (cached) applyPr(cached, seq, true);
  try {
    const pr = await freshP;
    if (seq !== loadSeq) return;
    applyPr(pr, seq, false);
    let final = get().pr ?? pr;
    if (final.files.some(missingPatch)) {
      try {
        const patches = await fetchPatches(ref);
        if (seq !== loadSeq || get().pr?.headOid !== final.headOid) return;
        final = fillPatches(get().pr!, patches);
        set({ pr: final });
        void prefetchBlobs(seq, new Set(final.files.filter(f => f.patch && patches.has(f.path)).map(f => f.path)));
      } catch (e) {
        console.warn('full diff unavailable', e);
      }
    }
    void putPr(key, final);
    const now = await currentOids(ref);
    if (seq === loadSeq && (now.baseOid !== pr.baseOid || now.headOid !== pr.headOid)) set({ stale: true });
  } catch (e) {
    if (seq !== loadSeq) return;
    if (cached) toast(`Showing cached copy; refresh failed: ${errText(e)}`, true);
    else set({ loading: false, error: errText(e) });
  } finally {
    if (seq === loadSeq) set({ revalidating: false });
  }
}

const missingPatch = (f: PrFile) => !f.patch && f.additions + f.deletions > 0;

function fillPatches(pr: PrData, patches: Map<string, string>): PrData {
  return {
    ...pr,
    files: pr.files.map(f => {
      if (!missingPatch(f)) return f;
      const patch = patches.get(f.path) ?? (f.previousPath ? patches.get(f.previousPath) : undefined);
      return patch ? { ...f, patch } : f;
    }),
  };
}

function applyPr(pr: PrData, seq: number, fromCache: boolean) {
  const prev = get().pr;
  const headChanged = !prev || prev.headOid !== pr.headOid;
  if (prev && !headChanged) {
    const old = new Map(prev.files.map(f => [f.path, f]));
    pr = {
      ...pr,
      files: pr.files.map(f => {
        const o = old.get(f.path);
        return !f.patch && o?.patch ? { ...f, patch: o.patch } : f;
      }),
    };
  }
  set(s => {
    const viewed = { ...s.viewed };
    for (const f of pr.files) {
      if (!prev || (!viewedInflight[f.path] && !viewedQueue.some(q => q.path === f.path) && !(f.path in viewedTouched))) {
        viewed[f.path] = f.viewed;
      }
    }
    const threads = prev ? mergeTemp(pr.threads, s.threads) : pr.threads;
    return {
      pr, loading: false, revalidating: fromCache, viewed, threads, threadsByPath: byPath(threads),
      pendingReviewId: prev && s.pendingReviewId && !pr.pendingReviewId ? s.pendingReviewId : pr.pendingReviewId,
      current: s.current ?? pr.files[0]?.path ?? null,
      ...(headChanged ? { blobs: {}, bigDiffs: {}, expansions: {} } : {}),
    };
  });
  document.title = `${pr.title} · #${pr.ref.number}`;
  if (headChanged) void prefetchBlobs(seq);
}

const needsHeadBlob = (f: PrFile) =>
  !!f.patch && f.status !== 'added' && f.status !== 'removed';

async function prefetchBlobs(seq: number, only?: Set<string>) {
  const s0 = get();
  const pr = s0.pr!;
  const ref = pr.ref;
  const valid = () => seq === loadSeq && get().pr?.headOid === pr.headOid;
  // current-first ordering: stream order, hidden files last
  const files = [...pr.files].sort((a, b) => Number(fileHidden(s0, a)) - Number(fileHidden(s0, b)));
  const todo = files.filter(f => needsHeadBlob(f) && (!only || only.has(f.path)));
  set(s => {
    const blobs = { ...s.blobs };
    for (const f of todo) blobs[f.path] = 'loading';
    return { blobs };
  });
  const chunks: PrFile[][] = [];
  for (let i = 0; i < todo.length; i += 40) chunks.push(todo.slice(i, i + 40));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      try {
        const res = await fetchBlobs(ref, chunk.map(f => ({ commit: pr.headOid, path: f.path })));
        if (!valid()) return;
        set(s => {
          const blobs = { ...s.blobs };
          for (const f of chunk) {
            blobs[f.path] = res.get(`${pr.headOid}:${f.path}`) ?? { text: null, binary: false, truncated: false, missing: true };
          }
          return { blobs };
        });
      } catch (e) {
        if (!valid()) return;
        set(s => {
          const blobs = { ...s.blobs };
          for (const f of chunk) blobs[f.path] = { text: null, binary: false, truncated: false, missing: true };
          return { blobs };
        });
        console.warn('blob fetch failed', e);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

export async function loadBigDiff(f: PrFile) {
  const pr = get().pr!;
  set(s => ({ bigDiffs: { ...s.bigDiffs, [f.path]: 'loading' } }));
  try {
    const specs = [];
    const basePath = f.previousPath || f.path;
    if (f.status !== 'added') specs.push({ commit: pr.mergeBaseOid, path: basePath });
    if (f.status !== 'removed') specs.push({ commit: pr.headOid, path: f.path });
    const res = await fetchBlobs(pr.ref, specs);
    const base = f.status === 'added' ? '' : res.get(`${pr.mergeBaseOid}:${basePath}`);
    const head = f.status === 'removed' ? '' : res.get(`${pr.headOid}:${f.path}`);
    const txt = (b: BlobResult | '' | undefined) => (b === '' ? '' : b && !b.binary && !b.truncated ? b.text : null);
    const a = txt(base), b = txt(head);
    if (a == null || b == null) throw new Error('binary, truncated or missing file');
    const rows = await diffInWorker(a, b);
    if (!rows) throw new Error('diff took too long');
    set(s => ({ bigDiffs: { ...s.bigDiffs, [f.path]: { rows } } }));
  } catch (e) {
    set(s => ({ bigDiffs: { ...s.bigDiffs, [f.path]: { error: errText(e) } } }));
  }
}

let refreshing = false;
export async function refresh(manual = false) {
  const s = get();
  if (!s.pr || refreshing || s.stale) return;
  refreshing = true;
  const started = performance.now();
  try {
    const r = await refreshPr(s.pr.ref, { baseOid: s.pr.baseOid, headOid: s.pr.headOid });
    if (get().pr !== s.pr) return;
    if (r.changed) {
      set({ stale: true });
      return;
    }
    set(st => {
      const viewed = { ...st.viewed };
      for (const [p, v] of Object.entries(r.viewed)) {
        if (!viewedInflight[p] && !viewedQueue.some(q => q.path === p) && !((viewedTouched[p] ?? -1) >= started)) viewed[p] = v;
      }
      const threads = mergeTemp(r.threads, st.threads);
      return { viewed, threads, threadsByPath: byPath(threads), pendingReviewId: r.pendingReviewId };
    });
    if (manual) toast('Refreshed');
  } catch (e) {
    if (manual) toast(`Refresh failed: ${errText(e)}`, true);
  } finally {
    refreshing = false;
  }
}

/** keep optimistic temp threads/comments that the server doesn't know yet */
function mergeTemp(server: Thread[], local: Thread[]) {
  const temps = local.filter(t => t.id.startsWith('tmp-'));
  const byId = new Map(local.map(t => [t.id, t]));
  const out = server.map(t => {
    const l = byId.get(t.id);
    const tmpComments = l?.comments.filter(c => c.id.startsWith('tmp-')) ?? [];
    return tmpComments.length ? { ...t, comments: [...t.comments, ...tmpComments] } : t;
  });
  return [...out, ...temps];
}

// ---------- viewed ----------

const viewedSeq: Record<string, number> = {};
const viewedInflight: Record<string, number> = {};
const viewedTouched: Record<string, number> = {};
let viewedQueue: Array<{ path: string; viewed: boolean; seq: number; prev: ViewedState }> = [];
let viewedTimer: ReturnType<typeof setTimeout> | null = null;

export function markViewed(paths: string[], viewed: boolean) {
  const s = get();
  if (!s.pr) return;
  const next = { ...s.viewed };
  const collapsed = { ...s.collapsed };
  for (const p of paths) {
    const prev = s.viewed[p] ?? 'UNVIEWED';
    if (isViewed(prev) === viewed) continue;
    next[p] = viewed ? 'VIEWED' : 'UNVIEWED';
    delete collapsed[p];
    viewedTouched[p] = performance.now();
    const seq = (viewedSeq[p] = (viewedSeq[p] ?? 0) + 1);
    viewedQueue = viewedQueue.filter(q => q.path !== p);
    viewedQueue.push({ path: p, viewed, seq, prev });
  }
  set({ viewed: next, collapsed });
  if (viewedTimer) clearTimeout(viewedTimer);
  viewedTimer = setTimeout(flushViewed, 150);
}

async function flushViewed() {
  const pr = get().pr;
  const batch = viewedQueue;
  viewedQueue = [];
  if (!pr || !batch.length) return;
  for (const q of batch) viewedInflight[q.path] = (viewedInflight[q.path] ?? 0) + 1;
  let results: Array<{ path: string; ok: boolean }>;
  try {
    results = await setViewed(pr.id, batch.map(q => ({ path: q.path, viewed: q.viewed })));
  } catch {
    results = batch.map(q => ({ path: q.path, ok: false }));
  }
  const ok = new Map(results.map(r => [r.path, r.ok]));
  const failed: string[] = [];
  set(s => {
    const viewed = { ...s.viewed };
    for (const q of batch) {
      viewedInflight[q.path]--;
      viewedTouched[q.path] = performance.now();
      if (ok.get(q.path) === false && viewedSeq[q.path] === q.seq) {
        viewed[q.path] = q.prev;
        failed.push(q.path);
      }
    }
    return { viewed };
  });
  if (failed.length) toast(`Could not update viewed state of ${failed.length} file(s)`, true);
}

// ---------- hide rules ----------

function saveRules(repoRules: HideRule[], prRules: HideRule[]) {
  const ref = get().ref!;
  set({ repoRules, prRules });
  write(repoKey(ref), repoRules);
  write(prKey(ref), prRules);
}

const sameRule = (a: HideRule, b: HideRule) => JSON.stringify(a) === JSON.stringify(b);

export function addRule(rule: HideRule) {
  const s = get();
  if (rule.kind === 'path') {
    if (!s.prRules.some(r => sameRule(r, rule))) saveRules(s.repoRules, [...s.prRules, rule]);
  } else if (!s.repoRules.some(r => sameRule(r, rule))) {
    saveRules([...s.repoRules, rule], s.prRules);
  }
}

export function removeRule(rule: HideRule) {
  const s = get();
  saveRules(s.repoRules.filter(r => !sameRule(r, rule)), s.prRules.filter(r => !sameRule(r, rule)));
}

export function toggleFileHidden(f: PrFile) {
  const s = get();
  const rule: HideRule = { kind: 'path', path: f.path };
  if (s.prRules.some(r => sameRule(r, rule))) removeRule(rule);
  else if (fileHidden(s, f)) toast('Hidden by a rule. Remove it in Overview → Hidden rules.');
  else addRule(rule);
}

// ---------- UI state ----------

export function setCollapsed(path: string, collapsed: boolean) {
  set(s => ({ collapsed: { ...s.collapsed, [path]: collapsed } }));
}

export function expand(path: string, from: number, to: number) {
  set(s => ({ expansions: { ...s.expansions, [path]: [...(s.expansions[path] ?? []), [from, to]] } }));
}

export function openComposer(path: string, t: ComposerTarget) {
  set(s => ({ composers: { ...s.composers, [path]: t } }));
}

export function closeComposer(path: string) {
  set(s => {
    const composers = { ...s.composers };
    delete composers[path];
    return { composers, selAnchor: s.selAnchor?.path === path ? null : s.selAnchor };
  });
}

// ---------- comments ----------

let tmpId = 0;

function viewerComment(body: string): Comment {
  const pr = get().pr!;
  return {
    id: `tmp-${++tmpId}`, body, bodyHTML: '', createdAt: new Date().toISOString(), author: pr.viewer,
    state: 'PENDING', url: '', viewerCanUpdate: false, viewerCanDelete: false,
  };
}

function setThreads(fn: (t: Thread[]) => Thread[]) {
  set(s => {
    const threads = fn(s.threads);
    return { threads, threadsByPath: byPath(threads) };
  });
}

async function reviewId() {
  const s = get();
  const id = await ensurePendingReview({ id: s.pr!.id, headOid: s.pr!.headOid, pendingReviewId: s.pendingReviewId });
  set({ pendingReviewId: id });
  return id;
}

/** Returns true on success. */
export async function createThread(t: NewThread): Promise<boolean> {
  const temp: Thread = {
    id: `tmp-${++tmpId}`, path: t.path, line: t.line ?? null, startLine: t.startLine ?? null, originalLine: t.line ?? null,
    side: t.side ?? 'RIGHT', startSide: t.startSide ?? null, isResolved: false, isOutdated: false,
    subjectType: t.subjectType, viewerCanResolve: false, viewerCanUnresolve: false, viewerCanReply: false,
    comments: [viewerComment(t.body)],
  };
  setThreads(ts => [...ts, temp]);
  try {
    const real = await busy(async () => addThread(await reviewId(), t));
    setThreads(ts => ts.map(x => (x.id === temp.id ? real : x)));
    return true;
  } catch (e) {
    setThreads(ts => ts.filter(x => x.id !== temp.id));
    toast(`Comment failed: ${errText(e)}`, true);
    return false;
  }
}

export async function reply(threadId: string, body: string): Promise<boolean> {
  const temp = viewerComment(body);
  const patch = (fn: (cs: Comment[]) => Comment[]) =>
    setThreads(ts => ts.map(t => (t.id === threadId ? { ...t, comments: fn(t.comments) } : t)));
  patch(cs => [...cs, temp]);
  try {
    const real = await busy(async () => replyThread(await reviewId(), threadId, body));
    patch(cs => cs.map(c => (c.id === temp.id ? real : c)));
    return true;
  } catch (e) {
    patch(cs => cs.filter(c => c.id !== temp.id));
    toast(`Reply failed: ${errText(e)}`, true);
    return false;
  }
}

export async function editComment(id: string, body: string): Promise<boolean> {
  try {
    const real = await busy(() => updateComment(id, body));
    setThreads(ts => ts.map(t => ({ ...t, comments: t.comments.map(c => (c.id === id ? { ...c, ...real } : c)) })));
    return true;
  } catch (e) {
    toast(`Edit failed: ${errText(e)}`, true);
    return false;
  }
}

export async function removeComment(id: string) {
  const before = get().threads;
  setThreads(ts => ts
    .map(t => ({ ...t, comments: t.comments.filter(c => c.id !== id) }))
    .filter(t => t.comments.length));
  try {
    await busy(() => deleteComment(id));
  } catch (e) {
    setThreads(() => before);
    toast(`Delete failed: ${errText(e)}`, true);
  }
}

export async function setResolved(threadId: string, resolved: boolean) {
  const flip = (v: boolean) =>
    setThreads(ts => ts.map(t => (t.id === threadId ? { ...t, isResolved: v, viewerCanResolve: !v, viewerCanUnresolve: v } : t)));
  flip(resolved);
  try {
    await busy(() => resolveThread(threadId, resolved));
  } catch (e) {
    flip(!resolved);
    toast(`Failed: ${errText(e)}`, true);
  }
}

export async function submit(event: ReviewEvent, body: string): Promise<boolean> {
  try {
    await busy(async () => submitReview(await reviewId(), event, body));
    set({ pendingReviewId: null });
    toast('Review submitted');
    await refresh();
    return true;
  } catch (e) {
    toast(`Submit failed: ${errText(e)}`, true);
    return false;
  }
}

export async function discard(): Promise<boolean> {
  const id = get().pendingReviewId;
  if (!id) return true;
  try {
    await busy(() => discardReview(id));
    set({ pendingReviewId: null });
    setThreads(ts => ts
      .map(t => ({ ...t, comments: t.comments.filter(c => c.state !== 'PENDING') }))
      .filter(t => t.comments.length));
    toast('Draft review discarded');
    return true;
  } catch (e) {
    toast(`Discard failed: ${errText(e)}`, true);
    return false;
  }
}
