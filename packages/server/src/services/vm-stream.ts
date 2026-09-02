import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { config } from '../config.js';
import { sanitizePane } from './ansi.js';
import {
  recordedSshInvocation,
  sshReuseOptions,
  ensureSshMaster,
  systemSshPath,
} from './ssh-mux.js';
import { wrapForShell, buildRunnerShellCommand } from './vm-payload.js';

/**
 * Live terminal frames from a VM container, over one long-lived connection.
 *
 * Polling the pane one call at a time costs a full `gcloud compute ssh` startup
 * per frame (~6s even with connection reuse), so a 2s poll interval can never
 * be live — measured end-to-end, the panel ran ~11s behind.
 *
 * Instead the monitor pays that startup once and leaves a loop running inside
 * the container, emitting the pane on an interval. Measured against the real
 * VM: ~7.6s to first frame, then a frame every 1.0s.
 *
 * Lifecycle is driven by demand. A stream starts on the first capture request
 * for a session and stops once nothing has asked for a while, so idle sessions
 * hold no connection. The remote loop is bounded and re-spawned rather than
 * infinite: if this process dies or the tunnel drops, an unbounded loop would
 * keep running inside the container with nobody reading it.
 */

const FRAME_MARKER = '@@@VMFRAME@@@';

/** stdin is deliberately not piped: the remote loop reads nothing. */
type StreamProc = ChildProcessByStdio<null, Readable, Readable>;

interface VmStream {
  proc: StreamProc;
  /** Last *complete* frame; a frame is complete when the next marker arrives. */
  latest: string | null;
  latestAt: number;
  lastRequestedAt: number;
  lines: number;
  /** Pane width most recently asked for; applied by resize, not by restarting. */
  cols: number;
  lastResizeAt: number;
  buf: string;
  stopped: boolean;
}

const streams = new Map<string, VmStream>();

/**
 * The remote loop. Bounded on purpose (see above); the monitor re-spawns while
 * frames are still being requested. Writing to a closed stdout also ends it —
 * belt and braces, since an orphan here would run inside the user's container.
 */
function buildStreamScript(lines: number, cols: number): string {
  const resize = cols > 0
    ? `tmux resize-window -t ${config.containerTmuxWindow} -x ${cols} -y 50 2>/dev/null || true\n`
    : '';
  return (
    resize +
    'i=0\n' +
    `while [ $i -lt ${config.vmStreamMaxFrames} ]; do\n` +
    `  printf '%s\\n' '${FRAME_MARKER}'\n` +
    `  tmux capture-pane -t ${config.containerTmuxPane} -p -J -e -S -${lines} || exit 0\n` +
    '  i=$((i+1))\n' +
    `  sleep ${config.vmStreamIntervalSeconds}\n` +
    'done\n'
  );
}

/**
 * Split a stream buffer into complete frames plus the unfinished tail.
 *
 * A frame is only complete once the *next* marker arrives — the pane is written
 * in several TCP chunks, so treating the tail as a frame would render the
 * terminal half-drawn every second. Anything before the first marker is
 * connection preamble and is dropped. Pure, so the chunk-boundary cases can be
 * tested without a VM.
 */
export function splitFrames(buf: string): { frames: string[]; rest: string } {
  const first = buf.indexOf(FRAME_MARKER);
  if (first === -1) return { frames: [], rest: buf };

  const frames: string[] = [];
  let start = first;
  let next: number;
  while ((next = buf.indexOf(FRAME_MARKER, start + FRAME_MARKER.length)) !== -1) {
    frames.push(buf.slice(start + FRAME_MARKER.length, next).replace(/^\n/, ''));
    start = next;
  }
  return { frames, rest: buf.slice(start) };
}

/** Cap on a partial frame's buffer, in case a pane is far larger than expected. */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function consumeFrames(stream: VmStream, chunk: string): void {
  const { frames, rest } = splitFrames(stream.buf + chunk);
  stream.buf = rest.length > MAX_BUFFER_BYTES ? rest.slice(-MAX_BUFFER_BYTES / 4) : rest;

  const last = frames.at(-1);
  if (last === undefined) return;
  // Only the newest frame matters — the panel renders current state, not history.
  stream.latest = sanitizePane(last);
  stream.latestAt = Date.now();
}

/** Guards against a second spawn while the first is still connecting. */
const starting = new Set<string>();

/**
 * Start a stream for a session. Async because establishing the shared SSH
 * connection may have to happen first; callers fire it and take frames once
 * they arrive.
 */
async function startStream(issueKey: string, lines: number, cols: number): Promise<void> {
  if (starting.has(issueKey)) return;
  starting.add(issueKey);
  try {
    // Same three-shell-safe wrapping as the one-shot payloads, minus the output
    // marker: frames carry their own.
    const wrapped = wrapForShell(buildStreamScript(lines, cols));

    // Prefer the already-open connection: it takes first frame from ~7.6s to
    // ~1s. Falls back to the script, which is also what records the invocation
    // this relies on, so the first stream of a server's life uses the slow path.
    const recorded = recordedSshInvocation();
    const ssh = systemSshPath();
    const reusable = recorded && ssh ? await ensureSshMaster(recorded) : false;

    const [file, args] = reusable && recorded && ssh
      ? [ssh, [
          ...sshReuseOptions(),
          ...recorded.sshArgs,
          buildRunnerShellCommand(recorded.runnerPath, issueKey, wrapped),
        ]]
      : [config.vmResolveScript, ['shell', issueKey, wrapped]];

    spawnStream(issueKey, lines, cols, file, args);
  } catch {
    // Nothing to keep: the next frame request retries.
  } finally {
    starting.delete(issueKey);
  }
}

