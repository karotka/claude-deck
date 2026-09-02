import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { config } from '../config.js';
import { isTag } from './tagging.js';
import { refreshVmStatus, vmScriptEnvAssignments, type VmState } from './vm-bridge.js';
import type { LauncherConfig } from '../config-file.js';

const execFileAsync = promisify(execFile);

/**
 * Running the user's own command to start work on a tag.
 *
 * This used to be two hardcoded scripts behind a `'local' | 'vm'` union:
 * JIRA_RESOLVE_SCRIPT and VM_RESOLVE_SCRIPT, with the tmux names, the container
 * name and the "which script" decision all branching on that union. A third
 * way of starting work — a worktree, a devcontainer, a second cluster — had
 * nowhere to go.
 *
 * A launcher is now just a declaration: a command with `{{tag}}` in it, plus
 * the names it will produce. The app owns no part of what the command does.
 */

/** The placeholder substituted into a launcher's command. */
const TAG_PLACEHOLDER = '{{tag}}';

export interface LaunchResult {
  tag: string;
  launcherId: string;
  launchSession: string;
  /** Null for a launcher that produces no container. */
  containerName: string | null;
}

export type ContainerState =
  | 'running' | 'exited' | 'created' | 'paused' | 'restarting' | 'dead' | 'missing';

export type LaunchPhase = 'starting' | 'booting' | 'building' | 'ready' | 'failed' | 'unknown';

export interface LaunchStatus {
  tag: string;
  launcherId: string;
  launchSession: string;
  containerName: string | null;
  tmuxAlive: boolean;
  tmuxOutput: string;
  containerState: ContainerState;
  containerExitCode: number | null;
  phase: LaunchPhase;
  /** Remote host state; null for a launcher that runs here. */
  remoteState: VmState | null;
}

export function getLaunchers(): LauncherConfig[] {
  return config.launchers;
}

export function getLauncher(id: string): LauncherConfig | undefined {
  return config.launchers.find(l => l.id === id);
}

/** The launcher to use when a request names none — the first one configured. */
export function defaultLauncher(): LauncherConfig | undefined {
  return config.launchers[0];
}

function resolveLauncher(id: string | undefined): LauncherConfig {
  const launcher = id ? getLauncher(id) : defaultLauncher();
  if (!launcher) {
    throw new Error(
      id
        ? `No launcher named "${id}" is configured.`
        : 'No launchers are configured. Add a "launchers" entry to '
          + 'claude-deck.config.json (see examples/), or set JIRA_RESOLVE_SCRIPT.',
    );
  }
  return launcher;
}

function normalizeTag(raw: string): string {
  const tag = raw.trim().toUpperCase();
  if (!isTag(tag)) {
    throw new Error(`"${raw}" is not a valid key for this installation.`);
  }
  return tag;
}

/**
 * The names a launch produces. Both are derived from the launcher's own
 * prefixes, which is what lets two launchers work on the same tag at once — a
 * shared launch-session name would have one launch kill the other's tmux.
 */
export function namesFor(launcher: LauncherConfig, tag: string) {
  const lower = tag.toLowerCase();
  return {
    launchSession: `${launcher.launchPrefix ?? `${launcher.id}-launch-`}${lower}`,
    containerName: launcher.containerPrefix ? `${launcher.containerPrefix}${lower}` : null,
  };
}

/** The launcher's command with the tag substituted into every argument. */
export function buildCommand(launcher: LauncherConfig, tag: string): string[] {
  return launcher.command.map(part => part.split(TAG_PLACEHOLDER).join(tag));
}

export async function launch(rawTag: string, launcherId?: string): Promise<LaunchResult> {
  const launcher = resolveLauncher(launcherId);
  const tag = normalizeTag(rawTag);

  const command = buildCommand(launcher, tag);
  const [executable] = command;
  try {
    await fsp.access(executable, fsConstants.X_OK);
  } catch {
    throw new Error(`Launcher "${launcher.id}": ${executable} is not executable.`);
  }

  const { launchSession, containerName } = namesFor(launcher, tag);

  // Kill a lingering launch tmux so the new one takes the name. The command
  // itself is responsible for handling work that is already running.
  try {
    await execFileAsync('tmux', ['kill-session', '-t', launchSession], { timeout: 3000 });
  } catch {
    // ignore: session didn't exist
  }

  // Launch commands commonly end by attaching to the agent's own tmux for a
  // single keypress, which needs a TTY. A detached host tmux session gives them
  // one without blocking the API request. Attach with:
  //   tmux attach -t <launchSession>
  //
  // `env VAR=…` in the argv rather than an env option on the child: tmux runs
  // the command in the *tmux server's* environment, so anything not spelled out
  // here is lost — and for a remote launcher the script's own default would
  // then target a different instance than the one the UI is polling.
  const withEnv = envAssignments(launcher);
  await execFileAsync(
    'tmux',
    ['new-session', '-d', '-s', launchSession, ...withEnv, ...command],
    { timeout: 10_000 },
  );

  return { tag, launcherId: launcher.id, launchSession, containerName };
}

