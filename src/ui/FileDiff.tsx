import { memo, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import type { FileModel, Item, PrFile, Row, Seg, Side, SplitItem, Thread } from '../types.ts';
import { buildModel, lineAnchor, parsePatch, splitPairs, validRange, view, wordDiff, type RangeCheck } from '../lib/diff.ts';
import { anchorStatus, locateThread, quoteRows } from '../lib/anchor.ts';
import { ghRepo } from '../lib/refs.ts';
import {
  ALL, closeComposer, closeOpened, expand, fileHidden, isLocalReview, isUnchanged, isViewed, loadBigDiff, markViewed, openComposer, resetFolds,
  setCollapsed, setFolds, setLocalOutdated, toast, toggleFileHidden, toggleOutline, useStore, type ComposerTarget,
} from './store.ts';
import { Lazy } from './Lazy.tsx';
import { NewComment, ThreadView } from './Thread.tsx';
import { StatusLetter } from './bits.tsx';
import { requestHighlight, useHighlight, type RowToks } from './hl.ts';
import { languageOf, type Tok } from '../lib/languages.ts';
import { outline } from '../lib/outline.ts';
import { foldRanges, type Fold } from '../lib/folds.ts';

const EMPTY: never[] = [];
const CHUNK = 400;
const BIG = 3000;

/** Where a thread renders (its end row), or -1. Local threads re-anchor by their quote; their stored flag is ignored. */
const rowOf = (model: FileModel, t: Thread) => locateThread(model, t.quote?.length ? { ...t, isOutdated: false } : t);

/** The file at the review's head on GitHub, if the review lives there. */
export function githubBlobUrl(pr: { ref: Parameters<typeof ghRepo>[0]; headOid: string }, path: string) {
  const g = ghRepo(pr.ref);
  return g ? `https://github.com/${g.owner}/${g.repo}/blob/${pr.headOid}/${path}` : null;
}

const parsedCache = new WeakMap<PrFile, ReturnType<typeof parsePatch>>();
function parsed(file: PrFile) {
  let p = parsedCache.get(file);
  if (!p) parsedCache.set(file, (p = parsePatch(file.patch ?? '')));
  return p;
}

export const FileBlock = memo(function FileBlock({ file }: { file: PrFile }) {
  const path = file.path;
  const viewed = useStore(s => s.viewed[path]);
  const collapsedOverride = useStore(s => s.collapsed[path]);
  const blob = useStore(s => s.blobs[path]);
  const bigDiff = useStore(s => s.bigDiffs[path]);
  const own = useStore(s => s.threadsByPath[path]);
  const prevName = useStore(s => (file.previousPath ? s.threadsByPath[file.previousPath] : undefined));
  const threads = useMemo(() => (prevName ? [...(own ?? []), ...prevName] : own ?? EMPTY), [own, prevName]);
  const isCurrent = useStore(s => s.current === path);
  const hidden = useStore(s => fileHidden(s, file));
  const pr = useStore(s => s.pr)!;
  const composer = useStore(s => s.composers[path]);
  const outlined = useStore(s => !!s.outline[path]);
  const localReview = useStore(s => isLocalReview(s));
  const [forceBig, setForceBig] = useState(false);
  const ghUrl = githubBlobUrl(pr, path);

  const collapsed = collapsedOverride ?? isViewed(viewed);

  const model: FileModel | null = useMemo(() => {
    if (bigDiff && typeof bigDiff === 'object' && 'rows' in bigDiff) return { rows: bigDiff.rows, complete: true };
    if (!file.patch && !isUnchanged(file)) return null;
    const text = blob && blob !== 'loading' && !blob.binary && !blob.truncated && !blob.missing ? blob.text : null;
    return buildModel(file, parsed(file), text);
    // keyed on content, not the file object: a fresh snapshot of the same revision must keep the model (and its highlighting)
  }, [file.path, file.patch, file.status, blob, bigDiff]);

  const changed = file.additions + file.deletions;
  const unchanged = isUnchanged(file);
  /** per thread: itself if it goes under the header (file-level, outdated, or not placeable yet), else null */
  const { located, flags } = useMemo(() => {
    const flags: Record<string, boolean> = {};
    if (!localReview) return { located: threads.map(t => (t.subjectType === 'FILE' || t.isOutdated || t.line == null ? t : null)), flags };
    const located = threads.map(t => {
      if (t.subjectType === 'FILE' || t.line == null) return t;
      if (!model || !t.quote?.length) return t;
      const st = anchorStatus(model, { ...t, isOutdated: false });
      if (st !== 'unknown') flags[t.id] = st === 'outdated';
      if (st === 'outdated') return t.isOutdated ? t : { ...t, isOutdated: true };
      if (st === 'unknown' || rowOf(model, t) < 0) return t.isOutdated ? { ...t, isOutdated: false } : t;
      return null;
    });
    return { located, flags };
  }, [threads, model, localReview]);
  const fileThreads = located.filter((t): t is Thread => !!t);
  const lineThreads = threads.filter((_, i) => !located[i]);
  useEffect(() => { if (localReview) setLocalOutdated(flags); }, [flags, localReview]);

  let body: ReactNode = null;
  if (!collapsed) {
    if (model && (changed <= BIG || forceBig)) {
      body = <DiffBody file={file} model={model} threads={lineThreads} composer={composer} hlReady={blob !== 'loading'} outlined={outlined} />;
    } else if (model) {
      body = (
        <div className="fnote">
          Large diff ({changed.toLocaleString()} changed lines).{' '}
          <button className="small" onClick={() => setForceBig(true)}>Show diff</button>
        </div>
      );
    } else if (unchanged) {
      body = <div className="fnote">{!blob || blob === 'loading' ? 'Loading…' : blob.missing ? 'Not in the head version.' : blob.binary ? 'Binary file.' : 'Too large to show (over 5 MB).'}</div>;
    } else if (bigDiff === 'loading') {
      body = <div className="fnote">Loading and diffing both versions…</div>;
    } else if (bigDiff && 'error' in bigDiff) {
      body = (
        <div className="fnote">
          Can't show this diff: {bigDiff.error}.{' '}
          {ghUrl && <a href={ghUrl} target="_blank" rel="noreferrer">Open on GitHub ↗</a>}
        </div>
      );
    } else if (file.status === 'renamed' && changed === 0) {
      body = <div className="fnote">Renamed without changes.</div>;
    } else if (changed === 0) {
      body = <div className="fnote">No textual changes (binary file or mode change).</div>;
    } else if (pr.ref.kind === 'paste') {
      body = <div className="fnote">The pasted diff has no text for this file (binary or omitted).</div>;
    } else {
      body = (
        <div className="fnote">
          {localReview ? 'No text diff for this file (too large or binary).' : "GitHub didn't render this diff (too large or binary)."}{' '}
          <button className="small" onClick={() => loadBigDiff(file)}>Load diff</button>
        </div>
      );
    }
  }

  return (
    <section className={`file${collapsed ? ' collapsed' : ''}${isCurrent ? ' current' : ''}`} data-path={path}>
      <header className="fhead">
        <span className="caret" onClick={() => setCollapsed(path, !collapsed)}>{collapsed ? '▸' : '▾'}</span>
        <StatusLetter status={file.status} />
        <span className="path" title={path} onClick={() => setCollapsed(path, !collapsed)}>
          <bdi>{file.previousPath ? `${file.previousPath} → ${path}` : path}</bdi>
        </span>
        {unchanged ? <span className="faint">not changed</span> : (
          <>
            <span className="add mono">+{file.additions}</span>
            <span className="del mono">−{file.deletions}</span>
          </>
        )}
        {viewed === 'DISMISSED' && <span className="chip warn">changed since viewed</span>}
        {hidden && <span className="chip">hidden</span>}
        {threads.length > 0 && <span className="chip" title="threads">💬 {threads.length}</span>}
        {blob === 'loading' && !collapsed && <span className="faint" title="loading full file for context">…</span>}
        <button className={`small${outlined ? ' on' : ''}`} title="Whole file with its blocks folded (z; all files: Z)" onClick={() => toggleOutline(path)}>
          Outline
        </button>
        {(!unchanged || localReview) && (
          <button className="small" title="Comment on file" onClick={() => { setCollapsed(path, false); openComposer(path, { kind: 'file' }); }}>
            Comment
          </button>
        )}
        {!unchanged && (
          <button className="small" title={hidden ? 'Unhide' : 'Hide this file'} onClick={() => toggleFileHidden(file)}>
            {hidden ? 'Unhide' : 'Hide'}
          </button>
        )}
        {ghUrl && <a className="btn small" title="View file at head on GitHub" target="_blank" rel="noreferrer" href={ghUrl}>↗</a>}
        {!unchanged && (
          <label title="Mark viewed (v)">
            <input type="checkbox" checked={isViewed(viewed)} onChange={e => markViewed([path], e.target.checked)} /> Viewed
          </label>
        )}
        {unchanged && threads.length === 0 && <button className="small" title="Close this file" onClick={() => closeOpened(path)}>Close</button>}
      </header>
      {!collapsed && (fileThreads.length > 0 || composer?.kind === 'file') && (
        <div className="file-threads">
          {fileThreads.map(t => <ThreadView key={t.id} thread={t} showLocation />)}
          {composer?.kind === 'file' && (
            <NewComment
              path={path}
              initial={composer.quote}
              target={{ path, body: '', subjectType: 'FILE' }}
              onDone={() => closeComposer(path)}
            />
          )}
        </div>
      )}
      {body}
    </section>
  );
});

interface BodyProps {
  file: PrFile; model: FileModel; threads: Thread[]; composer: ComposerTarget | undefined; hlReady: boolean; outlined: boolean;
}

const NO_FOLDS: Record<number, boolean> = {};
/** an outline leaves shorter blocks open */
const OUTLINE_MIN = 3;

/** Foldable blocks; in an outline, which are folded by default (those not holding other outline sections). */
function useFolds(model: FileModel, path: string, toks: RowToks | undefined, outlined: boolean) {
  const lang = languageOf(path);
  const folds = useMemo(() => {
    if (!model.complete) return [] as Fold[];
    return foldRanges(model.rows, lang, toks && (i => inStringOrComment(model.rows[i], toks, i)));
  }, [model, lang, toks]);
  const containers = useMemo(() => {
    const set = new Set<number>();
    if (!outlined) return set;
    const starts = outline(model.rows, lang, toks && (i => inStringOrComment(model.rows[i], toks, i))).filter(e => !e.top).map(e => e.idx);
    for (const f of folds) {
      let lo = 0, hi = starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= f.start) lo = mid + 1;
        else hi = mid;
      }
      if (lo < starts.length && starts[lo] <= f.end) set.add(f.start);
    }
    return set;
  }, [folds, outlined, model, lang, toks]);
  const overrides = useStore(s => s.folds[path]) ?? NO_FOLDS;
  const isFolded = useMemo(() => (f: Fold) => overrides[f.start] ?? (outlined && f.end - f.start >= OUTLINE_MIN && !containers.has(f.start)), [overrides, outlined, containers]);
  return { folds, isFolded };
}

