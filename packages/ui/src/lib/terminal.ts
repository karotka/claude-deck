import { stripAnsi } from './ansi';

/**
 * Splitting Claude Code's TUI into the parts this panel draws itself.
 *
 * The captured pane ends with a fixed shape: a boxed input line, then a status
 * footer.
 *
 *     ──────────────────────────────────── Browse ML ranker ─
 *     ❯
 *     ────────────────────────────────────────────────────────
 *       Model: Opus 5 | Ctx: 736.4k | Weekly: 0.0% | Reset: 4hr 30m
 *       ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent
 *
 * The panel has its own input, so leaving the TUI's would show two prompts, and
 * the status belongs *under* our input rather than stranded above it. This pulls
 * the shape apart so each piece can be drawn where it belongs — and the status
 * is read from the live pane, so it says whatever Claude Code currently says.
 */

/** Box-drawing characters tmux gives us for the TUI's rules and borders. */
const RULE_CHARS = /[─━┄┈╌═│┃╭╮╰╯┌┐└┘├┤]/g;

/**
 * A horizontal rule — the top or bottom edge of the input box. Mostly
 * box-drawing and long enough not to be a stray character in prose: a line of
 * dashes typed into a conversation is neither.
 */
function isRule(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 20) return false;
  const drawn = trimmed.match(RULE_CHARS)?.length ?? 0;
  return drawn / trimmed.length >= 0.6;
}

export interface PaneParts {
  /** Everything above the input box — the conversation itself. */
  body: string;
  /**
   * The status footer, one entry per line, already trimmed. Empty when the pane
   * doesn't have the expected shape, which happens while Claude is mid-render.
   */
  status: string[];
}

/**
 * Split a captured pane into its body and its status footer.
 *
 * Deliberately conservative: anything that isn't clearly the boxed-input shape
 * is returned whole, with no status. A wrong guess here would eat the end of
 * the conversation, which is the part the reader is looking at.
 */
export function splitPane(content: string): PaneParts {
  const whole = { body: content, status: [] as string[] };
  if (!content) return whole;

  // The pane now carries colour, so the structural checks below run against the
  // text with escapes removed while the slices returned keep them. Matching a
  // rule against a line full of SGR would never find one.
  const raw = content.split('\n');
  const lines = raw.map(stripAnsi);
  // A trailing newline from capture-pane is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); raw.pop(); }

  const lastRule = findLastIndex(lines, isRule);
  if (lastRule < 1) return whole;

  const openRule = findLastIndex(lines.slice(0, lastRule), isRule);
  if (openRule < 0) return whole;

  // Between the two rules is the input box. More than a few lines there means
  // this isn't the shape we think it is — a multi-line paste, or output that
  // happens to sit between two rules — so leave the pane alone.
  if (lastRule - openRule > 4) return whole;

  const status = raw
    .slice(lastRule + 1)
    .filter((_, i) => lines[lastRule + 1 + i].trim().length > 0)
    .map(line => line.trimEnd());

  return { body: raw.slice(0, openRule).join('\n'), status };
}

/** Array.prototype.findLastIndex, which the build's lib target doesn't have. */
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}