/** `env A=1 B=2` prefix, or nothing when there is nothing to pass. */
function envAssignments(launcher: LauncherConfig): string[] {
  const assignments = launcher.remote ? vmScriptEnvAssignments() : [];
  return assignments.length > 0 ? ['env', ...assignments] : [];
}

async function tmuxSessionAlive(name: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', name], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function tmuxCapture(name: string, lines = 200): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      ['capture-pane', '-t', name, '-p', '-S', `-${lines}`],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    // Trim trailing empty padding lines that tmux capture-pane adds.
    return stdout.replace(/\s+$/g, '');
  } catch {
    return '';
  }
}

const KNOWN_CONTAINER_STATES: ContainerState[] = [
  'running', 'exited', 'created', 'paused', 'restarting', 'dead',
];

async function inspectLocalContainer(
  name: string,
): Promise<{ state: ContainerState; exitCode: number | null }> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', name],
      { timeout: 3000 },
    );
    const [rawState, rawExit] = stdout.trim().split('|');
    const state = (KNOWN_CONTAINER_STATES as string[]).includes(rawState)
      ? (rawState as ContainerState)
      : 'missing';
    const exitCode = rawExit && !Number.isNaN(Number(rawExit)) ? Number(rawExit) : null;
    return { state, exitCode };
  } catch {
    return { state: 'missing', exitCode: null };
  }
}

/**
 * Remote container state, read from the cached `list` output rather than a
 * fresh call. The launch dialog polls every 1.5s while a remote round trip
 * takes seconds, so this leans on refreshVmStatus's TTL to coalesce the polls.
 */
async function inspectRemoteContainer(
  name: string,
): Promise<{ state: ContainerState; remoteState: VmState }> {
  const status = await refreshVmStatus();
  const container = status.containers.find(c => c.name === name);
  if (!container) return { state: 'missing', remoteState: status.state };
  return { state: container.state, remoteState: status.state };
}

export function derivePhase(
  tmuxAlive: boolean,
  containerState: ContainerState,
  tmuxOutput: string,
  remoteState: VmState | null,
): LaunchPhase {
  if (containerState === 'running') return 'ready';
  if (!tmuxAlive && containerState === 'missing') return 'failed';
  if (!tmuxAlive && (containerState === 'exited' || containerState === 'dead')) return 'failed';
  // A remote launch boots the host before it can create anything — that wait is
  // minutes long and shouldn't read as "nothing is happening".
  if (tmuxAlive && remoteState !== null && remoteState !== 'RUNNING') return 'booting';
  if (/Building Docker image|docker:desktop-linux|\[\+\] Building/i.test(tmuxOutput)) {
    return 'building';
  }
  if (tmuxAlive) return 'starting';
  return 'unknown';
}

export async function getLaunchStatus(
  rawTag: string,
  launcherId?: string,
): Promise<LaunchStatus> {
  const launcher = resolveLauncher(launcherId);
  const tag = normalizeTag(rawTag);
  const { launchSession, containerName } = namesFor(launcher, tag);

  const [tmuxAlive, tmuxOutput, container] = await Promise.all([
    tmuxSessionAlive(launchSession),
    tmuxCapture(launchSession),
    inspectContainer(launcher, containerName),
  ]);

  return {
    tag,
    launcherId: launcher.id,
    launchSession,
    containerName,
    tmuxAlive,
    tmuxOutput,
    containerState: container.state,
    containerExitCode: container.exitCode,
    phase: derivePhase(tmuxAlive, container.state, tmuxOutput, container.remoteState),
    remoteState: container.remoteState,
  };
}

async function inspectContainer(
  launcher: LauncherConfig,
  containerName: string | null,
): Promise<{ state: ContainerState; exitCode: number | null; remoteState: VmState | null }> {
  // A launcher that declares no container prefix produces nothing to inspect;
  // its progress is whatever its tmux pane says.
  if (!containerName) return { state: 'missing', exitCode: null, remoteState: null };
  if (launcher.remote) {
    const { state, remoteState } = await inspectRemoteContainer(containerName);
    return { state, exitCode: null, remoteState };
  }
  const { state, exitCode } = await inspectLocalContainer(containerName);
  return { state, exitCode, remoteState: null };
}