function DiffBody({ file, model, threads, composer, hlReady, outlined }: BodyProps) {
  const path = file.path;
  const hlOn = useStore(s => s.settings.highlight) && hlReady;
  const toks = useHighlight(model, path, hlOn);
  const { folds, isFolded } = useFolds(model, path, toks, outlined);
  const unchanged = isUnchanged(file);
  // a file outside the diff shows whole, in one column
  const viewMode = useStore(s => (unchanged ? 'unified' : s.settings.viewMode));
  const anyLine = useStore(s => isLocalReview(s));
  const ctxSetting = useStore(s => s.settings.context);
  const stored = useStore(s => s.expansions[path]) ?? EMPTY;
  const context = ctxSetting >= ALL || unchanged || outlined ? Infinity : ctxSetting;

  const byRow = useMemo(() => {
    const m = new Map<number, Thread[]>();
    const orphans: Thread[] = [];
    for (const t of threads) {
      const i = rowOf(model, t);
      if (i < 0) orphans.push(t);
      else {
        const a = m.get(i);
        if (a) a.push(t);
        else m.set(i, [t]);
      }
    }
    return { m, orphans };
  }, [model, threads]);

  const drag = useStore(s => (s.dragSel?.path === path ? s.dragSel : null));
  const lineComposer = useMemo(() => {
    const r = drag ?? (composer?.kind === 'line' ? composer : null);
    return r ? validRange(model, r.a, r.b, anyLine) : null;
  }, [drag, composer, model, anyLine]);
  const sel = lineComposer?.ok ? lineComposer : null;

  const base = useMemo(() => {
    const exp: Array<[number, number]> = [...stored];
    for (const i of byRow.m.keys()) exp.push([i, i]);
    if (sel) exp.push([sel.startIdx, sel.endIdx]);
    return view(model, context, exp);
  }, [model, context, stored, byRow, sel]);

  /** folded blocks whose opener shows; a block holding the comment being written stays open */
  const folded = useMemo(() => {
    const shown = new Uint8Array(model.rows.length);
    for (const it of base) if (it.kind === 'row') shown[it.idx] = 1;
    const out = new Map<number, Fold>();
    let hiddenTo = -1;
    for (const f of folds) {
      if (!shown[f.start] || f.start <= hiddenTo || !isFolded(f)) continue;
      if (sel && sel.endIdx > f.start && sel.startIdx <= f.end) continue;
      out.set(f.start, f);
      hiddenTo = f.end;
    }
    return out;
  }, [base, folds, isFolded, sel, model]);

  const items = useMemo(() => {
    if (!folded.size) return base;
    const hidden = new Uint8Array(model.rows.length);
    for (const f of folded.values()) hidden.fill(1, f.start + 1, f.end + 1);
    return base.filter(it => (it.kind === 'row' ? !hidden[it.idx] : !(it.from >= 0 && hidden[it.from] && hidden[it.to])));
  }, [base, folded, model]);

  const pairs = useMemo(() => splitPairs(items, model.rows), [items, model]);
  const partner = useMemo(() => {
    const p = new Map<number, number>();
    for (const it of pairs) {
      if (it.kind === 'pair' && it.left != null && it.right != null && it.left !== it.right) {
        p.set(it.left, it.right);
        p.set(it.right, it.left);
      }
    }
    return p;
  }, [pairs]);

  const list: Array<Item | SplitItem> = viewMode === 'split' ? pairs : items;
  const chunks: Array<Array<Item | SplitItem>> = [];
  for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));

  const foldAt = useMemo(() => new Map(folds.map(f => [f.start, f])), [folds]);
  const ctx: RowCtx = {
    file, model, byRow: byRow.m, composer: sel, dragging: !!drag, partner, split: viewMode === 'split', toks, hlOn, anyLine,
    readOnly: unchanged && !anyLine, foldAt, folded,
  };

  return (
    <>
      {outlined && <OutlineBar path={path} folds={folds} complete={model.complete} />}
      {lineComposer && !lineComposer.ok && (
        <div className="file-threads">
          <div className="fnote">{lineComposer.reason}</div>
        </div>
      )}
      {byRow.orphans.length > 0 && (
        <div className="file-threads">
          {byRow.orphans.map(t => <ThreadView key={t.id} thread={t} showLocation />)}
        </div>
      )}
      {chunks.map((c, i) => (
        <Lazy key={i} estimate={c.length * 18} eager={i === 0 && list.length < 200}>
          {() => <Chunk items={c} ctx={ctx} />}
        </Lazy>
      ))}
      {list.length === 0 && <div className="fnote">No changes to show.</div>}
    </>
  );
}

