/**
 * Terminal control sequences in captured pane output.
 *
 * Two functions, because the panes are wanted two ways. `sanitizePane` keeps
 * the colour and drops everything else — that is what the browser renders, and
 * Claude's TUI says a great deal with colour that is simply lost without it.
 * `stripAnsi` removes the lot, for the places that match on text.
 */

/**
 * Keep SGR (colour and weight) and remove every other escape.
 *
 * Cursor moves, scroll regions and OSC titles are instructions to a terminal
 * that is redrawing itself; the browser is handed a finished frame, so they are
 * noise at best and corruption at worst. Colour is the one thing in the stream
 * that carries meaning to a reader.
 */
export function sanitizePane(raw: string): string {
  return raw
    // Every CSI sequence, kept only when it is SGR (`…m`) — colour and weight.
    .replace(/\x1b\[[0-9;:?]*([a-zA-Z])/g, (match, final: string) =>
      final === 'm' ? match : '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')   // OSC (titles)
    .replace(/\x1b[>=<][^\n]*/g, '')                      // private mode sets
    .replace(/\x1b\([A-Z]/g, '')                           // charset switches
    // Control characters, but not ESC (\x1b) — the SGR kept above needs it.
    .replace(/[\x00-\x08\x0e-\x1a\x1c-\x1f]/g, '');
}

/**
 * Strip terminal control sequences from captured pane output.
 *
 * For the paths that match on the text rather than show it.
 */
export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')  // OSC sequences
    .replace(/\x1b[>=<][^\n]*/g, '')            // private mode sets
    .replace(/\[>[0-9]*m/g, '')                 // stray DEC sequences
    .replace(/\[<[a-z]/g, '')                   // stray DEC sequences
    .replace(/\x1b\([A-Z]/g, '')                // charset switches
    .replace(/[\x00-\x08\x0e-\x1f]/g, '');     // remaining control chars
}
