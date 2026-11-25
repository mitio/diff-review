import { useEffect, useMemo, useRef, useState } from 'react';
import type { Check, CheckBucket, RecentStatus, ReviewEvent, ReviewRef } from '../types.ts';
import { fetchRecentStatus } from '../lib/github.ts';
import { listRecent, recentId, removeRecent, type RecentPr } from '../lib/recent.ts';
import { appPath, githubUrl, isPr, parseReviewInput, prRef, refKey } from '../lib/refs.ts';
import { contentOid, createPaste } from '../lib/sources.ts';
import {
  ALL, composing, discard, dismissToast, exportLocal, flushRecent, toast, draftKey, headChecks, isLocalReview, loadChecks,
  openCount, fileHidden, isViewed, load, pendingCount, refresh, streamFiles, submit, updateSettings, useStore, type Tab,
} from './store.ts';
import { Conversation } from './Conversation.tsx';
import { navigate, onLinkClick, sameRef, useRoute } from './router.ts';
import { Sidebar } from './Sidebar.tsx';
import { Overview } from './Overview.tsx';
import { FileBlock } from './FileDiff.tsx';
import { ThreadView } from './Thread.tsx';
import { UserLink, relTime } from './bits.tsx';
import { setScrollRoot } from './Lazy.tsx';
import { onMainScroll, openFile, scrollToFile } from './nav.ts';
import { Finder, openFinder } from './Finder.tsx';
import { EmojiTextarea } from './EmojiTextarea.tsx';
import { CONTEXTS, SHORTCUTS, kbd, toggleSidebar, useKeys, type ShortcutId } from './keys.ts';

/** Short name of what is being reviewed. */
export function refLabel(r: ReviewRef): string {
  switch (r.kind) {
    case 'pr': return `${r.owner}/${r.repo}#${r.number}`;
    case 'commit': return `${r.owner}/${r.repo}@${r.sha.slice(0, 7)}`;
    case 'compare': return `${r.owner}/${r.repo} ${r.base}...${r.head}`;
    case 'local': return `${r.repo.split('/').pop()} · ${r.range || 'uncommitted'}`;
    case 'paste': return `pasted diff ${r.id.slice(0, 7)}`;
  }
}

export function App({ reviewRef: ref }: { reviewRef: ReviewRef }) {
  const pr = useStore(s => s.pr);
  const loading = useStore(s => s.loading);
  const error = useStore(s => s.error);
  const tab = useStore(s => s.tab);
  const width = useStore(s => s.settings.sidebarWidth);
  const sidebar = useStore(s => s.settings.sidebar);
  const fontSize = useStore(s => s.settings.fontSize);

  useEffect(() => { void load(ref); }, [refKey(ref)]);
  useEffect(() => { document.documentElement.style.setProperty('--diff-font', `${fontSize}px`); }, [fontSize]);
  useKeys();
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      // a local diff changes as you (or an agent) edit, so it refreshes more eagerly
      if (Date.now() - last < (isLocalReview(useStore.getState()) ? 5_000 : 30_000)) return;
      if (isLocalReview(useStore.getState()) && composing()) return;
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
        <p>Failed to load {refLabel(ref)}</p>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{error}</pre>
        <button onClick={() => void load(ref)}>Retry</button>{' '}
        <a className="btn" href="/" onClick={onLinkClick}>Home</a>
      </div>
    );
  }
  if (loading || !pr) return <div className="center">Loading {refLabel(ref)}…</div>;

  return (
    <div className="app">
      <div>
        <TopBar />
        <Banners />
      </div>
      <div className="body" style={{ gridTemplateColumns: sidebar ? `${width}px minmax(0, 1fr)` : 'minmax(0, 1fr)' }}>
        <Sidebar />
        <Main tab={tab} />
      </div>
      <Toasts />
      <Help />
      <Finder />
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
      {tab === 'conversation' && isPr(useStore.getState().ref) && <div className="overlay"><Conversation /></div>}
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
  const opened = useStore(s => s.opened);
  const files = useMemo(() => streamFiles(useStore.getState()), [pr, showHidden, focus, filter, repoRules, prRules, reveal, grouping, opened]);
  const orphans = useMemo(() => {
    const paths = new Set([...pr.files.flatMap(f => (f.previousPath ? [f.path, f.previousPath] : [f.path])), ...opened]);
    return threads.filter(t => !paths.has(t.path));
  }, [pr, threads, opened]);
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
      if (contentOid(pr)) openFile(pendingFile);
      else {
        toast(`${pendingFile} is not part of this diff`);
        useStore.setState({ pendingFile: null });
      }
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
  const local = useStore(s => isLocalReview(s));
  return local ? <LocalTopBar /> : <PrTopBar />;
}

