import { memo, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { Comment, NewThread, Thread } from '../types.ts';
import { createThread, draftKey, editComment, isLocalReview, pendingIn, removeComment, reply, setResolved, useStore } from './store.ts';
import { UserLink, relTime } from './bits.tsx';

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer');
  }
});

/** `key` is a full draftKey(), resolved when the editor mounts so a late save can't land on another PR. */
const loadDraft = (key: string) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const saveDraft = (key: string, v: string) => {
  try {
    if (v) localStorage.setItem(key, v);
    else localStorage.removeItem(key);
  } catch { /* ignore */ }
};

export function Editor({ draftId, initial, placeholder, submitLabel, onSubmit, onCancel, autoFocus = true }: {
  draftId: string;
  autoFocus?: boolean;
  initial?: string;
  placeholder?: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [key] = useState(() => draftKey(draftId));
  const [text, setText] = useState(() => loadDraft(key) ?? initial ?? '');
  const latest = useRef(text);
  latest.current = text;
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current!;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollIntoView({ block: 'nearest' });
  }, []);
  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    saveDraft(key, '');
    const ok = await onSubmit(body);
    setSending(false);
    if (!ok) saveDraft(key, text);
    else if (latest.current === text) setText('');
  };
  return (
    <div className="composer" onClick={e => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        placeholder={placeholder ?? 'Leave a comment (Markdown). ⌘↵ to add, Esc to cancel'}
        onChange={e => {
          setText(e.target.value);
          saveDraft(key, e.target.value);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            if (!text.trim() || text === initial) saveDraft(key, '');
            onCancel();
          }
        }}
      />
      <div className="row">
        <span className="faint">⌘↵ to {submitLabel.toLowerCase()} · Esc to cancel</span>
        <span className="spacer" />
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!text.trim() || sending} onClick={() => void send()}>{submitLabel}</button>
      </div>
    </div>
  );
}

/** GitHub's wording: every PR comment goes into the viewer's pending review. */
function useReviewLabel() {
  const local = useStore(s => isLocalReview(s));
  const started = useStore(s => !!s.pendingReviewId);
  return local ? 'Add comment' : started ? 'Add review comment' : 'Start a review';
}

export function NewComment({ path, label, initial, target, onDone }: {
  path: string;
  label?: string;
  initial?: string;
  target: NewThread;
  onDone: () => void;
}) {
  const submitLabel = useReviewLabel();
  return (
    <div className="thread">
      <div className="thead"><b>{label ?? 'Comment on file'}</b></div>
      <Editor
        draftId={`new:${path}:${target.subjectType}`}
        initial={initial}
        submitLabel={submitLabel}
        onSubmit={async body => {
          onDone();
          return createThread({ ...target, body });
        }}
        onCancel={onDone}
      />
    </div>
  );
}

export const Body = memo(function Body({ c }: { c: Pick<Comment, 'body' | 'bodyHTML'> }) {
  if (!c.bodyHTML) return <div className="md" style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>;
  return <div className="md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(c.bodyHTML) }} />;
});

function CommentView({ c }: { c: Comment }) {
  const [editing, setEditing] = useState(false);
  const tmp = c.id.startsWith('tmp-');
  return (
    <div className={`comment${c.state === 'PENDING' ? ' pending' : ''}`}>
      <div className="meta">
        <UserLink user={c.author} />
        {c.url ? (
          <a className="faint" href={c.url} target="_blank" rel="noreferrer" title={c.createdAt}>{relTime(c.createdAt)}</a>
        ) : (
          <span className="faint">{tmp ? 'saving…' : relTime(c.createdAt)}</span>
        )}
        {c.state === 'PENDING' && <span className="chip pending" title="Only you can see this until you finish your review">Pending</span>}
        <span className="spacer" />
        {c.viewerCanUpdate && !editing && <button className="small" onClick={() => setEditing(true)}>Edit</button>}
        {c.viewerCanDelete && !editing && (
          <button className="small danger" onClick={() => { if (confirm('Delete this comment?')) void removeComment(c.id); }}>
            Delete
          </button>
        )}
      </div>
      {editing ? (
        <Editor
          draftId={`edit:${c.id}`}
          initial={c.body}
          submitLabel="Save"
          onSubmit={async body => {
            const ok = await editComment(c.id, body);
            if (ok) setEditing(false);
            return ok;
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Body c={c} />
      )}
    </div>
  );
}

export const ThreadView = memo(function ThreadView({ thread, showLocation }: { thread: Thread; showLocation?: boolean }) {
  const [open, setOpen] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const tmp = thread.id.startsWith('tmp-');
  const pendingReview = useStore(s => s.pendingReviewId);
  const replyLabel = useReviewLabel();
  const nPending = pendingIn([thread]);
  const first = thread.comments[0];
  const where = thread.subjectType === 'FILE'
    ? 'file'
    : thread.line != null
      ? `${thread.side === 'LEFT' ? 'old ' : ''}line ${thread.startLine && thread.startLine !== thread.line ? `${thread.startLine}–` : ''}${thread.line}`
      : `outdated · was line ${thread.originalLine ?? '?'}`;
  return (
    <div className={`thread${thread.isResolved ? ' resolved' : ''}${open ? '' : ' collapsed'}${nPending ? ' pending' : ''}`}>
      <div className="thead">
        <button className="link" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button>
        {(showLocation || thread.isOutdated) && <span className="muted">{where}</span>}
        {thread.isOutdated && <span className="chip warn">outdated</span>}
        {thread.isResolved && <span className="chip">resolved</span>}
        {nPending > 0 && <span className="chip pending" title="Only you can see pending comments until you finish your review">{nPending === thread.comments.length ? 'Pending' : `${nPending} pending`}</span>}
        {!open && first && (
          <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <b>{first.author?.login}</b>: {first.body.slice(0, 120)}
          </span>
        )}
        <span className="spacer" />
        <span className="faint">{thread.comments.length}</span>
        {thread.viewerCanResolve && !thread.isResolved && (
          <button className="small" onClick={() => { setOpen(false); void setResolved(thread.id, true); }}>Resolve</button>
        )}
        {thread.viewerCanUnresolve && thread.isResolved && (
          <button className="small" onClick={() => { setOpen(true); void setResolved(thread.id, false); }}>Unresolve</button>
        )}
      </div>
      {open && thread.comments.map(c => <CommentView key={c.id} c={c} />)}
      {open && !tmp && (thread.viewerCanReply || pendingReview) && (
        replying ? (
          <Editor
            draftId={`reply:${thread.id}`}
            submitLabel={replyLabel}
            onSubmit={async body => {
              setReplying(false);
              return reply(thread.id, body);
            }}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <div className="composer">
            <input type="text" placeholder="Reply…" onFocus={() => setReplying(true)} readOnly />
          </div>
        )
      )}
    </div>
  );
});
