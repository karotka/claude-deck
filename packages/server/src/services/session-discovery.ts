import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, projectsDir } from '../config.js';
import { scanClaudeProcesses, getRunningPids } from './process-scanner.js';
import {
  scanDockerContainers,
  wasDockerScanRecent,
  readContainerSessionSample,
  readContainerSubagents,
  type DockerContainer,
} from './docker-scanner.js';
import { listTmuxSessions, wasTmuxScanRecent } from './tmux-bridge.js';
import {
  collectSessionSuccessions,
  containerSessionMatchesKey,
  issueKeyForContainer,
  reconcileContainerSessions,
} from './container-sessions.js';
import {
  recordSessionSuccession,
  resolveSessionId,
  successionsFromProcesses,
} from './session-aliases.js';
import {
  getLaunchedSessions,
  pruneLaunchedSessions,
  type LaunchedSession,
} from './launched-sessions.js';
import { mapWithConcurrency } from './concurrency.js';
import { extractTag, tagFromName } from './tagging.js';
import { claudeSessions, type ClaudeSession } from './claude-sessions.js';
import { tmuxSessionsForPids } from './tmux-ownership.js';
import { getProviders, target } from '../providers/registry.js';
import type { DiscoverOptions } from '../providers/types.js';

/** How many containers to read from at once per scan tick. */
const CONTAINER_READ_CONCURRENCY = 4;
import {
  parseFullSessionMetadata,
  parseSessionMetadataFromLines,
  parseSubagents,
  peekFirstUserMessage,
  peekLastActivity,
} from './jsonl-parser.js';
import type { Session, SubagentInfo } from '../types.js';

// Re-exported from their new home so existing importers (and their tests) keep
// finding them here; the VM scan needs them without pulling in this loop.
export {
  containerSessionMatchesKey,
  issueKeyForContainer,
  reconcileContainerSessions,
} from './container-sessions.js';

/** Sum of a session's own cost plus every subagent it spawned. */
function totalCostWithSubagents(ownCost: number, subagents: SubagentInfo[]): number {
  return subagents.reduce((sum, sa) => sum + sa.estimatedCost, ownCost);
}

let sessionCache = new Map<string, Session>();

/**
 * The transcript each live process was last seen writing.
 *
 * `/clear` keeps the process and starts a new conversation under a new session
 * id. Without this the old id simply goes stale: an open tab points at a
 * session that has stopped, and the work continues under a card nobody is
 * looking at. Succession was already tracked for containers and remote hosts,
 * whose ids change on restart, and this is the same event seen from the pid.
 */
const lastSessionIdByPid = new Map<number, string>();

// Sticky container/tmux assignments per session. Once a session has been
// matched to a docker container or tmux session, we keep that mapping across
// transient scan failures — only clearing it when a fresh scan positively
// proves the resource is gone. This prevents the UI from flapping between
// "interactive" and "observe-only" when `docker ps` times out, when matching
// momentarily picks a different candidate JSONL, etc.
//
// The status field (running/idle/stopped) is still re-derived every tick from
// fresh data; only the *identity* of the backing container/tmux is sticky.
interface StickyAssignment {
  dockerContainer?: string;
  tmuxSession?: string;
}
const stickyAssignments = new Map<string, StickyAssignment>();

// Sticky cache for the container-internal session (no host JSONL). Unlike
// host-backed sessions, this is rebuilt from scratch every tick by reading the
// JSONL from *inside* the container via `docker exec` — a call that readily times
// out when the same container is under load (e.g. the user is actively typing
// into it, so the Terminal panel's own `docker exec` capture/send-keys contend
// with the discovery tick). A single failed read must not evict a still-running
// session, so we keep the last good read per container and reuse it until the
// container is authoritatively gone. Keyed by container name.
const lastContainerSessions = new Map<string, Session>();

export function getCachedSessions(): Session[] {
  return Array.from(sessionCache.values());
}

/**
 * A cached session by id, following a restart when the id was retired.
 *
 * Container sessions are addressed by their transcript id, which changes when
 * the VM or the container restarts — see session-aliases. Resolving here means
 * every id-addressed route (detail, messages, subagents, capture, send) follows
 * the container across a restart instead of 404ing on a live session.
 */
