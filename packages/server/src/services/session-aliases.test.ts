import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSessionSuccession,
  resolveSessionId,
  clearSessionAliases,
  sessionAliasCount,
  MAX_SESSION_ALIASES,
  successionsFromProcesses,
} from './session-aliases.js';

describe('session aliases', () => {
  beforeEach(() => {
    clearSessionAliases();
  });

  it('returns the id unchanged when nothing succeeded it', () => {
    expect(resolveSessionId('unknown-id')).toBe('unknown-id');
  });

  it('resolves a retired id to the session that replaced it', () => {
    recordSessionSuccession('old-id', 'new-id');
    expect(resolveSessionId('old-id')).toBe('new-id');
  });

  it('leaves the current id alone', () => {
    recordSessionSuccession('old-id', 'new-id');
    expect(resolveSessionId('new-id')).toBe('new-id');
  });

  it('follows a chain of restarts to the newest id', () => {
    // A container restarted three times: the tab still holds the first id.
    recordSessionSuccession('id-1', 'id-2');
    recordSessionSuccession('id-2', 'id-3');
    expect(resolveSessionId('id-1')).toBe('id-3');
    expect(resolveSessionId('id-2')).toBe('id-3');
  });

  it('re-points every older id at the newest one, so lookups stay O(1)', () => {
    recordSessionSuccession('id-1', 'id-2');
    recordSessionSuccession('id-2', 'id-3');
    recordSessionSuccession('id-3', 'id-4');
    expect(resolveSessionId('id-1')).toBe('id-4');
  });

  it('ignores a self-succession', () => {
    recordSessionSuccession('same', 'same');
    expect(sessionAliasCount()).toBe(0);
  });

  it('ignores blank ids', () => {
    recordSessionSuccession('', 'new-id');
    recordSessionSuccession('old-id', '');
    expect(sessionAliasCount()).toBe(0);
  });

  it('survives a cycle without hanging', () => {
    // Shouldn't happen, but an id reappearing (transcript restored from a
    // backup, a container rolled back) must not spin resolveSessionId forever.
    recordSessionSuccession('a', 'b');
    recordSessionSuccession('b', 'a');
    expect(['a', 'b']).toContain(resolveSessionId('a'));
  });

  it('evicts the oldest entries past the cap', () => {
    for (let i = 0; i < MAX_SESSION_ALIASES + 10; i++) {
      recordSessionSuccession(`old-${i}`, `new-${i}`);
    }
    expect(sessionAliasCount()).toBeLessThanOrEqual(MAX_SESSION_ALIASES);
    // The most recent successions are the ones worth keeping.
    expect(resolveSessionId(`old-${MAX_SESSION_ALIASES + 9}`)).toBe(
      `new-${MAX_SESSION_ALIASES + 9}`,
    );
  });
});

describe('successionsFromProcesses', () => {
  const entry = (sessionId: string, ...pids: number[]) => ({ sessionId, pids });

  it('reports a process that has changed transcript', () => {
    // What `/clear` does: same process, new conversation, new session id. An
    // open tab addresses the old id, and without a succession it points at a
    // session that has stopped while the work continues elsewhere.
    const lastSeen = new Map([[42, 'before']]);
    expect(successionsFromProcesses([entry('after', 42)], lastSeen))
      .toEqual([{ from: 'before', to: 'after' }]);
    expect(lastSeen.get(42)).toBe('after');
  });

  it('reports nothing the first time a process is seen', () => {
    const lastSeen = new Map<number, string>();
    expect(successionsFromProcesses([entry('first', 42)], lastSeen)).toEqual([]);
    expect(lastSeen.get(42)).toBe('first');
  });

  it('reports nothing while the transcript is unchanged', () => {
    const lastSeen = new Map([[42, 'same']]);
    expect(successionsFromProcesses([entry('same', 42)], lastSeen)).toEqual([]);
  });

  it('forgets a process that has gone, so a recycled pid inherits nothing', () => {
    const lastSeen = new Map([[42, 'old'], [43, 'other']]);
    successionsFromProcesses([entry('other', 43)], lastSeen);
    expect(lastSeen.has(42)).toBe(false);

    // 42 comes back as a different program entirely; it must not be treated as
    // the old session having moved.
    expect(successionsFromProcesses([entry('unrelated', 42), entry('other', 43)], lastSeen))
      .toEqual([]);
  });

  it('follows every process of a conversation that is open twice', () => {
    const lastSeen = new Map([[42, 'before'], [43, 'before']]);
    expect(successionsFromProcesses([entry('after', 42, 43)], lastSeen)).toEqual([
      { from: 'before', to: 'after' },
      { from: 'before', to: 'after' },
    ]);
  });
});
