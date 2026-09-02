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
 * `claude attach <id>` — a *client* of a session running elsewhere.
 *
 * A background session (`claude --bg`) lives under the daemon, not in any
 * pane, so walking up from its pid never reaches tmux and the dashboard can
 * only watch it. But an attach client in a pane is a full view of that session:
 * capture reads it and keystrokes reach it. Finding one is what lets a session
 * be native in the user's terminal and still be driven from the browser.
 */
// `claude` immediately followed by `attach`, as argv actually looks. A looser
// pattern matched any command line that happened to contain both words — a
// shell command run from a directory called claude-deck was enough — and bound
// the wrong pane.
const ATTACH_COMMAND = /(?:^|\/)claude\s+attach\s+([0-9a-f]{6,}(?:-[0-9a-f]+)*)\b/;

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
    const session = paneOf(pid, panes, parents);
    if (session) owners.set(pid, session);
  }
  return owners;
}

/**
 * Sessions reachable through a `claude attach` client running in a pane, keyed
 * by the id that client was given.
 *
 * The other half of ownership. The pid walk above answers "which pane is this
 * process in"; this answers "which pane is a view of this session", which is a
 * different question whenever the session itself is not in a pane at all.
 *
 * Keyed by whatever id the client was given, which is the *short* form Claude
 * Code prints — `claude attach b5cfa1b3`, against a session id of
 * b5cfa1b3-9bc1-…. Callers match by prefix; see paneForSessionId.
 */
export async function tmuxSessionsForAttachedIds(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!config.tmuxEnabled) return found;

  const [panes, parents] = await Promise.all([panePids(), parentPids()]);
  if (panes.size === 0) return found;

  const commands = await processCommands();
  for (const [pid, command] of commands) {
    const id = ATTACH_COMMAND.exec(command)?.[1];
    if (!id) continue;
    const session = paneOf(pid, panes, parents);
    // First pane wins, so two terminals attached to one session can't have the
    // dashboard typing into whichever the process table listed last.
    if (session && !found.has(id)) found.set(id, session);
  }
  return found;
}

/** Walk from a process up to the pane it runs in, if any. */
function paneOf(
  pid: number,
  panes: Map<number, string>,
  parents: Map<number, number>,
): string | null {
  let current: number | undefined = pid;
  for (let depth = 0; current !== undefined && depth < MAX_ANCESTRY_DEPTH; depth++) {
    const session = panes.get(current);
    if (session) return session;
    const parent: number | undefined = parents.get(current);
    if (parent === undefined || parent === current || parent <= 1) break;
    current = parent;
  }
  return null;
}

/** pid → command line, for spotting attach clients. */
async function processCommands(): Promise<Map<number, string>> {
  const commands = new Map<number, string>();
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,command'], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      // Only the lines that could be an attach; the process table is long.
      if (match && match[2].includes('claude')) {
        commands.set(Number(match[1]), match[2]);
      }
    }
  } catch {
    // No process table, no attach clients as far as this can tell.
  }
  return commands;
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

/**
 * The pane showing this session, through an attach client.
 *
 * Matched by prefix because `claude --bg` prints a short id and `claude attach`
 * takes it, while a session id is the full uuid. A prefix of at least six
 * characters is not a coincidence, and the map is small.
 */
export function paneForSessionId(
  sessionId: string,
  attached: Map<string, string>,
): string | undefined {
  const exact = attached.get(sessionId);
  if (exact) return exact;
  for (const [id, pane] of attached) {
    if (sessionId.startsWith(id)) return pane;
  }
  return undefined;
}
