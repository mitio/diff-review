import { useMemo, useState } from 'react';
import type { IssueComment, ReviewSummary } from '../types.ts';
import { editIssueComment, postComment, removeIssueComment, useStore } from './store.ts';
import { Body, Editor } from './Thread.tsx';
import { UserLink, relTime } from './bits.tsx';

type Item = { kind: 'comment'; at: string; c: IssueComment } | { kind: 'review'; at: string; r: ReviewSummary };

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed', DISMISSED: 'review dismissed',
};

export function Conversation() {
  const pr = useStore(s => s.pr)!;
  const conv = useStore(s => s.conv);
  const items = useMemo(() => {
    if (!conv) return [];
    const out: Item[] = [
      ...conv.comments.map(c => ({ kind: 'comment' as const, at: c.createdAt, c })),
      ...conv.reviews.filter(r => r.body.trim() || r.state !== 'COMMENTED').map(r => ({ kind: 'review' as const, at: r.submittedAt, r })),
    ];
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [conv]);
  if (!conv) return <div className="center faint">Loading conversation…</div>;
  return (
    <div className="conversation">
      <div className="thread">
        <div className="thead">
          <UserLink user={pr.author} />
          <span className="faint" title={conv.createdAt}>opened {relTime(conv.createdAt)}</span>
        </div>
        <div className="comment">{conv.body.trim() ? <Body c={conv} /> : <div className="faint">No description.</div>}</div>
      </div>
      {conv.truncated && (
        <div className="faint">
          Older comments are not shown. <a href={pr.url} target="_blank" rel="noreferrer">See them on GitHub ↗</a>
        </div>
      )}
      {items.map(it => (it.kind === 'comment' ? <IssueCommentView key={it.c.id} c={it.c} /> : <ReviewView key={it.r.id} r={it.r} />))}
      <div className="thread">
        <div className="thead"><b>Comment on the PR</b><span className="faint">posts immediately, separate from your review</span></div>
        <Editor
          autoFocus={false}
          draftId="conversation"
          placeholder="Leave a comment (Markdown). ⌘↵ to post"
          submitLabel="Comment"
          onSubmit={postComment}
          onCancel={() => (document.activeElement as HTMLElement | null)?.blur()}
        />
      </div>
    </div>
  );
}

function ReviewView({ r }: { r: ReviewSummary }) {
  return (
    <div className={`thread review-${r.state}`}>
      <div className="thead">
        <UserLink user={r.author} />
        <span className={`chip review-${r.state}`}>{REVIEW_LABEL[r.state] ?? r.state.toLowerCase()}</span>
        <a className="faint" href={r.url} target="_blank" rel="noreferrer" title={r.submittedAt}>{relTime(r.submittedAt)}</a>
      </div>
      {r.body.trim() && <div className="comment"><Body c={r} /></div>}
    </div>
  );
}

function IssueCommentView({ c }: { c: IssueComment }) {
  const [editing, setEditing] = useState(false);
  const tmp = c.id.startsWith('tmp-');
  return (
    <div className="thread">
      <div className="thead">
        <UserLink user={c.author} />
        {c.url ? (
          <a className="faint" href={c.url} target="_blank" rel="noreferrer" title={c.createdAt}>{relTime(c.createdAt)}</a>
        ) : (
          <span className="faint">{tmp ? 'posting…' : relTime(c.createdAt)}</span>
        )}
        <span className="spacer" />
        {c.viewerCanUpdate && !editing && <button className="small" onClick={() => setEditing(true)}>Edit</button>}
        {c.viewerCanDelete && !editing && (
          <button className="small danger" onClick={() => { if (confirm('Delete this comment?')) void removeIssueComment(c.id); }}>
            Delete
          </button>
        )}
      </div>
      <div className="comment">
        {editing ? (
          <Editor
            draftId={`edit-issue:${c.id}`}
            initial={c.body}
            submitLabel="Save"
            onSubmit={async body => {
              const ok = await editIssueComment(c.id, body);
              if (ok) setEditing(false);
              return ok;
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <Body c={c} />
        )}
      </div>
    </div>
  );
}
