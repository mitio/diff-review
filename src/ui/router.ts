import { create } from 'zustand';
import type { Category, PrRef } from '../types.ts';
import { CATEGORIES } from '../lib/categorize.ts';
import { parsePrUrl } from '../lib/github.ts';
import { streamFiles, useStore, type Focus, type Tab } from './store.ts';

/** Everything the URL captures. Global preferences (split/unified, context, font) are deliberately not part of it. */
export interface Route { ref: PrRef | null; tab: Tab; focus: Focus; q: string; file: string | null }

const TABS: Tab[] = ['diff', 'overview', 'conversation'];

export function parseRoute(pathname: string, search: string): Route {
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(overview|conversation))?\/?$/.exec(pathname);
  const ref = m ? parsePrUrl(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}/pull/${m[3]}`) : null;
  const p = new URLSearchParams(search);
  let focus: Focus = null;
  const only = p.get('only') ?? '';
  const cat = /^cat:(.+)$/.exec(only);
  const dir = /^dir:(\d+):(.+)$/.exec(only);
  if (cat && (CATEGORIES as string[]).includes(cat[1])) focus = { kind: 'category', key: cat[1] as Category };
  else if (dir) focus = { kind: 'folder', depth: Number(dir[1]), key: dir[2] };
  return { ref, tab: (m?.[4] as Tab | undefined) ?? 'diff', focus, q: p.get('q') ?? '', file: p.get('file') || null };
}

export function routeUrl(r: Route): string {
  if (!r.ref) return '/';
  const path = `/${r.ref.owner}/${r.ref.repo}/pull/${r.ref.number}${r.tab === 'diff' ? '' : `/${r.tab}`}`;
  const p = new URLSearchParams();
  if (r.focus) p.set('only', r.focus.kind === 'category' ? `cat:${r.focus.key}` : `dir:${r.focus.depth}:${r.focus.key}`);
  if (r.q) p.set('q', r.q);
  if (r.file && r.tab === 'diff') p.set('file', r.file);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The part of the URL that gets its own history entry when it changes. */
const major = (r: Route) => routeUrl({ ...r, q: '', file: null });

/** Which PR (or Home) is on screen. */
export const useRoute = create<{ ref: PrRef | null }>(() => ({ ref: null }));

export const sameRef = (a: PrRef | null, b: PrRef | null) =>
  a === b || (!!a && !!b && a.owner === b.owner && a.repo === b.repo && a.number === b.number);

let lastMajor = '';
let fileIntent = false;
let replaceTimer: ReturnType<typeof setTimeout> | null = null;
/** the newest URL for the current entry, not yet written (replaceState is throttled) */
let pendingReplace: string | null = null;

function flushReplace() {
  if (replaceTimer) clearTimeout(replaceTimer);
  replaceTimer = null;
  if (pendingReplace && pendingReplace !== location.pathname + location.search) history.replaceState(null, '', pendingReplace);
  pendingReplace = null;
}

function apply(r: Route) {
  lastMajor = major(r);
  const s = useStore.getState();
  const prChanged = !sameRef(useRoute.getState().ref, r.ref);
  if (prChanged) useRoute.setState({ ref: r.ref });
  if (!r.ref) return;
  // a restored entry replaces any earlier jump target and reveal
  useStore.setState({
    tab: r.tab, focus: r.focus, filter: r.q, reveal: null,
    pendingFile: r.file && (prChanged || r.file !== s.current) ? r.file : null,
  });
  // the entry's file may need revealing again under the restored filters
  const now = useStore.getState();
  if (r.file && !now.pendingFile && now.pr && !streamFiles(now).some(f => f.path === r.file)) useStore.setState({ pendingFile: r.file });
}

function currentRoute(): Route | null {
  const ref = useRoute.getState().ref;
  const s = useStore.getState();
  if (!ref || !sameRef(s.ref, ref)) return null;
  return { ref, tab: s.tab, focus: s.focus, q: s.filter, file: s.pendingFile ?? s.current };
}

function sync() {
  const r = currentRoute();
  if (!r) return;
  const url = routeUrl(r);
  const m = major(r);
  if (m !== lastMajor || fileIntent) {
    if (url === (pendingReplace ?? location.pathname + location.search)) return;
    // the entry being left keeps its latest state
    flushReplace();
    fileIntent = false;
    lastMajor = m;
    history.pushState(null, '', url);
    return;
  }
  if (url === (pendingReplace ?? location.pathname + location.search)) return;
  // filter typing and the scroll spy change the URL constantly; keep it current without flooding history
  pendingReplace = url;
  replaceTimer ??= setTimeout(flushReplace, 250);
}

/** The next file change gets its own history entry (a click on a file, not scrolling). */
export function markFileIntent() {
  fileIntent = true;
}

export function navigate(url: string) {
  flushReplace();
  history.pushState(null, '', url);
  apply(parseRoute(location.pathname, location.search));
}

export function startRouter() {
  apply(parseRoute(location.pathname, location.search));
  addEventListener('popstate', () => {
    // the browser already switched entries; an unwritten replacement would land on the wrong one
    if (replaceTimer) clearTimeout(replaceTimer);
    replaceTimer = null;
    pendingReplace = null;
    fileIntent = false;
    apply(parseRoute(location.pathname, location.search));
  });
  useStore.subscribe(sync);
}

/** Same-origin link that navigates without a page load (modifier clicks still open a new tab). */
export function onLinkClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void; currentTarget: EventTarget }) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate((e.currentTarget as HTMLAnchorElement).getAttribute('href')!);
}
