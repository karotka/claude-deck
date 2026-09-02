import { describe, it, expect } from 'vitest';
import { cacheLaunchedSession, getCachedSessions } from './session-discovery.js';
import type { LaunchedSession } from './launched-sessions.js';

const entry: LaunchedSession = {
  sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  tmuxSession: 'cm-aaaaaaaa',
  cwd: '/Users/someone/projects/thing',
  launchedAt: '2026-08-18T06:00:00.000Z',
};

describe('cacheLaunchedSession', () => {
  it('makes a just-launched session resolvable before the next discovery tick', () => {
    // The UI navigates to /session/<id> the moment launch returns; without this
    // the lookup 404s for up to a full scan interval.
    expect(getCachedSessions().find(s => s.id === entry.sessionId)).toBeUndefined();

    cacheLaunchedSession(entry);

    const cached = getCachedSessions().find(s => s.id === entry.sessionId);
    expect(cached).toBeDefined();
    // Must carry the tmux name, or send/capture can't drive the session.
    expect(cached?.tmuxSession).toBe(entry.tmuxSession);
    expect(cached?.source).toBe('tmux');
    expect(cached?.status).toBe('running');
    expect(cached?.cwd).toBe(entry.cwd);
  });

  it('does not clobber a real session already discovered under that id', () => {
    cacheLaunchedSession(entry);
    const before = getCachedSessions().find(s => s.id === entry.sessionId);
    cacheLaunchedSession({ ...entry, cwd: '/somewhere/else' });
    expect(getCachedSessions().find(s => s.id === entry.sessionId)).toBe(before);
  });
});
