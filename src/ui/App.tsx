import { useEffect, useMemo, useRef, useState } from 'react';
import type { Check, CheckBucket, PrRef, RecentStatus, ReviewEvent } from '../types.ts';
import { fetchRecentStatus, parsePrUrl } from '../lib/github.ts';
import { listRecent, recentId, removeRecent, type RecentPr } from '../lib/recent.ts';
import {
  ALL, discard, dismissToast, flushRecent, toast, draftKey, headChecks, loadChecks, openComposer, setCollapsed, fileHidden, isViewed, load, pendingCount,
  refresh, streamFiles, submit, updateSettings, useStore, type Tab,
} from './store.ts';
import { Conversation } from './Conversation.tsx';
import { navigate, onLinkClick, sameRef, useRoute } from './router.ts';
import { Sidebar } from './Sidebar.tsx';
import { Overview } from './Overview.tsx';
import { FileBlock } from './FileDiff.tsx';
import { ThreadView } from './Thread.tsx';
import { UserLink, relTime } from './bits.tsx';
import { setScrollRoot } from './Lazy.tsx';
import { onMainScroll, scrollToFile, stepFile, toggleViewedCurrent } from './nav.ts';

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
    // CI moves on its own: poll while something is still running
    const poll = setInterval(() => {
      const c = headChecks(useStore.getState());
      if (document.visibilityState === 'visible' && c && c.counts.pending > 0) void loadChecks();
    }, 30_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(poll);
    };
  }, []);

  if (error) {
    return (
      <div className="center">
        <p>Failed to load {ref.owner}/{ref.repo}#{ref.number}</p>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{error}</pre>
        <button onClick={() => void load(ref)}>Retry</button>{' '}
        <a className="btn" href="/" onClick={onLinkClick}>Home</a>
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

function Main({ tab }: { tab: Tab }) {
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
      {tab === 'conversation' && <div className="overlay"><Conversation /></div>}
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
  const reveal = useStore(s => s.reveal);
  const grouping = useStore(s => s.settings.grouping);
  const files = useMemo(() => streamFiles(useStore.getState()), [pr, showHidden, focus, filter, repoRules, prRules, reveal, grouping]);
  const orphans = useMemo(() => {
    const paths = new Set(pr.files.flatMap(f => (f.previousPath ? [f.path, f.previousPath] : [f.path])));
    return threads.filter(t => !paths.has(t.path));
  }, [pr, threads]);
  const hiddenN = pr.files.filter(f => fileHidden({ repoRules, prRules }, f)).length;
  const pendingFile = useStore(s => s.pendingFile);
  useEffect(() => { onMainScroll(); }, [files]);
  useEffect(() => {
    // the store may still hold the previous PR for a render after back/forward
    if (!pendingFile || !sameRef(pr.ref, useRoute.getState().ref)) return;
    if (files.some(f => f.path === pendingFile)) {
      requestAnimationFrame(() => {
        if (useStore.getState().pendingFile === pendingFile && scrollToFile(pendingFile)) useStore.setState({ pendingFile: null });
      });
    } else if (pr.files.some(f => f.path === pendingFile)) {
      useStore.setState({ reveal: pendingFile });
    } else if (!useStore.getState().revalidating) {
      toast(`${pendingFile} is not part of this PR`);
      useStore.setState({ pendingFile: null });
    }
  }, [files, pendingFile, pr]);
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
  const conv = useStore(s => s.conv);
  const nConv = conv ? conv.comments.length + conv.reviews.filter(r => r.body.trim()).length : null;
  const tabBtn = (t: Tab, label: string, key: string) => (
    <button className={tab === t ? 'on' : ''} onClick={() => useStore.setState({ tab: t })} title={`${label} (${key})`}>{label}</button>
  );
  return (
    <div className="topbar">
      <a className="btn icon" href="/" onClick={onLinkClick} title="Home: recent PRs">⌂</a>
      <a className="title" href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>{pr.title}</a>
      <a className="muted" href={pr.url} target="_blank" rel="noreferrer">#{pr.ref.number}</a>
      <span className={`chip ${pr.isDraft ? 'draft' : `state-${pr.state}`}`}>{pr.isDraft ? 'Draft' : pr.state.toLowerCase()}</span>
      <UserLink user={pr.author} />
      <span className="refs" title={`${pr.baseRefName} ← ${pr.headRefName}`}>{pr.baseRefName} ← {pr.headRefName}</span>
      <span className="chip">{pr.files.length} files</span>
      <span className="chip"><span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span></span>
      <span className="chip" title="Viewed files">✓ {nViewed}/{pr.files.length}</span>
      <ChecksChip />
      <span className="spacer" />
      {busy > 0 && <span className="faint">saving…</span>}
      {revalidating && <span className="faint" title="Showing the cached copy while fetching the latest">syncing…</span>}
      <span className="seg">
        {tabBtn('overview', 'Overview', 'o')}
        {tabBtn('diff', 'Diff', 'd')}
        {tabBtn('conversation', nConv ? `Conversation · ${nConv}` : 'Conversation', 't')}
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
  const [key] = useState(() => draftKey('review-body'));
  const [body, setBody] = useState(() => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } });
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
    try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } catch { /* */ }
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
  ['o / d / t', 'overview / diff / conversation'],
  ['h', 'syntax highlighting on / off'],
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

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);
function typesText(t: HTMLElement) {
  if (t instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(t.type);
  return !!t.closest('textarea, select, [contenteditable]');
}

function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (typesText(t) || e.metaKey || e.ctrlKey || e.altKey) return;
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
        case 't': useStore.setState({ tab: 'conversation' }); break;
        case 'h': updateSettings({ highlight: !st.highlight }); break;
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

const BUCKET_ORDER: CheckBucket[] = ['fail', 'pending', 'ok', 'skipped'];
const BUCKET_ICON: Record<CheckBucket, string> = { fail: '✗', pending: '●', ok: '✓', skipped: '–' };

function ChecksChip() {
  const checks = useStore(s => headChecks(s));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  if (!checks || !checks.total) return null;
  const count = (b: CheckBucket) => checks.counts[b];
  const worst = BUCKET_ORDER.find(b => count(b) > 0) ?? 'ok';
  const sorted = [...checks.checks].sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) || a.name.localeCompare(b.name));
  const summary = (['fail', 'pending', 'ok'] as CheckBucket[]).filter(b => count(b)).map(b => `${BUCKET_ICON[b]} ${count(b)}`).join('  ');
  return (
    <span ref={ref} style={{ position: 'relative' }}>
      <button className={`chip ci-${worst}`} onClick={() => setOpen(!open)} title="CI checks on the head commit">CI {summary}</button>
      {open && (
        <div className="popover checks" style={{ left: 0, top: 26 }}>
          {checks.total > checks.checks.length && <div className="faint">Listing {checks.checks.length} of {checks.total} checks; the counts cover all.</div>}
          <table><tbody>{sorted.map((c, i) => <CheckRow key={i} c={c} />)}</tbody></table>
        </div>
      )}
    </span>
  );
}

