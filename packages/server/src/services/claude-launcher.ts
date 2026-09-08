import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  registerLaunchedSession,
  forgetLaunchedSession,
  getLaunchedSession,
  type LaunchedSession,
} from './launched-sessions.js';

const execFileAsync = promisify(execFile);

// Detached tmux sessions default to 80x24, which makes Claude's TUI wrap badly
// on first paint. TerminalCapture resizes to the real viewport on every capture;
// this is just a sane starting size.
const PANE_COLS = 200;
const PANE_ROWS = 50;

const SHELL_READY_ATTEMPTS = 20;
const SHELL_READY_INTERVAL_MS = 100;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function assertLaunchableDirectory(cwd: string): Promise<void> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Path must be absolute: "${cwd}"`);
  }
  let stat;
  try {
    stat = await fsp.stat(cwd);
  } catch {
    throw new Error(`Path does not exist: "${cwd}"`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: "${cwd}"`);
  }
}

/**
 * Wait until the pane is running a shell that will read typed input. Keys sent
 * before the shell starts usually survive in the pty buffer, but zsh setups that
 * flush pending input at startup would swallow the command — so observe first.
 */
async function waitForShell(tmuxSession: string): Promise<void> {
  for (let i = 0; i < SHELL_READY_ATTEMPTS; i++) {
    try {
      const { stdout } = await execFileAsync('tmux', [
        'display-message', '-p', '-t', `${tmuxSession}:0.0`, '#{pane_current_command}',
      ], { timeout: 3000 });
      if (stdout.trim()) return;
    } catch {
      // Pane not ready yet — retry.
    }
    await sleep(SHELL_READY_INTERVAL_MS);
  }
}

/**
 * Start a Claude Code session in a detached tmux session at `cwd`.
 *
 * The command is *typed into* an interactive shell rather than passed as the
 * tmux command, because `claude` is frequently a shell function (it injects an
 * OAuth token before exec'ing the real binary). Passing it to tmux directly
 * would exec the bare binary with no credentials.
 */
export async function launchClaudeSession(rawCwd: string): Promise<LaunchedSession> {
  const cwd = rawCwd.trim();
  await assertLaunchableDirectory(cwd);

  const sessionId = randomUUID();
  // uuid hex is free of the `.` and `:` that tmux reserves in target names.
  const tmuxSession = `${config.spawnTmuxPrefix}${sessionId.slice(0, 8)}`;

  await execFileAsync('tmux', [
    'new-session', '-d',
    '-s', tmuxSession,
    '-c', cwd,
    '-x', String(PANE_COLS),
    '-y', String(PANE_ROWS),
    config.spawnShell, '-i',
  ], { timeout: 10_000 });

  await waitForShell(tmuxSession);

  await execFileAsync('tmux', [
    'send-keys', '-t', `${tmuxSession}:0.0`,
    `claude --session-id ${sessionId}`, 'Enter',
  ], { timeout: 5000 });

  const entry: LaunchedSession = {
    sessionId,
    tmuxSession,
    cwd,
    launchedAt: new Date().toISOString(),
  };
  await registerLaunchedSession(entry);
  return entry;
}

/**
 * Reopen an existing session under tmux, so it can be typed into.
 *
 * Claude Code exposes no way to write into a session that is already running —
 * tmux is the only mechanism, and it has to be there from the start. A session
 * someone opened in their own terminal is therefore observe-only here, forever.
 *
 * `claude --resume <id>` is the way out, and it is exactly what the user would
 * type: the conversation comes back with its full history, in a tmux session
 * this app owns, and the card for that id becomes interactive because the
 * launched-session registry binds the two. Resuming a session that is *also*
 * open elsewhere works — Claude Code neither refuses nor complains — so this
 * does not try to stop it; the UI says so instead.
 */
