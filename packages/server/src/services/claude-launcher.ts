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
