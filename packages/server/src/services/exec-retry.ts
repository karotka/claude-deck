import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Spawn failures that mean "the OS was momentarily out of room", not "this
 * command is wrong". They surface as a string `code` on the error, whereas a
 * command that ran and exited non-zero carries a numeric exit code.
 */
const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);

const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 60;

function isTransientSpawnFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_SPAWN_CODES.has(code);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * execFile that retries transient spawn failures.
 *
 * Under host process pressure — a browser, a build and two dozen polled
 * containers at once — `posix_spawn` intermittently returns EAGAIN. Treating
 * that one-off as a real failure is what makes the terminal view flip to an
 * error and back on the next poll, so retry briefly before surfacing it.
 */
export async function execFileRetrying(
  file: string,
  args: string[],
  options: ExecFileOptions,
  attempts = DEFAULT_ATTEMPTS,
): Promise<{ stdout: string; stderr: string }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, options);
      return { stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      lastErr = err;
      if (!isTransientSpawnFailure(err) || attempt === attempts) throw err;
      // Backing off matters more than the exact curve: the contention that
      // caused EAGAIN is usually gone within a few tens of milliseconds.
      await sleep(BASE_BACKOFF_MS * attempt);
    }
  }
  throw lastErr;
}
