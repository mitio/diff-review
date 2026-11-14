import { create } from 'zustand';
import type {
  BlobResult, Category, Comment, HideRule, NewThread, PrData, PrFile, PrRef, ReviewEvent, Row, Thread, ViewedState,
} from '../types.ts';
import {
  addThread, currentOids, deleteComment, discardReview, ensurePendingReview, fetchBlobs, fetchPatches, loadPr,
  refreshPr, replyThread, resolveThread, setViewed, submitReview, updateComment,
} from '../lib/github.ts';
import { categorize, folderKey, isHidden } from '../lib/categorize.ts';
import { diffInWorker, type Anchor } from '../lib/diff.ts';
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
  | { kind: 'line'; a: Anchor; b: Anchor }
  | { kind: 'file'; quote?: string };

export type Focus = { kind: 'category'; key: Category } | { kind: 'folder'; depth: number; key: string } | null;

export interface Toast { id: number; text: string; error?: boolean }

export type BigDiff = 'loading' | { rows: Row[] } | { error: string };

/** Path-keyed records are prototype-less so paths like "constructor" are safe keys. */
export type Dict<T> = Record<string, T>;
export const dict = <T,>(from?: Dict<T>): Dict<T> => Object.assign(Object.create(null), from);
const put = <T,>(d: Dict<T>, k: string, v: T): Dict<T> => {
  const n = dict(d);
  n[k] = v;
  return n;
};
const drop = <T,>(d: Dict<T>, k: string): Dict<T> => {
  const n = dict(d);
  delete n[k];
  return n;
};

