import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[] }[],
}));

vi.mock('node:fs/promises', () => ({
  default: { access: async () => undefined },
  access: async () => undefined,
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    h.calls.push({ file, args });
    cb(null, { stdout: '', stderr: '' });
  },
  spawn: () => { throw new Error('not used'); },
}));

import { launch, derivePhase, namesFor, buildCommand } from './launcher.js';
import type { LauncherConfig } from '../config-file.js';

beforeEach(() => {
  h.calls.length = 0;
});

const newSession = () => h.calls.find(c => c.args[0] === 'new-session')!;

describe('launch', () => {
  // The environment the test suite pins (see test/setup-env.ts) sets both
  // LAUNCH_SCRIPT and REMOTE_SCRIPT, which config.ts turns into the
  // two-launcher list a config file would otherwise supply.
  it('runs the first launcher by default, in a detached tmux named for the tag', async () => {
    const result = await launch('proj-1234');

    expect(result).toMatchObject({
      tag: 'PROJ-1234',
      launcherId: 'local',
      launchSession: 'jira-launch-proj-1234',
      containerName: 'jira-agent-proj-1234',
    });
    const { file, args } = newSession();
    expect(file).toBe('tmux');
    expect(args).toContain('jira-launch-proj-1234');
    expect(args.at(-2)).toMatch(/start-agent\.sh$/);
    expect(args.at(-1)).toBe('PROJ-1234');
  });

  it('runs a named launcher, under its own launch-session name', async () => {
    const result = await launch('PROJ-1234', 'vm');

    // Distinct launch-session names are what let the same tag be started by two
    // launchers at once without one killing the other's tmux.
    expect(result).toMatchObject({
      tag: 'PROJ-1234',
      launcherId: 'vm',
      launchSession: 'jira-launch-vm-proj-1234',
      containerName: 'jira-agent-proj-1234',
    });
    const { args } = newSession();
    expect(args).toContain('jira-launch-vm-proj-1234');
    expect(args.at(-3)).toMatch(/agent-on-vm\.sh$/);
    expect(args.slice(-2)).toEqual(['start', 'PROJ-1234']);
  });

  it('spells out the remote target, since tmux would not inherit it', async () => {
    await launch('PROJ-1234', 'vm');

    // tmux runs the command in the tmux server's environment. Leaving this
    // implicit would start the container on whatever instance the script
    // defaults to, not the one the UI is polling.
    const { args } = newSession();
    expect(args).toContain('env');
    expect(args.some(a => a.startsWith('AGENT_VM_NAME='))).toBe(true);
  });

  it('does not prefix `env` for a local launcher that needs nothing', async () => {
    await launch('PROJ-1234', 'local');
    expect(newSession().args).not.toContain('env');
  });

  it('names an unknown launcher rather than silently using another', async () => {
    await expect(launch('PROJ-1234', 'nope')).rejects.toThrow(/No launcher named "nope"/);
    expect(h.calls).toHaveLength(0);
  });

  it('rejects a malformed tag before spawning anything', async () => {
    await expect(launch('not a key')).rejects.toThrow(/not a valid key/);
    expect(h.calls).toHaveLength(0);
  });

  it('says how to configure a launcher when there are none', async () => {
    const saved = {
      local: process.env.LAUNCH_SCRIPT,
      vm: process.env.REMOTE_SCRIPT,
    };
    delete process.env.LAUNCH_SCRIPT;
    delete process.env.REMOTE_SCRIPT;
    vi.resetModules();
    try {
      const { launch: unconfigured } = await import('./launcher.js');
      await expect(unconfigured('PROJ-1234')).rejects.toThrow(/No launchers are configured/);
      expect(h.calls.some(c => c.args[0] === 'new-session')).toBe(false);
    } finally {
      process.env.LAUNCH_SCRIPT = saved.local;
      process.env.REMOTE_SCRIPT = saved.vm;
      vi.resetModules();
    }
  });
});

describe('buildCommand', () => {
  const launcher: LauncherConfig = {
    id: 'x',
    label: 'X',
    command: ['./go.sh', '--issue={{tag}}', 'work/{{tag}}/dir'],
  };

  it('substitutes the tag into every argument, however it is embedded', () => {
    expect(buildCommand(launcher, 'PROJ-1')).toEqual([
      './go.sh', '--issue=PROJ-1', 'work/PROJ-1/dir',
    ]);
  });

  it('passes the command as argv, so nothing is re-parsed by a shell', () => {
    // A tag can only ever land in one argument slot, which is why no quoting or
    // escaping rules apply to a launcher command.
    expect(buildCommand({ ...launcher, command: ['./go.sh', '{{tag}}'] }, 'A B; rm -rf /'))
      .toEqual(['./go.sh', 'A B; rm -rf /']);
  });
});

describe('namesFor', () => {
  it('derives both names from the launcher\'s own prefixes', () => {
    expect(namesFor(
      { id: 'x', label: 'X', command: ['a'], launchPrefix: 'go-', containerPrefix: 'agent-' },
      'PROJ-1',
    )).toEqual({ launchSession: 'go-proj-1', containerName: 'agent-proj-1' });
  });

  it('falls back to the launcher id when no launch prefix is given', () => {
    expect(namesFor({ id: 'worktree', label: 'W', command: ['a'] }, 'PROJ-1').launchSession)
      .toBe('worktree-launch-proj-1');
  });

  it('reports no container for a launcher that makes none', () => {
    // A launcher that starts a worktree rather than a container has nothing to
    // inspect; its progress is whatever its tmux pane says.
    expect(namesFor({ id: 'w', label: 'W', command: ['a'] }, 'PROJ-1').containerName).toBeNull();
  });
});

describe('derivePhase', () => {
  it('is ready as soon as the container runs, wherever it runs', () => {
    expect(derivePhase(true, 'running', '', null)).toBe('ready');
    expect(derivePhase(false, 'running', '', 'RUNNING')).toBe('ready');
  });

  it('reports booting while a remote launch is still bringing the host up', () => {
    // Minutes of boot would otherwise read as a stalled "starting".
    expect(derivePhase(true, 'missing', '==> starting agent-vm...', 'TERMINATED'))
      .toBe('booting');
    expect(derivePhase(true, 'missing', '', 'STAGING')).toBe('booting');
  });

  it('does not report booting for a local launch', () => {
    expect(derivePhase(true, 'missing', '', null)).toBe('starting');
  });

  it('reports building once the image build starts', () => {
    expect(derivePhase(true, 'missing', '[+] Building 12.3s', 'RUNNING')).toBe('building');
  });

  it('fails when the launch tmux is gone and nothing came up', () => {
    expect(derivePhase(false, 'missing', '', null)).toBe('failed');
    expect(derivePhase(false, 'exited', '', 'RUNNING')).toBe('failed');
  });
});
