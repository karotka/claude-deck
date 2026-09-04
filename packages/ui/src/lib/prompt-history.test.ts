import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadHistory,
  rememberPrompt,
  stepHistory,
  MAX_ENTRIES,
  MAX_SESSIONS,
} from './prompt-history';

// The UI suite runs in node, where there is no localStorage. A few lines of
// map is all this module needs, and it keeps the whole suite off jsdom for one
// file's sake.
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string) { return this.data.has(k) ? this.data.get(k)! : null; }
  setItem(k: string, v: string) { this.data.set(k, String(v)); }
  removeItem(k: string) { this.data.delete(k); }
  clear() { this.data.clear(); }
}
(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();

beforeEach(() => localStorage.clear());

describe('rememberPrompt', () => {
  it('puts the most recent first', () => {
    rememberPrompt('s1', 'first');
    rememberPrompt('s1', 'second');
    expect(loadHistory('s1')).toEqual(['second', 'first']);
  });

  it('keeps sessions apart', () => {
    rememberPrompt('s1', 'mine');
    rememberPrompt('s2', 'theirs');
    expect(loadHistory('s1')).toEqual(['mine']);
    expect(loadHistory('s2')).toEqual(['theirs']);
  });

  it('does not record blank sends', () => {
    rememberPrompt('s1', '   ');
    expect(loadHistory('s1')).toEqual([]);
  });

  it('does not record an immediate repeat twice', () => {
    // Sending the same thing again is one thing you might want back, not two.
    rememberPrompt('s1', 'again');
    rememberPrompt('s1', 'again');
    expect(loadHistory('s1')).toEqual(['again']);
  });

  it('records a repeat that is not immediate', () => {
    rememberPrompt('s1', 'a');
    rememberPrompt('s1', 'b');
    rememberPrompt('s1', 'a');
    expect(loadHistory('s1')).toEqual(['a', 'b', 'a']);
  });

  it('caps a session at MAX_ENTRIES', () => {
    for (let i = 0; i < MAX_ENTRIES + 10; i++) rememberPrompt('s1', `msg ${i}`);
    expect(loadHistory('s1')).toHaveLength(MAX_ENTRIES);
    expect(loadHistory('s1')[0]).toBe(`msg ${MAX_ENTRIES + 9}`);
  });

  it('bounds the store, keeping the session being written to', () => {
    for (let i = 0; i < MAX_SESSIONS + 5; i++) rememberPrompt(`s${i}`, 'x');
    const kept = Object.keys(JSON.parse(localStorage.getItem('claude-deck-prompt-history')!));
    expect(kept.length).toBeLessThanOrEqual(MAX_SESSIONS);
    expect(loadHistory(`s${MAX_SESSIONS + 4}`)).toEqual(['x']);
  });

  it('survives a corrupt store rather than throwing into a send', () => {
    localStorage.setItem('claude-deck-prompt-history', 'not json');
    expect(loadHistory('s1')).toEqual([]);
    expect(rememberPrompt('s1', 'ok')).toEqual(['ok']);
  });
});

describe('stepHistory', () => {
  it('walks back from the draft into the most recent entry', () => {
    expect(stepHistory(3, -1, 'older')).toBe(0);
  });

  it('stops at the oldest instead of wrapping', () => {
    // Wrapping to the newest would look like the key had done nothing.
    expect(stepHistory(3, 2, 'older')).toBe(2);
  });

  it('comes forward to -1, which is where the draft is put back', () => {
    expect(stepHistory(3, 0, 'newer')).toBe(-1);
  });

  it('stays at -1 once the draft is back', () => {
    expect(stepHistory(3, -1, 'newer')).toBe(-1);
  });

  it('has nowhere to go with no history', () => {
    expect(stepHistory(0, -1, 'older')).toBe(-1);
  });
});
