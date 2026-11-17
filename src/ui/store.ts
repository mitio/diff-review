import { create } from 'zustand';
import type {
  BlobResult, BlobSpec, Category, Checks, Comment, Conversation, HideRule, IssueComment, NewThread, PrData, PrFile, ReviewEvent,
  ReviewRef, Row, Thread, ViewedState,
} from '../types.ts';
import {
  addIssueComment, addThread, currentOids, deleteComment, deleteIssueComment, discardReview, ensurePendingReview, fetchBlobs,
  fetchChecks, fetchConversation, fetchPatches, loadPr, refreshPr, replyThread, resolveThread, setViewed, submitReview,
  updateComment, updateIssueComment,
} from '../lib/github.ts';
import { touchRecent, updateRecent, type RecentPr } from '../lib/recent.ts';
import { categorize, folderKey, isHidden, sidebarOrder } from '../lib/categorize.ts';
import { diffInWorker, type Anchor } from '../lib/diff.ts';
import { getPr, putPr } from '../lib/cache.ts';
import { ghRepo, isPr, prRef, refKey } from '../lib/refs.ts';
import { contentOid, fetchLocalBlobs, listFiles, loadSource } from '../lib/sources.ts';
import { LocalReview, toThreads, viewedStates } from '../lib/localstate.ts';
import { exportMarkdown, sourceLine } from '../lib/export.ts';

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
  highlight: boolean;
}
export const ALL = 1e9;
const DEFAULT_SETTINGS: Settings = {
  viewMode: 'unified', context: 10, fontSize: 12, grouping: 'tree', folderDepth: 2, showHidden: false, sidebarWidth: 300, highlight: true,
};

export type ComposerTarget =
  | { kind: 'line'; a: Anchor; b: Anchor }
  | { kind: 'file'; quote?: string };

export type Focus = { kind: 'category'; key: Category } | { kind: 'folder'; depth: number; key: string } | null;

export type Tab = 'overview' | 'diff' | 'conversation';

export interface Toast { id: number; text: string; error?: boolean }

export type BigDiff = 'loading' | { rows: Row[] } | { error: string };

/** Every file at the review's head, for the file finder; `rev` is the revision it was listed for. */
export type FileTree = 'loading' | { rev: string; paths: string[]; truncated: boolean } | { rev: string; error: string };

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
  ref: ReviewRef | null;
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
  /** line range being drag-selected; the composer opens on mouseup */
  dragSel: { path: string; a: Anchor; b: Anchor } | null;
  /** files shown as an outline (whole file, blocks folded) */
  outline: Dict<boolean>;
  /** per file, fold start row -> folded; overrides the outline's default */
  folds: Dict<Record<number, boolean>>;
  tab: Tab;
  current: string | null;
  /** file to scroll to once it is rendered (from the URL) */
  pendingFile: string | null;
  /** shown in the diff even if filters, focus or hide rules exclude it (an explicit jump) */
  reveal: string | null;
  /** files outside the diff opened from the file finder (or holding local comments), in open order */
  opened: string[];
  tree: FileTree | null;
  finder: boolean;
  checks: Checks | null;
  conv: Conversation | null;
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

const prId = refKey;
const curKey = () => {
  const r = useStore.getState().ref;
  return r ? prId(r) : '';
};
/** Writes finishing after a switch to another PR must not touch the new PR's state. */
const onPr = (key: string) => curKey() === key;
/** Folder, category and glob rules apply to every review of the same repo. */
const repoKey = (r: ReviewRef) => {
  const g = ghRepo(r);
  return `ghr:rules:${g ? `${g.owner}/${g.repo}` : r.kind === 'local' ? `local:${r.repo}` : 'paste'}`;
};
const prKey = (r: ReviewRef) => `ghr:rules:${prId(r)}`;
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
  expansions: dict(), composers: dict(), selAnchor: null, dragSel: null, outline: dict(), folds: dict(), tab: 'diff', current: null, pendingFile: null, reveal: null, opened: [], tree: null, finder: false, checks: null, conv: null, filter: '', focus: null,
  toasts: [], stale: false, revalidating: false, busy: 0, help: false, settings: read('ghr:settings', DEFAULT_SETTINGS),
}));

const set = useStore.setState;
const get = useStore.getState;

