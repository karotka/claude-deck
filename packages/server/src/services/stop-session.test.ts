import { describe, it, expect, vi } from 'vitest';
import { stopSession, backgroundHandle, isOwnTmuxSession, isBackground } from './stop-session.js';
import type { StopDeps } from './stop-session.js';
import type { Session } from '../types.js';

function deps(): StopDeps & { runs: [string, string[]][]; kills: [number, string][] } {
  const runs: [string, string[]][] = [];
  const kills: [number, string][] = [];
  return {
    runs,
    kills,
    run: async (file, args) => { runs.push([file, args]); },
    kill: (pid, signal) => { kills.push([pid, signal]); },
  };
}

function session(over: Partial<Session>): Session {
  return {
    id: 'eb1c3b37-7810-48a1-9f52-6162d6ceece0',
    projectHash: '-x',
    projectPath: '/x',
    jsonlPath: '/x.jsonl',
    status: 'idle',
    pid: 4242,
    live: true,
    ...over,
  } as Session;
}

describe('backgroundHandle', () => {
  it('is the first segment of the session id, which is what claude stop takes', () => {
    expect(backgroundHandle('eb1c3b37-7810-48a1-9f52-6162d6ceece0')).toBe('eb1c3b37');
  });
});

describe('isOwnTmuxSession', () => {
  it('recognises a session this app launched', () => {
    expect(isOwnTmuxSession('cm-eb2c5f99')).toBe(true);
  });

  it('does not claim one the user named', () => {
    expect(isOwnTmuxSession('radius')).toBe(false);
  });
});

describe('stopSession', () => {
  it('uses claude stop for a background session, which keeps the conversation', async () => {
    const d = deps();
    const how = await stopSession(session({ liveKind: 'background' }), d);
    expect(how).toBe('claude stop');
    expect(d.runs).toEqual([['claude', ['stop', 'eb1c3b37']]]);
    expect(d.kills).toEqual([]);
  });

  it('kills a tmux session this app launched', async () => {
    const d = deps();
    const how = await stopSession(
      session({ liveKind: 'interactive', target: { kind: 'tmux', ref: 'cm-eb2c5f99' } }),
      d,
    );
    expect(how).toBe('tmux kill-session');
    expect(d.runs).toEqual([['tmux', ['kill-session', '-t', 'cm-eb2c5f99']]]);
  });

  it("leaves a tmux session the user set up alone, and signals the process instead", async () => {
    // Removing someone's own tmux session is closing their terminal for them.
    const d = deps();
    const how = await stopSession(
      session({ liveKind: 'interactive', target: { kind: 'tmux', ref: 'radius' } }),
      d,
    );
    expect(how).toBe('SIGTERM');
    expect(d.runs).toEqual([]);
    expect(d.kills).toEqual([[4242, 'SIGTERM']]);
  });

  it('never escalates past SIGTERM', async () => {
    const d = deps();
    await stopSession(session({ liveKind: 'interactive' }), d);
    expect(d.kills.map(k => k[1])).toEqual(['SIGTERM']);
  });

  it('refuses when there is no process here to stop', async () => {
    const d = deps();
    await expect(
      stopSession(session({ liveKind: 'interactive', pid: null }), d),
    ).rejects.toThrow(/no process on this machine/);
  });

  it('prefers claude stop over the signal when both would work', async () => {
    // The reversible option first: a stopped background session can be resumed.
    const d = deps();
    await stopSession(session({ liveKind: 'background', pid: 999 }), d);
    expect(d.kills).toEqual([]);
  });
});

describe('isBackground', () => {
  it('accepts both names the registry uses for the same thing', () => {
    // The per-pid file says `bg`; `claude agents --json` says `background`.
    expect(isBackground('bg')).toBe(true);
    expect(isBackground('background')).toBe(true);
  });

  it('is not an interactive session, and not nothing', () => {
    expect(isBackground('interactive')).toBe(false);
    expect(isBackground(undefined)).toBe(false);
  });
});

describe('stopSession with the registry spelling', () => {
  it('uses claude stop for a session the registry calls bg', async () => {
    // This is the spelling a real --bg session actually has on disk; matching
    // only `background` sent every one of them to a signal instead.
    const d = deps();
    const how = await stopSession(session({ liveKind: 'bg' }), d);
    expect(how).toBe('claude stop');
    expect(d.runs).toEqual([['claude', ['stop', 'eb1c3b37']]]);
  });
});
