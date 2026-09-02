import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { sanitizePane } from './ansi.js';
import { execFileRetrying } from './exec-retry.js';

// Same rationale as docker-scanner: capture/send run on a poll, and a transient
// EAGAIN from host process pressure isn't a real failure.
const execFileAsync = execFileRetrying;

// Run a command, feeding `input` on stdin. Used for `tmux load-buffer -`, which
// reads the payload from stdin and so sidesteps the ARG_MAX limit that a large
// argv would hit. Rejects on non-zero exit (including the spawn timeout, which
// kills the child) so callers surface a real error instead of hanging.
export function execFileWithInput(
  file: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { timeout: timeoutMs });
    let stderr = '';
    child.stderr?.on('data', d => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} ${args.join(' ')} failed (${code ?? signal}): ${stderr.trim()}`));
    });
    // Ignore EPIPE if the child exits before consuming all of stdin.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export interface TmuxSession {
  name: string;
  created: number;
  attached: boolean;
}

// Same rationale as scanDockerContainers — cache last good result so a single
// transient tmux failure doesn't wipe every session's tmuxSession assignment.
let lastTmuxSuccess: { sessions: TmuxSession[]; at: number } | null = null;
const TMUX_STALE_TTL_MS = 60_000;

/** True when the last tmux scan succeeded recently enough to be authoritative. */
export function wasTmuxScanRecent(): boolean {
  return !!lastTmuxSuccess && Date.now() - lastTmuxSuccess.at < TMUX_STALE_TTL_MS;
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
  if (!config.tmuxEnabled) return [];

  try {
    const { stdout } = await execFileAsync('tmux', [
      'ls', '-F', '#{session_name} #{session_created} #{session_attached}',
    ], { timeout: 5000 });

    const sessions: TmuxSession[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(' ');
      if (parts.length < 3) continue;
      sessions.push({
        name: parts[0],
        created: Number(parts[1]),
        attached: parts[2] === '1',
      });
    }
    lastTmuxSuccess = { sessions, at: Date.now() };
    return sessions;
  } catch (err) {
    // "no server running" is an answer, not a failure: tmux exits non-zero when
    // there is no server, and there is then definitively nothing to list.
    // Treating it as a failed scan kept dead tmux sessions on the dashboard for
    // a further minute — long enough to offer a terminal that cannot work.
    if (isNoServer(err)) {
      lastTmuxSuccess = { sessions: [], at: Date.now() };
      return [];
    }
    if (lastTmuxSuccess && Date.now() - lastTmuxSuccess.at < TMUX_STALE_TTL_MS) {
      return lastTmuxSuccess.sessions;
    }
    return [];
  }
}

/** Whether a failed `tmux ls` failed because tmux simply isn't running. */
function isNoServer(err: unknown): boolean {
  const text = String(
    (err as { stderr?: unknown })?.stderr ?? (err as Error)?.message ?? '',
  );
  return /no server running|error connecting to|no such file or directory/i.test(text);
}

export async function capturePane(
  sessionName: string,
  lines = 1000,
  cols?: number,
): Promise<string> {
  try {
    // Detached tmux sessions default to 80x24 — see dockerExecCapture for
    // the same rationale.
    if (cols && cols > 0) {
      try {
        await execFileAsync('tmux', [
          'resize-window', '-t', `${sessionName}:0`, '-x', String(cols), '-y', '50',
        ], { timeout: 3000 });
      } catch { /* best-effort */ }
    }
    const { stdout } = await execFileAsync('tmux', [
      // -J joins wrapped lines so URLs/text broken across pane width come back intact.
      // -e keeps the escape sequences, which is where the TUI's colour lives.
      // Without it every pane arrives monochrome and the panel has to guess at
      // meaning the terminal was stating outright.
      'capture-pane', '-t', `${sessionName}:0.0`, '-p', '-J', '-e', '-S', `-${lines}`,
    ], { timeout: 5000 });
    // Colour survives; cursor moves and title-setting do not. The browser is
    // handed a finished frame, not a terminal to drive.
    return sanitizePane(stdout);
  } catch (err) {
    throw new Error(`Failed to capture pane for ${sessionName}: ${err}`);
  }
}

// tmux paste buffers are global to the server, so namespace by session to keep
// two concurrent sends from clobbering each other's buffer before it's pasted.
function pasteBufferName(sessionName: string): string {
  return `cm-${sessionName.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

// Send `text` as a single bracketed paste instead of typing it keystroke by
// keystroke. Chunked `send-keys -l` broke on big/multiline input: each ~500-char
// chunk re-rendered the growing TUI prompt (slower and slower until a chunk hit
// the timeout), and every embedded newline was interpreted as Enter, submitting
// the prompt early. `load-buffer -` streams the whole payload over stdin (no
// ARG_MAX limit) and `paste-buffer -p` wraps it in bracketed-paste controls when
// the app (Claude Code) has requested them — so it lands as one paste block. The
// trailing Enter is a real keypress outside the paste, so it submits once.
export async function sendKeys(sessionName: string, text: string, appendEnter = true): Promise<void> {
  const target = `${sessionName}:0.0`;
  const buf = pasteBufferName(sessionName);
  try {
    await execFileWithInput('tmux', ['load-buffer', '-b', buf, '-'], text, 10000);
    await execFileAsync('tmux', [
      'paste-buffer', '-t', target, '-b', buf, '-d', '-p',
    ], { timeout: 5000 });
    if (appendEnter) {
      await execFileAsync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 5000 });
    }
  } catch (err) {
    throw new Error(`Failed to send keys to ${sessionName}: ${err}`);
  }
}

/**
 * Keys the interaction routes may forward verbatim.
 *
 * An allowlist rather than a filter: these names go into a `tmux send-keys`
 * argument, and tmux's key vocabulary is large enough that "anything that looks
 * safe" is not a judgement worth making per request.
 *
 * `BTab` is tmux's name for shift+tab, which is how Claude Code cycles
 * permission modes — the one binding whose absence you notice immediately,
 * because the TUI advertises it in its own status line.
 */
export const ALLOWED_RAW_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right',
  'Enter', 'Escape', 'Tab', 'BTab', 'BSpace', 'Space',
  'C-c', 'C-d',
]);

export async function sendKey(sessionName: string, key: string): Promise<void> {
  if (!ALLOWED_RAW_KEYS.has(key)) {
    throw new Error(`Disallowed key: ${key}`);
  }
  try {
    await execFileAsync('tmux', [
      'send-keys', '-t', `${sessionName}:0.0`, key,
    ], { timeout: 5000 });
  } catch (err) {
    throw new Error(`Failed to send key ${key} to ${sessionName}: ${err}`);
  }
}