// an explicit jump's reveal ends when the user narrows or re-scopes the view
useStore.subscribe((s, p) => {
  if (s.reveal && (s.focus !== p.focus || s.filter !== p.filter || s.repoRules !== p.repoRules || s.prRules !== p.prRules)) {
    set({ reveal: null });
  }
});

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

/** Files shown in the diff stream, in order: the diff's, then opened files outside it. */
export function streamFiles(s: State): PrFile[] {
  if (!s.pr) return [];
  const files = s.pr.files.filter(f => f.path === s.reveal ||
    ((s.settings.showHidden || !fileHidden(s, f)) && matchesFocus(s.focus, f) && matchesFilter(s.filter, f)));
  return [...sidebarOrder(files, s.settings.grouping), ...openedFiles(s)];
}

/** A file outside the diff, shown in full. */
export const isUnchanged = (f: PrFile) => f.status === 'unchanged';
const unchangedFiles = new Map<string, PrFile>();
let openedMemo: { opened: string[]; files: PrFile[] } = { opened: [], files: [] };
/** Stable PrFile objects for the opened paths (FileBlock is memoized on them). */
export function openedFiles(s: Pick<State, 'opened'>): PrFile[] {
  if (openedMemo.opened !== s.opened) {
    const files = s.opened.map(path => {
      let f = unchangedFiles.get(path);
      if (!f) unchangedFiles.set(path, (f = { path, status: 'unchanged', additions: 0, deletions: 0, viewed: 'UNVIEWED' }));
      return f;
    });
    openedMemo = { opened: s.opened, files };
  }
  return openedMemo.files;
}
/** a copy's source still exists unchanged, so only a rename's old path counts */
const diffPaths = (pr: PrData) => new Set(pr.files.flatMap(f => (f.previousPath && f.status === 'renamed' ? [f.path, f.previousPath] : [f.path])));

export const isViewed = (v: ViewedState | undefined) => v === 'VIEWED';

/** Comments and viewed state stay on this machine (everything but PRs). */
export const isLocalReview = (s: Pick<State, 'ref'>) => !!s.ref && !isPr(s.ref);

/** Unresolved threads of a local review. */
export function openCount(s: Pick<State, 'threads'>) {
  return s.threads.filter(t => !t.isResolved).length;
}

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
  ref: ReviewRef | null;
  nodeId: string | null;
  revision: string | null;
  confirmed: Map<string, ViewedState>;
  seq: Map<string, number>;
  inflight: Set<string>;
  touched: Map<string, number>;
  queue: Map<string, { viewed: boolean; seq: number }>;
  timer: ReturnType<typeof setTimeout> | null;
  /** the newest local state per written path (intent, or the rollback after a failure) */
  local: Map<string, ViewedState>;
  /** files of the newest applied snapshot */
  paths: string[];
}
const newBook = (key: string): ViewedBook => ({
  key, ref: null, nodeId: null, revision: null, confirmed: new Map(), seq: new Map(), inflight: new Set(), touched: new Map(), queue: new Map(),
  timer: null, local: new Map(), paths: [],
});
/** Viewed files as this book knows them: the local intent while a write is pending, else GitHub's state. */
function bookViewedCount(b: ViewedBook) {
  return b.paths.filter(p => isViewed(b.queue.has(p) || b.inflight.has(p) ? b.local.get(p) : b.confirmed.get(p) ?? b.local.get(p))).length;
}
let book = newBook('');
/** Books outlive navigation, so A -> B -> A keeps A's queued and in-flight writes ordered. */
const books = new Map<string, ViewedBook>();

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
export async function load(ref: ReviewRef) {
  const seq = ++loadSeq;
  const started = performance.now();
  const epoch = writeEpoch;
  const key = prId(ref);
  if (book.queue.size) void flushViewed(book);
  const samePr = curKey() === key;
  book = books.get(key) ?? newBook(key);
  book.ref = ref;
  books.set(key, book);
  touchRecent(ref);
  const seeded = dict<ViewedState>();
  for (const [p, v] of book.local) seeded[p] = v;
  set(s => ({
    ref, loading: true, error: null, pr: null, viewed: samePr ? s.viewed : seeded, threads: [], threadsByPath: dict(),
    pendingReviewId: null, checks: null, tree: null, finder: false, ...(samePr ? {} : { conv: null, current: null, reveal: null, opened: [] }),
    blobs: dict(), bigDiffs: dict(), collapsed: dict(), expansions: dict(), composers: dict(), selAnchor: null, dragSel: null, outline: dict(), folds: dict(),
    stale: false, revalidating: false, repoRules: readArr<HideRule>(repoKey(ref)), prRules: readArr<HideRule>(prKey(ref)),
  }));
  if (!isPr(ref)) return loadOther(ref, seq, key);
  detachLocal();
  const freshP = loadPr(prRef(ref));
  freshP.catch(() => {});
  void loadChecks();
  void loadConversation();
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
        const patches = await fetchPatches(prRef(ref));
        if (seq !== loadSeq || get().pr?.headOid !== final.headOid) return;
        final = fillPatches(get().pr!, patches);
        set({ pr: final });
        void prefetchBlobs(seq, new Set(final.files.filter(f => f.patch && patches.has(f.path)).map(f => f.path)));
      } catch (e) {
        console.warn('full diff unavailable', e);
      }
    }
    void putPr(key, final);
    const now = await currentOids(prRef(ref));
    if (seq === loadSeq && (now.baseOid !== final.baseOid || now.headOid !== final.headOid)) set({ stale: true });
  } catch (e) {
    if (seq !== loadSeq) return;
    if (cached) toast(`Showing cached copy; refresh failed: ${errText(e)}`, true);
    else set({ loading: false, error: errText(e) });
  } finally {
    if (seq === loadSeq) set({ revalidating: false });
  }
}