export function getCachedSession(id: string): Session | undefined {
  return sessionCache.get(id) ?? sessionCache.get(resolveSessionId(id));
}

/**
 * Every session every registered provider can see, merged and cached.
 *
 * Providers are asked in registration order and the first one to claim an id
 * keeps it, so a session that two providers can both see (a container whose
 * transcript is also bind-mounted onto this host, say) appears once. A provider
 * that throws is skipped for this tick rather than emptying the dashboard.
 */
export async function discoverSessions(
  opts: { includeOld?: boolean; writeCache?: boolean } = {},
): Promise<Session[]> {
  const includeOld = opts.includeOld ?? false;
  const writeCache = opts.writeCache ?? true;

  const perProvider = await Promise.all(
    getProviders().map(async provider => {
      try {
        return await provider.discover({ includeOld });
      } catch (err) {
        console.error(`Provider "${provider.id}" failed to discover:`, err);
        return [] as Session[];
      }
    }),
  );

  const merged: Session[] = [];
  const seen = new Set<string>();
  for (const sessions of perProvider) {
    for (const session of sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      merged.push(session);
    }
  }

  if (writeCache) {
    sessionCache = new Map(merged.map(s => [s.id, s]));
  }
  return merged;
}

/**
 * The 'local' provider's scan: transcripts on this host, the processes and tmux
 * sessions backing them, and the agent containers running here.
 */
