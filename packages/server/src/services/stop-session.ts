import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import type { Session } from '../types.js';

const execFileAsync = promisify(execFile);

/** What was done, in the words the UI shows back. */
export type StopMethod =
  | 'claude stop'
  | 'tmux kill-session'
  | 'SIGTERM';

/**
 * Deps, injected so the tests don't stop anything real. The signature is the
 * shape of the two things this module can do to the outside world.
 */
export interface StopDeps {
  run: (file: string, args: string[]) => Promise<void>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

const defaultDeps: StopDeps = {
  run: async (file, args) => { await execFileAsync(file, args, { timeout: 15000 }); },
  kill: (pid, signal) => { process.kill(pid, signal); },
};

/**
 * The short handle `claude stop` takes.
 *
 * Claude Code prints and accepts the first segment of the session id — the
 * eight hex digits before the first dash — and `claude agents` lists them that
 * way. Passing the full uuid is what people try first and it is not what the
 * background commands want.
 */
export function backgroundHandle(sessionId: string): string {
  return sessionId.split('-')[0];
}

/** Whether this tmux session is one the app launched, rather than the user's. */
export function isOwnTmuxSession(name: string): boolean {
  return name.startsWith(config.spawnTmuxPrefix);
}

/**
 * The registry's names for a background session.
 *
 * Two of them, and which one you see depends on where you look: the per-pid
 * file in `~/.claude/sessions` writes `bg`, while `claude agents --json`
 * reports `background` for the same session. Matching only the longer one made
 * `claude stop` unreachable for every real background session — they fell
 * through to a signal, which loses the clean, resumable stop.
 */
const BACKGROUND_KINDS = new Set(['bg', 'background']);

/** Whether the live registry says this session runs under the daemon. */
export function isBackground(liveKind: string | undefined): boolean {
  return !!liveKind && BACKGROUND_KINDS.has(liveKind);
}

/**
 * Stop a live session by the gentlest means that fits it.
 *
 * Ordered deliberately: the reversible option is tried first where it exists,
 * and the signal is the last resort rather than the default. Nothing here uses
 * SIGKILL — a process that ignores SIGTERM is a bug worth seeing, not one worth
 * hiding behind a harder signal.
 */
/**
 * Which of the three a stop would be, decided once and here.
 *
 * The dialog has to name the action before it happens, and the browser must not
 * work it out for itself: the tmux case turns on a configurable prefix, so a UI
 * that hardcoded one would describe the wrong action for anyone who changed it.
 * `null` means there is nothing here to stop.
 */
export function planStop(session: Session): StopMethod | null {
  if (isBackground(session.liveKind)) return 'claude stop';
  // Only a session this app started. Killing a window someone else set up is
  // closing their terminal for them, and the pid path does the same job without
  // pretending the tmux session was ours to remove.
  const tmuxName = ownTmuxName(session);
  if (tmuxName) return 'tmux kill-session';
  if (typeof session.pid === 'number' && session.pid > 0) return 'SIGTERM';
  return null;
}

/** The tmux session name, but only when this app is the one that made it. */
function ownTmuxName(session: Session): string | null {
  const name = session.target?.kind === 'tmux' ? session.target.ref : session.tmuxSession;
  return name && isOwnTmuxSession(name) ? name : null;
}

export async function stopSession(
  session: Session,
  deps: StopDeps = defaultDeps,
): Promise<StopMethod> {
  const plan = planStop(session);

  switch (plan) {
    case 'claude stop':
      await deps.run('claude', ['stop', backgroundHandle(session.id)]);
      return plan;
    case 'tmux kill-session':
      await deps.run('tmux', ['kill-session', '-t', ownTmuxName(session)!]);
      return plan;
    case 'SIGTERM':
      deps.kill(session.pid!, 'SIGTERM');
      return plan;
    default:
      throw new Error('Nothing to stop: this session has no process on this machine.');
  }
}
