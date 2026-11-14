import { useMemo, useState } from 'react';
import type { GroupSummary, HideRule, PrFile } from '../types.ts';
import { categorize, CATEGORIES, CATEGORY_LABELS, folderKey, summarize } from '../lib/categorize.ts';
import {
  addRule, fileHidden, isViewed, markViewed, removeRule, toggleFileHidden, updateSettings, useStore, type Focus,
} from './store.ts';
import { StatusLetter } from './bits.tsx';
import { goToFile } from './nav.ts';

export function Overview() {
  const pr = useStore(s => s.pr)!;
  const viewed = useStore(s => s.viewed);
  const repoRules = useStore(s => s.repoRules);
  const prRules = useStore(s => s.prRules);
  const depth = useStore(s => s.settings.folderDepth);
  const threads = useStore(s => s.threads);

  const rs = { repoRules, prRules };
  const isV = (f: PrFile) => isViewed(viewed[f.path]);
  const isH = (f: PrFile) => fileHidden(rs, f);

  const byCat = useMemo(() => {
    const g = summarize(pr.files, f => categorize(f.path), isV, isH);
    const order = new Map(CATEGORIES.map((c, i) => [c as string, i]));
    return g.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
  }, [pr, viewed, repoRules, prRules]);
  const byFolder = useMemo(
    () => summarize(pr.files, f => folderKey(f.path, depth), isV, isH).sort((a, b) => a.key.localeCompare(b.key)),
    [pr, viewed, repoRules, prRules, depth],
  );

  const paths = new Set(pr.files.flatMap(f => (f.previousPath ? [f.path, f.previousPath] : [f.path])));
  const orphans = threads.filter(t => !paths.has(t.path)).length;
  const unresolved = threads.filter(t => !t.isResolved).length;

  return (
    <div className="overview">
      <div className="col">
      <div className="panel">
        <header>
          By category
          <span className="spacer" />
          <span className="muted" style={{ fontWeight: 400 }}>
            {threads.length} threads · {unresolved} unresolved{orphans ? ` · ${orphans} on files no longer in the diff` : ''}
          </span>
        </header>
        <GroupTable
          groups={byCat}
          label={k => CATEGORY_LABELS[k as keyof typeof CATEGORY_LABELS] ?? k}
          dot
          focusOf={k => ({ kind: 'category', key: k as never })}
          hideRule={k => ({ kind: 'category', category: k as never })}
        />
      </div>
      <RulesPanel />
      </div>
      <div className="col">
      <div className="panel">
        <header>
          By folder
          <span className="spacer" />
          <span className="muted" style={{ fontWeight: 400 }}>depth</span>
          <span className="seg">
            {[1, 2, 3, 4].map(d => (
              <button key={d} className={`small${d === depth ? ' on' : ''}`} onClick={() => updateSettings({ folderDepth: d })}>{d}</button>
            ))}
          </span>
        </header>
        <GroupTable
          groups={byFolder}
          label={k => k}
          focusOf={k => ({ kind: 'folder', depth, key: k })}
          hideRule={k => (k === '/' ? null : { kind: 'glob', pattern: `${k}/**` })}
        />
      </div>
      </div>
    </div>
  );
}

