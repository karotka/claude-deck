import path from 'node:path';
import { config } from '../config.js';
import { mapWithConcurrency } from './concurrency.js';
import { parseSessionMetadataFromLines } from './jsonl-parser.js';
import {
  collectSessionSuccessions,
  containerSessionMatchesKey,
  reconcileContainerSessions,
} from './container-sessions.js';
import { recordSessionSuccession } from './session-aliases.js';
import {
  isVmAvailable,
  refreshVmStatus,
  getCachedVmStatus,
  readVmSessionSample,
  readVmSubagents,
  stopVmStream,
  type VmContainer,
} from './vm-bridge.js';
import {
  startStreamReaper,
  stopStreamReaper,
  stopAllStreams,
} from './vm-stream.js';
import { stopAllChannels } from './vm-channel.js';
import type { Session, SubagentInfo } from '../types.js';
import { target } from '../providers/registry.js';

/**
 * Discovery for agent containers running on the remote VM.
 *
 * Deliberately a separate loop from the local one: every read here is a gcloud
 * IAP round trip costing seconds, so it runs on its own slow interval and the
 * local 5s tick simply merges whatever this last produced. That keeps a stalled
 * tunnel from ever delaying the local dashboard.
 */

/** Reads run over one SSH tunnel; a burst of them just queues behind itself. */
const VM_READ_CONCURRENCY = 2;

let vmSessions: Session[] = [];
const lastVmSessions = new Map<string, Session>();

/** The VM sessions from the most recent completed scan. Never blocks. */
export function getVmSessions(): Session[] {
  return vmSessions;
}

/** Sum of a session's own cost plus every subagent it spawned. */
function totalCostWithSubagents(ownCost: number, subagents: SubagentInfo[]): number {
  return subagents.reduce((sum, sa) => sum + sa.estimatedCost, ownCost);
}

/**
 * Build a Session for one running VM container by reading its primary session
 * JSONL from inside the container. Best-effort — null when the container has no
 * readable session yet, or when the read didn't belong to this container.
 */
async function discoverVmSession(container: VmContainer): Promise<Session | null> {
  const sample = await readVmSessionSample(container.issueKey);
  if (!sample) return null;

  const base = path.basename(sample.jsonlPath, '.jsonl');
  const idFallback = /^[0-9a-f]{8}-/.test(base) ? base : null;
  const meta = parseSessionMetadataFromLines(sample.lines, idFallback);
  if (!meta) return null;

  // Same guard as the local path: a container that shares ~/.claude would hand
  // back an unrelated session, which would then show a wrong card.
  if (!containerSessionMatchesKey(meta.firstUserMessage, container.issueKey)) return null;

  const subagents = await readVmSubagents(container.issueKey, sample.jsonlPath);

  return {
    id: meta.sessionId,
    projectHash: '-workspace',
    projectPath: meta.cwd || '/workspace',
    // Lives inside a container on another machine — left empty so nothing tries
    // to read it as a host path.
    jsonlPath: '',
    remoteJsonlPath: sample.jsonlPath,
    status: 'running',
    pid: null,
    cwd: meta.cwd || '/workspace',
    gitBranch: meta.gitBranch,
    entrypoint: (meta.entrypoint as Session['entrypoint']) || 'cli',
    claudeVersion: meta.claudeVersion,
    model: meta.model,
    permissionMode: meta.permissionMode,
    sessionName: null,
    remoteUrl: meta.remoteUrl,
    startedAt: meta.startedAt,
    lastActivityAt: meta.lastActivityAt,
    totalInputTokens: meta.totalInputTokens,
    totalOutputTokens: meta.totalOutputTokens,
    totalCacheReadTokens: meta.totalCacheReadTokens,
    totalCacheWriteTokens: meta.totalCacheWriteTokens,
    messageCount: meta.messageCount,
    toolCallCount: meta.toolCallCount,
    estimatedCost: totalCostWithSubagents(meta.estimatedCost, subagents),
    firstUserMessage: meta.firstUserMessage,
    lastUserMessage: meta.lastUserMessage,
    subagents,
    source: 'remote',
    remote: true,
    tag: container.issueKey,
    // The handle every remote-script command takes is the issue key, so that is
    // the ref; the container name is only ever shown, never sent.
    target: target('remote', container.issueKey, container.name),
  };
}

/** One VM scan tick. Safe to call concurrently — overlapping calls no-op. */
export async function refreshVmSessions(): Promise<Session[]> {
  if (!(await isVmAvailable())) {
    vmSessions = [];
    lastVmSessions.clear();
    return vmSessions;
  }

  const status = await refreshVmStatus(true);

  if (status.state !== 'RUNNING') {
    // A failed status read is not evidence the VM stopped — hold the last known
    // cards rather than blinking them off mid-interaction.
    if (status.error) return vmSessions;
    vmSessions = [];
    lastVmSessions.clear();
    stopAllStreams();
    stopAllChannels();
    return vmSessions;
  }

  const running = status.containers.filter(c => c.state === 'running');

  // A stream outliving its container would keep re-spawning against nothing.
  const runningKeys = new Set(running.map(c => c.issueKey));
  for (const session of vmSessions) {
    const ref = session.target?.ref;
    if (ref && !runningKeys.has(ref)) {
      stopVmStream(ref);
    }
  }
  const freshReads = await mapWithConcurrency(running, VM_READ_CONCURRENCY, async c => ({
    containerName: c.name,
    session: await discoverVmSession(c),
  }));

  // A VM restart gives the container a new transcript, hence a new session id.
  // Recorded before the cache is overwritten — it holds the only copy of the
  // previous id — so anything still addressing the old one can follow it.
  for (const { from, to } of collectSessionSuccessions(lastVmSessions, freshReads)) {
    recordSessionSuccession(from, to);
  }

  vmSessions = reconcileContainerSessions(
    freshReads,
    new Set(running.map(c => c.name)),
    // The list came back this tick, so absence really does mean "gone".
    true,
    lastVmSessions,
    new Set(),
  );
  return vmSessions;
}

let vmInterval: ReturnType<typeof setInterval> | null = null;

export async function startVmDiscoveryLoop(): Promise<void> {
  if (!(await isVmAvailable())) return;

  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await refreshVmSessions();
    } catch (err) {
      console.error('VM discovery scan error:', err);
    } finally {
      inFlight = false;
    }
  };

  // Don't await the first tick: it can take tens of seconds against a cold
  // tunnel, and server startup must not wait on the VM being reachable.
  void tick();
  vmInterval = setInterval(tick, config.vmScanIntervalMs);
  startStreamReaper();
}

export function stopVmDiscoveryLoop(): void {
  if (vmInterval) {
    clearInterval(vmInterval);
    vmInterval = null;
  }
  stopStreamReaper();
  stopAllStreams();
  stopAllChannels();
}

/** VM reachability for the UI, without triggering a fresh probe. */
export function getVmStatusSnapshot(): {
  enabled: boolean;
  name: string;
  state: string;
  containers: number;
  checkedAt: string | null;
  error: string | null;
} {
  const status = getCachedVmStatus();
  return {
    enabled: config.vmEnabled,
    // Empty when AGENT_VM_NAME is unset — the script's own default instance.
    name: config.vmName || '(script default)',
    state: status.state,
    containers: status.containers.length,
    checkedAt: status.checkedAt,
    error: status.error,
  };
}
