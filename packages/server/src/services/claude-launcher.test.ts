import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture tmux invocations instead of driving a real tmux server. `vi.hoisted`
// runs before the (also hoisted) mock factory, so the arrays exist when it runs.
const h = vi.hoisted(() => ({
  execCalls: [] as { file: string; args: string[] }[],
  // Value returned for `tmux display-message -p '#{pane_current_command}'`.
  paneCommand: 'zsh',
  statIsDirectory: true,
  statThrows: false,
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    h.execCalls.push({ file, args });
    const stdout = args.includes('display-message') ? `${h.paneCommand}\n` : '';
    cb(null, { stdout, stderr: '' });
  },
  spawn: () => { throw new Error('spawn should not be used by the launcher'); },
}));

vi.mock('node:fs/promises', () => ({
  default: {
    stat: async () => {
      if (h.statThrows) throw new Error('ENOENT');
      return { isDirectory: () => h.statIsDirectory };
    },
    readFile: async () => { throw new Error('ENOENT'); },
    writeFile: async () => {},
  },
}));

const { launchClaudeSession, killLaunchedSession } = await import('./claude-launcher.js');
const { getLaunchedSessions } = await import('./launched-sessions.js');

const tmuxArgs = (verb: string) =>
  h.execCalls.find(c => c.file === 'tmux' && c.args[0] === verb)?.args ?? [];

beforeEach(() => {
  h.execCalls.length = 0;
  h.paneCommand = 'zsh';
  h.statIsDirectory = true;
  h.statThrows = false;
});

describe('launchClaudeSession', () => {
  it('creates a detached tmux session rooted at the requested cwd', async () => {
    const result = await launchClaudeSession('/some/project');

    const args = tmuxArgs('new-session');
    expect(args).toContain('-d');
    expect(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2)).toEqual(['-c', '/some/project']);
    expect(result.cwd).toBe('/some/project');
  });

  it('assigns the session id up front so discovery can match it exactly', async () => {
    const result = await launchClaudeSession('/some/project');

    // The id must be a real uuid — it becomes the JSONL filename Claude writes.
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const sent = h.execCalls.find(c => c.args[0] === 'send-keys');
    expect(sent?.args.join(' ')).toContain(`claude --session-id ${result.sessionId}`);
  });

  it('names the tmux session with the spawn prefix, not the jira prefix', async () => {
    const result = await launchClaudeSession('/some/project');
    // A `jira-` prefixed name would be fed to the Jira issue-key matcher.
    expect(result.tmuxSession.startsWith('cm-')).toBe(true);
    expect(result.tmuxSession.startsWith('jira-')).toBe(false);
  });

  it('runs claude through a shell so the auth wrapper function applies', async () => {
    await launchClaudeSession('/some/project');
    // The command is typed into an interactive shell rather than passed as the
    // tmux command, so a `claude` shell function is what actually runs.
    const newSession = tmuxArgs('new-session');
    expect(newSession).not.toContain('claude');
    const sent = h.execCalls.find(c => c.args[0] === 'send-keys');
    expect(sent).toBeDefined();
  });

  it('waits for the shell to be ready before typing the command', async () => {
    await launchClaudeSession('/some/project');
    const order = h.execCalls.map(c => c.args[0]);
    expect(order.indexOf('display-message')).toBeGreaterThan(order.indexOf('new-session'));
    expect(order.indexOf('send-keys')).toBeGreaterThan(order.indexOf('display-message'));
  });

  it('registers the launch so a session with no transcript yet is still reachable', async () => {
    const result = await launchClaudeSession('/some/project');
    const ids = getLaunchedSessions().map(e => e.sessionId);
    expect(ids).toContain(result.sessionId);
  });

  it('rejects a path that is not an existing directory', async () => {
    h.statThrows = true;
    await expect(launchClaudeSession('/nope')).rejects.toThrow(/not a directory|does not exist/i);

    h.statThrows = false;
    h.statIsDirectory = false;
    await expect(launchClaudeSession('/etc/hosts')).rejects.toThrow(/not a directory/i);
  });

  it('rejects a relative path', async () => {
    await expect(launchClaudeSession('relative/path')).rejects.toThrow(/absolute/i);
  });

  it('does not kill the tmux session it just created', async () => {
    await launchClaudeSession('/some/project');
    expect(h.execCalls.some(c => c.args[0] === 'kill-session')).toBe(false);
  });
});

describe('killLaunchedSession', () => {
  it('kills the tmux session and forgets the registry entry', async () => {
    const result = await launchClaudeSession('/some/project');
    h.execCalls.length = 0;

    await killLaunchedSession(result.sessionId);

    expect(tmuxArgs('kill-session')).toEqual(['kill-session', '-t', result.tmuxSession]);
    expect(getLaunchedSessions().map(e => e.sessionId)).not.toContain(result.sessionId);
  });

  it('is a no-op for an unknown session', async () => {
    await expect(killLaunchedSession('not-a-real-id')).resolves.toBeUndefined();
  });
});