// ---------- local reviews (commits, compares, local and pasted diffs) ----------

let local: LocalReview | null = null;
/** One instance (one writer) per review for the page's lifetime, so leaving and reopening can't fork its writes. */
const localReviews = new Map<string, Promise<LocalReview>>();
function openLocal(ref: ReviewRef): Promise<LocalReview> {
  const key = refKey(ref);
  let p = localReviews.get(key);
  if (!p) {
    p = LocalReview.open(ref, '');
    localReviews.set(key, p);
    p.catch(() => { if (localReviews.get(key) === p) localReviews.delete(key); });
  } else {
    // a revisit: pick up what other tabs wrote meanwhile
    void p.then(lr => lr.reload()).then(changed => { if (changed) syncLocal(); }).catch(() => {});
  }
  return p;
}
let unsubLocal: (() => void) | null = null;
function detachLocal() {
  unsubLocal?.();
  unsubLocal = null;
  local = null;
}
function attachLocal(lr: LocalReview) {
  detachLocal();
  local = lr;
  unsubLocal = lr.onReplace((_doc, reason) => {
    if (local !== lr) return;
    syncLocal();
    if (reason) toast(reason, true);
  });
}
/** Threads and viewed state from the local review's doc (its pending writes included). */
function syncLocal() {
  const s = get();
  if (!s.pr || !local || local.key !== refKey(s.pr.ref)) return;
  const doc = local.doc();
  const threads = toThreads(doc, s.pr.viewer);
  set({ threads, threadsByPath: byPath(threads), viewed: viewedStates(doc, s.pr.files) });
  // comments on files outside the diff show in those files
  if (contentOid(s.pr)) openPaths(threads.map(t => t.path));
}

async function loadOther(ref: ReviewRef, seq: number, key: string) {
  const freshP = loadSource(ref);
  freshP.catch(() => {});
  const docP = openLocal(ref);
  docP.catch(() => {});
  const cached = await getPr(key);
  if (seq !== loadSeq) return;
  try {
    const lr = await docP;
    if (seq !== loadSeq) return;
    attachLocal(lr);
    if (cached) applyOther(cached, seq, true);
    const pr = await freshP;
    if (seq !== loadSeq) return;
    applyOther(pr, seq, false);
    lr.setTitle(pr.title);
    void putPr(key, pr);
  } catch (e) {
    if (seq !== loadSeq) return;
    if (cached && get().pr) toast(`Showing cached copy; refresh failed: ${errText(e)}`, true);
    else set({ loading: false, error: errText(e) });
  } finally {
    if (seq === loadSeq) set({ revalidating: false });
  }
}

