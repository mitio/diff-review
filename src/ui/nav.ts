import { isViewed, markViewed, setCollapsed, streamFiles, useStore } from './store.ts';

export const mainEl = () => document.querySelector<HTMLElement>('.main');
const fileEl = (path: string) => mainEl()?.querySelector<HTMLElement>(`.file[data-path="${CSS.escape(path)}"]`) ?? null;

let spyLock = 0;

export function scrollToFile(path: string) {
  const main = mainEl();
  const el = fileEl(path);
  if (!main || !el) return;
  spyLock = performance.now() + 150;
  main.scrollTop = el.offsetTop - 8;
  useStore.setState({ current: path });
}

export function goToFile(path: string, expandIt = true) {
  const s = useStore.getState();
  if (expandIt && s.collapsed[path] !== false && isViewed(s.viewed[path])) setCollapsed(path, false);
  if (s.tab !== 'diff') useStore.setState({ tab: 'diff' });
  requestAnimationFrame(() => scrollToFile(path));
}

export function stepFile(dir: 1 | -1) {
  const s = useStore.getState();
  const files = streamFiles(s);
  if (!files.length) return;
  const i = files.findIndex(f => f.path === s.current);
  const next = files[Math.min(files.length - 1, Math.max(0, i < 0 ? 0 : i + dir))];
  if (s.tab !== 'diff') useStore.setState({ tab: 'diff' });
  requestAnimationFrame(() => scrollToFile(next.path));
}

export function toggleViewedCurrent() {
  const s = useStore.getState();
  const cur = s.current;
  if (!cur) return;
  const nowViewed = !isViewed(s.viewed[cur]);
  markViewed([cur], nowViewed);
  if (!nowViewed) return;
  const files = streamFiles(useStore.getState());
  const i = files.findIndex(f => f.path === cur);
  const after = [...files.slice(i + 1), ...files.slice(0, i)];
  const next = after.find(f => !isViewed(useStore.getState().viewed[f.path]));
  requestAnimationFrame(() => scrollToFile(next?.path ?? cur));
}

/** scroll spy: the file whose block covers the top of the pane */
export function onMainScroll() {
  if (performance.now() < spyLock) return;
  const main = mainEl();
  if (!main) return;
  const blocks = main.querySelectorAll<HTMLElement>('.file');
  const y = main.scrollTop + 40;
  let lo = 0, hi = blocks.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].offsetTop <= y) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const path = found >= 0 ? blocks[found].dataset.path ?? null : blocks[0]?.dataset.path ?? null;
  if (path && path !== useStore.getState().current) useStore.setState({ current: path });
}
