import { describe, expect, it } from 'vitest';
import { SHORTCUTS, cycleTab, kbd } from './keys.ts';

describe('shortcuts', () => {
  it('cycles views both ways, skipping Conversation outside PRs', () => {
    expect(cycleTab('diff', 1, true)).toBe('overview');
    expect(cycleTab('overview', 1, true)).toBe('conversation');
    expect(cycleTab('conversation', 1, true)).toBe('diff');
    expect(cycleTab('diff', -1, true)).toBe('conversation');
    expect(cycleTab('overview', 1, false)).toBe('diff');
    expect(cycleTab('conversation', 1, false)).toBe('overview');
  });

  it('binds each key once and pairs Shift variants with their lowercase key', () => {
    const keys = SHORTCUTS.flatMap(g => Object.values(g.items).flatMap(s => [...s.keys]));
    expect(new Set(keys).size).toBe(keys.length);
    for (const g of SHORTCUTS) for (const s of Object.values(g.items)) {
      const [a, b] = s.keys as readonly string[];
      if (b && /^[a-z]$/.test(a) && /^[A-Z]$/.test(b)) expect(b).toBe(a.toUpperCase());
    }
  });

  it('writes keys for help and tooltips', () => {
    expect(kbd('collapse')).toBe('x / X');
    expect(kbd('back')).toBe('Esc');
    expect(kbd('finder')).toBe('t');
  });
});