function applyOther(pr: PrData, seq: number, fromCache: boolean) {
  const prev = get().pr;
  const sameRev = !!prev && revision(prev) === revision(pr);
  dataGen++;
  // a line comment being written points at lines of the old diff; its draft text is kept
  const open = get().composers;
  const lineDrafts = Object.keys(open).filter(p => open[p].kind === 'line');
  if (prev && !sameRev && lineDrafts.length) {
    const composers = dict(open);
    for (const p of lineDrafts) delete composers[p];
    set({ composers, selAnchor: null, dragSel: null });
    toast('The diff changed, so the open line comment was closed. Opening a comment on the same lines again restores its draft.');
  }
  set(s => ({
    pr, loading: false, revalidating: fromCache,
    current: s.current ?? pr.files[0]?.path ?? null,
    ...(sameRev ? {} : { blobs: dict(), bigDiffs: dict(), expansions: dict(), folds: dict(), tree: null, opened: outsideDiff(pr, s.opened) }),
  }));
  syncLocal();
  if (typeof document !== 'undefined') document.title = `${pr.title} · diff-review`;
  recordRecent();
  if (!sameRev) {
    void prefetchBlobs(seq);
    void fetchOpened(get().opened);
  }
}

async function refreshOther(manual: boolean) {
  const ref = get().ref!;
  const ls = loadSeq;
  const gen = dataGen;
  const pr = await loadSource(ref);
  if (ls !== loadSeq || gen !== dataGen) return;
  // pick up comments written in another tab
  await local?.reload().catch(() => false);
  if (ls !== loadSeq || gen !== dataGen) return;
  applyOther(pr, ls, false);
  void putPr(refKey(ref), pr);
  if (manual) toast('Refreshed');
}

/** An open comment box pins the lines it targets; refreshing on focus would move them under it. */
export const composing = () => Object.keys(get().composers).length > 0;

/** Wraps a local write for the "saving…" indicator; failures already replaced the state (onReplace). */
async function localWrite<T>(p: Promise<T>): Promise<T | undefined> {
  set(s => ({ busy: s.busy + 1 }));
  syncLocal();
  try {
    return await p;
  } catch (e) {
    console.warn('local write failed', e);
    return undefined;
  } finally {
    set(s => ({ busy: s.busy - 1 }));
    syncLocal();
  }
}

/** The local review's comments as Markdown (for an agent). */
export function exportLocal(includeResolved: boolean): string | null {
  const s = get();
  if (!local || !s.pr || local.key !== refKey(s.pr.ref)) return null;
  return exportMarkdown(local.doc(), { source: sourceLine(s.pr.ref), order: s.pr.files.map(f => f.path), includeResolved });
}

/** Remembers which local threads no longer match the code, so the CLI export can say so. */
export function setLocalOutdated(flags: Record<string, boolean>) {
  local?.setOutdated(flags);
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
  book.paths = pr.files.map(f => f.path);
  const newRevision = book.revision !== null && book.revision !== revision(pr);
  book.revision = revision(pr);
  // local threads are only worth keeping over a snapshot of the same revision (their anchors match)
  const keepLocal = !!prev && sameRev && !threadsSafeSince(epoch);
  if (!threadsSafeSince(epoch)) needReconcile();
  set(s => {
    const viewed = mergeServerViewed(s.viewed, pr.files.map(f => [f.path, f.viewed]), newRevision ? Infinity : started);
    const threads = keepLocal ? s.threads : mergeTemp(pr.threads, s.threads);
    return {
      pr, loading: false, revalidating: fromCache, viewed, threads, threadsByPath: byPath(threads),
      pendingReviewId: keepLocal ? s.pendingReviewId : pr.pendingReviewId,
      current: s.current ?? pr.files[0]?.path ?? null,
      ...(sameRev ? {} : { blobs: dict(), bigDiffs: dict(), expansions: dict(), folds: dict(), tree: null, opened: outsideDiff(pr, s.opened) }),
    };
  });
  if (typeof document !== 'undefined' && isPr(pr.ref)) document.title = `${pr.title} · #${pr.ref.number}`;
  recordRecent();
  if (!sameRev) {
    void prefetchBlobs(seq);
    void fetchOpened(get().opened);
  }
}

const needsHeadBlob = (f: PrFile) => !!f.patch && f.status !== 'added' && f.status !== 'removed';

type BlobFetcher = (specs: BlobSpec[]) => Promise<Map<string, BlobResult>>;
/** null: the source has no file contents (pasted diffs) */
function blobFetcher(pr: PrData): BlobFetcher | null {
  const r = pr.ref;
  if (r.kind === 'local') return specs => fetchLocalBlobs(r.repo, specs);
  const g = ghRepo(r);
  return g ? specs => fetchBlobs({ ...g, number: 0 }, specs) : null;
}

