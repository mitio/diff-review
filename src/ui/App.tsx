import { useEffect, useMemo, useRef, useState } from 'react';
import type { PrRef, ReviewEvent } from '../types.ts';
import { parsePrUrl } from '../lib/github.ts';
import {
  ALL, discard, dismissToast, draftKey, openComposer, setCollapsed, fileHidden, isViewed, load, pendingCount, refresh, streamFiles, submit, updateSettings,
  useStore,
} from './store.ts';
import { Sidebar } from './Sidebar.tsx';
import { Overview } from './Overview.tsx';
import { FileBlock } from './FileDiff.tsx';
import { ThreadView } from './Thread.tsx';
import { UserLink } from './bits.tsx';
import { setScrollRoot } from './Lazy.tsx';
import { onMainScroll, stepFile, toggleViewedCurrent } from './nav.ts';

const CONTEXTS = [0, 3, 5, 10, 15, 25, ALL];

export function App({ prRef: ref }: { prRef: PrRef }) {
  const pr = useStore(s => s.pr);
  const loading = useStore(s => s.loading);
  const error = useStore(s => s.error);
  const tab = useStore(s => s.tab);
  const width = useStore(s => s.settings.sidebarWidth);
  const fontSize = useStore(s => s.settings.fontSize);

  useEffect(() => { void load(ref); }, [ref.owner, ref.repo, ref.number]);
  useEffect(() => { document.documentElement.style.setProperty('--diff-font', `${fontSize}px`); }, [fontSize]);
  useKeys();
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      if (Date.now() - last < 30_000) return;
      last = Date.now();
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (error) {
    return (
      <div className="center">
        <p>Failed to load {ref.owner}/{ref.repo}#{ref.number}</p>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{error}</pre>
        <button onClick={() => void load(ref)}>Retry</button>
      </div>
    );
  }
  if (loading || !pr) return <div className="center">Loading {ref.owner}/{ref.repo}#{ref.number}…</div>;

  return (
    <div className="app">
      <div>
        <TopBar />
        <Banners />
      </div>
      <div className="body" style={{ gridTemplateColumns: `${width}px 1fr` }}>
        <Sidebar />
        <Main tab={tab} />
      </div>
      <Toasts />
      <Help />
    </div>
  );
}

function Main({ tab }: { tab: 'overview' | 'diff' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setScrollRoot(ref.current);
    return () => setScrollRoot(null);
  }, []);
  return (
    <div className="mainwrap">
      <main className="main" ref={ref} onScroll={onScrollThrottled}>
        <DiffStream />
      </main>
      {tab === 'overview' && <div className="overlay"><Overview /></div>}
    </div>
  );
}

let scrollRaf = 0;
function onScrollThrottled() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    onMainScroll();
  });
}

function DiffStream() {
  const pr = useStore(s => s.pr)!;
  const showHidden = useStore(s => s.settings.showHidden);
  const focus = useStore(s => s.focus);
  const filter = useStore(s => s.filter);
  const repoRules = useStore(s => s.repoRules);
  const prRules = useStore(s => s.prRules);
  const threads = useStore(s => s.threads);
  const files = useMemo(() => streamFiles(useStore.getState()), [pr, showHidden, focus, filter, repoRules, prRules]);
  const orphans = useMemo(() => {
    const paths = new Set(pr.files.flatMap(f => (f.previousPath ? [f.path, f.previousPath] : [f.path])));
    return threads.filter(t => !paths.has(t.path));
  }, [pr, threads]);
  const hiddenN = pr.files.filter(f => fileHidden({ repoRules, prRules }, f)).length;
  useEffect(() => { onMainScroll(); }, [files]);
  return (
    <div className="files">
      {files.map(f => <FileBlock key={f.path} file={f} />)}
      {files.length === 0 && <div className="center">No files match.</div>}
      {orphans.length > 0 && (
        <section className="file">
          <header className="fhead"><span className="path"><bdi>Threads on files no longer in this diff</bdi></span></header>
          <div className="file-threads">
            {orphans.map(t => <div key={t.id}><div className="mono muted" style={{ fontSize: 12 }}>{t.path}</div><ThreadView thread={t} showLocation /></div>)}
          </div>
        </section>
      )}
      {hiddenN > 0 && !showHidden && (
        <div className="center faint">
          {hiddenN} hidden file{hiddenN === 1 ? '' : 's'}.{' '}
          <button className="link" onClick={() => updateSettings({ showHidden: true })}>Show</button>
        </div>
      )}
    </div>
  );
}

