/**
 * What you have sent from this browser, per session, so the up arrow brings it
 * back the way a shell does.
 *
 * Deliberately the browser's own record rather than the session's. Claude Code
 * keeps a history of its own and the up arrow walks it — but it walks it *in
 * the TUI*, filling an input the browser cannot see or send from, so from here
 * that did nothing you could use. This is the list of things typed into this
 * box, which is the list this box can put back into itself.
 *
 * Kept in localStorage: a reload should not lose it, and it never leaves the
 * machine it was typed on.
 */

const KEY = 'claude-deck-prompt-history';

/** Entries kept per session, and sessions kept at all. */
export const MAX_ENTRIES = 50;
export const MAX_SESSIONS = 30;

type Store = Record<string, string[]>;

function read(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' ? (raw as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Quota, or storage disabled. History is a convenience; losing it is not
    // worth failing a send over.
  }
}

/** Most recent first. */
export function loadHistory(sessionId: string): string[] {
  const list = read()[sessionId];
  return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
}

/**
 * Record a sent prompt and return the new history.
 *
 * Blank entries are not kept, and neither is an immediate repeat — sending the
 * same thing twice is one thing you might want back, not two.
 */
export function rememberPrompt(sessionId: string, text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return loadHistory(sessionId);

  const store = read();
  const previous = Array.isArray(store[sessionId]) ? store[sessionId] : [];
  const next = previous[0] === trimmed
    ? previous
    : [trimmed, ...previous].slice(0, MAX_ENTRIES);

  store[sessionId] = next;

  // Bound the whole store, not just each list: a machine accumulates sessions
  // forever and none of them ever tidy up after themselves.
  const ids = Object.keys(store);
  if (ids.length > MAX_SESSIONS) {
    for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) {
      if (id !== sessionId) delete store[id];
    }
  }

  write(store);
  return next;
}

/**
 * Where the up or down arrow lands.
 *
 * `-1` is "not in the history": the box holds whatever you were typing.
 * Stepping back from the oldest entry stays there rather than wrapping — a
 * shell does not loop, and silently jumping to the newest would look like the
 * arrow had done nothing at all. Stepping forward past the newest returns to
 * -1, which is what puts your unsent draft back.
 */
export function stepHistory(
  length: number,
  index: number,
  direction: 'older' | 'newer',
): number {
  if (length === 0) return -1;
  if (direction === 'older') return Math.min(index + 1, length - 1);
  return Math.max(index - 1, -1);
}
