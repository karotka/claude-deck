import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  panes: '' as string,
  ps: '' as string,
  fail: null as string | null,
  /** `ps -eo pid,command` output, for spotting attach clients. */
  commands: '' as string,
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    if (h.fail === file) return cb(new Error(`${file} failed`), { stdout: '', stderr: '' });
    const stdout = file === 'tmux'
      ? h.panes
      : args.includes('pid,command') ? h.commands : h.ps;
    cb(null, { stdout, stderr: '' });
  },
  spawn: () => { throw new Error('not used'); },
}));

const { tmuxSessionsForPids } = await import('./tmux-ownership.js');

beforeEach(() => {
  h.fail = null;
  // One pane, whose shell (40108) is a child of tmux itself.
  h.panes = '40108 mojevlastni\n';
  h.commands = '';
  h.ps = [
    '  PID  PPID',
    '40260 40108',   // claude, inside the pane
    '40108 40107',   // the pane's shell
    '40107     1',   // tmux
    '99999     1',   // something unrelated
  ].join('\n');
});

describe('tmuxSessionsForPids', () => {
  it('finds the tmux session a process is running inside', async () => {
    // The case this exists for: `tmux new -s mojevlastni` then `claude`. No
    // configured prefix, no tag — the naming-convention matcher sees nothing.
    expect(await tmuxSessionsForPids([40260])).toEqual(new Map([[40260, 'mojevlastni']]));
  });

  it('walks past intermediate processes', async () => {
    // `claude` is often a shell function, which adds a level or two between the
    // process and the pane.
    h.ps += '\n40999 40260';
    expect(await tmuxSessionsForPids([40999])).toEqual(new Map([[40999, 'mojevlastni']]));
  });

  it('says nothing about a process that is not inside tmux', async () => {
    expect(await tmuxSessionsForPids([99999])).toEqual(new Map());
  });

  it('treats a pane process as being in its own pane', async () => {
    expect(await tmuxSessionsForPids([40108])).toEqual(new Map([[40108, 'mojevlastni']]));
  });

  it('reports nothing when tmux is unavailable, rather than failing', async () => {
    h.fail = 'tmux';
    expect(await tmuxSessionsForPids([40260])).toEqual(new Map());
  });

  it('reports nothing when the process table cannot be read', async () => {
    h.fail = 'ps';
    expect(await tmuxSessionsForPids([40260])).toEqual(new Map());
  });

  it('does not loop on a cycle in the process table', async () => {
    h.ps = ['  PID  PPID', '500 501', '501 500'].join('\n');
    expect(await tmuxSessionsForPids([500])).toEqual(new Map());
  });

  it('asks nothing when given no pids', async () => {
    expect(await tmuxSessionsForPids([])).toEqual(new Map());
  });
});

describe('paneForSessionId', () => {
  it('matches the short id an attach client was given', async () => {
    // `claude --bg` prints a short id and `claude attach` takes it, while a
    // session id is the full uuid.
    const { paneForSessionId } = await import('./tmux-ownership.js');
    const attached = new Map([['b5cfa1b3', 'deckview']]);
    expect(paneForSessionId('b5cfa1b3-9bc1-4d13-bea1-f0f8f0962449', attached)).toBe('deckview');
  });

  it('prefers an exact match over a prefix', async () => {
    const { paneForSessionId } = await import('./tmux-ownership.js');
    const attached = new Map([['abc123', 'short'], ['abc123-full', 'exact']]);
    expect(paneForSessionId('abc123-full', attached)).toBe('exact');
  });

  it('says nothing about a session nobody has attached', async () => {
    const { paneForSessionId } = await import('./tmux-ownership.js');
    expect(paneForSessionId('other-session', new Map([['abc123', 'x']]))).toBeUndefined();
  });
});

describe('tmuxSessionsForAttachedIds', () => {
  it('finds the pane a `claude attach` client is running in', async () => {
    // A background session lives under the daemon, in no pane at all, so
    // walking up from its own pid never reaches tmux. The client is the view.
    h.panes = '40108 deckview\n';
    h.ps = ['  PID  PPID', '40260 40108', '40108 40107', '40107     1'].join('\n');
    h.commands = ['  PID COMMAND', '40260 claude attach b5cfa1b3'].join('\n');
    const { tmuxSessionsForAttachedIds } = await import('./tmux-ownership.js');
    expect(await tmuxSessionsForAttachedIds()).toEqual(new Map([['b5cfa1b3', 'deckview']]));
  });

  it('is not fooled by a command line that merely mentions both words', async () => {
    // Running anything from a directory called claude-deck used to be enough.
    h.panes = '40108 deckview\n';
    h.ps = ['  PID  PPID', '40260 40108', '40108 40107'].join('\n');
    h.commands = [
      '  PID COMMAND',
      '40260 node /Users/me/git/claude-deck/x.js --print attach abc123',
    ].join('\n');
    const { tmuxSessionsForAttachedIds } = await import('./tmux-ownership.js');
    expect(await tmuxSessionsForAttachedIds()).toEqual(new Map());
  });

  it('ignores an attach client that is not in any pane', async () => {
    h.panes = '40108 deckview\n';
    h.ps = ['  PID  PPID', '99999     1'].join('\n');
    h.commands = ['  PID COMMAND', '99999 claude attach b5cfa1b3'].join('\n');
    const { tmuxSessionsForAttachedIds } = await import('./tmux-ownership.js');
    expect(await tmuxSessionsForAttachedIds()).toEqual(new Map());
  });
});
