import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { config } from '../config.js';

/**
 * SSH connection reuse for the VM script.
 *
 * `gcloud compute ssh` builds a fresh IAP tunnel and SSH connection on every
 * invocation, which measured ~11.5s per call against the agent VM. OpenSSH can
 * reuse one connection across invocations (ControlMaster), which takes that to
 * ~6s — but the flags have to reach the `ssh` that gcloud spawns, and the VM
 * script exposes no way to pass them.
 *
 * So the monitor puts a tiny `ssh` shim on the PATH of the script processes it
 * spawns, and only those: nothing about the user's own ssh config, gcloud
 * config, or interactive shells is touched. The shim execs the real ssh with
 * multiplexing enabled.
 *
 * The remaining ~6s is gcloud's own startup (Python + instance/OS-Login API
 * calls), which no amount of connection reuse can remove — that is what the
 * streaming terminal in vm-stream.ts exists to amortize.
 */

const SYSTEM_SSH_CANDIDATES = ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'];

/** Where the shim records the invocation gcloud generated. See below. */
const RECORD_FILE = 'last-args';

/**
 * Control sockets live under a short, stable path: a unix socket path is capped
 * near 104 bytes, and os.tmpdir() on macOS is long enough to blow that once the
 * connection hash is appended.
 */
function muxDir(): string {
  return path.join('/tmp', `cm-ssh-${typeof os.userInfo === 'function' ? os.userInfo().uid : 0}`);
}

let prepared: string | null | undefined;

