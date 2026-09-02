import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * A Claude Code session the monitor started itself. The session id is assigned
 * up front (`claude --session-id <uuid>`) rather than discovered afterwards, so
 * the tmux session can be tied to its transcript by exact id instead of the
 * heuristics used for Jira containers.
 */
export interface LaunchedSession {
  sessionId: string;
  tmuxSession: string;
  cwd: string;
  launchedAt: string;
}

const registryFilePath = path.join(config.claudeDir, '.claude-monitor-launched.json');

let launched = new Map<string, LaunchedSession>();

export async function loadLaunchedSessions(): Promise<void> {
  try {
    const data = await fsp.readFile(registryFilePath, 'utf-8');
    const parsed = JSON.parse(data);
    const entries: LaunchedSession[] = Array.isArray(parsed) ? parsed : [];
    launched = new Map(entries.map(e => [e.sessionId, e]));
  } catch {
    launched = new Map();
  }
}

async function save(): Promise<void> {
  await fsp.writeFile(registryFilePath, JSON.stringify([...launched.values()]), 'utf-8');
}

export function getLaunchedSessions(): LaunchedSession[] {
  return [...launched.values()];
}

export function getLaunchedSession(sessionId: string): LaunchedSession | undefined {
  return launched.get(sessionId);
}

export async function registerLaunchedSession(entry: LaunchedSession): Promise<void> {
  launched.set(entry.sessionId, entry);
  await save();
}

export async function forgetLaunchedSession(sessionId: string): Promise<void> {
  if (!launched.delete(sessionId)) return;
  await save();
}

/**
 * Drop entries whose tmux session is gone. Called from discovery with the names
 * seen in the current scan, so the registry doesn't accumulate dead launches.
 * Skipped when the tmux scan wasn't authoritative — a transient `tmux ls`
 * failure must not evict live sessions.
 */
export async function pruneLaunchedSessions(liveTmuxNames: Set<string>): Promise<void> {
  let changed = false;
  for (const [sessionId, entry] of launched) {
    if (!liveTmuxNames.has(entry.tmuxSession)) {
      launched.delete(sessionId);
      changed = true;
    }
  }
  if (changed) await save();
}