function TopBar() {
  const pr = useStore(s => s.pr)!;
  const viewed = useStore(s => s.viewed);
  const tab = useStore(s => s.tab);
  const settings = useStore(s => s.settings);
  const pending = useStore(s => pendingCount(s));
  const hasDraft = useStore(s => !!s.pendingReviewId);
  const busy = useStore(s => s.busy);
  const revalidating = useStore(s => s.revalidating);
  const [reviewOpen, setReviewOpen] = useState(false);
  const nViewed = pr.files.filter(f => isViewed(viewed[f.path])).length;
  return (
    <div className="topbar">
      <a className="title" href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>{pr.title}</a>
      <a className="muted" href={pr.url} target="_blank" rel="noreferrer">#{pr.ref.number}</a>
      <span className={`chip ${pr.isDraft ? 'draft' : `state-${pr.state}`}`}>{pr.isDraft ? 'Draft' : pr.state.toLowerCase()}</span>
      <UserLink user={pr.author} />
      <span className="refs" title={`${pr.baseRefName} ← ${pr.headRefName}`}>{pr.baseRefName} ← {pr.headRefName}</span>
      <span className="chip">{pr.files.length} files</span>
      <span className="chip"><span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span></span>
      <span className="chip" title="Viewed files">✓ {nViewed}/{pr.files.length}</span>
      <span className="spacer" />
      {busy > 0 && <span className="faint">saving…</span>}
      {revalidating && <span className="faint" title="Showing the cached copy while fetching the latest">syncing…</span>}
      <span className="seg">
        <button className={tab === 'overview' ? 'on' : ''} onClick={() => useStore.setState({ tab: 'overview' })} title="Overview (o)">Overview</button>
        <button className={tab === 'diff' ? 'on' : ''} onClick={() => useStore.setState({ tab: 'diff' })} title="Diff (d)">Diff</button>
      </span>
      <span className="seg" title="Toggle with s">
        <button className={settings.viewMode === 'unified' ? 'on' : ''} onClick={() => updateSettings({ viewMode: 'unified' })}>Unified</button>
        <button className={settings.viewMode === 'split' ? 'on' : ''} onClick={() => updateSettings({ viewMode: 'split' })}>Split</button>
      </span>
      <select value={settings.context} onChange={e => updateSettings({ context: Number(e.target.value) })} title="Context lines ([ / ])">
        {CONTEXTS.map(c => <option key={c} value={c}>{c >= ALL ? 'all lines' : `${c} lines`}</option>)}
      </select>
      <span className="seg" title="Font size (- / =)">
        <button className="icon" onClick={() => updateSettings({ fontSize: Math.max(9, settings.fontSize - 1) })}>A−</button>
        <button className="icon" onClick={() => updateSettings({ fontSize: Math.min(18, settings.fontSize + 1) })}>A+</button>
      </span>
      <span style={{ position: 'relative' }}>
        <button className={hasDraft || pending ? 'primary' : ''} onClick={() => setReviewOpen(!reviewOpen)}>
          Review{pending ? ` · ${pending} pending` : ''}
        </button>
        {reviewOpen && <ReviewPanel onClose={() => setReviewOpen(false)} />}
      </span>
      <button className="icon" title="Keyboard shortcuts (?)" onClick={() => useStore.setState({ help: true })}>?</button>
    </div>
  );
}

function ReviewPanel({ onClose }: { onClose: () => void }) {
  const pending = useStore(s => pendingCount(s));
  const hasDraft = useStore(s => !!s.pendingReviewId);
  const own = useStore(s => s.pr!.author?.login === s.pr!.viewer.login);
  const [body, setBody] = useState(() => { try { return localStorage.getItem(draftKey('review-body')) ?? ''; } catch { return ''; } });
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const t = setTimeout(() => document.addEventListener('mousedown', onDown));
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown); };
  }, [onClose]);
  const save = (v: string) => {
    setBody(v);
    try { if (v) localStorage.setItem(draftKey('review-body'), v); else localStorage.removeItem(draftKey('review-body')); } catch { /* */ }
  };
  const go = async () => {
    setSending(true);
    const ok = await submit(event, body.trim());
    setSending(false);
    if (ok) { save(''); onClose(); }
  };
  return (
    <div className="popover" ref={ref} style={{ right: 0, top: 30 }} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <h3>Finish your review</h3>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        {pending ? `${pending} pending comment${pending === 1 ? '' : 's'}` : 'No pending comments'}{hasDraft ? ' in your draft review' : ''}.
      </div>
      <textarea
        autoFocus
        rows={5}
        placeholder="Leave a comment (optional)"
        value={body}
        onChange={e => save(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void go(); } }}
      />
      <div className="opts">
        <label><input type="radio" checked={event === 'COMMENT'} onChange={() => setEvent('COMMENT')} /> Comment <small>general feedback</small></label>
        <label style={own ? { opacity: .5 } : undefined}>
          <input type="radio" disabled={own} checked={event === 'APPROVE'} onChange={() => setEvent('APPROVE')} /> Approve
        </label>
        <label style={own ? { opacity: .5 } : undefined}>
          <input type="radio" disabled={own} checked={event === 'REQUEST_CHANGES'} onChange={() => setEvent('REQUEST_CHANGES')} /> Request changes
        </label>
      </div>
      <div className="row">
        {hasDraft && (
          <button className="danger" disabled={sending} onClick={async () => { if (confirm('Discard your draft review and all its pending comments?')) { await discard(); onClose(); } }}>
            Discard draft
          </button>
        )}
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={sending || (event === 'COMMENT' && !body.trim() && !pending)} onClick={() => void go()}>
          Submit review
        </button>
      </div>
    </div>
  );
}