export async function resumeSessionInTmux(
  sessionId: string,
  rawCwd: string,
): Promise<LaunchedSession> {
  const existing = getLaunchedSession(sessionId);
  if (existing) return existing;

  const cwd = rawCwd.trim();
  await assertLaunchableDirectory(cwd);

  // Same prefix as a fresh launch: these are equally this app's tmux sessions,
  // and the prefix is what keeps them out of the tag matcher.
  const tmuxSession = `${config.spawnTmuxPrefix}${sessionId.slice(0, 8)}`;
  // A leftover from an earlier resume would otherwise take the name.
  try {
    await execFileAsync('tmux', ['kill-session', '-t', tmuxSession], { timeout: 3000 });
  } catch { /* nothing there, which is the normal case */ }

  await execFileAsync('tmux', [
    'new-session', '-d',
    '-s', tmuxSession,
    '-c', cwd,
    '-x', String(PANE_COLS),
    '-y', String(PANE_ROWS),
    config.spawnShell, '-i',
  ], { timeout: 10_000 });

  await waitForShell(tmuxSession);

  // Typed into the shell rather than passed to tmux, for the same reason as a
  // fresh launch: `claude` is usually a shell function that injects a token.
  await execFileAsync('tmux', [
    'send-keys', '-t', `${tmuxSession}:0.0`,
    `claude --resume ${sessionId}`, 'Enter',
  ], { timeout: 5000 });

  const entry: LaunchedSession = {
    sessionId,
    tmuxSession,
    cwd,
    launchedAt: new Date().toISOString(),
  };
  await registerLaunchedSession(entry);
  return entry;
}

/**
 * What may be interpolated into `claude --cloud <handle>`.
 *
 * **Security-critical.** The command is typed into a shell with `send-keys`,
 * not handed to `execFile` as argv, because `claude` is usually a shell
 * function that injects a token — so whatever goes in here reaches a shell
 * unquoted. This is an injection guard, not an identity check: it stays fixed
 * and narrow, and it must never be relaxed to "whatever claude.ai might
 * produce". A handle that is a legitimate session and fails this test is a
 * missing feature; one that passes and is not is a compromised machine.
 *
 * Two accepted shapes, both of which `--cloud` takes: the URL you copy from the
 * address bar, and the bare session id inside it.
 */
const CLOUD_ID = /^[A-Za-z0-9_-]{6,128}$/;
const CLOUD_URL = /^https:\/\/claude\.ai\/code\/([A-Za-z0-9_-]{6,128})\/?$/;

/** The handle to pass to `--cloud`, or null when it is not one. */
export function cloudHandle(raw: string): string | null {
  const value = raw.trim();
  const url = CLOUD_URL.exec(value);
  if (url) return value.replace(/\/$/, '');
  return CLOUD_ID.test(value) ? value : null;
}

/**
 * Attach to a session running on claude.ai/code, in a tmux session here.
 *
 * The gap this closes: a cloud session leaves nothing on this disk and has no
 * API to ask, so the dashboard could not see one at all — the honest answer for
 * a long time was that it never would. `claude --cloud <url>` changes that. It
 * attaches to the existing conversation from this machine, and once it is
 * running in a pane it is an ordinary session here: the ownership scan binds it
 * like any other, and it is readable and typeable.
 *
 * The directory matters less than for a local session — the work is happening
 * elsewhere — but a shell has to start somewhere, and *where* turned out to
 * matter a great deal. Defaulting to the home directory meant Claude Code met
 * an untrusted folder on the way up and stopped at its safety prompt, so the
 * attach died before it began and left a dead pane on the board. Worse, the
 * folder it was asking about was the whole home directory, which is the last
 * one anybody should wave through. The configured launch directory is used
 * instead — the same one the New session dialog offers, which is somewhere the
 * user already works.
 */
