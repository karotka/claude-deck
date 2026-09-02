import type { TargetRef } from './providers/types.js';

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

  /**
   * Claude Code's own recap of what the session is for — what it writes when
   * you have been away. Better than anything derivable: it is the session's
   * account of itself, not an inference from its first message.
   */
  recap?: { text: string; at: string };

  /**
   * Every git branch the session worked on. One is the normal case; several
   * means it covered more than one piece of work, which is worth knowing before
   * reading 2000 messages looking for the bit you remember.
   */
  branches?: string[];

  /**
   * Where this session lives — 'local', 'tmux', 'docker', 'remote', or whatever
   * a third-party provider calls its sessions. Deliberately an open string: it
   * used to be a closed union, which meant every new backend had to be added to
   * the type and then to a branch in each of a dozen consumers. Nothing switches
   * on the value any more; it is a label and a filter key, and behaviour comes
   * from `target` and `remote`.
   */
  source: string;

  /**
   * The session is not on this machine.
   *
   * The UI gives these a deliberately distinct treatment: wherever local and
   * remote sessions sit side by side, the difference has to be readable at a
   * glance, because typing into one is a very different act from typing into
   * the other. A provider says so here instead of the UI keeping a list of
   * which source names happen to mean "elsewhere".
   */
  remote?: boolean;

  /**
   * Claude Code holds a live registry entry for this session — it is running
   * now, and the entry is where `pid`, `status` and `sessionName` came from.
   * See services/claude-sessions.ts.
   *
   * Absent means no entry was found. For a Claude Code that doesn't write the
   * registry that means "unknown" rather than "stopped", which is why nothing
   * is ever hidden on the strength of this being unset.
   */
  live?: boolean;

  /**
   * Every live process writing this transcript, newest first. Normally one.
   *
   * Two means the conversation is open twice — reopening a session under tmux
   * while it is still open in a terminal does that, and both keep writing. The
   * card says so rather than merging them, because a session that is quietly
   * open twice is a thing you want to know about.
   */
  pids?: number[];


  /**
   * A short identifier the session belongs to — today the Jira key a container
   * is named after, derived from the container or tmux name by stripping the
   * configured prefix. Used wherever there is no room for a full name (the tab
   * bar) and to group sessions that are working on the same thing.
   *
   * Absent for a session with nothing to derive one from.
   */
  tag?: string;

  /**
   * How to reach this session's live terminal, if at all. Absent means
   * observe-only — the transcript is readable, but there is nothing to type
   * into. See providers/types.ts.
   */
  target?: TargetRef;

  /**
   * For sessions whose transcript does not exist on this host: the JSONL path
   * wherever the session actually runs. Read back on demand through the
   * transport's `readTranscript`. Empty `jsonlPath` plus this set is what
   * distinguishes them.
   */
  remoteJsonlPath?: string;

  // --- Provider-internal --------------------------------------------------
  // Set and consumed by the built-in providers, not by generic code. They are
  // not the addressing mechanism — `target` is — but the local providers carry
  // their own bookkeeping (sticky assignment across a failed scan, container
  // management, the launched-session registry) that needs the concrete name.
  dockerContainer?: string;
  tmuxSession?: string;
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
  /**
   * 0-based index of this turn in the oldest-first merged transcript. JSONL is
   * append-only and merging only ever touches the tail, so a turn keeps its
   * `seq` across reads — the conversation view keys and dedupes on it.
   */
  seq?: number;
  timestamp: string;
  model?: string;
  usage?: TokenUsage;
  content?: ContentBlock[];
  stopReason?: string;
  subtype?: string;
  promptId?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  claudeVersion?: string;
  permissionMode?: string;
  sessionId?: string;
  remoteUrl?: string;
  /**
   * Plain-string body of a `system` record. Only away_summary uses it, and it
   * carries Claude Code's own recap of what the session is for.
   */
  summary?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

export interface SessionUpdate {
  type: 'session_updated' | 'session_new' | 'session_stopped' | 'new_message' | 'subagent_started';
  session?: Session;
  sessionId?: string;
  message?: ParsedMessage;
  subagent?: SubagentInfo;
}
