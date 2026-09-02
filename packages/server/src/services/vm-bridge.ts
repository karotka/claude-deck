import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { config } from '../config.js';
import { execFileRetrying } from './exec-retry.js';
import { ALLOWED_RAW_KEYS } from './tmux-bridge.js';
import { sanitizePane } from './ansi.js';
import {
  sshMuxPathPrefix,
  recordedSshInvocation,
  sshReuseOptions,
  ensureSshMaster,
  systemSshPath,
} from './ssh-mux.js';
import {
  requestFrame,
  hasFreshFrame,
  stopStream,
  injectFrame,
  streamGeometry,
  setVmStreamEnvResolver,
  setVmResizeHandler,
  setChannelReaper,
} from './vm-stream.js';
import {
  wrapPayload,
  wrapPayloadForChannel,
  extractPayloadOutput,
  isSafeRemoteRef,
  buildRunnerShellCommand,
} from './vm-payload.js';
import { channelExec, stopChannel, reapChannels } from './vm-channel.js';
import {
  readSessionSample,
  readSessionFull,
  readSubagents,
  type ExecScript,
} from './container-reader.js';
import type { SubagentInfo } from '../types.js';

/**
 * Drives agent containers running on the remote VM.
 *
 * Every operation shells out to the user's REMOTE_SCRIPT — the same script used
 * by hand from a terminal — so the monitor owns no part of the VM contract: not
 * the instance, not the IAP tunnel, not the image, not the secrets. The script
 * exposes exactly one way to run something inside a container:
 *
 *     <REMOTE_SCRIPT> shell <TAG> <command…>
 *
 * which lands the command in `docker exec … bash -lc` on the far side. Getting a
 * script through that intact means surviving three layers of word splitting
 * (the local script's `$*`, the remote login shell gcloud hands the command to,
 * and the runner's own `$*`), so the payload is base64-encoded and wrapped in
 * literal single quotes: base64's alphabet has no shell metacharacters, and the
 * quotes are consumed by the remote shell so the pipeline runs where it should.
 */

const execFileAsync = execFileRetrying;

/** Guards against a message so large it would blow the remote command line. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

const TMUX_TARGET = config.containerTmuxPane;
const TMUX_WINDOW = config.containerTmuxWindow;
const PASTE_BUFFER = 'cm-paste';

export type VmState =
  | 'RUNNING'
  | 'TERMINATED'
  | 'STOPPING'
  | 'STAGING'
  | 'PROVISIONING'
  | 'SUSPENDED'
  | 'MISSING'
  | 'UNKNOWN'
  /** The script itself is absent/not executable, or VM support is switched off. */
  | 'UNAVAILABLE';

export interface VmContainer {
  name: string;
  issueKey: string;
  state: 'running' | 'exited' | 'paused';
  status: string;
  runningFor: string;
}

export interface VmStatus {
  state: VmState;
  containers: VmContainer[];
  /** When the status was read; null before the first successful read. */
  checkedAt: string | null;
  error: string | null;
}

// Payload encoding lives in vm-payload so the streaming transport can share it.
// Re-exported because this module is where callers and tests look for it.
export {
  wrapPayload,
  extractPayloadOutput,
  isSafeRemoteRef,
  buildRunnerShellCommand,
} from './vm-payload.js';

// --- Script availability -----------------------------------------------------

let scriptUsable: boolean | null = null;

/** Whether VM support is switched on and the driving script is executable. */
export async function isVmAvailable(): Promise<boolean> {
  if (!config.vmEnabled) return false;
  if (scriptUsable !== null) return scriptUsable;
  try {
    await fsp.access(config.vmResolveScript, fsConstants.X_OK);
    scriptUsable = true;
  } catch {
    scriptUsable = false;
  }
  return scriptUsable;
}

/** Test seam — forget the cached script probe. */
export function resetVmAvailability(): void {
  scriptUsable = null;
}

/**
 * Which instance the script should target. Whatever is configured is passed
 * explicitly on every call rather than left to the script's built-in default:
 * if that default names a different VM, inheriting it would poll the wrong
 * instance while the UI showed this one. Nothing configured means nothing
 * forwarded, and the script's defaults stand.
 */
export function vmScriptEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const assignment of vmScriptEnvAssignments()) {
    const eq = assignment.indexOf('=');
    env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
  }
  // Connection reuse for the `ssh` gcloud spawns — see ssh-mux.ts. Scoped to
  // the processes we start; the user's own ssh is untouched.
  const muxDir = sshMuxPathPrefix();
  if (muxDir) env.PATH = `${muxDir}:${env.PATH ?? ''}`;
  return env;
}

