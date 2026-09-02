/**
 * Retired session id → the session that replaced it.
 *
 * A container session is addressed by its transcript's session id, but that id
 * is not stable across a restart: when the VM (or a container) comes back,
 * Claude writes a *new* transcript, so the same container reports a different
 * id on the next scan. Everything holding the old id — the open tab, a
 * bookmark, the terminal's capture/send polls — then 404s with "Session not
 * found" while the container is in fact alive and running the same work.
 *
 * Recording the succession lets those id-addressed routes follow the container
 * across the restart instead of dead-ending.
 */

/**
 * Bounded so a long-lived server can't accumulate an unbounded map from
 * containers that restart on a loop. Well above the number of agent containers
 * anyone runs, so a real tab is never evicted in practice.
 */
export const MAX_SESSION_ALIASES = 500;

/** Insertion-ordered, which is what makes the oldest-first eviction below work. */
const aliases = new Map<string, string>();

/**
 * Record that `from` was replaced by `to`.
 *
 * Existing aliases pointing at `from` are re-pointed at `to`, so resolution
 * stays a single lookup no matter how many times a container has restarted.
 */
export function recordSessionSuccession(from: string, to: string): void {
  if (!from || !to || from === to) return;

  for (const [old, current] of aliases) {
    if (current === from) aliases.set(old, to);
  }

  // Delete first so re-recording moves the entry to the end of the insertion
  // order — otherwise a repeatedly-restarting container keeps its original
  // position and gets evicted while it is still the active one.
  aliases.delete(from);
  aliases.set(from, to);

  // `to` is now a live id; it can't also be a retired one.
  aliases.delete(to);

  while (aliases.size > MAX_SESSION_ALIASES) {
    const oldest = aliases.keys().next();
    if (oldest.done) break;
    aliases.delete(oldest.value);
  }
}

/**
 * The current id for a possibly-retired one. Returns `id` unchanged when it was
 * never superseded, so callers can resolve unconditionally.
 */
export function resolveSessionId(id: string): string {
  let current = id;
  // Bounded walk: re-pointing above keeps chains at length 1, but a cycle
  // (an id reappearing) must not spin here.
  for (let hops = 0; hops < 8; hops++) {
    const next = aliases.get(current);
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

export function sessionAliasCount(): number {
  return aliases.size;
}

export function clearSessionAliases(): void {
  aliases.clear();
}

/**
 * Successions implied by a process that has changed transcript.
 *
 * `/clear` keeps the process and starts a new conversation under a new session
 * id, which from here looks like a pid whose transcript has moved. Recording it
 * is what keeps an id addressed by an open tab reaching the live conversation
 * instead of a session that has stopped.
 *
 * `lastSeen` is updated in place: pids that have gone are dropped, so a
 * recycled pid cannot inherit its predecessor's transcript.
 */
export function successionsFromProcesses(
  entries: Iterable<{ sessionId: string; pids: number[] }>,
  lastSeen: Map<number, string>,
): Array<{ from: string; to: string }> {
  const found: Array<{ from: string; to: string }> = [];
  const alive = new Set<number>();

  for (const entry of entries) {
    for (const pid of entry.pids) {
      alive.add(pid);
      const previous = lastSeen.get(pid);
      if (previous && previous !== entry.sessionId) {
        found.push({ from: previous, to: entry.sessionId });
      }
      lastSeen.set(pid, entry.sessionId);
    }
  }

  for (const pid of [...lastSeen.keys()]) {
    if (!alive.has(pid)) lastSeen.delete(pid);
  }
  return found;
}
