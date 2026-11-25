import { useEffect } from 'react';
import { isPr } from '../lib/refs.ts';
import {
  ALL, expandedAll, isLocalReview, isViewed, openComposer, refresh, setCollapsed, setCollapsedMany, setExpandedAll, setOutline, streamFiles, toast, updateSettings,
  useStore, type State, type Tab,
} from './store.ts';
import { mainEl, stepFile, toggleViewedCurrent } from './nav.ts';
import { openFinder } from './Finder.tsx';

export const CONTEXTS = [0, 3, 5, 10, 15, 25, ALL];

/** Views in `m` order; Conversation only exists for PRs. */
export function cycleTab(tab: Tab, dir: 1 | -1, conversation: boolean): Tab {
  const tabs: Tab[] = conversation ? ['diff', 'overview', 'conversation'] : ['diff', 'overview'];
  const i = Math.max(0, tabs.indexOf(tab));
  return tabs[(i + dir + tabs.length) % tabs.length];
}

export function toggleSidebar() {
  updateSettings({ sidebar: !useStore.getState().settings.sidebar });
}

/** The current file, or with `all` every listed file; flips them all one way, like GitHub's "collapse all". */
function scope(s: State, all: boolean) {
  useStore.setState({ tab: 'diff' });
  return all ? streamFiles(s).map(f => f.path) : s.current ? [s.current] : [];
}

function collapse(s: State, all: boolean) {
  const paths = scope(s, all);
  const collapsed = (p: string) => s.collapsed[p] ?? isViewed(s.viewed[p]);
  setCollapsedMany(paths, !paths.every(collapsed));
}

function expandLines(s: State, all: boolean) {
  const paths = scope(s, all);
  setExpandedAll(paths, !paths.every(p => expandedAll(s, p)));
}

function outline(s: State, all: boolean) {
  const paths = scope(s, all);
  setOutline(paths, !paths.every(p => s.outline[p]));
}

function commentOnFile(s: State) {
  if (!s.current) return;
  if (!isLocalReview(s) && !s.pr?.files.some(f => f.path === s.current)) return toast("GitHub takes comments only on the PR's files.");
  useStore.setState({ tab: 'diff' });
  setCollapsed(s.current, false);
  openComposer(s.current, { kind: 'file' });
}

function stepContext(s: State, dir: 1 | -1) {
  const i = CONTEXTS.indexOf(s.settings.context);
  updateSettings({ context: CONTEXTS[Math.min(CONTEXTS.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir))] });
}

/** Scrolls the open view (diff, or the Overview / Conversation overlay) whatever has focus. */
function scroll(by: 'line' | 'half' | 'page' | 'end', dir: 1 | -1) {
  const el = document.querySelector<HTMLElement>('.overlay') ?? mainEl();
  if (!el) return;
  if (by === 'end') return el.scrollTo({ top: dir > 0 ? el.scrollHeight : 0 });
  const px = by === 'line' ? 60 : by === 'half' ? el.clientHeight / 2 : el.clientHeight * 0.9;
  el.scrollBy({ top: dir * px, behavior: by === 'line' ? 'auto' : 'smooth' });
}

interface Shortcut {
  /** `e.key` values; a second key does the reverse, or the all-files version, and runs with `alt`. */
  keys: [string] | [string, string];
  label: string;
  /** Absent for keys handled where they apply (⌘↵ in comment boxes). */
  run?: (s: State, alt: boolean) => void;
}

