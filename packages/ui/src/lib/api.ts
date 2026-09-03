const BASE = '';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    // Status 0 means the request never reached a server, which is a different
    // thing from every other failure here and has a different answer: start the
    // server. The browser's own wording for it is "Failed to fetch", which
    // tells nobody anything, so it goes at the end rather than the front.
    throw new ApiError(
      "Can't reach the claude-deck server. Is it still running "
        + `(npm run dev)? — ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  const text = await res.text();

  if (!res.ok) {
    let serverMessage: string | undefined;
    if (text) {
      try {
        const parsed = JSON.parse(text);
        serverMessage = typeof parsed?.error === 'string' ? parsed.error : undefined;
      } catch {
        // fall through to default message
      }
    }
    throw new ApiError(serverMessage ?? `Request failed (${res.status})`, res.status);
  }

  if (!text) {
    throw new ApiError('Empty response from server', res.status);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(
      `Invalid JSON response from server (${res.status})`,
      res.status,
    );
  }
}

export interface Session {
  id: string;
  projectHash: string;
  projectPath: string;
  jsonlPath: string;
  status: 'running' | 'idle' | 'stopped';
  pid: number | null;
  cwd: string;
  gitBranch: string;
  entrypoint: 'cli' | 'web' | 'ide';
  claudeVersion: string;
  model: string;
  permissionMode: string;
  sessionName: string | null;
  remoteUrl: string | null;
  startedAt: string;
  lastActivityAt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  messageCount: number;
  toolCallCount: number;
  estimatedCost: number;
  firstUserMessage: string;
  lastUserMessage: string;
  subagents: SubagentInfo[];
  /** Claude Code's own recap of what the session is for. */
  recap?: { text: string; at: string };
  /** Every branch the session worked on. Present only when there is more than one. */
  branches?: string[];
  /**
   * Where the session lives. An open string, not a union: providers name their
   * own sources, and nothing in the UI switches on the value — it is rendered
   * as a badge and matched by the search box.
   */
  source: string;
  /** The session is not on this machine; the UI marks these distinctly. */
  remote?: boolean;
  /**
   * Claude Code holds a live registry entry for this session — it is running
   * now. Absent means no entry was found, which for an old Claude Code or a
   * build that doesn't write the registry means "unknown", not "stopped".
   */
  live?: boolean;
  /** 'interactive' or 'background', from Claude Code's registry. Decides how
      the session can be stopped — see the server's stop-session service. */
  liveKind?: string;
  /** What Stop would do to this session, decided by the server. Null when
      there is nothing running to stop. */
  stopMethod?: 'claude stop' | 'tmux kill-session' | 'SIGTERM' | null;
  /**
   * Every live process writing this transcript, newest first. Present only when
   * there is more than one — the conversation is open twice.
   */
  pids?: number[];

  /**
   * Short identifier the session belongs to (today, the issue key its container
   * is named after). Shown where a full name won't fit, and used to group
   * sessions working on the same thing. Derived server-side — the UI must not
   * try to reconstruct it, since only the server knows the naming rules.
   */
  tag?: string;
  /**
   * How to reach the session's live terminal. Absent means observe-only: the
   * transcript is readable but there is nothing to type into.
   */
  target?: TargetRef;
  hidden?: boolean;
  note?: string | null;
}

/** Mirrors the server's providers/types.ts. */
export interface TargetRef {
  /** Selects the transport server-side; the UI uses it to look up poll cadence. */
  kind: string;
  /** The handle the transport addresses this session by. */
  ref: string;
  /** What to show a human, when `ref` alone is not it. */
  label?: string;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  description: string;
  jsonlPath: string;
  messageCount: number;
  lastActivityAt: string;
  model: string;
  totalOutputTokens: number;
  estimatedCost: number;
}

export interface ParsedMessage {
  type: 'user' | 'assistant' | 'system' | 'permission-mode' | 'file-history-snapshot';
  /** Stable 0-based index in the oldest-first transcript; see server types.ts. */
  seq?: number;
  timestamp: string;
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  content?: Array<{
    type: 'text' | 'tool_use' | 'tool_result';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    content?: unknown;
  }>;
  stopReason?: string;
  subtype?: string;
  promptId?: string;
  permissionMode?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  claudeVersion?: string;
}

export interface Stats {
  totalSessions: number;
  runningSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export async function fetchSessions(params?: { status?: string; source?: string; showHidden?: boolean; recent?: boolean }): Promise<Session[]> {
  const url = new URL(`${BASE}/api/sessions`, window.location.origin);
  if (params?.status) url.searchParams.set('status', params.status);
  if (params?.source) url.searchParams.set('source', params.source);
  if (params?.showHidden) url.searchParams.set('showHidden', 'true');
  if (params?.recent === false) url.searchParams.set('recent', 'false');
  const data = await fetchJson<{ sessions: Session[] }>(url.toString());
  return data.sessions;
}

export async function hideSession(id: string): Promise<void> {
  await fetch(`${BASE}/api/sessions/${id}/hide`, { method: 'POST' });
}

export async function unhideSession(id: string): Promise<void> {
  await fetch(`${BASE}/api/sessions/${id}/unhide`, { method: 'POST' });
}

export async function fetchSessionNotes(): Promise<Record<string, string>> {
  const data = await fetchJson<{ notes: Record<string, string> }>(`${BASE}/api/notes`);
  return data.notes;
}

/** A blank note clears it. Persisted server-side, so every device sees it. */
export async function saveSessionNote(id: string, note: string): Promise<void> {
  const res = await fetch(`${BASE}/api/sessions/${id}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `save note failed (${res.status})`);
  }
}

