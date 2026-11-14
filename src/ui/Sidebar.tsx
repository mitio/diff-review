import { memo, useMemo, useState, type ReactNode } from 'react';
import type { PrFile, TreeNode } from '../types.ts';
import { buildTree, categorize, CATEGORIES, CATEGORY_LABELS } from '../lib/categorize.ts';
import {
  addRule, fileHidden, isViewed, markViewed, matchesFilter, matchesFocus, toggleFileHidden, updateSettings, useStore,
  type Grouping,
} from './store.ts';
import { MiniBar, StatusLetter } from './bits.tsx';
import { goToFile } from './nav.ts';

export function Sidebar() {
  const pr = useStore(s => s.pr)!;
  const grouping = useStore(s => s.settings.grouping);
  const showHidden = useStore(s => s.settings.showHidden);
  const filter = useStore(s => s.filter);
  const focus = useStore(s => s.focus);
  const repoRules = useStore(s => s.repoRules);
  const prRules = useStore(s => s.prRules);
  const width = useStore(s => s.settings.sidebarWidth);

  const files = useMemo(() => {
    const rs = { repoRules, prRules };
    return pr.files.filter(f => (showHidden || !fileHidden(rs, f)) && matchesFilter(filter, f) && matchesFocus(focus, f));
  }, [pr, showHidden, filter, focus, repoRules, prRules]);
  const max = useMemo(() => Math.max(1, ...pr.files.map(f => f.additions + f.deletions)), [pr]);
  const hiddenCount = useMemo(() => pr.files.filter(f => fileHidden({ repoRules, prRules }, f)).length, [pr, repoRules, prRules]);

  let list: ReactNode;
  if (grouping === 'flat') {
    list = files.map(f => <FileRow key={f.path} f={f} max={max} depth={0} label={f.path} />);
  } else if (grouping === 'category') {
    list = CATEGORIES.map(c => {
      const fs = files.filter(f => categorize(f.path) === c);
      if (!fs.length) return null;
      return (
        <Group key={c} label={CATEGORY_LABELS[c]} files={fs} depth={0} dot={c} onHide={() => addRule({ kind: 'category', category: c })}>
          {fs.map(f => <FileRow key={f.path} f={f} max={max} depth={1} label={f.path} />)}
        </Group>
      );
    });
  } else {
    const tree = buildTree(files);
    list = tree.children.map(n => <TreeItem key={n.path} node={n} depth={0} max={max} />);
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="tools">
        <input
          id="file-filter"
          type="text"
          placeholder="Filter files  /"
          value={filter}
          data-1p-ignore
          onChange={e => useStore.setState({ filter: e.target.value })}
          onKeyDown={e => { if (e.key === 'Escape') { useStore.setState({ filter: '' }); (e.target as HTMLElement).blur(); } }}
        />
        <select value={grouping} onChange={e => updateSettings({ grouping: e.target.value as Grouping })} title="Group files">
          <option value="tree">Tree</option>
          <option value="category">Category</option>
          <option value="flat">Flat</option>
        </select>
        <label className="muted" title="Show hidden files" style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontSize: 12 }}>
          <input type="checkbox" checked={showHidden} onChange={e => updateSettings({ showHidden: e.target.checked })} />
          hidden{hiddenCount ? ` (${hiddenCount})` : ''}
        </label>
      </div>
      {focus && (
        <div className="tools">
          <span className="chip">only: {focus.key}</span>
          <button className="small" onClick={() => useStore.setState({ focus: null })}>clear</button>
        </div>
      )}
      <div className="list">{list}</div>
      <Resizer />
    </aside>
  );
}

function Resizer() {
  return (
    <div
      className="resizer"
      onPointerDown={e => {
        const startX = e.clientX;
        const startW = useStore.getState().settings.sidebarWidth;
        const move = (ev: PointerEvent) => {
          const w = Math.min(700, Math.max(180, startW + ev.clientX - startX));
          useStore.setState(s => ({ settings: { ...s.settings, sidebarWidth: w } }));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          updateSettings({});
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

function collectFiles(n: TreeNode, out: PrFile[] = []) {
  if (n.file) out.push(n.file);
  for (const c of n.children) collectFiles(c, out);
  return out;
}

function TreeItem({ node, depth, max }: { node: TreeNode; depth: number; max: number }) {
  if (node.file) return <FileRow f={node.file} max={max} depth={depth} label={node.name} />;
  const files = collectFiles(node);
  return (
    <Group label={node.name} files={files} depth={depth} onHide={() => addRule({ kind: 'glob', pattern: `${node.path}/**` })}>
      {node.children.map(c => <TreeItem key={c.path} node={c} depth={depth + 1} max={max} />)}
    </Group>
  );
}

function Group({ label, files, depth, children, dot, onHide }: {
  label: string; files: PrFile[]; depth: number; children: ReactNode; dot?: string; onHide: () => void;
}) {
  const [open, setOpen] = useState(true);
  const viewed = useStore(s => files.reduce((n, f) => n + (isViewed(s.viewed[f.path]) ? 1 : 0), 0));
  const all = viewed === files.length;
  return (
    <>
      <div className="frow grow" style={{ paddingLeft: 4 + depth * 12 }} onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <input
          type="checkbox"
          checked={all}
          ref={el => { if (el) el.indeterminate = viewed > 0 && !all; }}
          onClick={e => e.stopPropagation()}
          onChange={() => markViewed(files.map(f => f.path), !all)}
          title={all ? 'Mark all unviewed' : 'Mark all viewed'}
        />
        {dot && <span className="catdot" style={{ background: `var(--cat-${dot})` }} />}
        <span className="fname" title={label}>{label}</span>
        <span className="count">{viewed}/{files.length}</span>
        <button className="link small hide-link" title="Hide this group" onClick={e => { e.stopPropagation(); onHide(); }}>hide</button>
      </div>
      {open && children}
    </>
  );
}

const FileRow = memo(function FileRow({ f, max, depth, label }: { f: PrFile; max: number; depth: number; label: string }) {
  const v = useStore(s => s.viewed[f.path]);
  const current = useStore(s => s.current === f.path);
  const hidden = useStore(s => fileHidden(s, f));
  const nThreads = useStore(s => s.threadsByPath[f.path]?.length ?? 0);
  return (
    <div
      className={`frow${current ? ' current' : ''}${hidden ? ' hidden-file' : ''}${isViewed(v) ? ' viewed' : ''}`}
      style={{ paddingLeft: 18 + depth * 12 }}
      onClick={() => goToFile(f.path)}
      onAuxClick={e => { if (e.button === 1) toggleFileHidden(f); }}
      title={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}
    >
      <input
        type="checkbox"
        checked={isViewed(v)}
        onClick={e => e.stopPropagation()}
        onChange={e => markViewed([f.path], e.target.checked)}
      />
      <StatusLetter status={f.status} />
      <span className="fname">{label}</span>
      {v === 'DISMISSED' && <span className="warn" title="changed since viewed" style={{ color: 'var(--warn-fg)' }}>●</span>}
      {nThreads > 0 && <span className="count">💬{nThreads}</span>}
      <MiniBar a={f.additions} d={f.deletions} max={max} />
    </div>
  );
});