/** The single source for the key handler, the help dialog and tooltips. */
export const SHORTCUTS = [
  {
    group: 'Navigate',
    items: {
      step: { keys: ['j', 'k'], label: 'next / previous file', run: (_, alt) => stepFile(alt ? -1 : 1) },
      finder: { keys: ['t'], label: 'go to any file', run: () => openFinder() },
      filter: {
        keys: ['/'], label: 'filter the file list', run: s => {
          if (!s.settings.sidebar) updateSettings({ sidebar: true });
          requestAnimationFrame(() => document.getElementById('file-filter')?.focus());
        },
      },
    },
  },
  {
    group: 'Scroll',
    items: {
      line: { keys: ['ArrowDown', 'ArrowUp'], label: 'down / up', run: (_, alt) => scroll('line', alt ? -1 : 1) },
      page: { keys: [' ', 'Shift+ '], label: 'page down / up (also PageDown / PageUp)', run: (_, alt) => scroll('page', alt ? -1 : 1) },
      half: { keys: ['J', 'K'], label: 'half a page down / up', run: (_, alt) => scroll('half', alt ? -1 : 1) },
      ends: { keys: ['g', 'G'], label: 'top / bottom (also Home / End)', run: (_, alt) => scroll('end', alt ? 1 : -1) },
    },
  },
  {
    group: 'Views',
    items: {
      view: { keys: ['m', 'M'], label: 'next / previous view: Diff → Overview → Conversation', run: (s, alt) => useStore.setState({ tab: cycleTab(s.tab, alt ? -1 : 1, isPr(s.ref)) }) },
      back: { keys: ['Escape'], label: 'back to Diff; close help', run: s => useStore.setState(s.help ? { help: false } : { tab: 'diff' }) },
    },
  },
  {
    group: 'Files (with Shift: all files)',
    items: {
      viewed: { keys: ['v'], label: 'viewed on / off, then jump to the next unviewed', run: () => toggleViewedCurrent() },
      collapse: { keys: ['x', 'X'], label: 'collapse / expand', run: collapse },
      expand: { keys: ['e', 'E'], label: 'expand all lines / collapse them again', run: expandLines },
      outline: { keys: ['z', 'Z'], label: 'outline: fold to the file’s blocks', run: outline },
      comment: { keys: ['c'], label: 'comment on the file', run: commentOnFile },
    },
  },
  {
    group: 'Display',
    items: {
      split: { keys: ['s'], label: 'unified / split', run: s => updateSettings({ viewMode: s.settings.viewMode === 'split' ? 'unified' : 'split' }) },
      context: { keys: ['[', ']'], label: 'less / more context', run: (s, alt) => stepContext(s, alt ? 1 : -1) },
      font: { keys: ['-', '='], label: 'smaller / larger font', run: (s, alt) => updateSettings({ fontSize: Math.min(18, Math.max(9, s.settings.fontSize + (alt ? 1 : -1))) }) },
      highlight: { keys: ['h'], label: 'syntax highlighting on / off', run: s => updateSettings({ highlight: !s.settings.highlight }) },
      sidebar: { keys: ['b'], label: 'file list on / off', run: () => toggleSidebar() },
    },
  },
  {
    group: 'Other',
    items: {
      refresh: { keys: ['r'], label: 'refresh comments and viewed state', run: () => void refresh(true) },
      submit: { keys: ['f'], label: 'finish the review (local: export the comments)', run: s => useStore.setState({ submitOpen: !s.submitOpen }) },
      send: { keys: ['⌘↵'], label: 'send the comment or review being written' },
      help: { keys: ['?'], label: 'this help', run: s => useStore.setState({ help: !s.help }) },
    },
  },
] as const satisfies ReadonlyArray<{ group: string; items: Record<string, Shortcut> }>;

type IdsOf<G> = G extends { items: infer I } ? keyof I & string : never;
export type ShortcutId = IdsOf<(typeof SHORTCUTS)[number]>;
const ITEMS: Record<string, Shortcut> = Object.fromEntries(SHORTCUTS.flatMap(g => Object.entries(g.items)));

/** How help and tooltips write a shortcut, e.g. `x / X`. */
const SHOWN: Record<string, string> = { Escape: 'Esc', ArrowDown: '↓', ArrowUp: '↑', ' ': 'Space', 'Shift+ ': '⇧Space' };

export function kbd(id: ShortcutId): string {
  return ITEMS[id].keys.map(k => SHOWN[k] ?? k).join(' / ');
}

const BY_KEY = new Map<string, (s: State) => void>();
for (const sc of Object.values(ITEMS)) {
  const run = sc.run;
  if (run) sc.keys.forEach((k, n) => BY_KEY.set(k, s => run(s, n > 0)));
}
for (const [alias, key] of Object.entries({ '+': '=', PageDown: ' ', PageUp: 'Shift+ ', Home: 'g', End: 'G' })) BY_KEY.set(alias, BY_KEY.get(key)!);

/** Where a scroll key belongs to the focused control or popup instead of the view. */
const OWNS: Record<string, string> = { ' ': 'input, button, select, a, summary, .popover, .help' };
for (const k of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']) OWNS[k] = 'input[type=radio], select, .popover, .help';

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);
function typesText(t: HTMLElement) {
  if (t instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(t.type);
  return !!t.closest('textarea, select, [contenteditable]');
}

export function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (typesText(t) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (OWNS[e.key] && (t.closest?.(OWNS[e.key]) || useStore.getState().help)) return;
      const run = BY_KEY.get(e.key === ' ' && e.shiftKey ? 'Shift+ ' : e.key);
      if (!run) return;
      e.preventDefault();
      run(useStore.getState());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