export async function fetchSession(id: string): Promise<Session> {
  // Through fetchJson, so an unreachable server and a missing session are
  // distinguishable. Raw fetch here meant `res.json()` threw on the empty body
  // of a failed request, and the caller could only conclude "no such session".
  const data = await fetchJson<{ session: Session }>(`${BASE}/api/sessions/${id}`);
  return data.session;
}

export async function fetchMessages(
  id: string,
  offset = 0,
  limit = 100,
): Promise<{ messages: ParsedMessage[]; total: number }> {
  const res = await fetch(`${BASE}/api/sessions/${id}/messages?offset=${offset}&limit=${limit}`);
  return res.json();
}

export async function fetchStats(): Promise<Stats> {
  return fetchJson<Stats>(`${BASE}/api/stats`);
}

/** Mirrors the server's trackers/types.ts. */
export type WorkItemState = 'todo' | 'inprogress' | 'done' | 'unknown';

export interface WorkItem {
  tag: string;
  /** The tracker's own name for the state; shown verbatim. */
  status: string;
  /** That status in the four states the UI can colour. */
  state: WorkItemState;
  summary: string | null;
  /** Link to the item, or null when the tracker has no web view. */
  url: string | null;
}

export interface WorkItemsResponse {
  /** False when no tracker is configured — hide the column, don't show errors. */
  enabled: boolean;
  tracker: { id: string; label: string } | null;
  items: Record<string, WorkItem>;
}

export async function fetchWorkItems(tags: string[]): Promise<WorkItemsResponse> {
  if (tags.length === 0) return { enabled: false, tracker: null, items: {} };
  const qs = encodeURIComponent(tags.join(','));
  return fetchJson<WorkItemsResponse>(`${BASE}/api/work-items?tags=${qs}`);
}

/** One phase of the configured workflow, as read off an item's artifacts. */
export interface PhaseState {
  label: string;
  done: boolean;
  linear: boolean;
}

export interface GroupState {
  name: string;
  /** Signal label → present. Labels come from the server's config. */
  signals: Record<string, boolean>;
  detail: string | null;
}

export interface WorkItemArtifacts {
  tag: string;
  dir: string;
  phase: number;
  phaseLabel: string;
  phases: PhaseState[];
  groups: GroupState[];
  /** What one group is called, e.g. "repo". */
  groupNoun?: string;
}

