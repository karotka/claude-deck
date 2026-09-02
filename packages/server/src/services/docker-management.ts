import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, projectsDir } from '../config.js';
import { listAllJiraContainers, removeDockerContainer } from './docker-scanner.js';
import { getCachedVmStatus, removeVmContainer, type VmContainer } from './vm-bridge.js';
import { getVmSessions } from './vm-discovery.js';
import { peekFirstUserMessage } from './jsonl-parser.js';
import { isHidden } from './hidden-sessions.js';

/** Which docker daemon a container lives on: this machine, or the agent VM. */
export type ContainerLocation = 'local' | 'vm';

export interface ManagedContainer {
  id: string;
  name: string;
  image: string;
  state: 'running' | 'exited' | 'paused';
  status: string;
  createdAt: string;       // raw docker string
  createdAtIso: string;    // ISO 8601, parseable
  ageDays: number;         // floor((now - createdAt) / day)
  issueKey: string | null; // e.g. PROJ-8010
  matchingSessionIds: string[];
  hiddenInApp: boolean;    // no matching session is visible (all hidden, or no JSONL at all)
  location: ContainerLocation;
}

export const DAY_MS = 86_400_000;

// "2026-04-27 12:18:22 +0200 CEST" → ISO 8601
function parseDockerDate(s: string): string {
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})/);
  if (!m) return new Date(s).toISOString();
  return new Date(`${m[1]}T${m[2]}${m[3]}`).toISOString();
}

function extractContainerIssueKey(name: string): string | null {
  if (!name.startsWith(config.dockerContainerPrefix)) return null;
  return name.slice(config.dockerContainerPrefix.length).toUpperCase();
}

function extractJsonlIssueKey(firstUserMessage: string | null | undefined): string | null {
  if (!firstUserMessage) return null;
  const m = firstUserMessage.toUpperCase().match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? m[1] : null;
}

/**
 * For every jira-agent container (running + exited), find all workspace JSONL
 * sessions whose firstUserMessage's issue key matches the container's key.
 * A container is hiddenInApp if none of those sessions are visible (i.e. all
 * are in the hidden list, or there are no matches at all).
 */
export async function listManagedContainers(): Promise<ManagedContainer[]> {
  const [containers, jsonlIndex] = await Promise.all([
    listAllJiraContainers(),
    indexWorkspaceJsonlsByIssueKey(),
  ]);

  const now = Date.now();
  const local: ManagedContainer[] = containers.map((c) => {
    const createdAtIso = parseDockerDate(c.createdAt);
    const ageDays = Math.floor((now - new Date(createdAtIso).getTime()) / DAY_MS);
    const issueKey = extractContainerIssueKey(c.name);
    const matchingSessionIds = issueKey ? jsonlIndex.get(issueKey) ?? [] : [];
    const hasVisible = matchingSessionIds.some((id) => !isHidden(id));
    return {
      id: c.id,
      name: c.name,
      image: c.image,
      state: c.state,
      status: c.status,
      createdAt: c.createdAt,
      createdAtIso,
      ageDays,
      issueKey,
      matchingSessionIds,
      hiddenInApp: !hasVisible,
      location: 'local',
    };
  });

  return [...local, ...listVmManagedContainers(now)];
}

/**
 * The VM containers from the discovery loop's last `list`, in the same shape as
 * the local ones. Deliberately reads the cache instead of probing: a fresh
 * `list` is a ~9s IAP round trip, and opening a tab must never be the thing
 * that reaches across to the VM.
 */
function listVmManagedContainers(now: number): ManagedContainer[] {
  const sessionIdsByKey = new Map<string, string[]>();
  for (const session of getVmSessions()) {
    const key = session.target?.ref;
    if (!key) continue;
    const ids = sessionIdsByKey.get(key) ?? [];
    ids.push(session.id);
    sessionIdsByKey.set(key, ids);
  }

  return getCachedVmStatus().containers.map((c) =>
    toManagedVmContainer(c, now, sessionIdsByKey.get(c.issueKey) ?? []),
  );
}

/** The units docker's humanized durations come in. */
const RUNNING_FOR_UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

const RUNNING_FOR_RE = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?$/i;

