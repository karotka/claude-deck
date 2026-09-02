import type { Tracker } from './types.js';

let active: Tracker | null = null;

/**
 * One tracker at a time. Not a list: a tag means one thing per installation,
 * and two trackers answering for the same tag would need a precedence rule
 * nobody could predict. Swapping the implementation is the supported move.
 */
export function registerTracker(tracker: Tracker): void {
  active = tracker;
}

/** The configured tracker, or null when this installation has none. */
export function getTracker(): Tracker | null {
  return active?.isConfigured() ? active : null;
}

/** Test seam. */
export function resetTracker(): void {
  active = null;
}