function OutlineBar({ path, folds, complete }: { path: string; folds: Fold[]; complete: boolean }) {
  const changed = folds.filter(f => f.add + f.del > 0);
  return (
    <div className="outline-bar">
      <span>Outline</span>
      {complete ? (
        <>
          <button className="link" onClick={() => setFolds(path, Object.fromEntries(changed.map(f => [f.start, false])))}>unfold changed</button>
          <button className="link" onClick={() => setFolds(path, Object.fromEntries(folds.map(f => [f.start, false])))}>unfold all</button>
          <button className="link" onClick={() => resetFolds(path)}>reset</button>
        </>
      ) : <span className="faint">only the changed hunks are loaded, so nothing folds</span>}
    </div>
  );
}

function inStringOrComment(row: Row, toks: RowToks, i: number) {
  const t = (row.kind === 'del' ? toks.a : toks.b)[i];
  let at = 0;
  for (const [n, cls] of t ?? []) {
    if (row.text.slice(at, (at += n)).trim()) return /hljs-(?:string|comment|subst)/.test(cls);
  }
  return false;
}

interface RowCtx {
  file: PrFile;
  model: FileModel;
  byRow: Map<number, Thread[]>;
  composer: Extract<RangeCheck, { ok: true }> | null;
  /** the composer stays closed mid-drag so it can't shift rows under the cursor */
  dragging: boolean;
  partner: Map<number, number>;
  split: boolean;
  toks: RowToks | undefined;
  hlOn: boolean;
  /** local review: every line is commentable */
  anyLine: boolean;
  /** a PR file outside the diff: GitHub takes no comments there */
  readOnly: boolean;
  /** foldable blocks by opener row, and the folded ones */
  foldAt: Map<number, Fold>;
  folded: Map<number, Fold>;
}

