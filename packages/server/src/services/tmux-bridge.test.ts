import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Capture every tmux invocation so we can assert the send strategy without a
// real tmux server. `vi.hoisted` runs before the mock factory so the arrays
// exist when `vi.mock` (also hoisted) references them.
const h = vi.hoisted(() => ({
  execCalls: [] as { file: string; args: string[] }[],
  spawnCalls: [] as { file: string; args: string[]; stdin: string }[],
  /** Set to make the next execFile reject, for the failure paths. */
  execError: null as unknown,
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    h.execCalls.push({ file, args });
    if (h.execError) cb(h.execError, { stdout: '', stderr: '' });
    else cb(null, { stdout: '', stderr: '' });
  },
  spawn: (file: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { on: () => void; write: (d: string) => void; end: (d?: string) => void };
      stderr: EventEmitter;
    };
    child.stderr = new EventEmitter();
    let stdin = '';
    child.stdin = {
      on: () => {},
      write: (d: string) => { stdin += d; },
      end: (d?: string) => {
        if (d) stdin += d;
        h.spawnCalls.push({ file, args, stdin });
        queueMicrotask(() => child.emit('close', 0, null));
      },
    };
    return child;
  },
}));

const { sendKeys, listTmuxSessions, wasTmuxScanRecent } = await import('./tmux-bridge.js');

beforeEach(() => {
  h.execError = null;
  h.execCalls.length = 0;
  h.spawnCalls.length = 0;
});

describe('sendKeys', () => {
  it('delivers the whole message as a single bracketed paste, not per-char chunks', async () => {
    // A payload larger than the old 500-char chunk size and containing newlines:
    // the old path split this into ~11 send-keys calls and each newline acted as
    // an Enter, submitting the prompt early.
    const big = 'x'.repeat(5000) + '\nsecond line\nthird line';

    await sendKeys('mysess', big, true);

    // The entire payload is loaded into a tmux buffer via stdin in one shot.
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0].file).toBe('tmux');
    expect(h.spawnCalls[0].args.slice(0, 2)).toEqual(['load-buffer', '-b']);
    expect(h.spawnCalls[0].args.at(-1)).toBe('-'); // read from stdin
    expect(h.spawnCalls[0].stdin).toBe(big);

    // It is pasted with bracketed-paste (-p) so newlines don't each submit, and
    // the buffer is deleted afterwards (-d).
    const paste = h.execCalls.find(c => c.args.includes('paste-buffer'));
    expect(paste).toBeDefined();
    expect(paste!.args).toContain('-p');
    expect(paste!.args).toContain('-d');
    expect(paste!.args).toContain('mysess:0.0');

    // Exactly one Enter is sent, and only after the paste.
    const enters = h.execCalls.filter(c => c.args.includes('Enter'));
    expect(enters).toHaveLength(1);

    // No send-keys -l chunking of the literal text.
    expect(h.execCalls.some(c => c.args.includes('-l'))).toBe(false);
  });

  it('reuses a session-scoped buffer name so concurrent sends do not clobber each other', async () => {
    await sendKeys('sess-one', 'hi', false);
    const load = h.spawnCalls[0].args;
    const bufName = load[load.indexOf('-b') + 1];
    const paste = h.execCalls.find(c => c.args.includes('paste-buffer'))!;
    expect(paste.args).toContain(bufName);
    expect(bufName).toContain('sess-one');
  });

  it('omits Enter when appendEnter is false (Tab-accept flow)', async () => {
    await sendKeys('mysess', 'partial text', false);
    expect(h.execCalls.some(c => c.args.includes('Enter'))).toBe(false);
    expect(h.spawnCalls).toHaveLength(1);
  });
});

describe('listTmuxSessions', () => {
  it('treats "no server running" as an empty list, not a failed scan', async () => {
    // tmux exits non-zero when there is no server, and there is then
    // definitively nothing to list. Holding the previous result kept dead
    // sessions on the dashboard for a further minute — long enough for it to
    // offer a terminal that cannot work.
    h.execError = Object.assign(new Error('Command failed: tmux ls'), {
      stderr: 'no server running on /private/tmp/tmux-502/default\n',
    });

    expect(await listTmuxSessions()).toEqual([]);
    // Authoritative: the emptiness is a fact, so sticky assignments may be
    // cleared on the strength of it.
    expect(wasTmuxScanRecent()).toBe(true);
  });

  it('holds the last good list when tmux fails for any other reason', async () => {
    // A spawn EAGAIN under load must not flip every session to observe-only.
    h.execError = null;
    await listTmuxSessions();

    h.execError = Object.assign(new Error('Command failed'), {
      stderr: 'fork failed: resource temporarily unavailable\n',
    });
    expect(await listTmuxSessions()).toEqual([]);
  });
});