async function prefetchBlobs(seq: number, only?: Set<string>) {
  const s0 = get();
  const pr = s0.pr!;
  const fetcher = blobFetcher(pr);
  if (!fetcher) return;
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
        res = await fetcher(chunk.map(f => ({ commit: pr.headOid, path: f.path })));
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
    const fetcher = blobFetcher(pr);
    if (!fetcher) throw new Error('a pasted diff has no file contents');
    const res = await fetcher(specs);
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

// ---------- files outside the diff ----------

const outsideDiff = (pr: PrData, paths: string[]) => {
  const inDiff = diffPaths(pr);
  const out = paths.filter(p => !inDiff.has(p));
  return out.length === paths.length ? paths : out;
};

/** Adds paths outside the diff to the opened files and loads them. */
export function openPaths(paths: string[]) {
  const s = get();
  if (!s.pr || !contentOid(s.pr)) return;
  const known = new Set(s.opened);
  const inDiff = diffPaths(s.pr);
  const add = [...new Set(paths)].filter(p => !known.has(p) && !inDiff.has(p));
  if (!add.length) return;
  set({ opened: [...s.opened, ...add] });
  void fetchOpened(add);
}

export function closeOpened(path: string) {
  set(s => ({
    opened: s.opened.filter(p => p !== path), blobs: drop(s.blobs, path), composers: drop(s.composers, path),
    selAnchor: s.selAnchor?.path === path ? null : s.selAnchor, dragSel: s.dragSel?.path === path ? null : s.dragSel,
  }));
}

/** The opened files' contents, from the tree that matches the head for files the diff doesn't touch. */
async function fetchOpened(paths: string[]) {
  const pr = get().pr;
  const oid = pr && contentOid(pr);
  const fetcher = pr && blobFetcher(pr);
  if (!pr || !oid || !fetcher || !paths.length) return;
  const rev = revision(pr);
  const ls = loadSeq;
  const valid = () => ls === loadSeq && !!get().pr && revision(get().pr!) === rev;
  set(s => {
    const blobs = dict(s.blobs);
    for (const p of paths) blobs[p] = 'loading';
    return { blobs };
  });
  const missing: BlobResult = { text: null, binary: false, truncated: false, missing: true };
  let res: Map<string, BlobResult> | null = null;
  try {
    res = await fetcher(paths.map(path => ({ commit: oid, path })));
  } catch (e) {
    console.warn('file fetch failed', e);
  }
  if (!valid()) return;
  set(s => {
    const blobs = dict(s.blobs);
    for (const p of paths) if (s.opened.includes(p)) blobs[p] = res?.get(`${oid}:${p}`) ?? missing;
    return { blobs };
  });
}

/** Lists every file at the head once per revision (for the file finder). */
export async function loadTree() {
  const pr = get().pr;
  if (!pr) return;
  const rev = revision(pr);
  const t = get().tree;
  if (t === 'loading' || (t && t.rev === rev && !('error' in t))) return;
  set({ tree: 'loading' });
  const ls = loadSeq;
  let tree: FileTree;
  try {
    tree = { rev, ...(await listFiles(pr)) };
  } catch (e) {
    tree = { rev, error: errText(e) };
  }
  if (ls === loadSeq && get().pr && revision(get().pr!) === rev) set({ tree });
}

let refreshing = false;
let refreshAgain = false;
export async function refresh(manual = false) {
  const s = get();
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  if (!s.pr || s.stale) return;
  refreshing = true;
  if (!isPr(s.pr.ref)) {
    try {
      await refreshOther(manual);
    } catch (e) {
      if (manual) toast(`Refresh failed: ${errText(e)}`, true);
    } finally {
      refreshing = false;
      if (refreshAgain) {
        refreshAgain = false;
        setTimeout(() => void refresh(), 0);
      }
    }
    return;
  }
  void loadChecks();
  void loadConversation();
  const started = performance.now();
  const epoch = writeEpoch;
  const gen = dataGen;
  const ls = loadSeq;
  const pr0 = s.pr;
  try {
    if (!isPr(pr0.ref)) return;
    const r = await refreshPr(prRef(pr0.ref), { baseOid: pr0.baseOid, headOid: pr0.headOid });
    if (gen !== dataGen || ls !== loadSeq) return;
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
    recordRecent();
    if (manual) toast('Refreshed');
  } catch (e) {
    if (manual) toast(`Refresh failed: ${errText(e)}`, true);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      setTimeout(() => void refresh(), 0);
    }
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
  if (!isPr(s.pr.ref)) return markViewedLocal(paths, viewed);
  const b = book;
  const next = dict(s.viewed);
  const collapsed = dict(s.collapsed);
  const now = performance.now();
  for (const p of paths) {
    if (isViewed(s.viewed[p]) === viewed) continue;
    next[p] = viewed ? 'VIEWED' : 'UNVIEWED';
    b.local.set(p, next[p]);
    delete collapsed[p];
    b.touched.set(p, now);
    const seq = (b.seq.get(p) ?? 0) + 1;
    b.seq.set(p, seq);
    b.queue.set(p, { viewed, seq });
  }
  set({ viewed: next, collapsed });
  scheduleViewedFlush(b);
  recordRecent();
}

/** Each intent stores the fingerprint of the file as it was displayed when clicked. */
function markViewedLocal(paths: string[], viewed: boolean) {
  const s = get();
  const lr = local;
  if (!s.pr || !lr) return;
  const files = new Map(s.pr.files.map(f => [f.path, f]));
  const items = paths.filter(p => isViewed(s.viewed[p]) !== viewed && files.has(p))
    .map(p => ({ path: p, fingerprint: viewed ? files.get(p)!.fingerprint ?? '' : null }));
  if (!items.length) return;
  const collapsed = dict(s.collapsed);
  for (const it of items) delete collapsed[it.path];
  set({ collapsed });
  void localWrite(lr.setViewed(items));
  recordRecent();
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
    else if (b.seq.get(q.path) === q.seq) {
      const v = b.confirmed.get(q.path) ?? 'UNVIEWED';
      rollback.push([q.path, v]);
      b.local.set(q.path, v);
    }
  }
  if (rollback.length && book === b) {
    set(s => {
      const viewed = dict(s.viewed);
      for (const [p, v] of rollback) viewed[p] = v;
      return { viewed };
    });
    toast(`Could not update viewed state of ${rollback.length} file(s)`, true);
    recordRecent();
  } else if (rollback.length && b.ref) {
    queueRecent(b.ref, { viewed: bookViewedCount(b) });
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

export function toggleOutline(path: string) {
  setOutline([path], !get().outline[path]);
}

/** Switching the outline starts from its default folds. */
export function setOutline(paths: string[], on: boolean) {
  set(s => {
    const outline = dict(s.outline), folds = dict(s.folds), collapsed = dict(s.collapsed);
    for (const p of paths) {
      outline[p] = on;
      delete folds[p];
      if (on) collapsed[p] = false;
    }
    return { outline, folds, collapsed };
  });
}

export function setFolds(path: string, patch: Record<number, boolean>) {
  set(s => ({ folds: put(s.folds, path, { ...s.folds[path], ...patch }) }));
}

export function resetFolds(path: string) {
  set(s => ({ folds: drop(s.folds, path) }));
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
  const key = curKey();
  const id = await ensurePendingReview({ id: s.pr!.id, headOid: s.pr!.headOid, pendingReviewId: s.pendingReviewId });
  if (onPr(key)) set({ pendingReviewId: id });
  return id;
}

/** Returns true on success. */
export async function createThread(t: NewThread): Promise<boolean> {
  if (local && isLocalReview(get())) return (await localWrite(local.addThread(t))) !== undefined;
  const temp: Thread = {
    id: `tmp-${++tmpId}`, path: t.path, line: t.line ?? null, startLine: t.startLine ?? null, originalLine: t.line ?? null,
    side: t.side ?? 'RIGHT', startSide: t.startSide ?? null, isResolved: false, isOutdated: false,
    subjectType: t.subjectType, viewerCanResolve: false, viewerCanUnresolve: false, viewerCanReply: false,
    comments: [viewerComment(t.body)],
  };
  setThreads(ts => [...ts, temp]);
  const key = curKey();
  try {
    const real = await writing(async () => addThread(await reviewId(), t));
    if (onPr(key)) setThreads(ts => swapTemp(ts, temp.id, real));
    return true;
  } catch (e) {
    if (onPr(key)) setThreads(ts => ts.filter(x => x.id !== temp.id));
    toast(`Comment failed: ${errText(e)}`, true);
    return false;
  }
}

export async function reply(threadId: string, body: string): Promise<boolean> {
  if (local && isLocalReview(get())) return (await localWrite(local.reply(threadId, body))) !== undefined;
  const temp = viewerComment(body);
  const key = curKey();
  const patch = (fn: (cs: Comment[]) => Comment[]) => {
    if (onPr(key)) setThreads(ts => ts.map(t => (t.id === threadId ? { ...t, comments: fn(t.comments) } : t)));
  };
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
  if (local && isLocalReview(get())) return (await localWrite(local.edit(id, body))) !== undefined;
  const key = curKey();
  try {
    const real = await writing(() => updateComment(id, body));
    if (onPr(key)) setThreads(ts => ts.map(t => ({ ...t, comments: t.comments.map(c => (c.id === id ? { ...c, ...real } : c)) })));
    return true;
  } catch (e) {
    toast(`Edit failed: ${errText(e)}`, true);
    return false;
  }
}

export async function removeComment(id: string) {
  if (local && isLocalReview(get())) {
    await localWrite(local.remove(id));
    return;
  }
  const ts0 = get().threads;
  const tIdx = ts0.findIndex(t => t.comments.some(c => c.id === id));
  if (tIdx < 0) return;
  const thread = ts0[tIdx];
  const cIdx = thread.comments.findIndex(c => c.id === id);
  const comment = thread.comments[cIdx];
  const key = curKey();
  setThreads(ts => ts
    .map(t => (t.id === thread.id ? { ...t, comments: t.comments.filter(c => c.id !== id) } : t))
    .filter(t => t.comments.length));
  try {
    await writing(() => deleteComment(id));
  } catch (e) {
    if (onPr(key)) setThreads(ts => {
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
  if (local && isLocalReview(get())) {
    await localWrite(local.resolve(threadId, resolved));
    return;
  }
  const key = curKey();
  const flip = (v: boolean) => onPr(key) &&
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
  const key = curKey();
  try {
    await writing(async () => submitReview(await reviewId(), event, body));
    toast('Review submitted');
    if (!onPr(key)) return true;
    set({ pendingReviewId: null });
    void refresh();
    // the submitted review belongs in the conversation; drop fetches that predate it
    convEpoch++;
    void loadConversation();
    return true;
  } catch (e) {
    toast(`Submit failed: ${errText(e)}`, true);
    return false;
  }
}

export async function discard(): Promise<boolean> {
  const id = get().pendingReviewId;
  if (!id) return true;
  const key = curKey();
  try {
    await writing(() => discardReview(id));
    toast('Draft review discarded');
    if (!onPr(key)) return true;
    set({ pendingReviewId: null });
    setThreads(ts => ts
      .map(t => ({ ...t, comments: t.comments.filter(c => c.state !== 'PENDING') }))
      .filter(t => t.comments.length));
    return true;
  } catch (e) {
    toast(`Discard failed: ${errText(e)}`, true);
    return false;
  }
}

// ---------- recent PRs ----------

type RecentPatch = Partial<Omit<RecentPr, 'ref' | 'openedAt'>>;
/** Debounced writes, merged per PR; values are taken when queued (the open PR may change before the write). */
const recentQueue = new Map<string, { ref: ReviewRef; patch: RecentPatch }>();
let recentTimer: ReturnType<typeof setTimeout> | null = null;
function queueRecent(ref: ReviewRef, patch: RecentPatch) {
  const k = prId(ref);
  recentQueue.set(k, { ref, patch: { ...recentQueue.get(k)?.patch, ...patch } });
  recentTimer ??= setTimeout(flushRecent, 300);
}
/** Writes queued recent-PR updates now (Home reads them on mount). */
export function flushRecent() {
  if (recentTimer) clearTimeout(recentTimer);
  recentTimer = null;
  for (const { ref, patch } of recentQueue.values()) updateRecent(ref, patch);
  recentQueue.clear();
}
function recordRecent() {
  const { pr, viewed } = get();
  if (!pr) return;
  queueRecent(pr.ref, {
    title: pr.title, author: pr.author, state: pr.state, isDraft: pr.isDraft, files: pr.changedFiles,
    additions: pr.additions, deletions: pr.deletions, headOid: pr.headOid,
    viewed: pr.files.filter(f => isViewed(viewed[f.path])).length,
  });
}

// ---------- CI checks ----------

let checksSeq = 0;
export async function loadChecks() {
  const ref = get().ref;
  if (!isPr(ref)) return;
  const ls = loadSeq;
  const seq = ++checksSeq;
  try {
    const checks = await fetchChecks(prRef(ref));
    if (ls === loadSeq && seq === checksSeq) set({ checks });
  } catch (e) {
    console.warn('checks unavailable', e);
  }
}
/** Checks for the loaded head commit only. */
export const headChecks = (s: Pick<State, 'checks' | 'pr'>) => (s.checks && s.pr && s.checks.oid === s.pr.headOid ? s.checks : null);

// ---------- conversation (top-level PR comments) ----------
// Same rule as review threads: a fetch that started before a conversation write finished must not replace local state.

let convWrites = 0;
let convEpoch = 0;
let convSeq = 0;
let convAgain = false;
export async function loadConversation() {
  const ref = get().ref;
  if (!isPr(ref)) return;
  const ls = loadSeq;
  const seq = ++convSeq;
  const epoch = convEpoch;
  try {
    const conv = await fetchConversation(prRef(ref));
    if (ls !== loadSeq || seq !== convSeq) return;
    if (convWrites > 0) {
      convAgain = true;
      return;
    }
    // a write finished while this was in flight: fetch again rather than show what predates it
    if (epoch !== convEpoch) {
      void loadConversation();
      return;
    }
    set(s => ({ conv: { ...conv, comments: [...conv.comments, ...(s.conv?.comments.filter(c => c.id.startsWith('tmp-')) ?? [])] } }));
  } catch (e) {
    console.warn('conversation unavailable', e);
  }
}
async function convWriting<T>(fn: () => Promise<T>): Promise<T> {
  convWrites++;
  set(s => ({ busy: s.busy + 1 }));
  try {
    return await fn();
  } finally {
    convWrites--;
    convEpoch++;
    set(s => ({ busy: s.busy - 1 }));
    if (convWrites === 0 && convAgain) {
      convAgain = false;
      void loadConversation();
    }
  }
}
function setIssueComments(fn: (c: IssueComment[]) => IssueComment[]) {
  set(s => (s.conv ? { conv: { ...s.conv, comments: fn(s.conv.comments) } } : {}));
}

/** Posts a top-level PR comment right away (not part of the draft review). */
export async function postComment(body: string): Promise<boolean> {
  const pr = get().pr;
  if (!pr || !get().conv) return false;
  const temp: IssueComment = {
    id: `tmp-${++tmpId}`, body, bodyHTML: '', createdAt: new Date().toISOString(), author: pr.viewer, url: '',
    viewerCanUpdate: false, viewerCanDelete: false,
  };
  setIssueComments(cs => [...cs, temp]);
  const key = curKey();
  try {
    const real = await convWriting(() => addIssueComment(pr.id, body));
    if (onPr(key)) setIssueComments(cs => swapTemp(cs, temp.id, real));
    return true;
  } catch (e) {
    if (onPr(key)) setIssueComments(cs => cs.filter(c => c.id !== temp.id));
    toast(`Comment failed: ${errText(e)}`, true);
    return false;
  }
}

export async function editIssueComment(id: string, body: string): Promise<boolean> {
  const key = curKey();
  try {
    const real = await convWriting(() => updateIssueComment(id, body));
    if (onPr(key)) setIssueComments(cs => cs.map(c => (c.id === id ? real : c)));
    return true;
  } catch (e) {
    toast(`Edit failed: ${errText(e)}`, true);
    return false;
  }
}

export async function removeIssueComment(id: string) {
  const cs0 = get().conv?.comments ?? [];
  const at = cs0.findIndex(c => c.id === id);
  if (at < 0) return;
  const comment = cs0[at];
  const key = curKey();
  setIssueComments(cs => cs.filter(c => c.id !== id));
  try {
    await convWriting(() => deleteIssueComment(id));
  } catch (e) {
    if (onPr(key)) setIssueComments(cs => {
      if (cs.some(c => c.id === id)) return cs;
      const out = [...cs];
      out.splice(Math.min(at, out.length), 0, comment);
      return out;
    });
    toast(`Delete failed: ${errText(e)}`, true);
  }
}
