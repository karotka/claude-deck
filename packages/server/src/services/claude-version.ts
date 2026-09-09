import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The Claude Code version installed on this machine.
 *
 * A session keeps whatever version it started with — Claude Code says so
 * itself, with "Update installed · Restart to update" — so a session left
 * running for a week is a week behind and nothing on the board said which. The
 * comparison needs the installed version, and that means asking the binary.
 *
 * Cached for the life of the process: an update lands rarely and a dashboard
 * that shells out on every poll to find out is worse than one that is a
 * restart late in noticing.
 */
let cached: string | null | undefined;

export async function installedClaudeVersion(): Promise<string | null> {
  if (cached !== undefined) return cached;
  cached = await read();
  return cached;
}

/** For tests, and for a caller that knows an update just happened. */
export function forgetInstalledVersion(): void {
  cached = undefined;
}

async function read(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 10_000 });
    // "2.1.266 (Claude Code)" — the number is all that is wanted.
    return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
  } catch {
    // Not on PATH, or a shell function rather than a binary. Less to say, not
    // a failure: without it the UI simply never claims a session is behind.
    return null;
  }
}
