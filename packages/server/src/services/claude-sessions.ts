import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Claude Code's own registry of the sessions running on this machine.
 *
 * One JSON file per live session in `~/.claude/sessions`, named after the pid,
 * carrying the session id, the name the user gave it, the working directory and
 * whether it is busy or idle. It is the answer to three questions this app
 * previously guessed at, badly:
 *
 * - **Which sessions are alive.** `ps` cannot tell a session idle since July
 *   from one being used, and this machine accumulated eleven `claude` processes.
 * - **Which transcript a process belongs to.** A plain `claude` puts no session
 *   id on its command line, so matching by working directory was ambiguous
 *   wherever more than one session shared a repo — which was most of them. The
 *   registry states the mapping outright.
 * - **What a session is called.** `<session-dir>/custom-title.json` exists only
 *   for sessions renamed a particular way; the registry named all twelve.
 *
 * **This is an undocumented internal of Claude Code.** Treated as an enrichment
 * and never a requirement: if the directory is absent, or a future version
 * changes it, everything here returns empty and the dashboard falls back to
 * what it derived before. Nothing is ever hidden because a registry entry
 * failed to appear.
 */

export interface ClaudeSession {
  /**
   * The process this entry describes — the newest one, when a conversation has
   * more than one. See `pids`.
   */
  pid: number;
  /**
   * Every live process writing this transcript, newest first.
   *
   * Normally one. Reopening a session under tmux while it is still open in a
   * terminal gives it two, and both register: the dashboard used to merge them
   * into a single card and silently pick whichever entry had been touched last,
   * so a card could report one process's pid while its terminal drove the
   * other's. Keeping the list makes the split visible instead.
   */
  pids: number[];
  /** The transcript this process is writing. */
  sessionId: string;
  cwd: string | null;
  /** The name the user gave it, if any. */
  name: string | null;
  /** Claude Code's own view: 'busy', 'idle', or whatever it adds next. */
  status: string | null;
  /** 'interactive' for a session at a terminal on this machine. */
  kind: string | null;
}

/**
 * Every live session Claude Code knows about, keyed by session id.
 *
 * Entries whose process is gone are dropped: a registry file outlives an
 * unclean exit, so its presence alone is not evidence.
 */
export async function claudeSessions(): Promise<Map<string, ClaudeSession>> {
  const found = new Map<string, ClaudeSession>();

  const entries_by_session: Entry[] = [];

  let entries: string[];
  try {
    entries = await fsp.readdir(config.claudeSessionsDir);
  } catch {
    return found;
  }

  for (const entry of entries) {
    // `<pid>.json` only. The directory also holds `<pid>.<hash>.key` files,
    // which are credentials and none of this app's business.
    if (!/^\d+\.json$/.test(entry)) continue;

    const parsed = await readEntry(path.join(config.claudeSessionsDir, entry));
    if (!parsed || !isAlive(parsed.pid)) continue;

    entries_by_session.push(parsed);
  }

  // Group by transcript. Two live processes on one conversation is a real
  // situation — "Reopen here" on a session still open in a terminal produces
  // exactly that — so they are collected rather than deduplicated away.
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries_by_session) {
    const list = grouped.get(entry.sessionId) ?? [];
    list.push(entry);
    grouped.set(entry.sessionId, list);
  }

  for (const [sessionId, list] of grouped) {
    // Newest process first. The one someone just reopened is the one bound to
    // tmux, so it is the one whose status and pid the card should report — the
    // older process is the one sitting in a terminal somewhere.
    list.sort((a, b) => b.startedAt - a.startedAt || b.updatedAt - a.updatedAt);
    found.set(sessionId, { ...list[0], pids: list.map(e => e.pid) });
  }
  return found;
}

interface Entry extends ClaudeSession {
  updatedAt: number;
  /** When the process itself started, for ordering duplicates. */
  startedAt: number;
}

async function readEntry(file: string): Promise<Entry | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf-8')) as Record<string, unknown>;
    const pid = raw.pid;
    const sessionId = raw.sessionId;
    if (typeof pid !== 'number' || typeof sessionId !== 'string' || !sessionId) return null;
    return {
      pid,
      pids: [pid],
      sessionId,
      cwd: str(raw.cwd),
      name: str(raw.name),
      status: str(raw.status),
      kind: str(raw.kind),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      // `procStart` is a human date string ("Mon Aug 3 07:43:24 2026"); when it
      // won't parse, fall back to the session's own start timestamp.
      startedAt: parseDate(raw.procStart) ?? numberOr(raw.startedAt, 0),
    };
  } catch {
    // Missing, malformed, or half-written while we read it. A registry we
    // cannot parse is a registry we do without.
    return null;
  }
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH — gone. EPERM would mean it exists but isn't ours, which cannot
    // happen for a process that wrote into our own home directory.
    return false;
  }
}