function spawnStream(
  issueKey: string,
  lines: number,
  cols: number,
  file: string,
  args: string[],
): VmStream {
  const proc: StreamProc = spawn(file, args, {
    env: vmStreamEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stream: VmStream = {
    proc,
    latest: null,
    latestAt: 0,
    lastRequestedAt: Date.now(),
    lines,
    cols,
    lastResizeAt: Date.now(),
    buf: '',
    stopped: false,
  };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => consumeFrames(stream, chunk));
  // gcloud narrates tunnel warnings on stderr; nothing there belongs in a frame.
  proc.stderr.resume();

  const onEnd = () => {
    stream.stopped = true;
    if (streams.get(issueKey) === stream) streams.delete(issueKey);
  };
  proc.on('close', onEnd);
  proc.on('error', onEnd);

  streams.set(issueKey, stream);
  return stream;
}

/** Env is resolved lazily so the SSH shim is prepared before the first spawn. */
let envResolver: (() => NodeJS.ProcessEnv) | null = null;

/** Wired up by vm-bridge, which owns how the script is targeted. */
export function setVmStreamEnvResolver(fn: () => NodeJS.ProcessEnv): void {
  envResolver = fn;
}

function vmStreamEnv(): NodeJS.ProcessEnv {
  return envResolver ? envResolver() : process.env;
}

/**
 * Latest streamed frame for a session, or null when none has arrived yet.
 * Requesting also keeps the stream alive and starts it if needed, so callers
 * should treat this as "ask for live frames, take whatever is ready".
 */
export function requestFrame(
  issueKey: string,
  lines: number,
  cols: number,
): string | null {
  if (!config.vmStreamEnabled) return null;

  let stream = streams.get(issueKey);

  // Only a request for *more* scrollback than the loop is capturing needs a
  // restart. Width deliberately does not: the pane belongs to one tmux session
  // that every viewer shares, and each client computes its own `cols` from its
  // own layout. Restarting on width made two clients — or one whose measured
  // width drifts by a pixel — tear the stream down on alternate polls, and
  // every teardown costs a ~6s one-shot read. Width is applied by resizing the
  // live pane instead, debounced so clients can't fight over it.
  if (stream && lines > stream.lines) {
    stopStream(issueKey);
    stream = undefined;
  }

  if (!stream || stream.stopped) {
    void startStream(issueKey, lines, cols);
    return null;
  }

  stream.lastRequestedAt = Date.now();
  maybeResize(issueKey, stream, cols);
  return stream.latest;
}

/** Applied out of band: a resize must never interrupt the frame loop. */
const RESIZE_MIN_INTERVAL_MS = 5000;
const RESIZE_TOLERANCE_COLS = 2;

let resizeHandler: ((issueKey: string, cols: number) => Promise<unknown>) | null = null;

/** Wired up by vm-bridge, which owns how commands reach the container. */
export function setVmResizeHandler(
  fn: (issueKey: string, cols: number) => Promise<unknown>,
): void {
  resizeHandler = fn;
}

function maybeResize(issueKey: string, stream: VmStream, cols: number): void {
  if (!resizeHandler || cols <= 0) return;
  if (Math.abs(stream.cols - cols) <= RESIZE_TOLERANCE_COLS) return;
  if (Date.now() - stream.lastResizeAt < RESIZE_MIN_INTERVAL_MS) return;

  stream.cols = cols;
  stream.lastResizeAt = Date.now();
  void resizeHandler(issueKey, cols).catch(() => { /* best-effort */ });
}

/**
 * Geometry the stream is currently capturing at, so a caller reading the pane
 * out of band asks for the same shape the panel is rendering.
 */
export function streamGeometry(issueKey: string): { lines: number; cols: number } {
  const stream = streams.get(issueKey);
  return stream
    ? { lines: stream.lines, cols: stream.cols }
    : { lines: DEFAULT_STREAM_LINES, cols: 0 };
}

const DEFAULT_STREAM_LINES = 1000;

/**
 * Adopt a pane captured elsewhere as the newest frame.
 *
 * Without this, a keystroke's own read would be followed by an older streamed
 * frame on the next poll, and the terminal would appear to undo what was just
 * typed before catching up again.
 */
export function injectFrame(issueKey: string, content: string): void {
  const stream = streams.get(issueKey);
  if (!stream) return;
  stream.latest = content;
  stream.latestAt = Date.now();
}

/** Whether a session currently has live frames — used to skip one-shot reads. */
export function hasFreshFrame(issueKey: string): boolean {
  const stream = streams.get(issueKey);
  if (!stream || stream.latest === null) return false;
  return Date.now() - stream.latestAt < config.vmStreamStaleMs;
}

export function stopStream(issueKey: string): void {
  const stream = streams.get(issueKey);
  if (!stream) return;
  streams.delete(issueKey);
  stream.stopped = true;
  stream.proc.kill('SIGTERM');
}

export function stopAllStreams(): void {
  for (const key of [...streams.keys()]) stopStream(key);
}

/**
 * Drop streams nobody is watching, and re-spawn ones whose bounded remote loop
 * ran out while the panel is still open.
 */
export function reapStreams(): void {
  reapIdleChannels?.();
  const now = Date.now();
  for (const [key, stream] of [...streams]) {
    if (now - stream.lastRequestedAt > config.vmStreamIdleMs) stopStream(key);
    else if (stream.stopped) streams.delete(key);
  }
}

/** Injected by vm-bridge so the reaper can retire idle channels too. */
let reapIdleChannels: (() => void) | null = null;

export function setChannelReaper(fn: () => void): void {
  reapIdleChannels = fn;
}

let reaper: ReturnType<typeof setInterval> | null = null;

export function startStreamReaper(): void {
  if (reaper) return;
  reaper = setInterval(reapStreams, 5000);
  reaper.unref?.();
}

export function stopStreamReaper(): void {
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}