function Chunk({ items, ctx }: { items: Array<Item | SplitItem>; ctx: RowCtx }) {
  useEffect(() => {
    if (ctx.hlOn) requestHighlight(ctx.model, ctx.file.path, true);
  }, [ctx.model, ctx.file.path, ctx.hlOn]);
  const out: ReactNode[] = [];
  for (const it of items) {
    if (it.kind === 'gap') {
      out.push(<GapRow key={`g${it.from}:${it.to}:${it.count}`} gap={it} path={ctx.file.path} cols={4} />);
    } else if (it.kind === 'row') {
      out.push(<UnifiedRow key={it.idx} idx={it.idx} ctx={ctx} />);
      pushExtras(out, [it.idx], ctx);
    } else {
      out.push(<SplitRow key={`${it.left}:${it.right}`} left={it.left} right={it.right} ctx={ctx} />);
      const ids = it.left === it.right ? [it.left] : [it.left, it.right];
      pushExtras(out, ids.filter((x): x is number => x != null), ctx);
    }
  }
  return (
    <table className={`diff ${ctx.split ? 'split' : 'unified'}`}>
      {ctx.split ? (
        <colgroup><col className="c-num" /><col /><col className="c-num" /><col /></colgroup>
      ) : (
        <colgroup><col className="c-num" /><col className="c-num" /><col className="c-sign" /><col /></colgroup>
      )}
      <tbody>{out}</tbody>
    </table>
  );
}

