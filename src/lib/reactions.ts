import type { Reaction, ReactionContent } from '../types.ts';

/** GitHub's reactions, in its order. */
export const REACTIONS: Array<[ReactionContent, string]> = [
  ['THUMBS_UP', '👍'], ['THUMBS_DOWN', '👎'], ['LAUGH', '😄'], ['HOORAY', '🎉'],
  ['CONFUSED', '😕'], ['HEART', '❤️'], ['ROCKET', '🚀'], ['EYES', '👀'],
];
export const REACTION_EMOJI = Object.fromEntries(REACTIONS) as Record<ReactionContent, string>;
const ORDER = REACTIONS.map(([c]) => c);

/** The list after the viewer adds (`on`) or removes their `content` reaction. */
export function bump(list: Reaction[], content: ReactionContent, on: boolean): Reaction[] {
  const cur = list.find(r => r.content === content);
  if (cur && cur.viewerHasReacted === on) return list;
  const next = cur
    ? list.map(r => (r === cur ? { ...r, count: r.count + (on ? 1 : -1), viewerHasReacted: on } : r))
    : on ? [...list, { content, count: 1, viewerHasReacted: true }] : list;
  return next.filter(r => r.count > 0).sort((a, b) => ORDER.indexOf(a.content) - ORDER.indexOf(b.content));
}
