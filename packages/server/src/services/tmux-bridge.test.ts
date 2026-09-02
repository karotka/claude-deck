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
  /** `#{session_attached} #{window_width} #{window_height}` for capturePane. */
  paneInfo: '0 80 24',
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    h.execCalls.push({ file, args });
    if (h.execError) return cb(h.execError, { stdout: '', stderr: '' });
    const stdout = args[0] === 'display-message' ? h.paneInfo : '';
    cb(null, { stdout, stderr: '' });
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

const { sendKeys, sendKey, listTmuxSessions, wasTmuxScanRecent, capturePane, wheelBytes } = await import('./tmux-bridge.js');

beforeEach(() => {
  h.execError = null;
  h.paneInfo = '0 80 24';
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

describe('capturePane resizing', () => {
  const resizes = () => h.execCalls.filter(c => c.args[0] === 'resize-window');

  it('sizes a detached pane to the viewport', async () => {
    // Detached tmux sessions default to 80x24, which makes the TUI wrap badly.
    await capturePane('sess', 50, 120);
    expect(resizes()).toHaveLength(1);
    expect(resizes()[0].args).toContain('120');
  });

  it('leaves the pane alone while someone is attached in a terminal', async () => {
    // tmux sizes a window to its attached client. Resizing it back to the
    // browser's viewport twice a second started a tug of war, and a TUI redraws
    // completely on every resize — `tmux attach` became unusably slow. The
    // person at the terminal wins; the browser renders whatever width it gets.
    h.paneInfo = '1 100 30';
    await capturePane('sess', 50, 200);
    expect(resizes()).toHaveLength(0);
  });

  it('does not resize a pane that is already the right size', async () => {
    h.paneInfo = '0 120 50';
    await capturePane('sess', 50, 120);
    expect(resizes()).toHaveLength(0);
  });

  it('resizes when the pane size cannot be read', async () => {
    // Safe fallback, and the old behaviour: the worst case is a pane the size
    // the browser asked for.
    h.paneInfo = 'nonsense';
    await capturePane('sess', 50, 120);
    expect(resizes()).toHaveLength(1);
  });

  it('never resizes when the caller gives no width', async () => {
    await capturePane('sess', 50);
    expect(resizes()).toHaveLength(0);
  });

  it('sizes the pane to the height the caller measured', async () => {
    // The pane used to be a fixed 50 rows however tall the panel was. Claude's
    // TUI holds no scrollback, so a short pane left dead space the user could
    // not scroll into and a tall one hid its own top.
    h.paneInfo = '0 120 50';
    await capturePane('sess', 50, 120, 36);
    expect(resizes()).toHaveLength(1);
    expect(resizes()[0].args).toEqual(
      expect.arrayContaining(['-x', '120', '-y', '36']),
    );
  });

  it('treats a height-only change as a reason to resize', async () => {
    h.paneInfo = '0 120 50';
    await capturePane('sess', 50, 120, 50);
    expect(resizes()).toHaveLength(0);
    await capturePane('sess', 50, 120, 51);
    expect(resizes()).toHaveLength(1);
  });
});

describe('wheel forwarding', () => {
  const sends = () => h.execCalls.filter(c => c.args[0] === 'send-keys');

  it('sends a wheel turn as literal SGR bytes, not a key name', async () => {
    // tmux has no key name for the wheel. Claude Code's TUI asks for SGR mouse
    // reporting, so a turn is the bytes a terminal would write into the pane.
    await sendKey('sess', 'WheelUp');
    expect(sends()).toHaveLength(1);
    expect(sends()[0].args).toContain('-l');
    expect(sends()[0].args.join(' ')).toContain('[<64;1;1M');
  });

  it('turns the other way for a wheel down', async () => {
    await sendKey('sess', 'WheelDown');
    expect(sends()[0].args.join(' ')).toContain('[<65;1;1M');
  });

  it('sends a notch of three ticks, as a terminal does', async () => {
    await sendKey('sess', 'WheelUp');
    const bytes = sends()[0].args[sends()[0].args.length - 1];
    expect(bytes.split('[<64').length - 1).toBe(3);
  });

  it('still refuses a key that is neither allowed nor a wheel turn', async () => {
    await expect(sendKey('sess', 'C-z')).rejects.toThrow(/Disallowed key/);
  });

  it('reports non-wheel keys as not a wheel', () => {
    expect(wheelBytes('Enter')).toBeNull();
  });
});