export interface ArtifactsResponse {
  /** False when no SESSIONS_DIR or no workflow is configured. */
  enabled: boolean;
  items: WorkItemArtifacts[];
}

/** One candidate tag found in a transcript, with how often it came up. */
export interface TagMention {
  tag: string;
  mentions: number;
}

/** Every piece of work a session's conversation touches. */
export interface SessionTags {
  /**
   * Most-mentioned first, with the session's own tag leading when it has one.
   * When `verified` is false these are candidates, not confirmed items.
   */
  tags: TagMention[];
  /** The tag the session was started for, if any. */
  primary: string | null;
  /** Live tracker state, keyed by tag. */
  items: Record<string, WorkItem>;
  /**
   * Whether a tracker is configured. When false only the session's own tag is
   * listed: everything else would be a string that merely looks like a key,
   * and nothing local can tell those apart.
   */
  trackerConfigured: boolean;
}

export async function fetchSessionTags(id: string): Promise<SessionTags> {
  return fetchJson<SessionTags>(`${BASE}/api/sessions/${encodeURIComponent(id)}/tags`);
}

/**
 * Hand a dropped or pasted file to the machine the session runs on, and get
 * back the path it landed at.
 *
 * A terminal carries text, not bytes — so an image has to become a path before
 * Claude can be pointed at it. This is what dragging a screenshot into the
 * pane does.
 */
export async function uploadAttachment(
  sessionId: string,
  file: File,
): Promise<{ path: string; bytes: number }> {
  const data = await fileToBase64(file);
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, data }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `upload failed (${res.status})`);
  }
  return res.json();
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL gives "data:<type>;base64,<payload>"; the server wants the
    // payload alone.
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}

export async function fetchArtifacts(): Promise<ArtifactsResponse> {
  return fetchJson<ArtifactsResponse>(`${BASE}/api/artifacts`);
}

/** Which docker daemon a container lives on: this machine, or the agent VM. */
export type ContainerLocation = 'local' | 'vm';

export interface ManagedContainer {
  id: string;
  name: string;
  image: string;
  state: 'running' | 'exited' | 'paused';
  status: string;
  createdAt: string;
  createdAtIso: string;
  ageDays: number;
  issueKey: string | null;
  matchingSessionIds: string[];
  hiddenInApp: boolean;
  location: ContainerLocation;
}

export interface CleanupCriteria {
  olderThanDays: number;
  onlyHidden: boolean;
  onlyStopped: boolean;
}

export async function fetchDockerContainers(): Promise<ManagedContainer[]> {
  const res = await fetch(`${BASE}/api/docker/containers`);
  const data = await res.json();
  return data.containers;
}

export async function removeDockerContainer(
  name: string,
  force = false,
  location: ContainerLocation = 'local',
): Promise<void> {
  const url = new URL(`${BASE}/api/docker/containers/${encodeURIComponent(name)}`, window.location.origin);
  if (force) url.searchParams.set('force', 'true');
  // Both daemons name their containers identically, so the server can't infer
  // which one a row came from.
  if (location === 'vm') url.searchParams.set('location', 'vm');
  const res = await fetch(url.toString(), { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `remove failed (${res.status})`);
  }
}