export async function discoverLocalSessions(opts: DiscoverOptions = {}): Promise<Session[]> {
  const includeOld = opts.includeOld ?? false;

  // Scan containers first so the filesystem scan can admit older workspace
  // JSONLs that correspond to a currently-running (resumed) container.
  const containers = await scanDockerContainers();
  const runningContainerIssueKeys = new Set(
    containers
      .filter(c => c.state === 'running')
      .map(c => tagFromName(c.name, config.dockerContainerPrefix)),
  );

  // Processes before the filesystem scan, not beside it: a session with a live
  // `claude` process must never be aged out, and the scan has to know which ids
  // those are before it decides what to skip. `ps` is cheap next to the reads
  // the scan is about to do.
  // Claude Code's own registry says which sessions are alive and which
  // transcript each is writing. `ps` is still read, for a session the registry
  // has never heard of — an older Claude Code, or a build that doesn't write it.
  const [processes, live] = await Promise.all([scanClaudeProcesses(), claudeSessions()]);
  const liveSessionIds = new Set([
    ...live.keys(),
    ...processes.map(p => p.sessionId).filter((id): id is string => !!id),
  ]);

  const [fileSessions, tmuxSessions] = await Promise.all([
    scanFilesystem(runningContainerIssueKeys, liveSessionIds, includeOld),
    listTmuxSessions(),
  ]);

  const runningPids = await getRunningPids();
  const processBySessionId = new Map<string, number>();
  for (const proc of processes) {
    if (proc.sessionId) {
      processBySessionId.set(proc.sessionId, proc.pid);
    }
  }

  // Match containers to workspace sessions by exact issue key. The key comes
  // from the canonical firstUserMessage (e.g. "resolve PROJ-8008") — we do NOT
  // match against lastUserMessage, which can incidentally mention other tickets
  // and cause cross-attachment. Containers without a matching JSONL are simply
  // not surfaced (no random fallback) to avoid wrong-session labels.
  const workspaceSessions = fileSessions.filter(s => s.projectHash === '-workspace');
  const runningContainerList = containers.filter(c => c.state === 'running');
  const assignedContainers = new Set<string>();
  const matchedContainerNames = new Set<string>();

  for (const container of runningContainerList) {
    const containerKey = tagFromName(container.name, config.dockerContainerPrefix);

    // Among unassigned sessions whose firstUserMessage's issue key equals
    // the container key, pick the most recently active one.
    const candidates = workspaceSessions
      .filter(s => !assignedContainers.has(s.id))
      .filter(s => extractTag(s.firstUserMessage) === containerKey)
      .sort((a, b) =>
        new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
      );

    const matched = candidates[0];
    if (matched) {
      matched.dockerContainer = container.name;
      matched.status = 'running';
      assignedContainers.add(matched.id);
      matchedContainerNames.add(container.name);
    }
  }

  // Match tmux sessions to file sessions by issue key in session name
  const tmuxPrefix = config.tmuxSessionPrefix;
  const assignedTmux = new Set<string>();

  for (const tmux of tmuxSessions) {
    if (!tmux.name.startsWith(tmuxPrefix)) continue;

    const issueKey = tagFromName(tmux.name, tmuxPrefix);

    // Match against local sessions by exact issue key in firstUserMessage,
    // most recently active first. Same rationale as docker matching above.
    const candidates = fileSessions
      .filter(s => s.projectHash !== '-workspace' && !assignedTmux.has(s.id))
      .filter(s => extractTag(s.firstUserMessage) === issueKey)
      .sort((a, b) =>
        new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
      );

    const matched = candidates[0];
    if (matched) {
      matched.tmuxSession = tmux.name;
      matched.source = 'tmux';
      matched.status = 'running';
      assignedTmux.add(matched.id);
    }
  }

  // Sessions the monitor launched itself. Unlike the Jira matchers above there
  // is no guessing: the id was assigned at launch (`claude --session-id`), so it
  // is exactly the id Claude writes its transcript under.
  //
  // Claude writes no JSONL until the first message is sent, so a freshly
  // launched session has nothing on disk to find. Without a stand-in it would be
  // absent from the dashboard — and unreachable, since the send/capture routes
  // resolve a session before touching tmux, which is how you'd answer the
  // trust-this-folder prompt. Synthesize one until the transcript shows up.
  const tmuxAuthoritative = wasTmuxScanRecent();
  const liveTmuxNames = new Set(tmuxSessions.map(t => t.name));
  const fileSessionsById = new Map(fileSessions.map(s => [s.id, s]));

  for (const entry of getLaunchedSessions()) {
    // A tmux scan that failed isn't evidence the session died; treat the entry
    // as live so an interactive session doesn't blink off the dashboard.
    if (tmuxAuthoritative && !liveTmuxNames.has(entry.tmuxSession)) continue;

    const existing = fileSessionsById.get(entry.sessionId);
    if (existing) {
      existing.tmuxSession = entry.tmuxSession;
      existing.source = 'tmux';
      existing.status = 'running';
    } else {
      fileSessions.push(placeholderLaunchedSession(entry));
    }
    assignedTmux.add(entry.sessionId);
  }

  if (tmuxAuthoritative) await pruneLaunchedSessions(liveTmuxNames);

  // Determine running status and enrich with docker info
  for (const session of fileSessions) {
    if (session.projectHash === '-workspace') {
      session.source = 'docker';
      if (!assignedContainers.has(session.id)) {
        session.status = 'stopped';
      }
      continue;
    }

    // Skip tmux-assigned sessions — already enriched above
    if (assignedTmux.has(session.id)) continue;
    // The registry answers for this one; see the pass below.
    if (live.has(session.id)) continue;

    const pid = processBySessionId.get(session.id);
    if (pid && runningPids.has(pid)) {
      session.status = 'running';
      session.pid = pid;
    } else {
      // Check if recently active (within last 30s) → idle, otherwise stopped
      const lastActivity = new Date(session.lastActivityAt).getTime();
      const age = Date.now() - lastActivity;
      session.status = age < 30_000 ? 'idle' : 'stopped';
      session.pid = null;
    }
  }

  // Surface running containers that have no host-side JSONL. Newer jira-agent
  // containers don't bind-mount ~/.claude, so their session logs live only
  // inside the container and never reach the filesystem scan. Read them straight
  // from inside via `docker exec` so they still appear on the dashboard with
  // live status and token counts.
  const existingIds = new Set(fileSessions.map(s => s.id));
  const unmatchedContainers = runningContainerList.filter(
    c => !matchedContainerNames.has(c.name),
  );
  // Bounded: each read spawns docker processes, and reading two dozen
  // containers at once every scan tick is enough to push the host into spawn
  // EAGAIN when anything else is busy.
  const freshReads = await mapWithConcurrency(
    unmatchedContainers,
    CONTAINER_READ_CONCURRENCY,
    async c => ({
      containerName: c.name,
      session: await discoverContainerSession(c),
    }),
  );
  // A container that restarted came back with a new transcript, hence a new
  // session id. Recorded before the cache is overwritten — it holds the only
  // copy of the previous id — so anything still addressing the old one can
  // follow it instead of 404ing on a live session.
  for (const { from, to } of collectSessionSuccessions(lastContainerSessions, freshReads)) {
    recordSessionSuccession(from, to);
  }
  // Reuse the last good read when a container's exec times out this tick, so a
  // still-running session doesn't flicker off the dashboard mid-interaction.
  const containerSessions = reconcileContainerSessions(
    freshReads,
    new Set(runningContainerList.map(c => c.name)),
    wasDockerScanRecent(),
    lastContainerSessions,
    existingIds,
  );
  fileSessions.push(...containerSessions);

  // Apply sticky container/tmux assignments where this scan didn't make a
  // fresh assignment. Only clear a sticky mapping when the current scan was
  // authoritative AND positively shows the resource is gone — otherwise a
  // transient `docker ps` timeout would briefly flip the UI to observe-only.
  const currentContainerNames = new Set(containers.map(c => c.name));
  const currentTmuxNames = liveTmuxNames;
  const dockerAuthoritative = wasDockerScanRecent();

  for (const session of fileSessions) {
    const sticky = stickyAssignments.get(session.id);
    if (!sticky) continue;

    // A docker container only ever backs a '-workspace' session — the container
    // matching loop assigns nothing else. Gating the sticky re-application on
    // that invariant stops a stale mapping from binding an unrelated local/tmux
    // session (e.g. one that a bind-mounted container's read once mis-attributed)
    // to a container that happens to still be running.
    if (
      !session.dockerContainer &&
      sticky.dockerContainer &&
      session.projectHash === '-workspace'
    ) {
      const stillExists = currentContainerNames.has(sticky.dockerContainer);
      if (stillExists || !dockerAuthoritative) {
        session.dockerContainer = sticky.dockerContainer;
        if (stillExists) session.status = 'running';
      }
    }

    if (!session.tmuxSession && sticky.tmuxSession) {
      const stillExists = currentTmuxNames.has(sticky.tmuxSession);
      if (stillExists || !tmuxAuthoritative) {
        session.tmuxSession = sticky.tmuxSession;
        if (stillExists) {
          session.source = 'tmux';
          session.status = 'running';
        }
      }
    }
  }

  // Update sticky map with the new state. We record any session that has a
  // container or tmux assignment — including ones that came from sticky and
  // are still alive — so the mapping survives even if a future scan happens to
  // miss the matching JSONL.
  for (const session of fileSessions) {
    if (session.dockerContainer || session.tmuxSession) {
      stickyAssignments.set(session.id, {
        dockerContainer: session.dockerContainer,
        tmuxSession: session.tmuxSession,
      });
    }
  }


  // Claude Code's own registry, applied last and to every session regardless of
  // how it got here. It is authoritative about the pid, the name, and whether
  // the session is working or waiting — and it has to run outside the status
  // loop above, which skips any session already bound to tmux. Skipping it
  // there cost a resumed session its name, since a name is the one thing only
  // the registry knows.
  for (const session of fileSessions) {
    const registered = live.get(session.id);
    if (!registered) continue;
    session.live = true;
    session.pid = registered.pid;
    if (registered.pids.length > 1) session.pids = registered.pids;
    session.status = registered.status === 'busy' ? 'running' : 'idle';
    if (registered.name) session.sessionName = registered.name;
  }

  // A live session with no transcript on disk yet — Claude Code writes nothing
  // until the first message — would otherwise be invisible until it is used.
  const known = new Set(fileSessions.map(s => s.id));
  for (const [id, entry] of live) {
    if (!known.has(id)) fileSessions.push(placeholderRegisteredSession(entry));
  }

  // A process that has changed transcript has been cleared. Record it so an id
  // addressed by an open tab still reaches the live conversation.
  for (const { from, to } of successionsFromProcesses(live.values(), lastSessionIdByPid)) {
    recordSessionSuccession(from, to);
  }

  // Bind sessions that are running inside tmux, whatever their tmux session is
  // called. After the placeholders above, not before: a session opened moments
  // ago has no transcript for the filesystem scan to find, and binding before
  // it exists left exactly the case this is for — `tmux new` then `claude` —
  // unbound. The matcher above works by naming convention — a configured prefix
  // plus a tag in the opening prompt — which fits containers and fits nothing a
  // person started by hand. Ownership is a fact: tmux reports each pane's
  // process, the process table gives the parentage, and the registry says which
  // transcript a pid is writing. So `tmux new -s work` followed by `claude` is
  // typeable from the browser with nothing named anything in particular.
  const registeredPids = fileSessions
    .filter(s => s.pid !== null && !s.tmuxSession)
    .map(s => s.pid as number);
  if (registeredPids.length > 0) {
    const owners = await tmuxSessionsForPids(registeredPids);
    // One pane drives one session: if two transcripts somehow claim the same
    // tmux name, the first keeps it rather than both offering a terminal that
    // types into the other's pane.
    const claimed = new Set(fileSessions.map(s => s.tmuxSession).filter(Boolean) as string[]);
    for (const session of fileSessions) {
      if (session.tmuxSession || session.pid === null) continue;
      const owner = owners.get(session.pid);
      if (!owner || claimed.has(owner)) continue;
      session.tmuxSession = owner;
      claimed.add(owner);
    }
  }

  // Derive the addressing handle last, once every assignment has settled — the
  // container and tmux matchers, the launched-session registry, the sticky
  // re-application, and the tmux ownership pass, which is the one that binds a
  // session someone started in their own tmux. Doing it per assignment
  // site instead would mean six places that each have to remember, and a sticky
  // re-attach after a failed scan would silently leave a session addressable by
  // a container it is no longer bound to.
  //
  // tmux wins over docker for a session that somehow carries both — the
  // precedence the interaction routes used to hardcode as the order of their
  // if-chain.
  for (const session of fileSessions) {
    if (session.tmuxSession) {
      session.target = target('tmux', session.tmuxSession);
      session.tag = tagFromName(session.tmuxSession, config.tmuxSessionPrefix);
    } else if (session.dockerContainer) {
      session.target = target('docker', session.dockerContainer);
      session.tag = tagFromName(session.dockerContainer, config.dockerContainerPrefix);
    } else {
      delete session.target;
    }
    if (!session.tag) delete session.tag;
  }

  return fileSessions;
}

