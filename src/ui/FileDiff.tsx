import { memo, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import type { FileModel, Item, PrFile, Row, Seg, Side, SplitItem, Thread } from '../types.ts';
import { buildModel, lineAnchor, parsePatch, splitPairs, threadRowIndex, validRange, view, wordDiff, type RangeCheck } from '../lib/diff.ts';
import {
  ALL, closeComposer, expand, fileHidden, isViewed, loadBigDiff, markViewed, openComposer, setCollapsed,
  toast, toggleFileHidden, useStore, type ComposerTarget,
} from './store.ts';
import { Lazy } from './Lazy.tsx';
import { NewComment, ThreadView } from './Thread.tsx';
import { StatusLetter } from './bits.tsx';
import { requestHighlight, useHighlight, type RowToks } from './hl.ts';
import type { Tok } from '../lib/languages.ts';

const EMPTY: never[] = [];
const CHUNK = 400;
const BIG = 3000;

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
  const [forceBig, setForceBig] = useState(false);

  const collapsed = collapsedOverride ?? isViewed(viewed);

  const model: FileModel | null = useMemo(() => {
    if (bigDiff && typeof bigDiff === 'object' && 'rows' in bigDiff) return { rows: bigDiff.rows, complete: true };
    if (!file.patch) return null;
    const text = blob && blob !== 'loading' && !blob.binary && !blob.truncated && !blob.missing ? blob.text : null;
    return buildModel(file, parsed(file), text);
    // keyed on content, not the file object: a fresh snapshot of the same revision must keep the model (and its highlighting)
  }, [file.path, file.patch, file.status, blob, bigDiff]);

  const changed = file.additions + file.deletions;
  const fileThreads = threads.filter(t => t.subjectType === 'FILE' || t.isOutdated || t.line == null);
  const lineThreads = threads.filter(t => !fileThreads.includes(t));

  let body: ReactNode = null;
  if (!collapsed) {
    if (model && (changed <= BIG || forceBig)) {
      body = <DiffBody file={file} model={model} threads={lineThreads} composer={composer} hlReady={blob !== 'loading'} />;
    } else if (model) {
      body = (
        <div className="fnote">
          Large diff ({changed.toLocaleString()} changed lines).{' '}
          <button className="small" onClick={() => setForceBig(true)}>Show diff</button>
        </div>
      );
    } else if (bigDiff === 'loading') {
      body = <div className="fnote">Loading and diffing both versions…</div>;
    } else if (bigDiff && 'error' in bigDiff) {
      body = (
        <div className="fnote">
          Can't show this diff: {bigDiff.error}.{' '}
          <a href={`https://github.com/${pr.ref.owner}/${pr.ref.repo}/blob/${pr.headOid}/${path}`} target="_blank" rel="noreferrer">
            Open on GitHub ↗
          </a>
        </div>
      );
    } else if (file.status === 'renamed' && changed === 0) {
      body = <div className="fnote">Renamed without changes.</div>;
    } else if (changed === 0) {
      body = <div className="fnote">No textual changes (binary file or mode change).</div>;
    } else {
      body = (
        <div className="fnote">
          GitHub didn't render this diff (too large or binary).{' '}
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
        <span className="add mono">+{file.additions}</span>
        <span className="del mono">−{file.deletions}</span>
        {viewed === 'DISMISSED' && <span className="chip warn">changed since viewed</span>}
        {hidden && <span className="chip">hidden</span>}
        {threads.length > 0 && <span className="chip" title="threads">💬 {threads.length}</span>}
        {blob === 'loading' && !collapsed && <span className="faint" title="loading full file for context">…</span>}
        <button className="small" title="Comment on file" onClick={() => { setCollapsed(path, false); openComposer(path, { kind: 'file' }); }}>
          Comment
        </button>
        <button className="small" title={hidden ? 'Unhide' : 'Hide this file'} onClick={() => toggleFileHidden(file)}>
          {hidden ? 'Unhide' : 'Hide'}
        </button>
        <a className="btn small" title="View file at head on GitHub" target="_blank" rel="noreferrer"
          href={`https://github.com/${pr.ref.owner}/${pr.ref.repo}/blob/${pr.headOid}/${path}`}>↗</a>
        <label title="Mark viewed (v)">
          <input type="checkbox" checked={isViewed(viewed)} onChange={e => markViewed([path], e.target.checked)} /> Viewed
        </label>
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

function DiffBody({ file, model, threads, composer, hlReady }: {
  file: PrFile; model: FileModel; threads: Thread[]; composer: ComposerTarget | undefined; hlReady: boolean;
}) {
  const path = file.path;
  const hlOn = useStore(s => s.settings.highlight) && hlReady;
  const toks = useHighlight(model, path, hlOn);
  const viewMode = useStore(s => s.settings.viewMode);
  const ctxSetting = useStore(s => s.settings.context);
  const stored = useStore(s => s.expansions[path]) ?? EMPTY;
  const context = ctxSetting >= ALL ? Infinity : ctxSetting;

  const byRow = useMemo(() => {
    const m = new Map<number, Thread[]>();
    const orphans: Thread[] = [];
    for (const t of threads) {
      const i = threadRowIndex(model, t);
      if (i < 0) orphans.push(t);
      else {
        const a = m.get(i);
        if (a) a.push(t);
        else m.set(i, [t]);
      }
    }
    return { m, orphans };
  }, [model, threads]);

  const lineComposer = useMemo(
    () => (composer?.kind === 'line' ? validRange(model, composer.a, composer.b) : null),
    [composer, model],
  );
  const sel = lineComposer?.ok ? lineComposer : null;

  const items = useMemo(() => {
    const exp: Array<[number, number]> = [...stored];
    for (const i of byRow.m.keys()) exp.push([i, i]);
    if (sel) exp.push([sel.startIdx, sel.endIdx]);
    return view(model, context, exp);
  }, [model, context, stored, byRow, sel]);

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

  const ctx: RowCtx = { file, model, byRow: byRow.m, composer: sel, partner, split: viewMode === 'split', toks, hlOn };

  return (
    <>
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

interface RowCtx {
  file: PrFile;
  model: FileModel;
  byRow: Map<number, Thread[]>;
  composer: Extract<RangeCheck, { ok: true }> | null;
  partner: Map<number, number>;
  split: boolean;
  toks: RowToks | undefined;
  hlOn: boolean;
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
    const ts = ctx.byRow.get(idx);
    const isComposer = ctx.composer && ctx.composer.endIdx === idx;
    if (!ts && !isComposer) continue;
    out.push(
      <tr className="inline" key={`x${idx}`}>
        <td colSpan={4}>
          <div className="box">
            {ts?.map(t => <ThreadView key={t.id} thread={t} />)}
            {isComposer && <LineComposer path={ctx.file.path} r={ctx.composer!} />}
          </div>
        </td>
      </tr>,
    );
  }
}

function LineComposer({ path, r }: { path: string; r: Extract<RangeCheck, { ok: true }> }) {
  const single = r.startIdx === r.endIdx;
  const target = {
    path, body: '', subjectType: 'LINE' as const, line: r.line, side: r.side,
    ...(single ? {} : { startLine: r.startLine, startSide: r.startSide }),
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

function onNumClick(e: MouseEvent, idx: number, ctx: RowCtx, clicked: Side) {
  e.preventDefault();
  const path = ctx.file.path;
  const row = ctx.model.rows[idx];
  const s = useStore.getState();
  const prev = s.selAnchor;
  const anchor = lineAnchor(row, clicked);
  if (!anchor) {
    const n = clicked === 'LEFT' ? row.oldNo ?? row.newNo : row.newNo ?? row.oldNo;
    const quote = `\`L${n}\`${clicked === 'LEFT' || row.kind === 'del' ? ' (old)' : ''}\n> ${row.text.slice(0, 200)}\n\n`;
    toast('GitHub only accepts line comments inside its diff hunks. Commenting on the file instead.');
    openComposer(path, { kind: 'file', quote });
    useStore.setState({ selAnchor: null });
    return;
  }
  if (e.shiftKey && prev && prev.path === path) {
    const r = validRange(ctx.model, prev.anchor, anchor);
    if (!r.ok) {
      toast(r.reason, true);
      return;
    }
    openComposer(path, { kind: 'line', a: prev.anchor, b: anchor });
    return;
  }
  openComposer(path, { kind: 'line', a: anchor, b: anchor });
  useStore.setState({ selAnchor: { path, anchor } });
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
    </>
  );
}

const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

const UnifiedRow = memo(function UnifiedRow({ idx, ctx }: { idx: number; ctx: RowCtx }) {
  const row = ctx.model.rows[idx];
  const nc = row.hunk == null ? ' nc' : '';
  return (
    <tr className={`${row.kind}${inSel(ctx, idx) ? ' sel' : ''}${row.noEol ? ' noeol' : ''}`}>
      <td className={`num${nc}`} onClick={e => onNumClick(e, idx, ctx, 'LEFT')}>{row.oldNo ?? ''}</td>
      <td className={`num${nc}`} onClick={e => onNumClick(e, idx, ctx, 'RIGHT')}>{row.newNo ?? ''}</td>
      <td className="sign">{SIGN[row.kind]}</td>
      <td className="code"><Code row={row} idx={idx} ctx={ctx} /></td>
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
    const nc = row.hunk == null ? ' nc' : '';
    const noeol = row.noEol && (row.kind !== 'ctx' || isRight) ? ' noeol-c' : '';
    return [
      <td key="n" className={`num ${k}${nc}`} onClick={e => onNumClick(e, idx, ctx, isRight ? 'RIGHT' : 'LEFT')}>{no ?? ''}</td>,
      <td key="c" className={`code ${k}${noeol}`}><Code row={row} idx={idx} ctx={ctx} pane={isRight ? 'right' : 'left'} /></td>,
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
