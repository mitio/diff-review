import { fuzzyFind } from './fuzzy.ts';

export interface Emoji { emoji: string; names: string[]; tags: string[] }
export interface EmojiHit { emoji: string; name: string }

/** The `:query` being typed right before the caret, GitHub-style: `:` starts a word, then name chars. */
export function emojiQuery(beforeCaret: string): string | null {
  const m = /(?:^|[\s([{]):([a-z0-9_+-]+)$/i.exec(beforeCaret);
  return m ? m[1].toLowerCase() : null;
}

const byName = new WeakMap<Emoji[], { names: string[]; emoji: Map<string, string> }>();
function names(list: Emoji[]) {
  let n = byName.get(list);
  if (!n) {
    n = { names: list.flatMap(e => e.names), emoji: new Map(list.flatMap(e => e.names.map(name => [name, e.emoji]))) };
    byName.set(list, n);
  }
  return n;
}

/**
 * Exact name, then names starting with `q` (shortest first), tag matches, names containing it, in gemoji order; then
 * names holding `q`'s letters in order (`thup` → thumbsup), best fuzzy score first.
 */
export function searchEmoji(list: Emoji[], q: string, limit = 8): EmojiHit[] {
  const ranked: Array<EmojiHit & { rank: number; i: number }> = [];
  list.forEach((e, i) => {
    let best: { rank: number; name: string } | null = null;
    for (const name of e.names) {
      const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 3 : -1;
      if (rank >= 0 && (!best || rank < best.rank)) best = { rank, name };
    }
    if (!best && e.tags.some(t => t.startsWith(q))) best = { rank: 2, name: e.names[0] };
    if (best) ranked.push({ emoji: e.emoji, name: best.name, rank: best.rank, i });
  });
  const hits = ranked
    .sort((a, b) => a.rank - b.rank || (a.rank === 1 ? a.name.length - b.name.length : 0) || a.i - b.i)
    .slice(0, limit)
    .map(({ emoji, name }) => ({ emoji, name }));
  if (hits.length < limit && q.length > 1) {
    const all = names(list);
    const seen = new Set(hits.map(h => h.emoji));
    for (const { path: name } of fuzzyFind(all.names, q, limit * 4)) {
      const emoji = all.emoji.get(name)!;
      if (seen.has(emoji)) continue;
      seen.add(emoji);
      hits.push({ emoji, name });
      if (hits.length === limit) break;
    }
  }
  return hits;
}
