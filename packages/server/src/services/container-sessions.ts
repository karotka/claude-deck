import type { Session } from '../types.js';
import { tagFromName, messageClaimsTag } from './tagging.js';

/**
 * Pure helpers for turning "a set of agent containers" into "a set of session
 * cards", shared by the local Docker scan and the remote VM scan. Kept apart
 * from session-discovery so the VM loop can use them without importing the
 * discovery loop itself.
 */

/**
 * Re-exported under the names this module has always used, so the container
 * scans read naturally, while the definition of "what a tag is" lives in one
 * place. See services/tagging.ts.
 */
export { tagFromName as issueKeyForContainer, messageClaimsTag as containerSessionMatchesKey };

/**
 * Reconcile freshly-read container sessions against a sticky cache so a
 * transient read failure doesn't drop a live session's card.
 *
 * - A successful read refreshes the cache for that container.
 * - A failed read (null) for a still-running container falls back to the cached
 *   session, so the card stays put until the container actually stops.
 * - Cache entries whose container is no longer running are evicted — but only
 *   when the scan was authoritative, so a stale/failed listing can't drop live
 *   sessions during a hiccup.
 * - During a non-authoritative outage (a listing failure old enough that its
 *   stale cache expired, so the scan reports zero running containers) we can't
 *   prove any container stopped. The cached sessions are then the only record of
 *   those cards, so they're re-emitted this tick — not merely retained — instead
 *   of vanishing and popping back once the listing recovers.
 *
 * `cache` is keyed by container name and mutated in place. Returns the sessions
 * to surface this tick, filtered against `existingIds` (host sessions).
 */
export function reconcileContainerSessions(
  freshReads: Array<{ containerName: string; session: Session | null }>,
  runningContainerNames: Set<string>,
  authoritative: boolean,
  cache: Map<string, Session>,
  existingIds: Set<string>,
): Session[] {
  const result: Session[] = [];
  const handled = new Set<string>();

  for (const { containerName, session } of freshReads) {
    handled.add(containerName);
    if (session) {
      cache.set(containerName, session);
      if (!existingIds.has(session.id)) result.push(session);
    } else {
      const cached = cache.get(containerName);
      if (cached && !existingIds.has(cached.id)) result.push(cached);
    }
  }

  if (authoritative) {
    for (const name of [...cache.keys()]) {
      if (!runningContainerNames.has(name)) cache.delete(name);
    }
  } else {
    // The listing is in a blind spot: keep every cached card visible. No
    // host-side container matching ran this tick (the scan saw zero
    // containers), so these reads are the only representation of the cards and
    // can't be duplicates of a freshly-matched host session.
    for (const [name, cached] of cache) {
      if (handled.has(name) || existingIds.has(cached.id)) continue;
      result.push(cached);
    }
  }

  return result;
}

/**
 * Which containers came back with a different session than the one cached for
 * them — i.e. restarted and started a fresh transcript.
 *
 * Pure, and deliberately called *before* `reconcileContainerSessions` overwrites
 * the cache, since the cache is the only record of the previous id. A null read
 * is a failed exec, not a restart, so it yields nothing.
 */
export function collectSessionSuccessions(
  cache: Map<string, Session>,
  freshReads: Array<{ containerName: string; session: Session | null }>,
): Array<{ from: string; to: string }> {
  const successions: Array<{ from: string; to: string }> = [];
  for (const { containerName, session } of freshReads) {
    if (!session) continue;
    const previous = cache.get(containerName);
    if (previous && previous.id !== session.id) {
      successions.push({ from: previous.id, to: session.id });
    }
  }
  return successions;
}
