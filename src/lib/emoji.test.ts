import { describe, expect, it } from 'vitest';
import { gemoji } from 'gemoji';
import { emojiQuery, searchEmoji } from './emoji.ts';

describe('emojiQuery', () => {
  it('finds a :query at a word start before the caret', () => {
    expect(emojiQuery(':sm')).toBe('sm');
    expect(emojiQuery('nice (:+1')).toBe('+1');
    expect(emojiQuery('a\n:Tada')).toBe('tada');
  });
  it('ignores colons inside words, times, URLs and finished codes', () => {
    expect(emojiQuery('Note:x')).toBeNull();
    expect(emojiQuery('at 10:30')).toBeNull();
    expect(emojiQuery('https://x')).toBeNull();
    expect(emojiQuery(':smile: ')).toBeNull();
    expect(emojiQuery(':')).toBeNull();
  });
});

describe('searchEmoji', () => {
  it('ranks exact, then prefix, then tag, then substring', () => {
    expect(searchEmoji(gemoji, 'tada')[0]).toEqual({ emoji: '🎉', name: 'tada' });
    expect(searchEmoji(gemoji, '+1')[0]).toEqual({ emoji: '👍', name: '+1' });
    const names = searchEmoji(gemoji, 'smile', 20).map(h => h.name);
    expect(names[0]).toBe('smile');
    expect(names.indexOf('smile_cat')).toBeLessThan(names.indexOf('sweat_smile'));
  });
  it('limits results and returns nothing for no match', () => {
    expect(searchEmoji(gemoji, 's')).toHaveLength(8);
    expect(searchEmoji(gemoji, 'zzzzq')).toEqual([]);
  });
});
