import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { config } from '../config.js';
import {
  recordedSshInvocation,
  sshReuseOptions,
  ensureSshMaster,
  systemSshPath,
} from './ssh-mux.js';

/**
 * A persistent request/response channel into one VM container.
 *
 * Measured layer by layer, a keystroke's ~0.55s breaks down as: 0.42s to open
 * an SSH channel and run `true`, 0.09s for `docker exec`, and ~0.04s for the
 * runner and tmux. The remote work is already cheap — what costs is opening a
 * channel per keystroke. Nothing on the far side can fix that.
 *
 * So a session keeps one connection open with a shell loop on the VM reading
 * commands from stdin, one per line, and marking the end of each one's output.
 * Sending is then a pipe write plus the remote work only: ~0.13s.
 *
 * The loop invokes the same `vm-resolve-runner.sh shell <KEY> …` the VM script
 * would, with the runner path taken from a recording of the script's own
 * invocation — this is a persistent way of issuing the script's command, not a
 * reimplementation of what it does. Anything unavailable or broken here returns
 * null and the caller falls back to a one-shot call.
 */

const CMD_END = '@@@CMDEND@@@';

/** Payloads here are single-line and small; anything big uses a one-shot call. */
const MAX_COMMAND_BYTES = 128 * 1024;

type ChannelProc = ChildProcessByStdio<Writable, Readable, Readable>;

interface Channel {
  proc: ChannelProc;
  buf: string;
  /** Resolves with the output of the command currently in flight. */
  pending: ((output: string) => void) | null;
  /** One command at a time: the loop is strictly ordered, and so are we. */
  queue: Promise<unknown>;
  lastUsedAt: number;
  stopped: boolean;
}

const channels = new Map<string, Channel>();
const starting = new Set<string>();

/**
 * The remote loop. `$line` and `$HOME` are expanded by the remote shell as the
 * loop runs, not when the command string is parsed.
 */
function buildLoopCommand(runnerPath: string, issueKey: string): string {
  return (
    'while IFS= read -r line; do ' +
    '[ -n "$line" ] || continue; ' +
    `${runnerPath} shell ${issueKey} "$line" 2>&1; ` +
    `printf '\\n%s\\n' '${CMD_END}'; ` +
    'done'
  );
}

function consume(channel: Channel, chunk: string): void {
  channel.buf += chunk;
  const idx = channel.buf.indexOf(CMD_END);
  if (idx === -1) return;

  const output = channel.buf.slice(0, idx);
  channel.buf = channel.buf.slice(idx + CMD_END.length).replace(/^\n/, '');

  const resolve = channel.pending;
  channel.pending = null;
  resolve?.(output);
}

async function startChannel(issueKey: string): Promise<Channel | null> {
  if (starting.has(issueKey)) return null;
  starting.add(issueKey);
  try {
    const recorded = recordedSshInvocation();
    const ssh = systemSshPath();
    if (!recorded || !ssh) return null;
    if (!(await ensureSshMaster(recorded))) return null;

    const proc = spawn(
      ssh,
      [
        ...sshReuseOptions(),
        ...recorded.sshArgs,
        buildLoopCommand(recorded.runnerPath, issueKey),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChannelProc;

    const channel: Channel = {
      proc,
      buf: '',
      pending: null,
      queue: Promise.resolve(),
      lastUsedAt: Date.now(),
      stopped: false,
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => consume(channel, chunk));
    proc.stderr.resume();

    const onEnd = () => {
      channel.stopped = true;
      // Never leave a caller hanging on a channel that has gone away.
      channel.pending?.('');
      channel.pending = null;
      if (channels.get(issueKey) === channel) channels.delete(issueKey);
    };
    proc.on('close', onEnd);
    proc.on('error', onEnd);

    channels.set(issueKey, channel);
    return channel;
  } catch {
    return null;
  } finally {
    starting.delete(issueKey);
  }
}

function sendOne(channel: Channel, command: string, timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    if (channel.stopped) {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      // A stuck command poisons ordering for everything behind it — drop the
      // whole channel and let the caller fall back.
      if (channel.pending) {
        channel.pending = null;
        channel.stopped = true;
        channel.proc.kill('SIGTERM');
      }
      resolve(null);
    }, timeoutMs);

    channel.pending = (output: string) => {
      clearTimeout(timer);
      resolve(output);
    };
    channel.proc.stdin.write(`${command}\n`, (err) => {
      if (!err) return;
      clearTimeout(timer);
      channel.pending = null;
      resolve(null);
    });
  });
}

/**
 * Run one container command over the session's persistent channel.
 *
 * `command` is the payload as the runner's `bash -lc` should see it — with no
 * outer quoting, since it is read as a line rather than parsed by a shell on
 * the way in. Returns null whenever the channel can't serve it, which is always
 * a signal to fall back rather than an error to surface.
 */
export async function channelExec(
  issueKey: string,
  command: string,
  timeoutMs = 20_000,
): Promise<string | null> {
  if (!config.vmChannelEnabled) return null;
  if (command.includes('\n') || Buffer.byteLength(command) > MAX_COMMAND_BYTES) return null;

  let channel = channels.get(issueKey);
  if (!channel || channel.stopped) {
    channel = (await startChannel(issueKey)) ?? undefined;
    if (!channel) return null;
  }

  const active = channel;
  active.lastUsedAt = Date.now();

  // Serialize: the remote loop handles one command at a time, so overlapping
  // writes would interleave two commands' output around one end marker.
  const result = active.queue.then(() => sendOne(active, command, timeoutMs));
  active.queue = result.catch(() => undefined);
  return result;
}

export function stopChannel(issueKey: string): void {
  const channel = channels.get(issueKey);
  if (!channel) return;
  channels.delete(issueKey);
  channel.stopped = true;
  channel.proc.kill('SIGTERM');
}

export function stopAllChannels(): void {
  for (const key of [...channels.keys()]) stopChannel(key);
}

/** Drop channels for sessions nobody has interacted with recently. */
export function reapChannels(): void {
  const now = Date.now();
  for (const [key, channel] of [...channels]) {
    if (now - channel.lastUsedAt > config.vmChannelIdleMs) stopChannel(key);
    else if (channel.stopped) channels.delete(key);
  }
}
