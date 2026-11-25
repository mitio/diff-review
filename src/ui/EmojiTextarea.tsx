import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type Ref, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { emojiQuery, searchEmoji, type Emoji, type EmojiHit } from '../lib/emoji.ts';

let list: Emoji[] | null = null;
let loading: Promise<Emoji[]> | null = null;
const loadEmoji = () => (loading ??= import('gemoji').then(m => (list = m.gemoji)));

interface Open { hits: EmojiHit[]; i: number; start: number; end: number; left: number; top: number }
const ROW_PX = 26;

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> };

/** A textarea with GitHub's `:emoji` autocomplete; picking one inserts the character. */
export function EmojiTextarea({ ref, onKeyDown, onChange, onSelect, onBlur, ...rest }: Props) {
  const el = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  /** Start of the `:token` closed with Escape; it stays closed until that token ends. */
  const dismissed = useRef<number | null>(null);
  const setRef = useCallback((node: HTMLTextAreaElement | null) => {
    el.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  const update = () => {
    const t = el.current;
    if (!t || t.selectionStart !== t.selectionEnd) return setOpen(null);
    const end = t.selectionStart;
    const q = emojiQuery(t.value.slice(0, end));
    if (q == null) {
      dismissed.current = null;
      return setOpen(null);
    }
    const start = end - q.length - 1;
    if (start === dismissed.current) return setOpen(null);
    if (!list) {
      void loadEmoji().then(() => { if (document.activeElement === t) update(); });
      return;
    }
    const hits = searchEmoji(list, q);
    if (!hits.length) return setOpen(null);
    const c = caretXY(t, start);
    const r = t.getBoundingClientRect();
    let top = r.top + c.y - t.scrollTop + c.h + 2;
    if (top + hits.length * ROW_PX + 8 > window.innerHeight) top = r.top + c.y - t.scrollTop - hits.length * ROW_PX - 10;
    const left = Math.min(r.left + c.x - t.scrollLeft, window.innerWidth - 240);
    setOpen(o => ({ hits, start, end, left, top, i: o && o.start === start && o.end === end ? Math.min(o.i, hits.length - 1) : 0 }));
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e.target !== el.current) setOpen(null); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [!!open]);

  const pick = (h: EmojiHit) => {
    const t = el.current;
    if (!t || !open) return;
    t.focus();
    t.setSelectionRange(open.start, open.end);
    // execCommand keeps native undo; React sees the input event either way
    if (!document.execCommand('insertText', false, h.emoji)) {
      t.setRangeText(h.emoji, open.start, open.end, 'end');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setOpen(null);
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const n = open.hits.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen({ ...open, i: (open.i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(open.hits[open.i]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissed.current = open.start;
        setOpen(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <>
      <textarea
        {...rest}
        ref={setRef}
        onChange={e => { onChange?.(e); update(); }}
        onSelect={e => { onSelect?.(e); update(); }}
        onBlur={e => { onBlur?.(e); setOpen(null); }}
        onKeyDown={keyDown}
      />
      {/* in body: `content-visibility` on file blocks would clip a fixed popup and shift its origin */}
      {open && createPortal(
        <div
          className="popover emoji-pop"
          style={{ left: open.left, top: open.top }}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
        >
          {open.hits.map((h, j) => (
            <div key={h.name} className={`emoji-opt${j === open.i ? ' on' : ''}`} onMouseEnter={() => setOpen({ ...open, i: j })} onClick={() => pick(h)}>
              <span className="emoji">{h.emoji}</span>:{h.name}:
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

const MIRRORED = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight',
  'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize',
] as const;

/** Position of character `pos` inside the textarea's border box, measured with an off-screen copy. */
function caretXY(t: HTMLTextAreaElement, pos: number) {
  const cs = getComputedStyle(t);
  const div = document.createElement('div');
  for (const p of MIRRORED) div.style[p] = cs[p];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden' });
  div.textContent = t.value.slice(0, pos);
  const span = document.createElement('span');
  span.textContent = t.value.slice(pos) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const out = {
    x: span.offsetLeft + parseFloat(cs.borderLeftWidth),
    y: span.offsetTop + parseFloat(cs.borderTopWidth),
    h: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4,
  };
  div.remove();
  return out;
}
