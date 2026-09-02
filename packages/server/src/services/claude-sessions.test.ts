import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs: string[] = [];

/** A registry directory shaped like Claude Code's. */
function registry(files: Record<string, unknown | string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-reg-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(dir, name),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }
  return dir;
}

async function load(dir: string) {
  process.env.CLAUDE_SESSIONS_DIR = dir;
  vi.resetModules();
  return import('./claude-sessions.js');
}

/** Above any real pid, so nothing can be running under it. */
const DEAD_PID = 2 ** 31 - 1;

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.CLAUDE_SESSIONS_DIR;
  vi.resetModules();
});

describe('claudeSessions', () => {
  it('maps a live process to the transcript it is writing', async () => {
    // The mapping this app could not previously make: a plain `claude` puts no
    // session id on its command line.
    const { claudeSessions } = await load(registry({
      [`${process.pid}.json`]: {
        pid: process.pid,
        sessionId: 'abc-123',
        cwd: '/repo',
        name: 'Personalization eval',
        status: 'idle',
        kind: 'interactive',
      },
    }));
    const found = await claudeSessions();
    expect(found.get('abc-123')).toMatchObject({
      pid: process.pid,
      sessionId: 'abc-123',
      cwd: '/repo',
      name: 'Personalization eval',
      status: 'idle',
    });
  });

  it('drops an entry whose process is gone', async () => {
    // A registry file outlives an unclean exit, so its presence is not evidence.
    const { claudeSessions } = await load(registry({
      [`${DEAD_PID}.json`]: { pid: DEAD_PID, sessionId: 'stale' },
    }));
    expect((await claudeSessions()).size).toBe(0);
  });

  it('never reads the key files sitting beside the entries', async () => {
    // The directory also holds `<pid>.<hash>.key` credentials, which are none
    // of this app's business.
    const { claudeSessions } = await load(registry({
      [`${process.pid}.json`]: { pid: process.pid, sessionId: 'abc-123' },
      [`${process.pid}.deadbeef.key`]: 'SECRET',
      'notes.txt': 'x',
    }));
    const found = await claudeSessions();
    expect([...found.keys()]).toEqual(['abc-123']);
  });

  it('skips an entry it cannot parse rather than failing the scan', async () => {
    // Files are written while we may be reading them.
    const { claudeSessions } = await load(registry({
      '1.json': 'half-writ',
      '2.json': { pid: process.pid },
      '3.json': { sessionId: 'no-pid' },
      [`${process.pid}.json`]: { pid: process.pid, sessionId: 'good' },
    }));
    expect([...(await claudeSessions()).keys()]).toEqual(['good']);
  });

  it('returns nothing when the registry is absent, rather than failing', async () => {
    // The whole point of treating this as an enrichment: a future Claude Code
    // may move or drop it, and the dashboard must keep working.
    const { claudeSessions } = await load('/nope/not/here');
    expect((await claudeSessions()).size).toBe(0);
  });

  it('normalizes blank strings to null so callers need not check twice', async () => {
    const { claudeSessions } = await load(registry({
      [`${process.pid}.json`]: {
        pid: process.pid, sessionId: 'abc', name: '   ', cwd: '', status: 'busy',
      },
    }));
    const entry = (await claudeSessions()).get('abc')!;
    expect(entry.name).toBeNull();
    expect(entry.cwd).toBeNull();
    expect(entry.status).toBe('busy');
  });
});