function findSystemSsh(): string | null {
  for (const candidate of SYSTEM_SSH_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * Directory to prepend to PATH so the script's `ssh` calls get multiplexed.
 * Returns null when disabled or unavailable — callers then simply run without
 * connection reuse, which is slower but works identically.
 */
export function sshMuxPathPrefix(): string | null {
  if (!config.vmSshMux) return null;
  if (prepared !== undefined) return prepared;

  const systemSsh = findSystemSsh();
  if (!systemSsh) {
    prepared = null;
    return prepared;
  }

  try {
    const dir = muxDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const shim = path.join(dir, 'ssh');
    fs.writeFileSync(
      shim,
      [
        '#!/bin/sh',
        '# Written by claude-monitor. Two jobs:',
        '#  1. Reuse one SSH connection per host, so repeated `gcloud compute',
        '#     ssh` calls skip the tunnel handshake.',
        '#  2. Record the invocation gcloud generated, so later calls can reuse',
        '#     that connection directly and skip gcloud itself. NUL-separated,',
        '#     written to a temp file and renamed, so a concurrent reader never',
        '#     sees a half-written record.',
        `T=${dir}/args.$$`,
        ': > "$T"',
        'for a in "$@"; do printf \'%s\\0\' "$a" >> "$T"; done',
        `mv -f "$T" ${dir}/${RECORD_FILE}`,
        `exec ${systemSsh} \\`,
        '  -o ControlMaster=auto \\',
        `  -o ControlPath=${dir}/%C \\`,
        `  -o ControlPersist=${config.vmSshMuxPersistSeconds} \\`,
        '  "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    prepared = dir;
  } catch {
    // A read-only /tmp or similar — fall back to unmultiplexed calls.
    prepared = null;
  }
  return prepared;
}

/** Test seam — forget the prepared shim. */
export function resetSshMux(): void {
  prepared = undefined;
}

export interface RecordedSsh {
  /** Everything up to and including the `--` separator. */
  sshArgs: string[];
  /** Path to the remote runner on the VM, as the script invokes it. */
  runnerPath: string;
}

/**
 * Split a recorded invocation into the connection arguments and the remote
 * runner path. The command gcloud appends after `--` is the runner call the VM
 * script wanted to make, so its first token tells us where the runner lives.
 *
 * Everything here is *learned* from an invocation the script itself made —
 * nothing about the VM, user, tunnel or paths is hardcoded, so if the script
 * retargets, the next recording follows it. Pure, for testability.
 */
export function parseRecordedSsh(raw: string): RecordedSsh | null {
  const args = raw.split('\0').filter(a => a.length > 0);
  const sep = args.indexOf('--');
  if (sep === -1) return null;

  const runnerPath = args[sep + 1];
  // Only ever replay a command aimed at the runner the script uses. Anything
  // else means the recording isn't what we think it is.
  if (!runnerPath?.endsWith(config.vmRunnerScript)) return null;

  return { sshArgs: args.slice(0, sep + 1), runnerPath };
}

/**
 * The last SSH invocation the VM script made, if one was recorded.
 *
 * This is what lets an interactive keystroke cost ~0.6s instead of ~6s: the
 * expensive part of a script call is gcloud's own startup, not the network, so
 * replaying its ssh invocation over the connection it already opened skips
 * gcloud entirely. If the shared connection has since expired, ssh simply runs
 * gcloud's ProxyCommand again — the same cost as before, never worse.
 */
export function recordedSshInvocation(): RecordedSsh | null {
  if (!config.vmFastExec) return null;
  const dir = sshMuxPathPrefix();
  if (!dir) return null;
  try {
    return parseRecordedSsh(fs.readFileSync(path.join(dir, RECORD_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Multiplexing options, for callers invoking the real ssh directly. */
export function sshMuxOptions(): string[] {
  const dir = muxDir();
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${dir}/%C`,
    '-o', `ControlPersist=${config.vmSshMuxPersistSeconds}`,
  ];
}

/**
 * Options for a call that must *reuse* the shared connection and may never
 * build one of its own.
 *
 * `ControlMaster=auto` races: several calls starting at once each find no
 * master and each runs gcloud's ProxyCommand, so the machine ends up with a
 * handful of IAP tunnels and those calls pay the full ~6s startup anyway.
 * Observed live: six concurrent tunnels, with new ones appearing per call.
 * Reuse-only calls cannot do that — if the master is missing they fail fast,
 * and the caller establishes one explicitly (once, serialized) and retries.
 */
export function sshReuseOptions(): string[] {
  return ['-o', 'ControlMaster=no', '-o', `ControlPath=${muxDir()}/%C`];
}

/** Connection arguments with the trailing `--` removed, for master control. */
function connectionArgs(recorded: RecordedSsh): string[] {
  return recorded.sshArgs.filter(a => a !== '--');
}

function runSsh(args: string[], timeoutMs: number): Promise<void> {
  const ssh = findSystemSsh();
  if (!ssh) return Promise.reject(new Error('no ssh binary'));
  return new Promise((resolve, reject) => {
    execFile(ssh, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Whether the shared master connection is currently up. */
export async function isMasterAlive(recorded: RecordedSsh): Promise<boolean> {
  try {
    await runSsh([...sshMuxOptions(), '-O', 'check', ...connectionArgs(recorded)], 10_000);
    return true;
  } catch {
    return false;
  }
}

let establishing: Promise<void> | null = null;

/**
 * Make sure exactly one shared connection exists, building it if needed.
 *
 * Serialized on purpose: concurrent callers wait on the same attempt rather
 * than each starting a tunnel. `-N -f` backgrounds a command-less master, so
 * this resolves once the connection is usable by everyone else.
 */
export async function ensureSshMaster(recorded: RecordedSsh): Promise<boolean> {
  if (await isMasterAlive(recorded)) return true;

  if (!establishing) {
    establishing = runSsh(
      [
        '-o', 'ControlMaster=yes',
        '-o', `ControlPath=${muxDir()}/%C`,
        '-o', `ControlPersist=${config.vmSshMuxPersistSeconds}`,
        ...connectionArgs(recorded),
        '-N', '-f',
      ],
      120_000,
    ).finally(() => { establishing = null; });
  }

  try {
    await establishing;
    return true;
  } catch {
    // Someone else may have won the race and created it anyway.
    return isMasterAlive(recorded);
  }
}

/** The real ssh binary, or null when none of the usual locations has one. */
export function systemSshPath(): string | null {
  return findSystemSsh();
}
