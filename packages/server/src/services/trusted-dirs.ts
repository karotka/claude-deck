import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Directories Claude Code has already been told to trust.
 *
 * Before it starts anywhere, Claude Code asks whether the folder is one you
 * trust, and it will not go on until someone answers at the keyboard. Launching
 * into a folder it has not seen therefore stops dead at a prompt — which is
 * correct of it, and useless as a default for a dashboard that launches things.
 *
 * The home directory is the trap: it is the obvious fallback, it is almost
 * never on this list, and the question it raises is whether to hand a whole
 * home directory over, which is the last one anybody should wave through.
 * Offering a folder already trusted skips the question honestly, by not asking
 * for anything new.
 *
 * **Undocumented Claude Code internal**, so it degrades: an unreadable or
 * changed file means no suggestions, never a failure.
 */

/** Where the flag lives, as an injectable for the tests. */
export const TRUST_FILE = path.join(os.homedir(), '.claude.json');

interface TrustShape {
  projects?: Record<string, { hasTrustDialogAccepted?: unknown }>;
}

/** Directory paths with the trust flag set, in the order the file lists them. */
export function trustedFrom(raw: unknown): string[] {
  const projects = (raw as TrustShape)?.projects;
  if (!projects || typeof projects !== 'object') return [];
  return Object.entries(projects)
    .filter(([, v]) => v && (v as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true)
    .map(([dir]) => dir)
    .filter(dir => typeof dir === 'string' && dir.startsWith('/'));
}

export async function trustedDirectories(file = TRUST_FILE): Promise<string[]> {
  try {
    return trustedFrom(JSON.parse(await fsp.readFile(file, 'utf-8')));
  } catch {
    return [];
  }
}

/**
 * The directory to offer when launching something.
 *
 * `preferred` wins if it is trusted — it is what the user configured. Failing
 * that, any trusted directory beats one that will stop at a prompt. Failing
 * that, `preferred` anyway: a launch that asks a question is still better than
 * no launch at all, and the dialog says what to expect.
 */
export function bestLaunchDir(preferred: string, trusted: string[]): string {
  if (trusted.includes(preferred)) return preferred;
  return trusted[0] ?? preferred;
}