function duration(c: Check) {
  if (!c.startedAt || !c.completedAt) return '';
  const s = Math.round((Date.parse(c.completedAt) - Date.parse(c.startedAt)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function CheckRow({ c }: { c: Check }) {
  return (
    <tr>
      <td className={`ci-${c.bucket}`} title={c.detail}>{BUCKET_ICON[c.bucket]}</td>
      <td>
        {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name}
        {c.source && <span className="faint"> · {c.source}</span>}
        {c.required && <span className="chip">required</span>}
      </td>
      <td className="faint" title={c.detail}>{c.bucket === 'pending' ? c.detail : duration(c)}</td>
    </tr>
  );
}

const prPath = (r: PrRef) => `/${r.owner}/${r.repo}/pull/${r.number}`;

export function Home() {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const [recent, setRecent] = useState<RecentPr[]>(() => { flushRecent(); return listRecent(); });
  const [live, setLive] = useState<Map<string, RecentStatus> | null>(null);
  useEffect(() => {
    document.title = 'gh-review';
    const list = listRecent();
    setRecent(list);
    if (!list.length) return;
    let cancelled = false;
    fetchRecentStatus(list).then(m => { if (!cancelled) setLive(m); }).catch(e => console.warn('recent status unavailable', e));
    return () => { cancelled = true; };
  }, []);
  const origin = location.origin;
  const bookmarklet = `javascript:(()=>{const m=location.href.match(/github\\.com\\/([^/]+\\/[^/]+\\/pull\\/\\d+)/);if(m)location.href='${origin}/'+m[1];})()`;
  return (
    <div className="home">
      <h2 style={{ margin: 0 }}>gh-review</h2>
      <form onSubmit={e => {
        e.preventDefault();
        const r = parsePrUrl(v.trim());
        if (!r) { setErr('Not a PR URL'); return; }
        navigate(prPath(r));
      }}>
        <input autoFocus placeholder="https://github.com/owner/repo/pull/123" value={v} onChange={e => { setV(e.target.value); setErr(''); }} data-1p-ignore />
        <button className="primary" type="submit">Open</button>
      </form>
      {err && <div className="del">{err}</div>}
      {recent.length > 0 && (
        <table className="recent">
          <tbody>
            {recent.map(r => (
              <RecentRow key={recentId(r)} r={r} live={live?.get(recentId(r))} onRemove={() => { removeRecent(r); setRecent(listRecent()); }} />
            ))}
          </tbody>
        </table>
      )}
      <div className="muted">
        Or replace <code style={{ display: 'inline' }}>https://github.com</code> with <code style={{ display: 'inline' }}>{origin}</code> in any PR URL.
        Bookmarklet (drag to your bookmarks bar):{' '}
        {/* React blocks javascript: hrefs, so set it on the DOM node directly */}
        <a ref={el => { el?.setAttribute('href', bookmarklet); }}>Review in gh-review</a>
      </div>
    </div>
  );
}

const DECISION: Record<string, [string, string]> = {
  APPROVED: ['approved', 'review-APPROVED'], CHANGES_REQUESTED: ['changes requested', 'review-CHANGES_REQUESTED'], REVIEW_REQUIRED: ['review required', ''],
};
const CI_BUCKET: Record<string, CheckBucket> = { SUCCESS: 'ok', FAILURE: 'fail', ERROR: 'fail', PENDING: 'pending', EXPECTED: 'pending' };

function RecentRow({ r, live, onRemove }: { r: RecentPr; live: RecentStatus | undefined; onRemove: () => void }) {
  const state = live?.state ?? r.state;
  const draft = live?.isDraft ?? r.isDraft;
  const moved = !!live && !!r.headOid && live.headOid !== r.headOid;
  const decision = live?.reviewDecision ? DECISION[live.reviewDecision] : undefined;
  const ci = live?.ci ? CI_BUCKET[live.ci] : undefined;
  return (
    <tr>
      <td className="rtitle">
        <a href={prPath(r)} onClick={onLinkClick} title={live?.title ?? r.title}>{live?.title ?? r.title}</a>
        <div className="faint">
          {r.owner}/{r.repo}#{r.number}
          {r.files > 0 && <> · {r.viewed}/{r.files} viewed · <span className="add">+{r.additions}</span> <span className="del">−{r.deletions}</span></>}
        </div>
      </td>
      <td><UserLink user={r.author} /></td>
      <td className="chips">
        <span className={`chip ${draft ? 'draft' : `state-${state}`}`}>{draft ? 'Draft' : state.toLowerCase()}</span>
        {ci && <span className={`chip ci-${ci}`} title={`CI: ${live!.ci!.toLowerCase()}`}>CI {BUCKET_ICON[ci]}</span>}
        {decision && <span className={`chip ${decision[1]}`}>{decision[0]}</span>}
        {moved && <span className="chip warn" title="New commits since you last opened it">new commits</span>}
      </td>
      <td className="faint" title={new Date(r.openedAt).toISOString()}>{relTime(new Date(r.openedAt).toISOString())}</td>
      <td className="acts">
        <a className="btn small" href={`https://github.com/${r.owner}/${r.repo}/pull/${r.number}`} target="_blank" rel="noreferrer" title="Open on GitHub">↗</a>
        <button className="small" title="Remove from this list" onClick={onRemove}>×</button>
      </td>
    </tr>
  );
}
