import type { Session } from './api';

/**
 * The three things Stop can mean, in one place.
 *
 * The dashboard and the detail page both offer it, and the wording is the
 * safeguard: it is the only warning before something ends. Two copies of it
 * would drift, and the copy that drifted would be the one telling somebody
 * their conversation was safe when it was not.
 *
 * Which of the three applies is the server's answer, carried on the session as
 * `stopMethod` — the tmux case turns on a configurable prefix, so a browser
 * deciding for itself would misdescribe it for anyone who changed that.
 */
export function stopPlanText(session: Session): string {
  switch (session.stopMethod) {
    case 'claude stop':
      return `Stop this background session?\n\nRuns \`claude stop ${session.id.slice(0, 8)}\`. `
        + 'The conversation is kept and you can resume it later.';
    case 'tmux kill-session':
      return `Stop this session?\n\nCloses the tmux session ${session.target?.ref}, which this `
        + 'dashboard started. The transcript is kept, so Reopen here brings it back.';
    case 'SIGTERM':
      return 'Stop this session?\n\nSends SIGTERM to the process — the same signal closing '
        + 'its terminal sends. The transcript is kept; an answer in flight is lost.';
    default:
      return 'Stop this session?\n\nThere is no process here to stop, so this may do nothing.';
  }
}

/** Whether this session can be driven from the browser at all. */
export function canDrive(session: Session): boolean {
  return !!session.target;
}

export async function interrupt(sessionId: string): Promise<void> {
  await fetch(`/api/sessions/${sessionId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'Escape' }),
  });
}

/** Returns the server's complaint, or null when it worked. */
export async function stop(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    if (res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return body.error || 'Failed to stop the session.';
  } catch {
    return 'Could not reach the server.';
  }
}
