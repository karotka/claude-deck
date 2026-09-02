import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[] }[],
  // Queue of outcomes; each entry is either an Error to fail with or null for success.
  outcomes: [] as (Error | null)[],
}));

function spawnError(code: string): Error {
  const err = new Error(`spawn docker ${code}`) as Error & { code: string; syscall: string };
  err.code = code;
  err.syscall = 'spawn docker';
  return err;
}

function exitError(code: number): Error {
  const err = new Error(`Command failed`) as Error & { code: number };
  err.code = code;
  return err;
}

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res?: { stdout: string; stderr: string }) => void,
  ) => {
    h.calls.push({ file, args });
    const outcome = h.outcomes.shift() ?? null;
    if (outcome) cb(outcome);
    else cb(null, { stdout: 'ok', stderr: '' });
  },
}));

const { execFileRetrying } = await import('./exec-retry.js');

beforeEach(() => {
  h.calls.length = 0;
  h.outcomes.length = 0;
});

describe('execFileRetrying', () => {
  it('retries a transient EAGAIN spawn failure and succeeds', async () => {
    // EAGAIN means the OS momentarily refused to fork — the command itself is
    // fine, so giving up on the first try is what makes the terminal flicker.
    h.outcomes.push(spawnError('EAGAIN'));

    const { stdout } = await execFileRetrying('docker', ['ps'], { timeout: 1000 });

    expect(stdout).toBe('ok');
    expect(h.calls).toHaveLength(2);
  });

  it('retries other transient resource errors too', async () => {
    for (const code of ['EMFILE', 'ENFILE', 'ENOMEM']) {
      h.calls.length = 0;
      h.outcomes.length = 0;
      h.outcomes.push(spawnError(code));
      await expect(execFileRetrying('docker', ['ps'], {})).resolves.toBeDefined();
      expect(h.calls.length).toBe(2);
    }
  });

  it('gives up after the attempt budget and rethrows the spawn error', async () => {
    h.outcomes.push(spawnError('EAGAIN'), spawnError('EAGAIN'), spawnError('EAGAIN'));
    await expect(execFileRetrying('docker', ['ps'], {}, 3)).rejects.toThrow(/EAGAIN/);
    expect(h.calls).toHaveLength(3);
  });

  it('does not retry a real command failure', async () => {
    // A non-zero exit is a genuine answer — retrying just multiplies the load.
    h.outcomes.push(exitError(1));
    await expect(execFileRetrying('docker', ['ps'], {})).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  });

  it('does not retry a missing binary', async () => {
    h.outcomes.push(spawnError('ENOENT'));
    await expect(execFileRetrying('docker', ['ps'], {})).rejects.toThrow(/ENOENT/);
    expect(h.calls).toHaveLength(1);
  });
});
