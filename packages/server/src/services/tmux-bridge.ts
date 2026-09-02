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

/**
 * Height the browser's pane is given when the caller doesn't measure one.
 * The browser does measure, so this is the fallback for internal callers.
 */
const DEFAULT_PANE_ROWS = 50;

/**
 * Whether to resize the window before capturing it.
 *
 * Two reasons not to, and both were being ignored on every poll:
 *
 * - **Somebody is attached in a terminal.** tmux sizes a window to its
 *   attached client; resizing it back to the browser's viewport twice a second
 *   started a tug of war, and a TUI redraws itself completely on every resize.
 *   `tmux attach` became unusably slow, which is a strange thing for a
 *   dashboard to do to the terminal it is watching. An attached client wins:
 *   the browser renders whatever width the pane has.
 * - **The size already matches.** A resize to the current size is a no-op to
 *   tmux but not free, and asking costs the same one call as resizing did.
 *
 * A failed query resizes, which is the old behaviour and safe: the worst case
 * is the pane being the size the browser asked for.
 */
async function shouldResize(
  sessionName: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('tmux', [
      'display-message', '-p', '-t', `${sessionName}:0`,
      '#{session_attached} #{window_width} #{window_height}',
    ], { timeout: 3000 });
    const [attached, width, height] = stdout.trim().split(/\s+/).map(Number);
    if (attached > 0) return false;
    return width !== cols || height !== rows;
  } catch {
    return true;
  }
}

export async function capturePane(
  sessionName: string,
  lines = 1000,
  cols?: number,
  rows = DEFAULT_PANE_ROWS,
): Promise<string> {
  try {
    // Detached tmux sessions default to 80x24, which makes the TUI wrap badly,
    // so the window is sized to the browser's viewport. Conditionally, though —
    // see shouldResize: doing it unconditionally on every poll made the session
    // unusable for anyone attached in a terminal.
    if (cols && cols > 0 && await shouldResize(sessionName, cols, rows)) {
      try {
        await execFileAsync('tmux', [
          'resize-window', '-t', `${sessionName}:0`, '-x', String(cols), '-y', String(rows),
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

/**
 * The wheel, which is not a key.
 *
 * tmux has no `send-keys` name for a wheel turn, because a wheel turn is not a
 * key — it is bytes the application asked to be sent. Claude Code's TUI turns
 * on SGR mouse reporting (verified on a live pane: `mouse_any_flag` and
 * `mouse_sgr_flag` both set), so a tick is `ESC [ < 64 ; col ; row M`, 65 for
 * down. `send-keys -l` writes those bytes into the pane, which is exactly what
 * a terminal does when the wheel turns over it.
 *
 * This is the only way to scroll a Claude Code pane at all: the TUI runs on the
 * alternate screen, so tmux holds no scrollback and there is no history behind
 * the frame to pan over. Scrolling has to be the application's, not the
 * terminal's.
 *
 * Three ticks per turn is the usual terminal notch, and the coordinates are the
 * pane's top-left: the TUI scrolls its transcript wherever the pointer is, so
 * the corner saves a round trip asking how big the pane is.
 */
const WHEEL_SEQUENCES: Record<string, string> = {
  WheelUp: '\x1b[<64;1;1M',
  WheelDown: '\x1b[<65;1;1M',
};
const TICKS_PER_TURN = 3;

/** The bytes for a wheel turn, or null if `key` is not one. */
export function wheelBytes(key: string): string | null {
  const seq = WHEEL_SEQUENCES[key];
  return seq ? seq.repeat(TICKS_PER_TURN) : null;
}

export async function sendKey(sessionName: string, key: string): Promise<void> {
  const wheel = wheelBytes(key);
  if (!wheel && !ALLOWED_RAW_KEYS.has(key)) {
    throw new Error(`Disallowed key: ${key}`);
  }
  try {
    await execFileAsync('tmux', [
      // -l for the wheel: its bytes are a literal sequence, not a key name.
      'send-keys', '-t', `${sessionName}:0.0`, ...(wheel ? ['-l', wheel] : [key]),
    ], { timeout: 5000 });
  } catch (err) {
    throw new Error(`Failed to send key ${key} to ${sessionName}: ${err}`);
  }
}