function pushExtras(out: ReactNode[], ids: number[], ctx: RowCtx) {
  for (const idx of ids) {
    const f = ctx.folded.get(idx);
    let ts = ctx.byRow.get(idx);
    if (f) {
      // threads on folded lines show under the block's first line
      for (const [i, more] of ctx.byRow) if (i > f.start && i <= f.end) ts = [...(ts ?? []), ...more];
    }
    const isComposer = ctx.composer && !ctx.dragging && ctx.composer.endIdx === idx;
    if (!ts && !isComposer) continue;
    out.push(
      <tr className="inline" key={`x${idx}`}>
        <td colSpan={4}>
          <div className="box">
            {ts?.map(t => <ThreadView key={t.id} thread={t} />)}
            {isComposer && <LineComposer path={ctx.file.path} r={ctx.composer!} model={ctx.model} />}
          </div>
        </td>
      </tr>,
    );
  }
}

function FoldCaret({ idx, ctx }: { idx: number; ctx: RowCtx }) {
  const f = ctx.foldAt.get(idx);
  if (!f) return null;
  const on = ctx.folded.has(idx);
  return (
    <span
      className={`fold${on ? ' on' : ''}`}
      title={on ? 'Unfold' : 'Fold'}
      onMouseDown={e => {
        e.preventDefault();
        e.stopPropagation();
        setFolds(ctx.file.path, { [idx]: !on });
      }}
    >
      {on ? '▸' : '▾'}
    </span>
  );
}