/**
 * The same targeting as `VAR=value` assignments, for callers that can't pass an
 * env object. The launch path runs the script under `tmux new-session`, and
 * tmux starts commands in the *tmux server's* environment — not the caller's —
 * so a plain `env:` option would be dropped there.
 */
export function vmScriptEnvAssignments(): string[] {
  const assignments: string[] = [];
  if (config.vmName) assignments.push(`AGENT_VM_NAME=${config.vmName}`);
  if (config.vmZone) assignments.push(`AGENT_VM_ZONE=${config.vmZone}`);
  if (config.vmProject) assignments.push(`AGENT_VM_PROJECT=${config.vmProject}`);
  return assignments;
}

async function runVmScript(
  args: string[],
  opts: { timeoutMs: number; maxBuffer?: number },
): Promise<string> {
  const { stdout } = await execFileAsync(config.vmResolveScript, args, {
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
    env: vmScriptEnv(),
  });
  return stdout;
}

// --- VM status ---------------------------------------------------------------

const VM_STATE_LINE_RE = /^VM\s+\S+\s+\([^)]*\):\s*(\S+)\s*$/m;

const KNOWN_STATES: VmState[] = [
  'RUNNING', 'TERMINATED', 'STOPPING', 'STAGING', 'PROVISIONING', 'SUSPENDED', 'MISSING',
];

/**
 * Parse `<REMOTE_SCRIPT> list`, which prints the instance state followed
 * by a `docker ps -a` table (the table is omitted entirely when the VM is down):
 *
 *   VM agent-vm (project/zone): RUNNING
 *   NAMES                 STATUS          CREATED
 *   jira-agent-proj-1234  Up 3 hours      3 hours ago
 *
 * Pure, so the table shapes can be tested without a VM.
 */
export function parseVmListOutput(
  stdout: string,
  containerPrefix: string,
): { state: VmState; containers: VmContainer[] } {
  const stateMatch = stdout.match(VM_STATE_LINE_RE);
  const raw = stateMatch?.[1]?.toUpperCase() ?? '';
  const state = (KNOWN_STATES as string[]).includes(raw) ? (raw as VmState) : 'UNKNOWN';

  const containers: VmContainer[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(containerPrefix)) continue;
    // `docker ps --format table` pads columns with runs of spaces; a single
    // space is data ("Up 3 hours"), two or more is a column break.
    const [name, status = '', runningFor = ''] = trimmed.split(/\s{2,}/);
    if (!name) continue;
    containers.push({
      name,
      issueKey: name.slice(containerPrefix.length).toUpperCase(),
      state: dockerStatusToState(status),
      status,
      runningFor,
    });
  }

  return { state, containers };
}

function dockerStatusToState(status: string): VmContainer['state'] {
  if (/\(Paused\)/i.test(status)) return 'paused';
  if (/^Up\b/i.test(status)) return 'running';
  return 'exited';
}

let lastStatus: VmStatus = { state: 'UNKNOWN', containers: [], checkedAt: null, error: null };
let statusReadAt = 0;
let statusInFlight: Promise<VmStatus> | null = null;

/** Last known VM status without touching the network. */
export function getCachedVmStatus(): VmStatus {
  return lastStatus;
}

/**
 * Read VM state and its container list in a single `list` call.
 *
 * `list` is the one command that is safe to poll: it checks the instance state
 * first and returns without connecting when the VM is down. Every other command
 * (`shell`, `attach`, `start`, …) runs `ensure_vm_up`, which would *boot the VM*
 * — so nothing else may be called on a poll.
 */