export async function previewDockerCleanup(criteria: Partial<CleanupCriteria>): Promise<{ containers: ManagedContainer[]; criteria: CleanupCriteria }> {
  const res = await fetch(`${BASE}/api/docker/cleanup/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(criteria),
  });
  return res.json();
}

/**
 * One way this installation can start work on a tag. The list is entirely
 * configuration — the UI renders whatever the server declares and knows none of
 * the entries by name.
 */
export interface Launcher {
  id: string;
  label: string;
  /** Placeholder for the input, e.g. "Issue key". */
  inputLabel: string | null;
  description: string | null;
  /** Runs the work somewhere other than this machine. */
  remote: boolean;
}

export async function fetchLaunchers(): Promise<Launcher[]> {
  const res = await fetchJson<{ launchers: Launcher[] }>(`${BASE}/api/launchers`);
  return res.launchers;
}

export interface LaunchResult {
  tag: string;
  launcherId: string;
  launchSession: string;
  /** Null for a launcher that produces no container. */
  containerName: string | null;
}

export interface LaunchStatus {
  tag: string;
  launcherId: string;
  launchSession: string;
  containerName: string | null;
  tmuxAlive: boolean;
  tmuxOutput: string;
  containerState: 'running' | 'exited' | 'created' | 'paused' | 'restarting' | 'dead' | 'missing';
  containerExitCode: number | null;
  phase: 'starting' | 'booting' | 'building' | 'ready' | 'failed' | 'unknown';
  /** Remote host state for a remote launcher; null for local ones. */
  remoteState: string | null;
}

export interface VmStatus {
  enabled: boolean;
  name: string;
  state: string;
  containers: number;
  checkedAt: string | null;
  error: string | null;
}

/** Cached VM reachability — used to enable/explain the "run on VM" option. */
export async function fetchVmStatus(): Promise<VmStatus> {
  return fetchJson<VmStatus>(`${BASE}/api/vm/status`);
}

export async function fetchLaunchStatus(
  tag: string,
  launcherId: string,
): Promise<LaunchStatus> {
  const url = new URL(
    `${BASE}/api/launch-status/${encodeURIComponent(tag)}`,
    window.location.origin,
  );
  url.searchParams.set('launcher', launcherId);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `status failed (${res.status})`);
  }
  return res.json();
}

export async function startLaunch(tag: string, launcherId: string): Promise<LaunchResult> {
  const res = await fetch(`${BASE}/api/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, launcher: launcherId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `start failed (${res.status})`);
  }
  return res.json();
}

export async function executeDockerCleanup(criteria: Partial<CleanupCriteria>): Promise<{ removed: string[]; failed: Array<{ name: string; error: string }>; criteria: CleanupCriteria }> {
  const res = await fetch(`${BASE}/api/docker/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(criteria),
  });
  return res.json();
}

export interface LaunchedSession {
  sessionId: string;
  tmuxSession: string;
  cwd: string;
  launchedAt: string;
}

/** Server-side configuration the UI renders itself from — see routes/config.ts. */
export interface AppConfig {
  /** Prefilled in the launch dialog's input, e.g. 'PROJ-'. May be empty. */
  tagPrefix: string;
  /** Regular expression source matching one tag; see parseTags in lib/utils. */
  tagPattern: string;
  dockerEnabled: boolean;
  /**
   * Per-transport UI hints, keyed by `TargetRef.kind`. Lets a transport declare
   * how fast its terminal should be polled instead of the UI keeping a table of
   * which source names are cheap to read.
   */
  transports: Record<string, { pollIntervalMs?: number }>;
  /** Largest file the terminal accepts on a drop or paste. */
  maxAttachmentBytes: number;
}

export async function fetchAppConfig(): Promise<AppConfig> {
  return fetchJson<AppConfig>(`${BASE}/api/config`);
}

export async function fetchLaunchDefaults(): Promise<{ defaultCwd: string }> {
  const res = await fetch(`${BASE}/api/claude/launch-defaults`);
  if (!res.ok) throw new Error(`defaults failed (${res.status})`);
  return res.json();
}

/**
 * Reopen an existing session under tmux so it can be typed into — the same
 * `claude --resume <id>` you would run yourself. Returns once the tmux session
 * exists; the card becomes interactive on the next discovery tick.
 */
export async function resumeSession(sessionId: string): Promise<LaunchedSession> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: 'POST',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `resume failed (${res.status})`);
  }
  return res.json();
}

export async function launchClaudeSession(cwd: string): Promise<LaunchedSession> {
  const res = await fetch(`${BASE}/api/claude/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `launch failed (${res.status})`);
  }
  return res.json();
}