/**
 * Put a just-launched session into the cache immediately.
 *
 * The cache is otherwise only refreshed by the discovery loop, so for up to one
 * scan interval after launching there is nothing for `/api/sessions/:id` to
 * resolve — and the UI navigates to that id the moment the launch returns. Left
 * to the loop, the user lands on "Session not found".
 */
export function cacheLaunchedSession(entry: LaunchedSession): void {
  if (sessionCache.has(entry.sessionId)) return;
  sessionCache.set(entry.sessionId, placeholderLaunchedSession(entry));
}

/**
 * Stand-in for a registered session whose transcript isn't on disk yet.
 *
 * Claude Code writes no JSONL until the first message is sent, so a session
 * someone just opened has nothing for the filesystem scan to find — and the
 * registry is the only evidence it exists. Replaced wholesale once the
 * transcript appears.
 */
function placeholderRegisteredSession(entry: ClaudeSession): Session {
  const cwd = entry.cwd ?? '';
  const now = new Date().toISOString();
  return {
    id: entry.sessionId,
    projectHash: encodeProjectHash(cwd),
    projectPath: cwd,
    jsonlPath: '',
    status: entry.status === 'busy' ? 'running' : 'idle',
    pid: entry.pid,
    live: true,
    cwd,
    gitBranch: '',
    entrypoint: 'cli',
    claudeVersion: '',
    model: '',
    permissionMode: '',
    sessionName: entry.name,
    remoteUrl: null,
    startedAt: now,
    lastActivityAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    messageCount: 0,
    toolCallCount: 0,
    estimatedCost: 0,
    firstUserMessage: '',
    lastUserMessage: '',
    subagents: [],
    source: 'local',
  };
}

