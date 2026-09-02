import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// This app's own install directory. The scan looks for any command line
// containing "claude", and the directory this fork is installed in very
// probably contains it too — so the server's own node process, and the Vite
// dev server beside it, would otherwise be listed as Claude sessions. Matching
// the install path is what distinguishes them, rather than a hardcoded product
// name that stops being true the moment someone renames the checkout.
// src/services/ in dev, dist/services/ after a build — three levels up either way.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface ClaudeProcess {
  pid: number;
  sessionId: string | null;
  args: string;
}

/** Claude Code names sessions with a UUID; anything else is not one. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function matchSessionId(args: string, pattern: RegExp): string | null {
  const value = args.match(pattern)?.[1];
  return value && SESSION_ID_RE.test(value) ? value : null;
}

export async function scanClaudeProcesses(): Promise<ClaudeProcess[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,command'], {
      timeout: 5000,
    });

    const processes: ClaudeProcess[] = [];

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      // Match lines that contain a claude process but not grep itself
      if (!trimmed.includes('claude') || trimmed.includes('grep')) continue;
      // Skip this app: its own process, and anything else running out of the
      // same checkout (the dev server, a build, a sibling worker).
      if (trimmed.includes(appRoot)) continue;

      const match = trimmed.match(/^(\d+)\s+(.+)/);
      if (!match) continue;

      const pid = Number(match[1]);
      const args = match[2];

      // Only match actual claude CLI processes
      if (!args.match(/\bclaude\b/)) continue;

      // Only a real session id counts. `--resume` also takes a session *name*
      // ("claude --resume IQ plugin") or nothing at all when it opens the
      // picker, and taking the next word regardless produced ids like "IQ" that
      // match no transcript and quietly occupy a slot in the pid map.
      const sessionId =
        matchSessionId(args, /--session-id\s+(\S+)/) ?? matchSessionId(args, /--resume\s+(\S+)/);

      processes.push({ pid, sessionId, args });
    }

    return processes;
  } catch {
    return [];
  }
}

export async function getRunningPids(): Promise<Set<number>> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', 'claude'], {
      timeout: 3000,
    });
    const pids = new Set<number>();
    for (const line of stdout.trim().split('\n')) {
      const pid = Number(line.trim());
      if (pid > 0) pids.add(pid);
    }
    return pids;
  } catch {
    return new Set();
  }
}
