import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  panes: '' as string,
  ps: '' as string,
  fail: null as string | null,
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    if (h.fail === file) return cb(new Error(`${file} failed`), { stdout: '', stderr: '' });
    const stdout = file === 'tmux' ? h.panes : h.ps;
    cb(null, { stdout, stderr: '' });
  },
  spawn: () => { throw new Error('not used'); },
}));

const { tmuxSessionsForPids } = await import('./tmux-ownership.js');

beforeEach(() => {
  h.fail = null;
  // One pane, whose shell (40108) is a child of tmux itself.
  h.panes = '40108 mojevlastni\n';
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