export async function attachCloudSessionInTmux(
  rawHandle: string,
  rawCwd?: string,
): Promise<LaunchedSession> {
  const handle = cloudHandle(rawHandle);
  if (!handle) {
    throw new Error(
      'Not a claude.ai/code session: expected https://claude.ai/code/<id> or the id itself.',
    );
  }

  const cwd = (rawCwd || '').trim() || config.spawnDefaultCwd;
  if (!cwd) {
    throw new Error('No directory to start in: set SPAWN_DEFAULT_CWD or pass one.');
  }
  await assertLaunchableDirectory(cwd);

  // Named after the id, not the URL, so the tmux session stays short and the
  // prefix keeps it out of the tag matcher like every other launch.
  const id = handle.split('/').pop()!;
  const tmuxSession = `${config.spawnTmuxPrefix}cloud-${id.slice(0, 12)}`;
  try {
    await execFileAsync('tmux', ['kill-session', '-t', tmuxSession], { timeout: 3000 });
  } catch { /* nothing there, which is the normal case */ }

  await execFileAsync('tmux', [
    'new-session', '-d',
    '-s', tmuxSession,
    '-c', cwd,
    '-x', String(PANE_COLS),
    '-y', String(PANE_ROWS),
    config.spawnShell, '-i',
  ], { timeout: 10_000 });

  await waitForShell(tmuxSession);

  await execFileAsync('tmux', [
    'send-keys', '-t', `${tmuxSession}:0.0`,
    `claude --cloud ${handle}`, 'Enter',
  ], { timeout: 5000 });

  // An attach can be refused, and the refusal is a line of text followed by the
  // shell prompt coming back — which from outside looks exactly like a session
  // that started. Leaving that on the board is the worst outcome: a card
  // standing for nothing, with the reason buried in a pane nobody thought to
  // open. So wait to see whether Claude Code is actually running in there, and
  // if it is not, hand back what it said and take the tmux session away again.
  const failure = await attachFailure(tmuxSession);
  if (failure) {
    try {
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSession], { timeout: 3000 });
    } catch { /* already gone */ }
    throw new Error(failure);
  }

  const entry: LaunchedSession = {
    sessionId: `cloud:${id}`,
    tmuxSession,
    cwd,
    launchedAt: new Date().toISOString(),
  };
  await registerLaunchedSession(entry);
  return entry;
}

/**
 * Whether the attach failed, and what it said.
 *
 * Asks tmux what the pane is running rather than reading the text: a shell
 * where Claude Code should be is the fact, in any language and whatever the
 * message happens to be. The message is only fetched once that has been
 * established, to pass on.
 */
async function attachFailure(tmuxSession: string): Promise<string | null> {
  const deadline = Date.now() + ATTACH_TIMEOUT_MS;
  let settled = 0;
  while (Date.now() < deadline) {
    await sleep(500);
    let command = '';
    try {
      const { stdout } = await execFileAsync('tmux', [
        'list-panes', '-t', `${tmuxSession}:0`, '-F', '#{pane_current_command}',
      ], { timeout: 3000 });
      command = stdout.trim().split('\n')[0] ?? '';
    } catch {
      return 'The tmux session went away before Claude Code started in it.';
    }
    // Anything but a shell means something started — but a refused attach
    // *does* start: Claude Code comes up, prints why it will not go on, and
    // exits. Catching it in that window and calling it success is exactly the
    // mistake this function exists to avoid, so the pane has to stay off the
    // shell for a while rather than merely be off it once.
    if (command && !SHELL_COMMANDS.has(command)) {
      if (++settled >= STABLE_POLLS) return null;
    } else {
      settled = 0;
    }
  }

  return (await lastErrorLine(tmuxSession))
    ?? 'Claude Code did not start. Open the pane to see why.';
}

/** Pane commands that mean nothing has started yet. */
const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'login']);
const ATTACH_TIMEOUT_MS = 15_000;
/** Consecutive half-second polls off the shell before the attach is believed. */
const STABLE_POLLS = 6;

/** The complaint Claude Code printed before the prompt came back, if any. */
async function lastErrorLine(tmuxSession: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('tmux', [
      'capture-pane', '-t', `${tmuxSession}:0.0`, '-p', '-J',
    ], { timeout: 3000 });
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    // Last first: the shell prompt is below it, and an earlier run's output may
    // be above.
    for (const line of lines.reverse()) {
      if (/^(error|fatal)\b/i.test(line)) return line;
    }
    return null;
  } catch {
    return null;
  }
}

/** Kill a monitor-launched session's tmux session and drop it from the registry. */
export async function killLaunchedSession(sessionId: string): Promise<void> {
  const entry = getLaunchedSession(sessionId);
  if (!entry) return;
  try {
    await execFileAsync('tmux', ['kill-session', '-t', entry.tmuxSession], { timeout: 5000 });
  } catch {
    // Already gone — still drop the registry entry below.
  }
  await forgetLaunchedSession(sessionId);
}
