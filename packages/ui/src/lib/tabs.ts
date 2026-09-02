import type { Session } from './api';

/**
 * How many stopped sessions the tab bar keeps. Stopped sessions accumulate
 * indefinitely; the bar shows a handful so a just-finished run stays clickable.
 */
export const STOPPED_TAB_LIMIT = 5;

/**
 * Whether the session can be typed into, wherever it lives. A target is exactly
 * what the server sets when some registered transport can drive it, so this
 * stays true for a backend the UI has never heard of.
 */
export function isInteractive(s: Session): boolean {
  return !!s.target;
}

/**
 * Tabs the user has closed, per browser.
 *
 * Closing a tab and hiding a session are different intentions that the × used
 * to conflate: it called the hide API, which drops the session from the
 * dashboard for every viewer and persists in ~/.claude. People clicking × mean
 * "stop showing me this one here", the way they would in a browser — a local,
 * reversible, per-device thing. Hiding stays available as the Hide button on
 * the card, where the word is on screen.
 */
const CLOSED_KEY = 'claude-monitor-tabs-closed';

export function loadClosedTabs(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    // Unreadable storage (private window, cleared data) simply means no tabs
    // have been closed. Never a reason to fail.
    return new Set();
  }
}

export function saveClosedTabs(ids: Set<string>): void {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...ids]));
  } catch { /* storage unavailable; the set still applies for this page */ }
}

export interface TabVisibility {
  /** The session currently open, pinned so closing a tab can't strand you. */
  activeId: string;
  interactiveOnly: boolean;
  /** Tabs closed in this browser; see loadClosedTabs. */
  closed?: Set<string>;
}

/**
 * Which sessions the tab bar shows, before the user's saved order is applied.
 * "Interactive only" is a hard filter: a session you cannot type into is not
 * listed even while you are viewing it — the header below the bar still names
 * the open session, so nothing is lost by leaving it out.
 */
export function visibleTabs(
  sessions: Session[],
  { activeId, interactiveOnly, closed }: TabVisibility,
): Session[] {
  // The session being viewed is always listed, whatever else says otherwise:
  // closing the tab you are on must not leave the bar disagreeing with the page.
  const notHidden = sessions.filter(
    s => s.id === activeId || (!s.hidden && !closed?.has(s.id)),
  );
  const pool = interactiveOnly ? notHidden.filter(isInteractive) : notHidden;
  const running = pool.filter(s => s.status !== 'stopped');
  const stopped = pool.filter(s => s.status === 'stopped').slice(0, STOPPED_TAB_LIMIT);
  return [...running, ...stopped];
}