export async function refreshVmStatus(force = false): Promise<VmStatus> {
  if (!(await isVmAvailable())) {
    lastStatus = { state: 'UNAVAILABLE', containers: [], checkedAt: null, error: null };
    return lastStatus;
  }
  if (!force && Date.now() - statusReadAt < config.vmStateTtlMs) return lastStatus;
  if (statusInFlight) return statusInFlight;

  statusInFlight = (async () => {
    try {
      const stdout = await runVmScript(['list'], { timeoutMs: 90_000 });
      const parsed = parseVmListOutput(stdout, config.dockerContainerPrefix);
      lastStatus = { ...parsed, checkedAt: new Date().toISOString(), error: null };
    } catch (err) {
      // Keep the last known container list: a timed-out gcloud call is not
      // evidence that the VM stopped, and dropping the list would blink every
      // VM card off the dashboard mid-interaction.
      lastStatus = {
        ...lastStatus,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      statusReadAt = Date.now();
      statusInFlight = null;
    }
    return lastStatus;
  })();

  return statusInFlight;
}

/** True when the VM is up, so a `shell` call won't have to boot it first. */
function vmIsUp(): boolean {
  return lastStatus.state === 'RUNNING';
}

// --- Running commands inside a VM container ----------------------------------

const DEFAULT_EXEC_TIMEOUT_MS = 90_000;

/** `rm` stops the container, deletes it and its volume, all over the tunnel. */
const VM_REMOVE_TIMEOUT_MS = 120_000;

/**
 * Run a `sh` script inside the agent container for `issueKey` on the VM.
 *
 * Refuses when the VM isn't known to be up: `shell` boots a stopped instance as
 * a side effect, and a background poll must never do that.
 */
export async function vmExec(
  issueKey: string,
  script: string,
  opts: { timeoutMs?: number; maxBuffer?: number; skipChannel?: boolean } = {},
): Promise<string> {
  if (!isSafeRemoteRef(issueKey)) {
    throw new Error(
      `"${issueKey}" cannot be used as a remote container handle: only letters, `
      + 'digits, dot, dash and underscore are accepted, because the handle is '
      + 'interpolated into a shell command on the far side.',
    );
  }
  if (!(await isVmAvailable())) {
    throw new Error('Remote support is disabled, or REMOTE_SCRIPT is not executable');
  }
  // Cheap when the discovery loop already refreshed within the TTL, and the
  // guard below is only meaningful against a state we actually looked at.
  await refreshVmStatus();
  if (!vmIsUp()) {
    throw new Error(`VM is ${lastStatus.state.toLowerCase()} — start a VM session first`);
  }
  const wrapped = wrapPayload(script);
  if (Buffer.byteLength(wrapped) > MAX_PAYLOAD_BYTES) {
    throw new Error('Payload too large to send to the VM');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  // Best: the session's persistent channel — no SSH channel to open, which is
  // 0.42s of the 0.55s a one-shot call costs. Unquoted, because the loop reads
  // it as a line rather than parsing it as shell words.
  if (!opts.skipChannel) {
    const viaChannel = await channelExec(
      issueKey,
      wrapPayloadForChannel(script),
      Math.min(timeoutMs, 30_000),
    );
    if (viaChannel !== null) {
      try {
        return extractPayloadOutput(viaChannel);
      } catch {
        // The loop echoes runner errors too; fall through to a fresh call
        // rather than trusting a half-answer.
      }
    }
  }

  // Next best: reuse the connection the script already opened — the difference
  // between a keystroke landing in ~0.6s and in ~6s.
  const fast = await tryFastShell(issueKey, wrapped, timeoutMs, opts.maxBuffer);
  if (fast !== null) return extractPayloadOutput(fast);

  const stdout = await runVmScript(['shell', issueKey, wrapped], {
    timeoutMs,
    maxBuffer: opts.maxBuffer,
  });
  return extractPayloadOutput(stdout);
}

/**
 * Run a container command over the already-open connection. Returns null when
 * the fast path isn't usable, so the caller falls back to the script — this
 * must never be the reason an interaction fails.
 */
async function tryFastShell(
  issueKey: string,
  wrapped: string,
  timeoutMs: number,
  maxBuffer?: number,
): Promise<string | null> {
  const recorded = recordedSshInvocation();
  const ssh = systemSshPath();
  if (!recorded || !ssh) return null;

  const run = async () => {
    const { stdout } = await execFileAsync(
      ssh,
      [
        ...sshReuseOptions(),
        ...recorded.sshArgs,
        buildRunnerShellCommand(recorded.runnerPath, issueKey, wrapped),
      ],
      { timeout: timeoutMs, maxBuffer: maxBuffer ?? 8 * 1024 * 1024 },
    );
    return stdout;
  };

  try {
    if (!(await ensureSshMaster(recorded))) return null;
    return await run();
  } catch {
    // The master can go away between the check and the call. Rebuild once —
    // beyond that, let the script handle it, which also refreshes the
    // recording for next time.
    try {
      if (!(await ensureSshMaster(recorded))) return null;
      return await run();
    } catch {
      return null;
    }
  }
}

/**
 * `vmExec` shaped for the shared container reader. Callers below pass
 * tunnel-sized timeouts explicitly — the reader's local-docker defaults would
 * be far too tight for a round trip over IAP.
 */
function vmExecScript(issueKey: string): ExecScript {
  return (script, { timeoutMs, maxBuffer }) => vmExec(issueKey, script, { timeoutMs, maxBuffer });
}

// --- Terminal capture --------------------------------------------------------

interface CaptureEntry { at: number; content: string }
const captureCache = new Map<string, CaptureEntry>();
const captureInFlight = new Map<string, Promise<string>>();

/**
 * Capture the Claude tmux pane inside a VM container.
 *
 * Frames normally come from a live stream (vm-stream.ts), which costs one
 * connection setup for the whole session instead of one per poll — that is what
 * makes the panel feel current rather than ~11s behind.
 *
 * The one-shot path below is the fallback: it covers first paint, before the
 * stream's first frame arrives, and any period where the stream has died. There
 * it keeps the original protections — repeats inside the TTL are served from
 * cache, and concurrent callers share one in-flight request — so the panel's 2s
 * poll can't stack multi-second round trips.
 */
export async function vmCapture(
  issueKey: string,
  lines = 1000,
  cols?: number,
): Promise<string> {
  const streamed = requestFrame(issueKey, Math.floor(lines), Math.floor(cols ?? 0));
  if (streamed !== null && hasFreshFrame(issueKey)) return streamed;

  const key = `${issueKey}:${lines}:${cols ?? 0}`;
  const cached = captureCache.get(key);
  if (cached && Date.now() - cached.at < config.vmCaptureTtlMs) return cached.content;

  const existing = captureInFlight.get(key);
  if (existing) return existing;

  const resize = cols && cols > 0
    ? `tmux resize-window -t ${TMUX_WINDOW} -x ${Math.floor(cols)} -y 50 2>/dev/null || true\n`
    : '';
  // -J joins wrapped lines so URLs broken across the pane width come back intact.
  const script = `${resize}tmux capture-pane -t ${TMUX_TARGET} -p -J -e -S -${Math.floor(lines)}`;

  const run = (async () => {
    try {
      const content = sanitizePane(await vmExec(issueKey, script, { timeoutMs: 60_000 }));
      captureCache.set(key, { at: Date.now(), content });
      return content;
    } finally {
      captureInFlight.delete(key);
    }
  })();

  captureInFlight.set(key, run);
  return run;
}

// --- Sending input -----------------------------------------------------------

/**
 * Type text into the Claude session inside a VM container.
 *
 * Same bracketed-paste approach as the local transports (see tmux-bridge's
 * sendKeys): the text goes in as one paste rather than a stream of keystrokes,
 * so embedded newlines don't submit the prompt early. The text is base64'd
 * *inside* the payload — which is itself base64'd — so no amount of quoting,
 * newlines or unicode in a user's message can break out of the command.
 *
 * The pause before Enter is load-bearing. Locally these are three separate
 * `docker exec` calls, and the process-spawn latency between them — 50ms or so
 * each — is enough for the TUI to finish consuming the bracketed paste before
 * the Enter arrives. Here all three run back to back inside one payload with no
 * gap at all, so the Enter landed mid-paste and was swallowed: every message
 * needed a second Enter to actually send. The delay restores what the local
 * path gets for free.
 */
export async function vmSend(
  issueKey: string,
  text: string,
  appendEnter = true,
): Promise<string | null> {
  const textB64 = Buffer.from(text, 'utf8').toString('base64');
  const enter = appendEnter
    ? `\nsleep ${config.vmPasteSettleSeconds}\ntmux send-keys -t ${TMUX_TARGET} Enter`
    : '';
  const script =
    `printf '%s' '${textB64}' | base64 -d | tmux load-buffer -b ${PASTE_BUFFER} -\n` +
    `tmux paste-buffer -t ${TMUX_TARGET} -b ${PASTE_BUFFER} -d -p${enter}`;

  return deliver(issueKey, script);
}

export async function vmSendKey(issueKey: string, key: string): Promise<string | null> {
  if (!ALLOWED_RAW_KEYS.has(key)) {
    throw new Error(`Disallowed key: ${key}`);
  }
  return deliver(issueKey, `tmux send-keys -t ${TMUX_TARGET} ${key}`);
}

/** How long to let the TUI repaint before grabbing the pane back. */
const REPAINT_SETTLE_SECONDS = 0.15;
const PANE_MARKER = '@@@PANE@@@';

/**
 * Deliver input and return the pane it produced, in one round trip.
 *
 * Reading the effect back here rather than waiting for the next poll is what
 * closes the visible gap: otherwise a keystroke costs its own round trip, then
 * up to a frame interval, then up to a poll interval before anything appears.
 * The pane is also pushed into the stream, so the next poll can't briefly show
 * an older frame and appear to undo the keystroke.
 */
async function deliver(issueKey: string, script: string): Promise<string | null> {
  const geometry = streamGeometry(issueKey);
  const withPane =
    `${script}\n` +
    `sleep ${REPAINT_SETTLE_SECONDS}\n` +
    `printf '%s\\n' '${PANE_MARKER}'\n` +
    `tmux capture-pane -t ${TMUX_TARGET} -p -J -e -S -${geometry.lines}`;

  const raw = await vmExec(issueKey, withPane, { timeoutMs: 60_000 });
  invalidateCapture(issueKey);

  const idx = raw.indexOf(PANE_MARKER);
  if (idx === -1) return null;
  const pane = sanitizePane(raw.slice(idx + PANE_MARKER.length).replace(/^\n/, ''));
  injectFrame(issueKey, pane);
  return pane;
}

/**
 * Drop cached frames after input, so the next poll shows the effect. The live
 * stream needs no help — its next frame is a second away.
 */
function invalidateCapture(issueKey: string): void {
  for (const key of [...captureCache.keys()]) {
    if (key.startsWith(`${issueKey}:`)) captureCache.delete(key);
  }
}

/** Wire the stream's script targeting to this module's. */
setVmStreamEnvResolver(vmScriptEnv);

/**
 * Resize the live pane without disturbing the frame loop. Debounced by the
 * caller; failures are ignored, since a mis-sized pane is cosmetic while a
 * torn-down stream is not.
 */
setVmResizeHandler((issueKey, cols) =>
  vmExec(issueKey, `tmux resize-window -t ${TMUX_WINDOW} -x ${Math.floor(cols)} -y 50 2>/dev/null || true`, {
    timeoutMs: 30_000,
  }),
);

/** Release a session's remote resources — used when its container is gone. */
export function stopVmStream(issueKey: string): void {
  stopStream(issueKey);
  stopChannel(issueKey);
}

/** Retire idle channels on the same sweep that retires idle streams. */
setChannelReaper(reapChannels);

// --- Session reads -----------------------------------------------------------

/**
 * Remove an agent container on the VM.
 *
 * Destructive in a way the local path is not: the script's `rm` deletes the
 * container *and* `docker volume rm`s its session volume, so the transcript
 * goes with it. Callers must say so before they ask for confirmation.
 *
 * Refuses unless the VM is known to be up — `rm` runs `ensure_vm_up` on the far
 * side, so a click on a stale row would otherwise boot the instance just to
 * delete a container.
 */
export async function removeVmContainer(issueKey: string): Promise<void> {
  if (!isSafeRemoteRef(issueKey)) {
    throw new Error(
      `"${issueKey}" cannot be used as a remote container handle: only letters, `
      + 'digits, dot, dash and underscore are accepted, because the handle is '
      + 'interpolated into a shell command on the far side.',
    );
  }
  if (!(await isVmAvailable())) {
    throw new Error('Remote support is disabled, or REMOTE_SCRIPT is not executable');
  }
  await refreshVmStatus();
  if (!vmIsUp()) {
    throw new Error(`VM is ${lastStatus.state.toLowerCase()} — start a VM session first`);
  }
  // `-f` skips the script's own y/N prompt — a `read` that would hang forever
  // on a non-TTY exec. It is not docker's force; `docker rm -f` runs either way.
  await runVmScript(['rm', issueKey, '-f'], { timeoutMs: VM_REMOVE_TIMEOUT_MS });
}

export async function readVmSessionSample(
  issueKey: string,
): Promise<{ jsonlPath: string; lines: string[] } | null> {
  return readSessionSample(
    vmExecScript(issueKey),
    config.containerClaudeProjectsDir,
    30_000,
  );
}

export async function readVmSessionFull(
  issueKey: string,
  jsonlPath: string,
): Promise<string> {
  return readSessionFull(vmExecScript(issueKey), `vm:${issueKey}`, jsonlPath, {
    timeoutMs: 120_000,
    // A transcript pulled over the tunnel is expensive enough that the
    // conversation view's poll interval should not re-fetch it.
    ttlMs: 15_000,
  });
}

export async function readVmSubagents(
  issueKey: string,
  primaryJsonlPath: string,
): Promise<SubagentInfo[]> {
  return readSubagents(vmExecScript(issueKey), `vm:${issueKey}`, primaryJsonlPath, {
    statsOnly: !config.vmSubagentCosts,
    byteBudget: config.vmSubagentByteBudget,
    listTimeoutMs: 60_000,
    contentTimeoutMs: 180_000,
  });
}