/**
 * Stand-in for a monitor-launched session whose transcript doesn't exist yet.
 * Carries the tmux name so the send/capture routes can drive it immediately —
 * that's what lets you answer Claude's trust-this-folder prompt from the UI.
 * Replaced wholesale by the real parsed session once the JSONL appears.
 */
function placeholderLaunchedSession(entry: LaunchedSession): Session {
  return {
    id: entry.sessionId,
    projectHash: encodeProjectHash(entry.cwd),
    projectPath: entry.cwd,
    jsonlPath: '',
    status: 'running',
    pid: null,
    cwd: entry.cwd,
    gitBranch: '',
    entrypoint: 'cli',
    claudeVersion: '',
    model: '',
    permissionMode: '',
    sessionName: null,
    remoteUrl: null,
    startedAt: entry.launchedAt,
    lastActivityAt: entry.launchedAt,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    messageCount: 0,
    toolCallCount: 0,
    estimatedCost: 0,
    firstUserMessage: '',
    lastUserMessage: '',
    subagents: [],
    source: 'tmux',
    tmuxSession: entry.tmuxSession,
    // Set here rather than left to the derivation pass: a just-launched session
    // is put straight into the cache and driven (that is how you answer the
    // trust-this-folder prompt) before any scan has run over it.
    target: target('tmux', entry.tmuxSession),
  };
}