function GroupTable({ groups, label, dot, focusOf, hideRule }: {
  groups: GroupSummary[];
  label: (k: string) => string;
  dot?: boolean;
  focusOf: (k: string) => Focus;
  hideRule: (k: string) => HideRule | null;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const viewed = useStore(s => s.viewed);
  const repoRules = useStore(s => s.repoRules);
  const prRules = useStore(s => s.prRules);
  const maxChurn = Math.max(1, ...groups.map(g => g.additions + g.deletions));
  const tot = groups.reduce((a, g) => ({ f: a.f + g.files.length, a: a.a + g.additions, d: a.d + g.deletions, v: a.v + g.viewed }), { f: 0, a: 0, d: 0, v: 0 });
  const toggle = (k: string) => setOpen(s => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  return (
    <table className="groups">
      <thead>
        <tr>
          <th>Group</th><th className="num">Files</th><th className="num">+</th><th className="num">−</th>
          <th>Churn</th><th>Viewed</th><th />
        </tr>
      </thead>
      <tbody>
        {groups.map(g => {
          const churn = g.additions + g.deletions;
          const cw = Math.round((90 * churn) / maxChurn);
          const aw = churn ? Math.round((cw * g.additions) / churn) : 0;
          const allHidden = g.hidden === g.files.length;
          const allViewed = g.viewed === g.files.length;
          const rule = hideRule(g.key);
          const ruleOn = !!rule && [...repoRules, ...prRules].some(r => JSON.stringify(r) === JSON.stringify(rule));
          return [
            <tr key={g.key} className={`grp${allHidden ? ' all-hidden' : ''}`} onClick={() => toggle(g.key)}>
              <td className="gname" title={g.key}>
                <span className="faint">{open.has(g.key) ? '▾ ' : '▸ '}</span>
                {dot && <span className="catdot" style={{ background: `var(--cat-${g.key})`, marginRight: 5 }} />}
                {label(g.key)}
                {g.hidden > 0 && <span className="faint"> · {g.hidden} hidden</span>}
              </td>
              <td className="num">{g.files.length}</td>
              <td className="num add">{g.additions}</td>
              <td className="num del">{g.deletions}</td>
              <td><span className="bar"><i className="a" style={{ width: aw }} /><i className="d" style={{ width: cw - aw }} /></span></td>
              <td>
                <span className="bar" style={{ width: 50 }}><i className="v" style={{ width: Math.round((50 * g.viewed) / g.files.length) }} /></span>{' '}
                <span className="faint">{g.viewed}/{g.files.length}</span>
              </td>
              <td className="acts" onClick={e => e.stopPropagation()}>
                <button className="small" onClick={() => markViewed(g.files.map(f => f.path), !allViewed)}>
                  {allViewed ? 'Unview' : '✓ Viewed'}
                </button>
                {rule && (
                  <button className="small" onClick={() => (ruleOn ? removeRule(rule) : addRule(rule))}>
                    {ruleOn ? 'Unhide' : 'Hide'}
                  </button>
                )}
                <button className="small" onClick={() => useStore.setState({ focus: focusOf(g.key), tab: 'diff' })}>Only</button>
              </td>
            </tr>,
            open.has(g.key) && g.files.map(f => (
              <tr key={`${g.key}/${f.path}`} className="sub">
                <td className="gname" colSpan={4} title={f.path}>
                  <input
                    type="checkbox"
                    checked={isViewed(viewed[f.path])}
                    onChange={e => markViewed([f.path], e.target.checked)}
                    style={{ margin: '0 4px 0 0', verticalAlign: 'middle' }}
                  />
                  <StatusLetter status={f.status} />{' '}
                  <a href="#" onClick={e => { e.preventDefault(); goToFile(f.path); }}>{f.path}</a>
                </td>
                <td className="num add">+{f.additions}</td>
                <td className="num del">−{f.deletions}</td>
                <td className="acts">
                  <button className="small" onClick={() => toggleFileHidden(f)}>
                    {fileHidden({ repoRules, prRules }, f) ? 'Unhide' : 'Hide'}
                  </button>
                </td>
              </tr>
            )),
          ];
        })}
        <tr>
          <td className="muted"><b>Total</b></td>
          <td className="num">{tot.f}</td>
          <td className="num add">{tot.a}</td>
          <td className="num del">{tot.d}</td>
          <td />
          <td className="faint">{tot.v}/{tot.f}</td>
          <td />
        </tr>
      </tbody>
    </table>
  );
}

function ruleText(r: HideRule) {
  if (r.kind === 'category') return `category: ${CATEGORY_LABELS[r.category]}`;
  if (r.kind === 'glob') return r.pattern;
  return `file: ${r.path}`;
}

function RulesPanel() {
  const repoRules = useStore(s => s.repoRules);
  const prRules = useStore(s => s.prRules);
  const ref = useStore(s => s.ref)!;
  const [glob, setGlob] = useState('');
  return (
    <div className="panel">
      <header>Hidden rules<span className="spacer" /><span className="muted" style={{ fontWeight: 400 }}>local only</span></header>
      <div className="rules">
        <div className="muted" style={{ fontSize: 12 }}>For all PRs in {ref.owner}/{ref.repo}:</div>
        {repoRules.length === 0 && <div className="faint">None.</div>}
        {repoRules.map(r => (
          <div className="rule" key={JSON.stringify(r)}>
            <button className="small" onClick={() => removeRule(r)} title="Remove rule">✕</button>{ruleText(r)}
          </div>
        ))}
        {prRules.length > 0 && <div className="muted" style={{ fontSize: 12 }}>This PR only:</div>}
        {prRules.map(r => (
          <div className="rule" key={JSON.stringify(r)}>
            <button className="small" onClick={() => removeRule(r)} title="Remove rule">✕</button>{ruleText(r)}
          </div>
        ))}
        <form onSubmit={e => { e.preventDefault(); if (glob.trim()) { addRule({ kind: 'glob', pattern: glob.trim() }); setGlob(''); } }}>
          <input type="text" placeholder="Add glob, e.g. *.snap or spec/fixtures/**" value={glob} onChange={e => setGlob(e.target.value)} data-1p-ignore />
          <button type="submit">Hide</button>
        </form>
        <div className="faint" style={{ fontSize: 11.5 }}>
          No '/' matches the file name anywhere; with '/' it matches from the repo root. Quick categories:{' '}
          {CATEGORIES.filter(c => c !== 'source').map(c => (
            <button key={c} className="link small" onClick={() => addRule({ kind: 'category', category: c })}>{CATEGORY_LABELS[c]}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
