import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * Which tmux session, if any, a given process is running inside.
 *
 * This is what lets a session someone started themselves — `tmux new -s work`
 * and then `claude` — be driven from the browser. The tmux matcher it joins
 * works by naming convention: a tmux session whose name carries the configured
 * prefix, matched to a transcript by a tag found in its opening prompt. That
 * was built for one container workflow and never fitted a session a person
 * opened by hand, which has neither the prefix nor the tag.
 *
 * Ownership is a fact instead of a guess: tmux reports each pane's process, the
 * process table gives the parentage, and Claude Code's registry says which
 * transcript a pid is writing. Nothing has to be named anything.
 */

/** Beyond this many ancestors, something is wrong and we stop rather than loop. */
const MAX_ANCESTRY_DEPTH = 40;

/**
 * Map each of `pids` to the tmux session it runs in. Pids that aren't inside
 * tmux are simply absent.
 *
 * Two commands total, not two per process: a pane list and one pass over the
 * process table. This runs on every scan tick.
 */
export async function tmuxSessionsForPids(pids: number[]): Promise<Map<number, string>> {
  const owners = new Map<number, string>();
  if (!config.tmuxEnabled || pids.length === 0) return owners;

  const [panes, parents] = await Promise.all([panePids(), parentPids()]);
  if (panes.size === 0 || parents.size === 0) return owners;

  for (const pid of pids) {
    // Walk up from the process to its pane. The claude process is typically a
    // child of the pane's shell, but a wrapper script or a `claude` shell
    // function can add a level or two, so this follows the chain rather than
    // checking the immediate parent.
    let current: number | undefined = pid;
    for (let depth = 0; current !== undefined && depth < MAX_ANCESTRY_DEPTH; depth++) {
      const session = panes.get(current);
      if (session) {
        owners.set(pid, session);
        break;
      }
      const parent: number | undefined = parents.get(current);
      // pid 1, or a parent that is its own child, ends the walk.
      if (parent === undefined || parent === current || parent <= 1) break;
      current = parent;
    }
  }
  return owners;
}

/** Pane process → tmux session name, for every pane on the server. */
async function panePids(): Promise<Map<number, string>> {
  const panes = new Map<number, string>();
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_pid} #{session_name}'],
      { timeout: 5000 },
    );
    for (const line of stdout.split('\n')) {
      const [rawPid, ...rest] = line.trim().split(' ');
      const pid = Number(rawPid);
      const name = rest.join(' ');
      if (Number.isFinite(pid) && name) panes.set(pid, name);
    }
  } catch {
    // No server, or tmux missing. Either way nothing is inside tmux as far as
    // this can tell, and the caller falls back to what it derived before.
  }
  return panes;
}

/** pid → ppid for every process on the machine. */
async function parentPids(): Promise<Map<number, number>> {
  const parents = new Map<number, number>();
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,ppid'], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(pid) && Number.isFinite(ppid)) parents.set(pid, ppid);
    }
  } catch {
    // Without the process table there is no ancestry to walk.
  }
  return parents;
}
