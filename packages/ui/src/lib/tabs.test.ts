import { describe, it, expect } from 'vitest';
import { isInteractive, visibleTabs, STOPPED_TAB_LIMIT, reorder, tabByStep } from './tabs';
import type { Session } from './api';

const ACTIVE_ID = 'active-session';

function session(overrides: Partial<Session>): Session {
  return { id: 's1', source: 'local', status: 'running', ...overrides } as Session;
}

describe('isInteractive', () => {
  it('accepts a session running in a local tmux session', () => {
    expect(isInteractive(session({ target: { kind: 'tmux', ref: 'cm-7a574cae' } }))).toBe(true);
  });

  it('accepts a session running in a local container', () => {
    expect(isInteractive(session({
      target: { kind: 'docker', ref: 'jira-agent-proj-9583' },
    }))).toBe(true);
  });

  it('accepts a session reached by a transport the UI knows nothing about', () => {
    // The point of keying off `target`: a backend added server-side is
    // interactive here without this file learning its name.
    expect(isInteractive(session({ target: { kind: 'nomad', ref: 'alloc-77' } }))).toBe(true);
  });

  it('rejects a plain local session, which has nothing to type into', () => {
    expect(isInteractive(session({ source: 'local' }))).toBe(false);
  });
});

describe('visibleTabs', () => {
  it('lists everything not hidden when the filter is off', () => {
    const sessions = [session({ id: 'a' }), session({ id: 'b', target: { kind: 'docker', ref: 'jira-agent-proj-1' } })];
    expect(visibleTabs(sessions, { activeId: 'a', interactiveOnly: false }).map(s => s.id))
      .toEqual(['a', 'b']);
  });

  it('drops non-interactive sessions when the filter is on', () => {
    const sessions = [session({ id: 'a' }), session({ id: 'b', target: { kind: 'remote', ref: 'PROJ-9613' } })];
    expect(visibleTabs(sessions, { activeId: 'b', interactiveOnly: true }).map(s => s.id))
      .toEqual(['b']);
  });

  it('drops the session being viewed too, rather than pinning it past the filter', () => {
    const sessions = [
      session({ id: ACTIVE_ID }),
      session({ id: 'agent', target: { kind: 'docker', ref: 'jira-agent-proj-9583' } }),
    ];
    expect(visibleTabs(sessions, { activeId: ACTIVE_ID, interactiveOnly: true }).map(s => s.id))
      .toEqual(['agent']);
  });

  it('keeps hidden sessions out unless one is the session being viewed', () => {
    const sessions = [
      session({ id: ACTIVE_ID, hidden: true }),
      session({ id: 'other', hidden: true }),
      session({ id: 'shown' }),
    ];
    expect(visibleTabs(sessions, { activeId: ACTIVE_ID, interactiveOnly: false }).map(s => s.id))
      .toEqual([ACTIVE_ID, 'shown']);
  });

  it('sorts running sessions ahead of stopped ones and caps the stopped tail', () => {
    const stopped = Array.from({ length: STOPPED_TAB_LIMIT + 2 }, (_, i) =>
      session({ id: `stopped-${i}`, status: 'stopped' }),
    );
    const result = visibleTabs([...stopped, session({ id: 'live' })], {
      activeId: 'live',
      interactiveOnly: false,
    });
    expect(result[0].id).toBe('live');
    expect(result).toHaveLength(STOPPED_TAB_LIMIT + 1);
  });
});

describe('closed tabs', () => {
  it('drops a tab the user closed', () => {
    // Closing a tab is local and reversible; it does not hide the session from
    // the dashboard, which is what the × used to do.
    const sessions = [session({ id: 'a' }), session({ id: 'b' })];
    const closed = new Set(['b']);
    expect(visibleTabs(sessions, { activeId: 'a', interactiveOnly: false, closed }).map(s => s.id))
      .toEqual(['a']);
  });

  it('still lists the session being viewed', () => {
    // Otherwise closing the tab you are on leaves the bar disagreeing with the
    // page you are looking at.
    const sessions = [session({ id: 'a' }), session({ id: 'b' })];
    const closed = new Set(['a']);
    expect(visibleTabs(sessions, { activeId: 'a', interactiveOnly: false, closed }).map(s => s.id))
      .toEqual(['a', 'b']);
  });

  it('behaves as before when nothing is closed', () => {
    const sessions = [session({ id: 'a' }), session({ id: 'b' })];
    expect(visibleTabs(sessions, { activeId: 'a', interactiveOnly: false }).map(s => s.id))
      .toEqual(['a', 'b']);
  });
});

describe('reorder', () => {
  it('moves a tab to the right', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a tab to the left', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('counts positions in the list without the held tab', () => {
    // Index 0 is "before everything else", whichever side it came from — the
    // same number has to mean the same place dragging either way.
    expect(reorder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(reorder(['a', 'b', 'c'], 'a', 0)).toEqual(['a', 'b', 'c']);
  });

  it('clamps an index past the end', () => {
    expect(reorder(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
  });

  it('leaves the list alone when the tab is not in it', () => {
    expect(reorder(['a', 'b'], 'z', 1)).toEqual(['a', 'z', 'b']);
  });
});

describe('tabByStep', () => {
  it('steps right and left', () => {
    expect(tabByStep(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(tabByStep(['a', 'b', 'c'], 'b', -1)).toBe('a');
  });

  it('wraps at both ends', () => {
    // A shortcut that goes dead on the last tab makes you look to find out why.
    expect(tabByStep(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(tabByStep(['a', 'b', 'c'], 'a', -1)).toBe('c');
  });

  it('has nowhere to go with one tab', () => {
    expect(tabByStep(['a'], 'a', 1)).toBeNull();
    expect(tabByStep([], 'a', 1)).toBeNull();
  });

  it('does nothing when the open session has no tab in the strip', () => {
    expect(tabByStep(['a', 'b'], 'zz', 1)).toBeNull();
  });
});