function FoldChip({ idx, ctx }: { idx: number; ctx: RowCtx }) {
  const f = ctx.folded.get(idx);
  if (!f) return null;
  const n = f.end - f.start;
  return (
    <button className="foldchip" onClick={() => setFolds(ctx.file.path, { [idx]: false })} title="Unfold">
      ⋯ {n} line{n === 1 ? '' : 's'}
      {f.add > 0 && <span className="add"> +{f.add}</span>}
      {f.del > 0 && <span className="del"> −{f.del}</span>}
    </button>
  );
}

function LineComposer({ path, r, model }: { path: string; r: Extract<RangeCheck, { ok: true }>; model: FileModel }) {
  const single = r.startIdx === r.endIdx;
  const target = {
    path, body: '', subjectType: 'LINE' as const, line: r.line, side: r.side,
    ...(single ? {} : { startLine: r.startLine, startSide: r.startSide }),
    quote: quoteRows(model, r.startIdx, r.endIdx),
  };
  const sideName = (x: Side) => (x === 'LEFT' ? 'old ' : '');
  const label = single
    ? `${sideName(r.side)}line ${r.line}`
    : `${sideName(r.startSide)}line ${r.startLine} to ${sideName(r.side)}line ${r.line}`;
  return (
    <NewComment
      path={`${path}:${r.startSide}${r.startLine}-${r.side}${r.line}`}
      label={`Comment on ${label}`}
      target={target}
      onDone={() => closeComposer(path)}
    />
  );
}

function onNumDown(e: MouseEvent<HTMLElement>, idx: number, ctx: RowCtx, clicked: Side) {
  if (e.button !== 0 || ctx.readOnly) return;
  if (isUnchanged(ctx.file)) clicked = 'RIGHT';
  e.preventDefault();
  const path = ctx.file.path;
  const row = ctx.model.rows[idx];
  const s = useStore.getState();
  const prev = s.selAnchor;
  const anchor = lineAnchor(row, clicked, ctx.anyLine);
  if (!anchor) {
    const n = clicked === 'LEFT' ? row.oldNo ?? row.newNo : row.newNo ?? row.oldNo;
    const quote = `\`L${n}\`${clicked === 'LEFT' || row.kind === 'del' ? ' (old)' : ''}\n> ${row.text.slice(0, 200)}\n\n`;
    toast('GitHub only accepts line comments inside its diff hunks. Commenting on the file instead.');
    openComposer(path, { kind: 'file', quote });
    useStore.setState({ selAnchor: null });
    return;
  }
  if (e.shiftKey && prev && prev.path === path) {
    const r = validRange(ctx.model, prev.anchor, anchor, ctx.anyLine);
    if (!r.ok) {
      toast(r.reason, true);
      return;
    }
    openComposer(path, { kind: 'line', a: prev.anchor, b: anchor });
    return;
  }
  useStore.setState({ selAnchor: { path, anchor }, dragSel: { path, a: anchor, b: anchor } });
  startDrag(e.currentTarget, ctx.model, ctx.anyLine);
}

