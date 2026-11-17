import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PrFile } from '../types.ts';
import { fuzzyFind } from '../lib/fuzzy.ts';
import { loadTree, openedFiles, useStore } from './store.ts';
import { StatusLetter } from './bits.tsx';
import { openFile } from './nav.ts';

const LIMIT = 50;

export function openFinder() {
  const s = useStore.getState();
  if (!s.pr) return;
  useStore.setState({ finder: true });
  void loadTree();
}

export function Finder() {
  const open = useStore(s => s.finder);
  return open ? <FinderPanel /> : null;
}

function FinderPanel() {
  const pr = useStore(s => s.pr)!;
  const tree = useStore(s => s.tree);
  const opened = useStore(s => s.opened);
  const threadsByPath = useStore(s => s.threadsByPath);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ finder: false });

  const listed = tree && tree !== 'loading' && 'paths' in tree ? tree : null;
  const byPath = useMemo(() => new Map<string, PrFile>(pr.files.map(f => [f.path, f])), [pr]);
  const paths = useMemo(() => {
    if (listed) return listed.paths;
    // until the listing arrives (or if it failed): the diff's files and the opened ones
    return [...new Set([...pr.files.filter(f => f.status !== 'removed').map(f => f.path), ...opened])];
  }, [listed, pr, opened]);
  const results = useMemo(() => {
    if (q.trim()) return fuzzyFind(paths, q, LIMIT);
    const first = [...pr.files.filter(f => f.status !== 'removed').map(f => f.path), ...openedFiles({ opened }).map(f => f.path)];
    return first.slice(0, LIMIT).map(path => ({ path, score: 0, hits: [] as number[] }));
  }, [paths, q, pr, opened]);

  useEffect(() => setSel(0), [q]);
  // a new revision drops the listing; list it again while the finder is open
  useEffect(() => { if (tree === null) void loadTree(); }, [tree]);
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const pick = (path: string | undefined) => {
    if (!path) return;
    close();
    openFile(path);
  };

  let note: ReactNode = null;
  if (tree === 'loading') note = 'Listing all files…';
  else if (tree && 'error' in tree) note = `Couldn't list all files (${tree.error}); showing the diff's files.`;
  else if (pr.ref.kind === 'paste') note = 'A pasted diff has only its own files.';
  else if (listed?.truncated) note = `GitHub listed only ${listed.paths.length.toLocaleString()} files of this tree.`;

  return (
    <div className="help finder" onMouseDown={close}>
      <div className="card" onMouseDown={e => e.stopPropagation()}>
        <input
          autoFocus
          type="text"
          placeholder={`Go to file (${paths.length.toLocaleString()} files)`}
          value={q}
          data-1p-ignore
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
            const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
            if (down || up) {
              e.preventDefault();
              setSel(i => Math.max(0, Math.min(results.length - 1, i + (down ? 1 : -1))));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(results[sel]?.path);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        {note && <div className="faint fnote">{note}</div>}
        <div className="results" ref={listRef}>
          {results.map((r, i) => {
            const f = byPath.get(r.path);
            const n = threadsByPath[r.path]?.length ?? 0;
            return (
              <div key={r.path} className={`frow${i === sel ? ' sel' : ''}`} onMouseMove={() => setSel(i)} onClick={() => pick(r.path)}>
                <StatusLetter status={f?.status ?? 'unchanged'} />
                <span className="fname" title={r.path}>{highlight(r.path, r.hits)}</span>
                {n > 0 && <span className="count">💬{n}</span>}
                {f && <span className="add mono">+{f.additions}</span>}
                {f && <span className="del mono">−{f.deletions}</span>}
              </div>
            );
          })}
          {q.trim() && results.length === 0 && <div className="fnote">No file matches.</div>}
          {results.length === LIMIT && <div className="fnote faint">Showing the first {LIMIT}; type more to narrow.</div>}
        </div>
      </div>
    </div>
  );
}

function highlight(path: string, hits: number[]): ReactNode {
  if (!hits.length) return path;
  const set = new Set(hits);
  const out: ReactNode[] = [];
  let run = '', on = false;
  const flush = () => {
    if (run) out.push(on ? <b key={out.length}>{run}</b> : run);
    run = '';
  };
  for (let i = 0; i < path.length; i++) {
    if (set.has(i) !== on) {
      flush();
      on = !on;
    }
    run += path[i];
  }
  flush();
  return out;
}
