import { describe, expect, it } from 'vitest';
import { bump } from './reactions.ts';

describe('bump', () => {
  const heart = { content: 'HEART' as const, count: 2, viewerHasReacted: false };
  it('adds in GitHub order and counts the viewer', () => {
    expect(bump([heart], 'THUMBS_UP', true)).toEqual([{ content: 'THUMBS_UP', count: 1, viewerHasReacted: true }, heart]);
    expect(bump([heart], 'HEART', true)).toEqual([{ content: 'HEART', count: 3, viewerHasReacted: true }]);
  });
  it('removes the viewer and drops empty reactions', () => {
    expect(bump([{ content: 'EYES', count: 1, viewerHasReacted: true }], 'EYES', false)).toEqual([]);
    expect(bump([heart], 'HEART', false)).toEqual([heart]);
  });
});