/**
 * Whether a transcript is older than the dashboard's cutoff.
 *
 * Two checks, in this order for a reason. A file's mtime is an *upper* bound on
 * when it was really appended to: writing moves it, but so does anything else
 * that touches the file — a backup pass, an indexer, a sync client. So:
 *
 * - mtime older than the cutoff is conclusive, and needs no read. This is what
 *   keeps the scan cheap: the great majority of transcripts are excluded by a
 *   `stat` that has already happened.
 * - mtime newer than the cutoff proves nothing on its own, so the transcript is
 *   asked directly. Without this, one `touch` resurrects a month-old
 *   conversation onto the dashboard, dated correctly but listed as current —
 *   the card's own "last activity" then contradicts the reason it is on screen.
 *
 * A transcript with no readable timestamp in its tail is kept. Being wrong
 * about which way to fail here is asymmetric: showing a stale session costs a
 * row, hiding a live one costs the thing the dashboard exists for.
 */
async function isStale(jsonlPath: string, mtimeMs: number, cutoff: number): Promise<boolean> {
  if (mtimeMs < cutoff) return true;
  const lastActivity = await peekLastActivity(jsonlPath);
  return lastActivity !== null && lastActivity < cutoff;
}

/** Inverse of decodeProjectHash — how Claude names its per-project directory. */
function encodeProjectHash(projectPath: string): string {
  return projectPath.replace(/[/.]/g, '-');
}

/**
 * Build a Session for a running container by reading its primary session JSONL
 * from inside the container (via `docker exec`). One session per container: the
 * one the foreground claude is running (see readContainerSessionSample). Used for
 * containers that don't share ~/.claude with the host. Best-effort — returns null
 * if the container has no readable session yet.
 */
async function discoverContainerSession(container: DockerContainer): Promise<Session | null> {
  const sample = await readContainerSessionSample(container.name);
  if (!sample) return null;

  const base = path.basename(sample.jsonlPath, '.jsonl');
  const idFallback = /^[0-9a-f]{8}-/.test(base) ? base : null;
  const meta = parseSessionMetadataFromLines(sample.lines, idFallback);
  if (!meta) return null;

  // Reject reads that don't belong to this container. Containers that bind-mount
  // the host ~/.claude return the newest *host* session here, which is usually
  // some other session entirely — surfacing it would show a wrong card and, via
  // the sticky map, permanently bind an unrelated session to this container.
  const containerKey = issueKeyForContainer(container.name, config.dockerContainerPrefix);
  if (!containerSessionMatchesKey(meta.firstUserMessage, containerKey)) return null;

  // Subagent fan-out can dwarf the coordinator's own usage (see
  // readContainerSubagents) — without this, heavily-delegated jira-agent runs
  // show a cost that's a tiny fraction of what they actually spent.
  const subagents = await readContainerSubagents(container.name, sample.jsonlPath);
  const cost = totalCostWithSubagents(meta.estimatedCost, subagents);

  return {
    id: meta.sessionId,
    projectHash: '-workspace',
    projectPath: meta.cwd || '/workspace',
    // Lives inside the container, not on the host — left empty so nothing tries
    // to read it as a host path. The transcript is read back on demand from
    // inside the container using remoteJsonlPath.
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
    estimatedCost: cost,
    firstUserMessage: meta.firstUserMessage,
    lastUserMessage: meta.lastUserMessage,
    subagents,
    source: 'docker',
    dockerContainer: container.name,
    target: target('docker', container.name),
  };
}

