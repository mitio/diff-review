import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Reaction, ReactionContent } from '../types.ts';
import { fetchReactors } from '../lib/github.ts';
import { REACTIONS, REACTION_EMOJI } from '../lib/reactions.ts';
import { toggleReaction } from './store.ts';

type Reactors = Awaited<ReturnType<typeof fetchReactors>>;
const reactors = new Map<string, Promise<Reactors>>();

function who(r: Reaction, names: Reactors | undefined): string {
  const g = names?.[r.content];
  const emoji = REACTION_EMOJI[r.content];
  if (!g?.logins.length) return `${r.count} reacted with ${emoji}${r.viewerHasReacted ? ', including you' : ''}`;
  const more = g.total - g.logins.length;
  return `${g.logins.join(', ')}${more > 0 ? ` and ${more} more` : ''} reacted with ${emoji}`;
}

/** The reactions on a comment; each toggles the viewer's own. */
export function ReactionChips({ subjectId, reactions }: { subjectId: string; reactions?: Reaction[] }) {
  const [names, setNames] = useState<Reactors>();
  if (!reactions?.length) return null;
  const load = () => {
    if (!reactors.has(subjectId)) reactors.set(subjectId, fetchReactors(subjectId).catch(() => ({})));
    void reactors.get(subjectId)!.then(setNames);
  };
  return (
    <div className="reactions" onMouseEnter={load}>
      {reactions.map(r => (
        <button
          key={r.content}
          className={`reaction${r.viewerHasReacted ? ' on' : ''}`}
          title={who(r, names)}
          onClick={() => { reactors.delete(subjectId); setNames(undefined); void toggleReaction(subjectId, r.content); }}
        >
          {REACTION_EMOJI[r.content]} {r.count}
        </button>
      ))}
    </div>
  );
}

/** GitHub's smiley button: pick one of its eight reactions. */
export function AddReaction({ subjectId, reactions, canReact }: { subjectId: string; reactions?: Reaction[]; canReact?: boolean }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => { if (!pop.current?.contains(e.target as Node) && e.target !== btn.current) setAt(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [at]);
  if (!reactions || !canReact) return null;
  const pick = (c: ReactionContent) => {
    setAt(null);
    reactors.delete(subjectId);
    void toggleReaction(subjectId, c);
  };
  return (
    <>
      <button
        ref={btn}
        className="small"
        title="Add a reaction"
        onClick={() => {
          if (at) return setAt(null);
          const r = btn.current!.getBoundingClientRect();
          setAt({ left: Math.min(r.left, window.innerWidth - 300), top: r.bottom + 4 });
        }}
      >
        ☺+
      </button>
      {at && createPortal(
        <div ref={pop} className="popover reaction-pick" style={at}>
          {REACTIONS.map(([c, emoji]) => (
            <button key={c} className={reactions.some(r => r.content === c && r.viewerHasReacted) ? 'on' : ''} title={c.toLowerCase().replace('_', ' ')} onClick={() => pick(c)}>
              {emoji}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