/** Cells carry `data-idx` (and `data-side` where the side isn't implied by the row). */
function startDrag(cell: HTMLElement, model: FileModel, anyLine: boolean) {
  const section = cell.closest('section.file');
  const onOver = (ev: globalThis.MouseEvent) => {
    const td = (ev.target as Element).closest?.<HTMLElement>('td[data-idx]');
    const d = useStore.getState().dragSel;
    if (!td || !d || td.closest('section.file') !== section) return;
    const row = model.rows[Number(td.dataset.idx)];
    const b = row && lineAnchor(row, (td.dataset.side as Side | undefined) ?? d.a.side, anyLine);
    if (!b || (b.side === d.b.side && b.line === d.b.line) || !validRange(model, d.a, b, anyLine).ok) return;
    useStore.setState({ dragSel: { ...d, b } });
  };
  const onUp = () => {
    document.removeEventListener('mouseover', onOver);
    window.removeEventListener('mouseup', onUp);
    const d = useStore.getState().dragSel;
    if (!d) return;
    useStore.setState({ dragSel: null });
    openComposer(d.path, { kind: 'line', a: d.a, b: d.b });
  };
  document.addEventListener('mouseover', onOver);
  window.addEventListener('mouseup', onUp);
}

function inSel(ctx: RowCtx, idx: number | null) {
  return idx != null && !!ctx.composer && idx >= ctx.composer.startIdx && idx <= ctx.composer.endIdx;
}

/** `pane`: which file the cell shows; unified rows use the old file only for deletions. */
function Code({ row, idx, ctx, pane }: { row: Row; idx: number; ctx: RowCtx; pane?: 'left' | 'right' }) {
  let segs: Seg[] | null = null;
  const p = ctx.partner.get(idx);
  if (p != null && row.kind !== 'ctx') {
    const other = ctx.model.rows[p];
    const w = row.kind === 'del' ? wordDiff(row.text, other.text) : wordDiff(other.text, row.text);
    if (w) segs = row.kind === 'del' ? w.a : w.b;
    if (segs && segs.reduce((n, x) => n + x.text.length, 0) !== row.text.length) segs = null;
  }
  const side = pane === 'left' || (!pane && row.kind === 'del') ? ctx.toks?.a : ctx.toks?.b;
  let toks = side?.[idx] ?? null;
  if (toks && toks.reduce((n, t) => n + t[0], 0) !== row.text.length) toks = null;
  const content = renderLine(row.text, toks, segs, row.kind === 'del' ? 'del' : 'ins');
  return (
    <>
      {content}
      {row.cr && <span className="faint" title="CRLF line ending">␍</span>}
      {(!pane || (pane === 'right') === (row.kind !== 'del')) && <FoldChip idx={idx} ctx={ctx} />}
    </>
  );
}

const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

const UnifiedRow = memo(function UnifiedRow({ idx, ctx }: { idx: number; ctx: RowCtx }) {
  const row = ctx.model.rows[idx];
  const nc = row.hunk == null && !ctx.anyLine ? ' nc' : '';
  const whole = isUnchanged(ctx.file);
  return (
    <tr className={`${row.kind}${inSel(ctx, idx) ? ' sel' : ''}${row.noEol ? ' noeol' : ''}`}>
      <td className={`num${nc}`} data-idx={idx} data-side={whole ? 'RIGHT' : 'LEFT'} onMouseDown={e => onNumDown(e, idx, ctx, 'LEFT')}>{whole ? '' : row.oldNo ?? ''}</td>
      <td className={`num${nc}`} data-idx={idx} data-side="RIGHT" onMouseDown={e => onNumDown(e, idx, ctx, 'RIGHT')}>{row.newNo ?? ''}</td>
      <td className="sign" data-idx={idx}><FoldCaret idx={idx} ctx={ctx} />{SIGN[row.kind]}</td>
      <td className="code" data-idx={idx}><Code row={row} idx={idx} ctx={ctx} /></td>
    </tr>
  );
});