/** Controls both top bars share: tabs, view mode, context, font. */
function ViewControls({ conversation }: { conversation: boolean }) {
  const tab = useStore(s => s.tab);
  const settings = useStore(s => s.settings);
  const conv = useStore(s => s.conv);
  const nConv = conv ? conv.comments.length + conv.reviews.filter(r => r.body.trim()).length : null;
  const tabBtn = (t: Tab, label: string) => (
    <button className={tab === t ? 'on' : ''} onClick={() => useStore.setState({ tab: t })} title={`Switch views with ${kbd('view')}`}>{label}</button>
  );
  return (
    <>
      <button className={settings.sidebar ? 'on' : ''} onClick={toggleSidebar} title={`File list on / off (${kbd('sidebar')})`}>Files</button>
      <button onClick={openFinder} title={`Go to any file (${kbd('finder')})`}>Go to file</button>
      <span className="seg">
        {tabBtn('diff', 'Diff')}
        {tabBtn('overview', 'Overview')}
        {conversation && tabBtn('conversation', nConv ? `Conversation · ${nConv}` : 'Conversation')}
      </span>
      <span className="seg" title={`Unified / split (${kbd('split')})`}>
        <button className={settings.viewMode === 'unified' ? 'on' : ''} onClick={() => updateSettings({ viewMode: 'unified' })}>Unified</button>
        <button className={settings.viewMode === 'split' ? 'on' : ''} onClick={() => updateSettings({ viewMode: 'split' })}>Split</button>
      </span>
      <select value={settings.context} onChange={e => updateSettings({ context: Number(e.target.value) })} title={`Context lines (${kbd('context')})`}>
        {CONTEXTS.map(c => <option key={c} value={c}>{c >= ALL ? 'all lines' : `${c} lines`}</option>)}
      </select>
      <span className="seg" title={`Font size (${kbd('font')})`}>
        <button className="icon" onClick={() => updateSettings({ fontSize: Math.max(9, settings.fontSize - 1) })}>A−</button>
        <button className="icon" onClick={() => updateSettings({ fontSize: Math.min(18, settings.fontSize + 1) })}>A+</button>
      </span>
    </>
  );
}

function LocalTopBar() {
  const pr = useStore(s => s.pr)!;
  const viewed = useStore(s => s.viewed);
  const busy = useStore(s => s.busy);
  const revalidating = useStore(s => s.revalidating);
  const open = useStore(s => openCount(s));
  const [exportOpen, setExportOpen] = useState(false);
  const nViewed = pr.files.filter(f => isViewed(viewed[f.path])).length;
  const gh = githubUrl(pr.ref);
  const r = pr.ref;
  return (
    <div className="topbar">
      <a className="btn icon" href="/" onClick={onLinkClick} title="Home: recent reviews">⌂</a>
      {gh
        ? <a className="title" href={gh} target="_blank" rel="noreferrer" title={pr.title}>{pr.title}</a>
        : <span className="title" title={pr.title}>{pr.title}</span>}
      {r.kind === 'local' && <span className="muted mono" title={r.repo}>{r.repo.split('/').pop()}</span>}
      {pr.author && <UserLink user={pr.author} />}
      {(pr.baseRefName || pr.headRefName) && (
        <span className="refs mono" title={`${pr.baseOid} ← ${pr.headOid}`}>{pr.baseRefName} ← {pr.headRefName}</span>
      )}
      <span className="chip">{pr.files.length} files</span>
      <span className="chip"><span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span></span>
      <span className="chip" title="Viewed files">✓ {nViewed}/{pr.files.length}</span>
      <span className="spacer" />
      {busy > 0 && <span className="faint">saving…</span>}
      {revalidating && <span className="faint" title="Showing the cached copy while fetching the latest">syncing…</span>}
      <ViewControls conversation={false} />
      <span style={{ position: 'relative' }}>
        <button className={open ? 'primary' : ''} onClick={() => setExportOpen(!exportOpen)} title="Copy or download the comments as Markdown">
          Comments{open ? ` · ${open}` : ''}
        </button>
        {exportOpen && <ExportPanel onClose={() => setExportOpen(false)} />}
      </span>
      <button className="icon" title={`Keyboard shortcuts (${kbd('help')})`} onClick={() => useStore.setState({ help: true })}>?</button>
    </div>
  );
}

function ExportPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const threads = useStore(s => s.threads);
  const r = useStore(s => s.pr!.ref);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const t = setTimeout(() => document.addEventListener('mousedown', onDown));
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown); };
  }, [onClose]);
  const open = threads.filter(t => !t.isResolved).length;
  const resolved = threads.length - open;
  const n = all ? threads.length : open;
  const copy = async () => {
    const md = exportLocal(all);
    if (md == null) return;
    try {
      await navigator.clipboard.writeText(md);
      toast(`Copied ${n} thread${n === 1 ? '' : 's'} as Markdown`);
      onClose();
    } catch (e) {
      toast(`Copy failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  };
  const download = () => {
    const md = exportLocal(all);
    if (md == null) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = 'review.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    onClose();
  };
  const quoted = (x: string) => (/^[A-Za-z0-9_./~^@{}:+-]+$/.test(x) ? x : `'${x}'`);
  const cli = r.kind === 'local' ? `diff-review export${r.range ? ` ${quoted(r.range)}` : ''}` : null;
  return (
    <div className="popover" ref={ref} style={{ right: 0, top: 30, width: 340 }} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <h3>Comments</h3>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        {open} open{resolved ? `, ${resolved} resolved` : ''}. Stored on this machine only.
        {cli && <> In the repo, <code style={{ display: 'inline', whiteSpace: 'nowrap' }}>{cli}</code> prints them.</>}
      </div>
      {resolved > 0 && <label><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Include resolved</label>}
      <div className="row" style={{ marginTop: 8 }}>
        <span className="spacer" />
        <button disabled={!n} onClick={download}>Download .md</button>
        <button className="primary" disabled={!n} onClick={() => void copy()}>Copy Markdown</button>
      </div>
    </div>
  );
}

function PrTopBar() {
  const pr = useStore(s => s.pr)!;
  const viewed = useStore(s => s.viewed);
  const pending = useStore(s => pendingCount(s));
  const hasDraft = useStore(s => !!s.pendingReviewId);
  const busy = useStore(s => s.busy);
  const revalidating = useStore(s => s.revalidating);
  const [reviewOpen, setReviewOpen] = useState(false);
  const nViewed = pr.files.filter(f => isViewed(viewed[f.path])).length;
  return (
    <div className="topbar">
      <a className="btn icon" href="/" onClick={onLinkClick} title="Home: recent PRs">⌂</a>
      <a className="title" href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>{pr.title}</a>
      <a className="muted" href={pr.url} target="_blank" rel="noreferrer">#{isPr(pr.ref) ? pr.ref.number : ''}</a>
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
      <ViewControls conversation />
      <span style={{ position: 'relative' }}>
        <button
          className={hasDraft || pending ? 'pending-review' : ''}
          onClick={() => setReviewOpen(!reviewOpen)}
          title={hasDraft || pending ? 'Your review is not submitted: only you can see its comments' : 'Submit a review'}
        >
          {hasDraft || pending ? `Finish review · ${pending} pending` : 'Review'}
        </button>
        {reviewOpen && <ReviewPanel onClose={() => setReviewOpen(false)} />}
      </span>
      <button className="icon" title={`Keyboard shortcuts (${kbd('help')})`} onClick={() => useStore.setState({ help: true })}>?</button>
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
        {pending ? `${pending} pending comment${pending === 1 ? '' : 's'}` : 'No pending comments'}{hasDraft ? ' in your draft review' : ''}.{pending ? ' Only you can see them until you submit.' : ''}
      </div>
      <EmojiTextarea
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
      {pr.truncated && pr.files.length >= pr.changedFiles && (
        <div className="banner">
          GitHub listed only the first {pr.files.length} files, and the full diff was too large to fetch.
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


function Help() {
  const open = useStore(s => s.help);
  if (!open) return null;
  const close = () => useStore.setState({ help: false });
  return (
    <div className="help" onClick={close}>
      <div className="card" onClick={e => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Keyboard</h3>
        <table>
          {SHORTCUTS.map(g => (
            <tbody key={g.group}>
              <tr><th colSpan={2}>{g.group}</th></tr>
              {Object.entries(g.items).map(([id, sc]) => <tr key={id}><td>{kbd(id as ShortcutId)}</td><td>{sc.label}</td></tr>)}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
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

export function Home() {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const [pasting, setPasting] = useState(false);
  const [recent, setRecent] = useState<RecentPr[]>(() => { flushRecent(); return listRecent(); });
  const [live, setLive] = useState<Map<string, RecentStatus> | null>(null);
  useEffect(() => {
    document.title = 'diff-review';
    const list = listRecent();
    setRecent(list);
    const prs = list.flatMap(e => (isPr(e.ref) ? [prRef(e.ref)] : []));
    if (!prs.length) return;
    let cancelled = false;
    fetchRecentStatus(prs).then(m => { if (!cancelled) setLive(m); }).catch(e => console.warn('recent status unavailable', e));
    return () => { cancelled = true; };
  }, []);
  const origin = location.origin;
  const bookmarklet = `javascript:(()=>{const m=location.href.match(/github\\.com(\\/[^/]+\\/[^/]+\\/(pull\\/\\d+|commit\\/[0-9a-f]+|compare\\/[^?#]+))/);if(m)location.href='${origin}'+m[1];})()`;
  return (
    <div className="home">
      <h2 style={{ margin: 0 }}>diff-review</h2>
      <form onSubmit={e => {
        e.preventDefault();
        const r = parseReviewInput(v);
        if (!r) { setErr('Not a GitHub PR, commit or compare URL'); return; }
        navigate(appPath(r, 'diff'));
      }}>
        <input autoFocus placeholder="GitHub PR, commit or compare URL" value={v} onChange={e => { setV(e.target.value); setErr(''); }} data-1p-ignore />
        <button className="primary" type="submit">Open</button>
        <button type="button" className={pasting ? 'on' : ''} onClick={() => setPasting(!pasting)}>Paste a diff</button>
      </form>
      {err && <div className="del">{err}</div>}
      {pasting && <PasteDiff />}
      {recent.length > 0 && (
        <table className="recent">
          <tbody>
            {recent.map(r => (
              <RecentRow key={recentId(r)} r={r} live={live?.get(recentId(r))} onRemove={() => { removeRecent(r.ref); setRecent(listRecent()); }} />
            ))}
          </tbody>
        </table>
      )}
      <div className="muted">
        Or replace <code style={{ display: 'inline' }}>https://github.com</code> with <code style={{ display: 'inline' }}>{origin}</code> in a PR,
        commit or compare URL. Bookmarklet (drag to your bookmarks bar):{' '}
        {/* React blocks javascript: hrefs, so set it on the DOM node directly */}
        <a ref={el => { el?.setAttribute('href', bookmarklet); }}>Review in diff-review</a>.
        Local changes: run <code style={{ display: 'inline' }}>diff-review</code> in a git repo
        (<code style={{ display: 'inline' }}>diff-review main...</code>, <code style={{ display: 'inline' }}>diff-review -c HEAD</code>,{' '}
        <code style={{ display: 'inline' }}>git diff | diff-review -</code>).
      </div>
    </div>
  );
}

function PasteDiff() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (diff: string) => {
    if (!diff.trim()) return;
    setBusy(true);
    try {
      navigate(`/paste/${await createPaste(diff)}`);
    } catch (e) {
      toast(`Could not store the diff: ${e instanceof Error ? e.message : String(e)}`, true);
      setBusy(false);
    }
  };
  return (
    <div
      className="paste"
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) void f.text().then(t => { setText(t); void go(t); });
      }}
    >
      <textarea
        autoFocus
        rows={10}
        className="mono"
        placeholder="Paste the output of git diff, git show or git format-patch, or drop a .diff/.patch file here"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void go(text); } }}
      />
      <div className="row">
        <span className="faint">⌘↵ to review</span>
        <span className="spacer" />
        <button className="primary" disabled={busy || !text.trim()} onClick={() => void go(text)}>Review</button>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<ReviewRef['kind'], string> = { pr: 'PR', commit: 'commit', compare: 'compare', local: 'local', paste: 'pasted' };

const DECISION: Record<string, [string, string]> = {
  APPROVED: ['approved', 'review-APPROVED'], CHANGES_REQUESTED: ['changes requested', 'review-CHANGES_REQUESTED'], REVIEW_REQUIRED: ['review required', ''],
};
const CI_BUCKET: Record<string, CheckBucket> = { SUCCESS: 'ok', FAILURE: 'fail', ERROR: 'fail', PENDING: 'pending', EXPECTED: 'pending' };

function RecentRow({ r, live, onRemove }: { r: RecentPr; live: RecentStatus | undefined; onRemove: () => void }) {
  const pr = isPr(r.ref);
  const state = live?.state ?? r.state;
  const draft = live?.isDraft ?? r.isDraft;
  const moved = !!live && !!r.headOid && live.headOid !== r.headOid;
  const decision = live?.reviewDecision ? DECISION[live.reviewDecision] : undefined;
  const ci = live?.ci ? CI_BUCKET[live.ci] : undefined;
  const gh = githubUrl(r.ref);
  const href = appPath(r.ref, 'diff');
  return (
    <tr>
      <td className="rtitle">
        <a href={href} onClick={onLinkClick} title={live?.title ?? r.title}>{live?.title ?? r.title}</a>
        <div className="faint">
          <span title={r.ref.kind === 'local' ? r.ref.repo : undefined}>{refLabel(r.ref)}</span>
          {r.files > 0 && <> · {r.viewed}/{r.files} viewed · <span className="add">+{r.additions}</span> <span className="del">−{r.deletions}</span></>}
        </div>
      </td>
      <td>{(pr || r.author) && <UserLink user={r.author} />}</td>
      <td className="chips">
        {pr ? <span className={`chip ${draft ? 'draft' : `state-${state}`}`}>{draft ? 'Draft' : state.toLowerCase()}</span> : <span className="chip">{KIND_LABEL[r.ref.kind]}</span>}
        {ci && <span className={`chip ci-${ci}`} title={`CI: ${live!.ci!.toLowerCase()}`}>CI {BUCKET_ICON[ci]}</span>}
        {decision && <span className={`chip ${decision[1]}`}>{decision[0]}</span>}
        {moved && <span className="chip warn" title="New commits since you last opened it">new commits</span>}
      </td>
      <td className="faint" title={new Date(r.openedAt).toISOString()}>{relTime(new Date(r.openedAt).toISOString())}</td>
      <td className="acts">
        {gh && <a className="btn small" href={gh} target="_blank" rel="noreferrer" title="Open on GitHub">↗</a>}
        <button className="small" title="Remove from this list" onClick={onRemove}>×</button>
      </td>
    </tr>
  );
}