async function scanFilesystem(
  runningContainerIssueKeys: Set<string>,
  liveSessionIds: Set<string>,
  includeOld: boolean,
): Promise<Session[]> {
  const dir = projectsDir();
  let projectDirs: string[];

  try {
    projectDirs = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const maxAge = config.maxSessionAgeDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAge;
  const sessions: Session[] = [];

  for (const projectHash of projectDirs) {
    const projectDir = path.join(dir, projectHash);
    let entries: string[];

    try {
      const stat = await fsp.stat(projectDir);
      if (!stat.isDirectory()) continue;
      entries = await fsp.readdir(projectDir);
    } catch {
      continue;
    }

    const jsonlFiles = entries.filter(e => e.endsWith('.jsonl'));
    const isWorkspace = projectHash === '-workspace';

    for (const jsonlFile of jsonlFiles) {
      const jsonlPath = path.join(projectDir, jsonlFile);

      try {
        // A live process outranks any age rule. Claude Code names the transcript
        // after the session id, so this costs nothing — and without it a session
        // that has been sitting at a prompt for a week vanishes from the one
        // screen that exists to show it.
        const live = liveSessionIds.has(path.basename(jsonlFile, '.jsonl'));

        const stat = await fsp.stat(jsonlPath);
        if (!includeOld && !live && (await isStale(jsonlPath, stat.mtimeMs, cutoff))) {
          // Admit older workspace JSONLs only if their tag matches a
          // currently-running container (resumed container session whose JSONL
          // hasn't been written to since the resume).
          if (!isWorkspace || runningContainerIssueKeys.size === 0) continue;
          const firstMsg = await peekFirstUserMessage(jsonlPath);
          if (!firstMsg) continue;
          const upper = firstMsg.toUpperCase();
          const matches = [...runningContainerIssueKeys].some(k => upper.includes(k));
          if (!matches) continue;
        }

        const meta = await parseFullSessionMetadata(jsonlPath);
        if (!meta) continue;
        if (meta.totalInputTokens === 0 && meta.totalOutputTokens === 0) {
          // Normally a zero-token JSONL is an empty stub worth skipping — but a
          // freshly-launched jira-agent container writes its "resolve PROJ-xxxx"
          // prompt (and a synthetic zero-token turn) before Claude's first real
          // reply. Keep those so a just-started container still appears on the
          // dashboard instead of vanishing until its first token-bearing turn.
          const upper = (meta.firstUserMessage ?? '').toUpperCase();
          const belongsToRunningContainer =
            isWorkspace && [...runningContainerIssueKeys].some(k => upper.includes(k));
          if (!belongsToRunningContainer) continue;
        }

        const sessionDir = path.join(projectDir, jsonlFile.replace('.jsonl', ''));
        const [subagents, sessionName] = await Promise.all([
          parseSubagents(sessionDir),
          readSessionTitle(sessionDir),
        ]);

        // The transcript's own cwd, not the directory name it is filed under.
        // Claude encodes '/', '.' and '-' all as '-', so the hash cannot be
        // decoded back: "-Users-me-git-my-repo" is as consistent with
        // .../my/repo as with .../my-repo, and
        // guessing gave a path that does not exist and a project name — the
        // last segment — that was simply wrong. Decoding is only a fallback,
        // for a transcript too short to have recorded a cwd yet.
        const projectPath = meta.cwd || decodeProjectHash(projectHash);

        const cost = totalCostWithSubagents(meta.estimatedCost, subagents);

        sessions.push({
          id: meta.sessionId,
          projectHash,
          projectPath,
          jsonlPath,
          status: 'stopped', // will be updated by process scan
          pid: null,
          cwd: meta.cwd,
          gitBranch: meta.gitBranch,
          entrypoint: (meta.entrypoint as Session['entrypoint']) || 'cli',
          claudeVersion: meta.claudeVersion,
          model: meta.model,
          permissionMode: meta.permissionMode,
          sessionName,
          remoteUrl: meta.remoteUrl,
          startedAt: meta.startedAt,
          lastActivityAt: meta.lastActivityAt,
          totalInputTokens: meta.totalInputTokens,
          totalOutputTokens: meta.totalOutputTokens,
          totalCacheReadTokens: meta.totalCacheReadTokens,
          totalCacheWriteTokens: meta.totalCacheWriteTokens,
          messageCount: meta.messageCount,
          toolCallCount: meta.toolCallCount,
          estimatedCost: cost,
          firstUserMessage: meta.firstUserMessage,
          lastUserMessage: meta.lastUserMessage,
          subagents,
          source: 'local',
        });
      } catch {
        continue;
      }
    }
  }

  // Sort by last activity, most recent first
  sessions.sort((a, b) => {
    const ta = new Date(a.lastActivityAt).getTime() || 0;
    const tb = new Date(b.lastActivityAt).getTime() || 0;
    return tb - ta;
  });

  return sessions;
}

/**
 * The name the user gave this session, from `<session-dir>/custom-title.json`.
 *
 * Claude Code keeps it beside the transcript rather than inside it, which is
 * why parsing the JSONL never found one and every session came through
 * unnamed. It is the best label a session has: "Browse ML ranker" says what a
 * session is in a way that a working directory shared by eight of them cannot.
 *
 * Null when the session was never named, which is the common case.
 */
export async function readSessionTitle(sessionDir: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(sessionDir, 'custom-title.json'), 'utf-8');
    const title = (JSON.parse(raw) as { customTitle?: unknown }).customTitle;
    return typeof title === 'string' && title.trim() ? title.trim() : null;
  } catch {
    // Absent, unreadable or not the shape we expect — an unnamed session, not
    // an error. This runs for every transcript on every scan tick.
    return null;
  }
}