/**
 * `docker ps --format {{.RunningFor}}` → milliseconds since the container was
 * created. The VM's list prints this humanized string instead of a timestamp,
 * so it is the only age signal a remote row has. Null when unrecognised.
 */
export function parseRunningForMs(runningFor: string): number | null {
  const text = runningFor.trim().replace(/\s+ago$/i, '').trim();
  if (/^less than a second$/i.test(text)) return 0;
  if (/^about a minute$/i.test(text)) return RUNNING_FOR_UNIT_MS.minute;
  if (/^about an hour$/i.test(text)) return RUNNING_FOR_UNIT_MS.hour;

  const match = text.match(RUNNING_FOR_RE);
  if (!match) return null;
  return Number(match[1]) * RUNNING_FOR_UNIT_MS[match[2].toLowerCase()];
}

/** One VM container in the shape the Docker tab renders. */
export function toManagedVmContainer(
  container: VmContainer,
  now: number,
  matchingSessionIds: string[],
): ManagedContainer {
  // An unreadable duration becomes age 0 rather than something large, so an
  // age-based cleanup never sweeps a container whose age we couldn't establish.
  const ageMs = parseRunningForMs(container.runningFor) ?? 0;

  return {
    // The VM's list carries no container ID, and the same agent can exist under
    // an identical name on both daemons — namespaced so two rows never collide.
    id: `vm:${container.name}`,
    name: container.name,
    // Not in the VM's list format, and the tab doesn't render it.
    image: '',
    state: container.state,
    status: container.status,
    createdAt: container.runningFor,
    createdAtIso: new Date(now - ageMs).toISOString(),
    ageDays: Math.floor(ageMs / DAY_MS),
    issueKey: container.issueKey,
    matchingSessionIds,
    hiddenInApp: !matchingSessionIds.some((id) => !isHidden(id)),
    location: 'vm',
  };
}

/**
 * Remove one container wherever it runs. The VM path also destroys the session
 * volume — see removeVmContainer — so callers must have said so up front.
 */
export async function removeManagedContainer(
  name: string,
  location: ContainerLocation,
  force: boolean,
): Promise<void> {
  if (location !== 'vm') {
    return removeDockerContainer(name, force);
  }
  const issueKey = extractContainerIssueKey(name);
  if (!issueKey) {
    throw new Error(`Not a VM agent container: ${name}`);
  }
  return removeVmContainer(issueKey);
}

/** Scan workspace JSONLs once, build issueKey → [sessionId,...] map. */
async function indexWorkspaceJsonlsByIssueKey(): Promise<Map<string, string[]>> {
  const dir = path.join(projectsDir(), '-workspace');
  const index = new Map<string, string[]>();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return index;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const sessionId = entry.replace(/\.jsonl$/, '');
    const firstMsg = await peekFirstUserMessage(path.join(dir, entry));
    const key = extractJsonlIssueKey(firstMsg);
    if (!key) continue;
    const arr = index.get(key) ?? [];
    arr.push(sessionId);
    index.set(key, arr);
  }
  return index;
}

export interface CleanupPlan {
  containers: ManagedContainer[];
  criteria: {
    olderThanDays: number;
    onlyHidden: boolean;
    onlyStopped: boolean;
  };
}

export async function planCleanup(opts: {
  olderThanDays?: number;
  onlyHidden?: boolean;
  onlyStopped?: boolean;
}): Promise<CleanupPlan> {
  const olderThanDays = opts.olderThanDays ?? 7;
  const onlyHidden = opts.onlyHidden ?? true;
  const onlyStopped = opts.onlyStopped ?? true;

  const criteria = { olderThanDays, onlyHidden, onlyStopped };
  const containers = filterCleanupTargets(await listManagedContainers(), criteria);

  return { containers, criteria };
}

export function filterCleanupTargets(
  containers: ManagedContainer[],
  criteria: CleanupPlan['criteria'],
): ManagedContainer[] {
  return containers.filter((c) => {
    if (c.ageDays < criteria.olderThanDays) return false;
    if (criteria.onlyHidden && !c.hiddenInApp) return false;
    if (criteria.onlyStopped && c.state === 'running') return false;
    return true;
  });
}