interface State {
  ref: PrRef | null;
  pr: PrData | null;
  loading: boolean;
  error: string | null;
  viewed: Dict<ViewedState>;
  threads: Thread[];
  threadsByPath: Dict<Thread[]>;
  pendingReviewId: string | null;
  blobs: Dict<BlobResult | 'loading'>;
  bigDiffs: Dict<BigDiff>;
  repoRules: HideRule[];
  prRules: HideRule[];
  collapsed: Dict<boolean>;
  expansions: Dict<Array<[number, number]>>;
  composers: Dict<ComposerTarget>;
  selAnchor: { path: string; anchor: Anchor } | null;
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

const prId = (r: PrRef) => `${r.owner}/${r.repo}#${r.number}`;
const repoKey = (r: PrRef) => `ghr:rules:${r.owner}/${r.repo}`;
const prKey = (r: PrRef) => `ghr:rules:${prId(r)}`;
/** localStorage key for unsent text, scoped to the open PR. */
export const draftKey = (k: string) => {
  const r = useStore.getState().ref;
  return `ghr:draft:${r ? prId(r) : '-'}:${k}`;
};

const byPath = (threads: Thread[]) => {
  const m = dict<Thread[]>();
  for (const t of threads) (m[t.path] ??= []).push(t);
  return m;
};

const revision = (pr: PrData) => `${pr.baseOid}:${pr.headOid}`;

export const useStore = create<State>(() => ({
  ref: null, pr: null, loading: false, error: null, viewed: dict(), threads: [], threadsByPath: dict(),
  pendingReviewId: null, blobs: dict(), bigDiffs: dict(), repoRules: [], prRules: [], collapsed: dict(),
  expansions: dict(), composers: dict(), selAnchor: null, tab: 'diff', current: null, filter: '', focus: null,
  toasts: [], stale: false, revalidating: false, busy: 0, help: false, settings: read('ghr:settings', DEFAULT_SETTINGS),
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

/** Threads for a file, including those still recorded under its previous name. */
export function fileThreads(s: Pick<State, 'threadsByPath'>, f: PrFile): Thread[] | undefined {
  const a = s.threadsByPath[f.path];
  const b = f.previousPath ? s.threadsByPath[f.previousPath] : undefined;
  return b ? [...(a ?? []), ...b] : a;
}

// ---------- comment-write bookkeeping ----------
// A server snapshot fetched while a comment write was in flight (or before it finished) may predate it.
// Such snapshots must not replace local threads.

let writeEpoch = 0;
let writesInflight = 0;
async function writing<T>(fn: () => Promise<T>): Promise<T> {
  writesInflight++;
  writeEpoch++;
  set(s => ({ busy: s.busy + 1 }));
  try {
    return await fn();
  } finally {
    writesInflight--;
    writeEpoch++;
    set(s => ({ busy: s.busy - 1 }));
    if (writesInflight === 0 && reconcileNeeded) {
      reconcileNeeded = false;
      setTimeout(() => void refresh(), 300);
    }
  }
}
const threadsSafeSince = (epoch: number) => writesInflight === 0 && writeEpoch === epoch;
/** A snapshot was not applied to threads because of writes: fetch the server's view once they settle. */
let reconcileNeeded = false;
function needReconcile() {
  if (writesInflight === 0) setTimeout(() => void refresh(), 300);
  else reconcileNeeded = true;
}
/** Bumped on every applied snapshot; a refresh started before a newer snapshot is dropped. */
let dataGen = 0;

// ---------- viewed bookkeeping ----------
// Per PR and path: the last state GitHub confirmed, the newest local intent (seq), at most one request in flight.
// A reload of the same PR keeps the book, so queued and in-flight writes survive it.

interface ViewedBook {
  key: string;
  nodeId: string | null;
  confirmed: Map<string, ViewedState>;
  seq: Map<string, number>;
  inflight: Set<string>;
  touched: Map<string, number>;
  queue: Map<string, { viewed: boolean; seq: number }>;
  timer: ReturnType<typeof setTimeout> | null;
}
const newBook = (key: string): ViewedBook => ({
  key, nodeId: null, confirmed: new Map(), seq: new Map(), inflight: new Set(), touched: new Map(), queue: new Map(), timer: null,
});
let book = newBook('');

/** Server viewed states, applied (and trusted as confirmed) only for paths not written since `since`. */
function mergeServerViewed(cur: Dict<ViewedState>, server: Iterable<[string, ViewedState]>, since: number) {
  const viewed = dict(cur);
  for (const [p, v] of server) {
    const busyPath = book.inflight.has(p) || book.queue.has(p) || (book.touched.get(p) ?? -Infinity) >= since;
    if (busyPath) continue;
    viewed[p] = v;
    book.confirmed.set(p, v);
  }
  return viewed;
}

// ---------- loading ----------

let loadSeq = 0;
export async function load(ref: PrRef) {
  const seq = ++loadSeq;
  const started = performance.now();
  const epoch = writeEpoch;
  const key = prId(ref);
  if (book.queue.size) void flushViewed(book);
  const samePr = book.key === key;
  if (!samePr) book = newBook(key);
  set(s => ({
    ref, loading: true, error: null, pr: null, viewed: samePr ? s.viewed : dict(), threads: [], threadsByPath: dict(),
    pendingReviewId: null,
    blobs: dict(), bigDiffs: dict(), collapsed: dict(), expansions: dict(), composers: dict(), selAnchor: null,
    stale: false, revalidating: false, repoRules: readArr<HideRule>(repoKey(ref)), prRules: readArr<HideRule>(prKey(ref)),
  }));
  const freshP = loadPr(ref);
  freshP.catch(() => {});
  const cached = await getPr(key);
  if (seq !== loadSeq) return;
  if (cached) applyPr(cached, seq, true, started, epoch);
  try {
    const pr = await freshP;
    if (seq !== loadSeq) return;
    applyPr(pr, seq, false, started, epoch);
    let final = get().pr!;
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
    if (seq === loadSeq && (now.baseOid !== final.baseOid || now.headOid !== final.headOid)) set({ stale: true });
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

function applyPr(pr: PrData, seq: number, fromCache: boolean, started: number, epoch: number) {
  const prev = get().pr;
  const sameRev = !!prev && revision(prev) === revision(pr);
  if (prev && sameRev) {
    // patches filled from the whole-PR diff for this exact revision stay valid
    const old = new Map(prev.files.map(f => [f.path, f]));
    pr = {
      ...pr,
      files: pr.files.map(f => {
        const o = old.get(f.path);
        return !f.patch && o?.patch ? { ...f, patch: o.patch } : f;
      }),
    };
  }
  dataGen++;
  book.nodeId = pr.id;
  // local threads are only worth keeping over a snapshot of the same revision (their anchors match)
  const keepLocal = !!prev && sameRev && !threadsSafeSince(epoch);
  if (!threadsSafeSince(epoch)) needReconcile();
  set(s => {
    const viewed = mergeServerViewed(s.viewed, pr.files.map(f => [f.path, f.viewed]), started);
    const threads = keepLocal ? s.threads : mergeTemp(pr.threads, s.threads);
    return {
      pr, loading: false, revalidating: fromCache, viewed, threads, threadsByPath: byPath(threads),
      pendingReviewId: keepLocal ? s.pendingReviewId : pr.pendingReviewId,
      current: s.current ?? pr.files[0]?.path ?? null,
      ...(sameRev ? {} : { blobs: dict(), bigDiffs: dict(), expansions: dict() }),
    };
  });
  if (typeof document !== "undefined") document.title = `${pr.title} · #${pr.ref.number}`;
  if (!sameRev) void prefetchBlobs(seq);
}

const needsHeadBlob = (f: PrFile) => !!f.patch && f.status !== 'added' && f.status !== 'removed';

async function prefetchBlobs(seq: number, only?: Set<string>) {
  const s0 = get();
  const pr = s0.pr!;
  const ref = pr.ref;
  const rev = revision(pr);
  const valid = () => seq === loadSeq && !!get().pr && revision(get().pr!) === rev;
  const files = [...pr.files].sort((a, b) => Number(fileHidden(s0, a)) - Number(fileHidden(s0, b)));
  const todo = files.filter(f => needsHeadBlob(f) && (!only || only.has(f.path)));
  set(s => {
    const blobs = dict(s.blobs);
    for (const f of todo) blobs[f.path] = 'loading';
    return { blobs };
  });
  const chunks: PrFile[][] = [];
  for (let i = 0; i < todo.length; i += 40) chunks.push(todo.slice(i, i + 40));
  let next = 0;
  const missing: BlobResult = { text: null, binary: false, truncated: false, missing: true };
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      let res: Map<string, BlobResult> | null = null;
      try {
        res = await fetchBlobs(ref, chunk.map(f => ({ commit: pr.headOid, path: f.path })));
      } catch (e) {
        console.warn('blob fetch failed', e);
      }
      if (!valid()) return;
      set(s => {
        const blobs = dict(s.blobs);
        for (const f of chunk) blobs[f.path] = res?.get(`${pr.headOid}:${f.path}`) ?? missing;
        return { blobs };
      });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

export async function loadBigDiff(f: PrFile) {
  const pr = get().pr!;
  const rev = revision(pr);
  const stillValid = () => !!get().pr && revision(get().pr!) === rev;
  set(s => ({ bigDiffs: put(s.bigDiffs, f.path, 'loading' as BigDiff) }));
  let result: BigDiff;
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
    result = { rows };
  } catch (e) {
    result = { error: errText(e) };
  }
  if (stillValid()) set(s => ({ bigDiffs: put(s.bigDiffs, f.path, result) }));
}

let refreshing = false;
export async function refresh(manual = false) {
  const s = get();
  if (!s.pr || refreshing || s.stale) return;
  refreshing = true;
  const started = performance.now();
  const epoch = writeEpoch;
  const gen = dataGen;
  const pr0 = s.pr;
  try {
    const r = await refreshPr(pr0.ref, { baseOid: pr0.baseOid, headOid: pr0.headOid });
    if (gen !== dataGen) return;
    if (r.changed) {
      set({ stale: true });
      return;
    }
    set(st => {
      const viewed = mergeServerViewed(st.viewed, Object.entries(r.viewed), started);
      if (!threadsSafeSince(epoch)) {
        needReconcile();
        return { viewed };
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

export function markViewed(paths: string[], viewed: boolean) {
  const s = get();
  if (!s.pr) return;
  const b = book;
  const next = dict(s.viewed);
  const collapsed = dict(s.collapsed);
  const now = performance.now();
  for (const p of paths) {
    if (isViewed(s.viewed[p]) === viewed) continue;
    next[p] = viewed ? 'VIEWED' : 'UNVIEWED';
    delete collapsed[p];
    b.touched.set(p, now);
    const seq = (b.seq.get(p) ?? 0) + 1;
    b.seq.set(p, seq);
    b.queue.set(p, { viewed, seq });
  }
  set({ viewed: next, collapsed });
  scheduleViewedFlush(b);
}

function scheduleViewedFlush(b: ViewedBook) {
  if (b.timer) clearTimeout(b.timer);
  b.timer = setTimeout(() => void flushViewed(b), 150);
}

async function flushViewed(b: ViewedBook) {
  if (b.timer) clearTimeout(b.timer);
  b.timer = null;
  const nodeId = b.nodeId;
  if (!nodeId) return;
  const batch: Array<{ path: string; viewed: boolean; seq: number }> = [];
  for (const [path, q] of b.queue) {
    if (b.inflight.has(path)) continue;
    // nothing to send if the intent equals what GitHub already has
    const c = b.confirmed.get(path);
    if (c !== undefined && isViewed(c) === q.viewed) {
      b.queue.delete(path);
      continue;
    }
    batch.push({ path, ...q });
  }
  if (!batch.length) return;
  for (const q of batch) {
    b.queue.delete(q.path);
    b.inflight.add(q.path);
  }
  let results: Array<{ path: string; ok: boolean }>;
  try {
    results = await setViewed(nodeId, batch.map(q => ({ path: q.path, viewed: q.viewed })));
  } catch {
    results = batch.map(q => ({ path: q.path, ok: false }));
  }
  const ok = new Map(results.map(r => [r.path, r.ok]));
  const now = performance.now();
  const rollback: Array<[string, ViewedState]> = [];
  for (const q of batch) {
    b.inflight.delete(q.path);
    b.touched.set(q.path, now);
    if (ok.get(q.path)) b.confirmed.set(q.path, q.viewed ? 'VIEWED' : 'UNVIEWED');
    else if (b.seq.get(q.path) === q.seq) rollback.push([q.path, b.confirmed.get(q.path) ?? 'UNVIEWED']);
  }
  if (rollback.length && book === b) {
    set(s => {
      const viewed = dict(s.viewed);
      for (const [p, v] of rollback) viewed[p] = v;
      return { viewed };
    });
    toast(`Could not update viewed state of ${rollback.length} file(s)`, true);
  }
  if (b.queue.size) scheduleViewedFlush(b);
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
  set(s => ({ collapsed: put(s.collapsed, path, collapsed) }));
}

export function expand(path: string, from: number, to: number) {
  set(s => ({ expansions: put(s.expansions, path, [...(s.expansions[path] ?? []), [from, to] as [number, number]]) }));
}

export function openComposer(path: string, t: ComposerTarget) {
  set(s => ({ composers: put(s.composers, path, t) }));
}

export function closeComposer(path: string) {
  set(s => ({ composers: drop(s.composers, path), selAnchor: s.selAnchor?.path === path ? null : s.selAnchor }));
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

/** Replace a temp item with the server's; if a refresh already brought the real one in, just drop the temp. */
function swapTemp<T extends { id: string }>(list: T[], tempId: string, real: T): T[] {
  if (list.some(x => x.id === real.id)) return list.filter(x => x.id !== tempId);
  return list.map(x => (x.id === tempId ? real : x));
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
    const real = await writing(async () => addThread(await reviewId(), t));
    setThreads(ts => swapTemp(ts, temp.id, real));
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
    const real = await writing(async () => replyThread(await reviewId(), threadId, body));
    patch(cs => swapTemp(cs, temp.id, real));
    return true;
  } catch (e) {
    patch(cs => cs.filter(c => c.id !== temp.id));
    toast(`Reply failed: ${errText(e)}`, true);
    return false;
  }
}

export async function editComment(id: string, body: string): Promise<boolean> {
  try {
    const real = await writing(() => updateComment(id, body));
    setThreads(ts => ts.map(t => ({ ...t, comments: t.comments.map(c => (c.id === id ? { ...c, ...real } : c)) })));
    return true;
  } catch (e) {
    toast(`Edit failed: ${errText(e)}`, true);
    return false;
  }
}

export async function removeComment(id: string) {
  const ts0 = get().threads;
  const tIdx = ts0.findIndex(t => t.comments.some(c => c.id === id));
  if (tIdx < 0) return;
  const thread = ts0[tIdx];
  const cIdx = thread.comments.findIndex(c => c.id === id);
  const comment = thread.comments[cIdx];
  setThreads(ts => ts
    .map(t => (t.id === thread.id ? { ...t, comments: t.comments.filter(c => c.id !== id) } : t))
    .filter(t => t.comments.length));
  try {
    await writing(() => deleteComment(id));
  } catch (e) {
    setThreads(ts => {
      const at = ts.findIndex(t => t.id === thread.id);
      if (at < 0) {
        const out = [...ts];
        out.splice(Math.min(tIdx, out.length), 0, { ...thread, comments: [comment] });
        return out;
      }
      return ts.map(t => {
        if (t.id !== thread.id || t.comments.some(c => c.id === id)) return t;
        const comments = [...t.comments];
        comments.splice(Math.min(cIdx, comments.length), 0, comment);
        return { ...t, comments };
      });
    });
    toast(`Delete failed: ${errText(e)}`, true);
  }
}

export async function setResolved(threadId: string, resolved: boolean) {
  const flip = (v: boolean) =>
    setThreads(ts => ts.map(t => (t.id === threadId ? { ...t, isResolved: v, viewerCanResolve: !v, viewerCanUnresolve: v } : t)));
  flip(resolved);
  try {
    await writing(() => resolveThread(threadId, resolved));
  } catch (e) {
    flip(!resolved);
    toast(`Failed: ${errText(e)}`, true);
  }
}

export async function submit(event: ReviewEvent, body: string): Promise<boolean> {
  try {
    await writing(async () => submitReview(await reviewId(), event, body));
    set({ pendingReviewId: null });
    toast('Review submitted');
    void refresh();
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
    await writing(() => discardReview(id));
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