/**
 * Last-resort guess at the path a project hash was made from.
 *
 * Irreducibly lossy: the encoding maps '/', '.' and '-' onto the same '-', so
 * "-Users-me-git-my-repo" could be any of several real paths and this returns
 * the wrong one whenever a directory name contains a hyphen or a dot — which is
 * most of them. Use `meta.cwd` from the transcript wherever there is one; this
 * exists only for a transcript that has not recorded a cwd yet.
 */
function decodeProjectHash(hash: string): string {
  return hash.replace(/^-/, '/').replace(/-/g, '/');
}

let scanInterval: ReturnType<typeof setInterval> | null = null;
let scanListeners: Array<(sessions: Session[]) => void> = [];

export function onSessionsUpdated(fn: (sessions: Session[]) => void): () => void {
  scanListeners.push(fn);
  return () => {
    scanListeners = scanListeners.filter(l => l !== fn);
  };
}

export async function startDiscoveryLoop(): Promise<void> {
  // Initial scan
  const sessions = await discoverSessions();
  for (const fn of scanListeners) fn(sessions);

  // Re-entrancy guard: setInterval fires every scanIntervalMs regardless of
  // whether the previous scan finished. A slow `docker ps` (10s timeout) on a
  // 5s interval would overlap scans and the late-completing one would clobber
  // the cache non-deterministically. Skip ticks while a scan is in flight.
  let scanInFlight = false;
  scanInterval = setInterval(async () => {
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      const sessions = await discoverSessions();
      for (const fn of scanListeners) fn(sessions);
    } catch (err) {
      console.error('Discovery scan error:', err);
    } finally {
      scanInFlight = false;
    }
  }, config.scanIntervalMs);
}

export function stopDiscoveryLoop(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}

/**
 * Get full session detail with accurate token counts (reads entire JSONL).
 */
export async function getSessionDetail(id: string): Promise<Session | null> {
  const cached = getCachedSession(id);
  if (!cached) return null;

  const meta = await parseFullSessionMetadata(cached.jsonlPath);
  if (!meta) return cached;

  // Subagents aren't re-scanned here (only the main jsonlPath is re-read) —
  // reuse the per-subagent costs from the last discovery tick, which is the
  // same freshness `cached.subagents` itself already had.
  const cost = totalCostWithSubagents(meta.estimatedCost, cached.subagents);

  return {
    ...cached,
    totalInputTokens: meta.totalInputTokens,
    totalOutputTokens: meta.totalOutputTokens,
    totalCacheReadTokens: meta.totalCacheReadTokens,
    totalCacheWriteTokens: meta.totalCacheWriteTokens,
    messageCount: meta.messageCount,
    toolCallCount: meta.toolCallCount,
    estimatedCost: cost,
  };
}