const SplitRow = memo(function SplitRow({ left, right, ctx }: { left: number | null; right: number | null; ctx: RowCtx }) {
  const L = left != null ? ctx.model.rows[left] : null;
  const R = right != null ? ctx.model.rows[right] : null;
  const sel = inSel(ctx, left) || inSel(ctx, right);
  const half = (row: Row | null, idx: number | null, no: number | undefined, isRight: boolean) => {
    if (!row || idx == null) return [<td key="n" className="num empty" />, <td key="c" className="code empty" />];
    const k = row.kind === 'ctx' ? '' : row.kind;
    const nc = row.hunk == null && !ctx.anyLine ? ' nc' : '';
    const noeol = row.noEol && (row.kind !== 'ctx' || isRight) ? ' noeol-c' : '';
    const side = isRight ? 'RIGHT' : 'LEFT';
    return [
      <td key="n" className={`num ${k}${nc}`} data-idx={idx} data-side={side} onMouseDown={e => onNumDown(e, idx, ctx, side)}>
        {no ?? ''}
        {isRight === (row.kind !== 'del') && <FoldCaret idx={idx} ctx={ctx} />}
      </td>,
      <td key="c" className={`code ${k}${noeol}`} data-idx={idx} data-side={side}><Code row={row} idx={idx} ctx={ctx} pane={isRight ? 'right' : 'left'} /></td>,
    ];
  };
  return (
    <tr className={sel ? 'sel' : undefined}>
      {half(L, left, L?.oldNo, false)}
      {half(R, right, R?.newNo, true)}
    </tr>
  );
});

function GapRow({ gap, path, cols }: { gap: Extract<Item, { kind: 'gap' }>; path: string; cols: number }) {
  const n = gap.count;
  return (
    <tr className="gap">
      <td colSpan={cols}>
        <div className="gapbtns">
          {gap.expandable ? (
            <>
              <span>↕ {n} hidden line{n === 1 ? '' : 's'}</span>
              {n > 20 && <button className="link" onClick={() => expand(path, gap.from, gap.from + 19)}>↓ 20</button>}
              {n > 20 && <button className="link" onClick={() => expand(path, gap.to - 19, gap.to)}>↑ 20</button>}
              <button className="link" onClick={() => expand(path, gap.from, gap.to)}>show all</button>
            </>
          ) : (
            <span>⋯ {n > 0 ? `${n} unchanged line${n === 1 ? '' : 's'}` : 'unchanged lines'}</span>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Syntax tokens intersected with word-diff segments: changed runs wrap the token spans they cover. */
function renderLine(text: string, toks: Tok[] | null, segs: Seg[] | null, Tag: 'ins' | 'del'): ReactNode {
  if (!toks) return segs ? segs.map((s, i) => (s.changed ? <Tag key={i}>{s.text}</Tag> : s.text)) : text;
  const span = (from: number, to: number, cls: string, key: number) =>
    cls ? <span key={key} className={cls}>{text.slice(from, to)}</span> : text.slice(from, to);
  if (!segs) {
    let at = 0;
    return toks.map(([n, cls], i) => span(at, (at += n), cls, i));
  }
  const out: ReactNode[] = [];
  let ti = 0, tEnd = toks[0]?.[0] ?? 0, at = 0, key = 0;
  for (const seg of segs) {
    const segEnd = at + seg.text.length;
    const parts: ReactNode[] = [];
    while (at < segEnd) {
      while (tEnd <= at && ti < toks.length - 1) tEnd += toks[++ti][0];
      const to = Math.min(segEnd, tEnd);
      parts.push(span(at, to, toks[ti][1], key++));
      at = to;
    }
    if (seg.changed) out.push(<Tag key={key++}>{parts}</Tag>);
    else out.push(...parts);
  }
  return out;
}
