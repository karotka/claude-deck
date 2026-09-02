/**
 * Turning a captured pane's colour into something the browser can render.
 *
 * `capture-pane -e` hands back the TUI's SGR sequences, which is where most of
 * what Claude Code tells you lives: the model and usage in the status bar, the
 * branch, the diff counts, whether a mode is on. The panel used to receive none
 * of it — the pane arrived monochrome, and the meaning had to be guessed back
 * out of glyphs at the start of each line.
 *
 * Only SGR is handled, because only SGR survives the server's sanitiser: a
 * finished frame needs colour, not cursor movement.
 */

export interface AnsiSpan {
  text: string;
  /** Undefined where the run carries default styling. */
  style?: AnsiStyle;
}

export interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: 'bold';
  fontStyle?: 'italic';
  textDecoration?: 'underline';
  opacity?: number;
}

export interface AnsiLine {
  /** The line with every escape removed — for measuring and matching. */
  plain: string;
  spans: AnsiSpan[];
}

/**
 * The 16 named colours, tuned for a dark panel rather than taken from a
 * terminal's defaults: pure blue on near-black is unreadable, and the bright
 * variants of a standard palette are what a TUI actually uses for emphasis.
 */
const BASE_COLORS = [
  '#3b4048', '#e06c75', '#98c379', '#e5c07b',
  '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
  '#5c6370', '#ef7078', '#a9d67f', '#f0ce85',
  '#78c2f3', '#d68fe2', '#68c8cf', '#e6e6e6',
];

/** xterm's 256-colour cube and greyscale ramp, computed rather than tabulated. */
function xterm256(n: number): string {
  if (n < 16) return BASE_COLORS[n];
  if (n < 232) {
    const i = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return rgb(level(Math.floor(i / 36) % 6), level(Math.floor(i / 6) % 6), level(i % 6));
  }
  const grey = 8 + (n - 232) * 10;
  return rgb(grey, grey, grey);
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

const SGR = /\x1b\[([0-9;:]*)m/g;

/** Apply one SGR parameter run to a style, in place. */
function applyCodes(codes: number[], style: AnsiStyle): void {
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    switch (code) {
      case 0: for (const k of Object.keys(style)) delete style[k as keyof AnsiStyle]; break;
      case 1: style.fontWeight = 'bold'; break;
      // Dim is opacity rather than a darker colour: it has to work over
      // whatever foreground is already set.
      case 2: style.opacity = 0.6; break;
      case 3: style.fontStyle = 'italic'; break;
      case 4: style.textDecoration = 'underline'; break;
      case 22: delete style.fontWeight; delete style.opacity; break;
      case 23: delete style.fontStyle; break;
      case 24: delete style.textDecoration; break;
      case 39: delete style.color; break;
      case 49: delete style.backgroundColor; break;
      case 38:
      case 48: {
        // Extended colour: `38;5;N` (256) or `38;2;R;G;B` (truecolor). The
        // parameters are consumed here, so the loop skips past them.
        const target = code === 38 ? 'color' : 'backgroundColor';
        if (codes[i + 1] === 5 && codes.length > i + 2) {
          style[target] = xterm256(codes[i + 2]);
          i += 2;
        } else if (codes[i + 1] === 2 && codes.length > i + 4) {
          style[target] = rgb(codes[i + 2], codes[i + 3], codes[i + 4]);
          i += 4;
        }
        break;
      }
      default:
        if (code >= 30 && code <= 37) style.color = BASE_COLORS[code - 30];
        else if (code >= 90 && code <= 97) style.color = BASE_COLORS[code - 90 + 8];
        else if (code >= 40 && code <= 47) style.backgroundColor = BASE_COLORS[code - 40];
        else if (code >= 100 && code <= 107) style.backgroundColor = BASE_COLORS[code - 100 + 8];
    }
  }
}

/**
 * Split a pane into lines of styled runs.
 *
 * Style carries across lines, because a TUI sets a colour and then draws
 * several rows in it — resetting per line would drop the colour off every
 * wrapped answer after its first row.
 */
export function parseAnsi(content: string): AnsiLine[] {
  const style: AnsiStyle = {};

  return content.split('\n').map(rawLine => {
    const spans: AnsiSpan[] = [];
    let plain = '';
    let last = 0;

    SGR.lastIndex = 0;
    for (let m = SGR.exec(rawLine); m !== null; m = SGR.exec(rawLine)) {
      const text = rawLine.slice(last, m.index);
      if (text) {
        spans.push({ text, style: snapshot(style) });
        plain += text;
      }
      // An empty parameter list means 0 — `ESC[m` is a reset.
      applyCodes(m[1] === '' ? [0] : m[1].split(/[;:]/).map(n => Number(n) || 0), style);
      last = m.index + m[0].length;
    }

    const tail = rawLine.slice(last);
    if (tail) {
      spans.push({ text: tail, style: snapshot(style) });
      plain += tail;
    }
    return { plain, spans };
  });
}

/** A copy, or undefined when nothing is set — so the common case renders bare. */
function snapshot(style: AnsiStyle): AnsiStyle | undefined {
  const keys = Object.keys(style);
  return keys.length === 0 ? undefined : { ...style };
}

/** Every escape removed. For matching and measuring. */
export function stripAnsi(content: string): string {
  return content.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, '');
}