function Banners() {
  const stale = useStore(s => s.stale);
  const pr = useStore(s => s.pr)!;
  const ref = useStore(s => s.ref)!;
  return (
    <>
      {stale && (
        <div className="banner">
          This PR changed on GitHub (new commits or a new base). Comments and viewed state are paused until you reload.
          <button className="small" onClick={() => void load(ref)}>Reload</button>
        </div>
      )}
      {pr.files.length < pr.changedFiles && (
        <div className="banner">
          GitHub lists only {pr.files.length} of {pr.changedFiles} changed files. Group actions apply to listed files only.
        </div>
      )}
    </>
  );
}

function Toasts() {
  const toasts = useStore(s => s.toasts);
  return (
    <div className="toasts">
      {toasts.map(t => <div key={t.id} className={`toast${t.error ? ' error' : ''}`} onClick={() => dismissToast(t.id)}>{t.text}</div>)}
    </div>
  );
}

const KEYS: Array<[string, string]> = [
  ['j / k', 'next / previous file'],
  ['v', 'toggle viewed, jump to next unviewed'],
  ['x', 'collapse / expand current file'],
  ['s', 'toggle unified / split'],
  ['[ / ]', 'less / more context'],
  ['- / =', 'smaller / larger font'],
  ['o / d', 'overview / diff'],
  ['/', 'filter files'],
  ['r', 'refresh comments + viewed state'],
  ['c', 'comment on current file'],
  ['⌘↵', 'add comment to review'],
  ['?', 'this help'],
];

function Help() {
  const open = useStore(s => s.help);
  if (!open) return null;
  const close = () => useStore.setState({ help: false });
  return (
    <div className="help" onClick={close}>
      <div className="card" onClick={e => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Keyboard</h3>
        <table><tbody>{KEYS.map(([k, d]) => <tr key={k}><td>{k}</td><td>{d}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}

function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useStore.getState();
      const st = s.settings;
      const i = CONTEXTS.indexOf(st.context);
      switch (e.key) {
        case 'j': stepFile(1); break;
        case 'k': stepFile(-1); break;
        case 'v': toggleViewedCurrent(); break;
        case 'x': if (s.current) setCollapsed(s.current, !(s.collapsed[s.current] ?? isViewed(s.viewed[s.current]))); break;
        case 's': updateSettings({ viewMode: st.viewMode === 'split' ? 'unified' : 'split' }); break;
        case '[': updateSettings({ context: CONTEXTS[Math.max(0, (i < 0 ? 3 : i) - 1)] }); break;
        case ']': updateSettings({ context: CONTEXTS[Math.min(CONTEXTS.length - 1, (i < 0 ? 3 : i) + 1)] }); break;
        case '-': updateSettings({ fontSize: Math.max(9, st.fontSize - 1) }); break;
        case '=': case '+': updateSettings({ fontSize: Math.min(18, st.fontSize + 1) }); break;
        case 'o': useStore.setState({ tab: 'overview' }); break;
        case 'd': useStore.setState({ tab: 'diff' }); break;
        case 'r': void refresh(true); break;
        case 'c': if (s.current) { useStore.setState({ tab: 'diff' }); setCollapsed(s.current, false); openComposer(s.current, { kind: 'file' }); } break;
        case '/': e.preventDefault(); document.getElementById('file-filter')?.focus(); break;
        case '?': useStore.setState({ help: !s.help }); break;
        case 'Escape': useStore.setState({ help: false }); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function Home() {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const origin = location.origin;
  const bookmarklet = `javascript:(()=>{const m=location.href.match(/github\\.com\\/([^/]+\\/[^/]+\\/pull\\/\\d+)/);if(m)location.href='${origin}/'+m[1];})()`;
  return (
    <div className="home">
      <h2 style={{ margin: 0 }}>gh-review</h2>
      <form onSubmit={e => {
        e.preventDefault();
        const r = parsePrUrl(v.trim());
        if (!r) { setErr('Not a PR URL'); return; }
        location.href = `/${r.owner}/${r.repo}/pull/${r.number}`;
      }}>
        <input autoFocus placeholder="https://github.com/owner/repo/pull/123" value={v} onChange={e => { setV(e.target.value); setErr(''); }} data-1p-ignore />
        <button className="primary" type="submit">Open</button>
      </form>
      {err && <div className="del">{err}</div>}
      <div className="muted">
        Or replace <code style={{ display: 'inline' }}>https://github.com</code> with <code style={{ display: 'inline' }}>{origin}</code> in any PR URL.
        Bookmarklet (drag to your bookmarks bar):{' '}
        {/* React blocks javascript: hrefs, so set it on the DOM node directly */}
        <a ref={el => { el?.setAttribute('href', bookmarklet); }}>Review in gh-review</a>
      </div>
    </div>
  );
}
