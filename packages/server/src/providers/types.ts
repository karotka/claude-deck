import type { Session } from '../types.js';

/**
 * Where a session physically lives, and the handle its transport addresses it
 * by.
 *
 * This replaces the four parallel `dockerContainer` / `tmuxSession` /
 * `vmContainer` / `vmIssueKey` fields the routes used to switch on. Those
 * encoded both *which* transport to use and *what* to pass it in one field per
 * backend, so every new backend meant a new optional field on Session plus a
 * new branch in every consumer. Here `kind` selects the transport and `ref` is
 * opaque to everything except that transport.
 */
export interface TargetRef {
  /** Selects the transport. Matches SessionTransport.kind. */
  kind: string;
  /** The handle the transport addresses this session by. Opaque to callers. */
  ref: string;
  /** What to show a human, when `ref` alone is not it. */
  label?: string;
}

export interface CaptureOptions {
  /** Scrollback lines to return. */
  lines?: number;
  /** Width to render at, so captured lines fill the panel. */
  cols?: number;
}

/**
 * Reading and driving a live terminal for one class of session.
 *
 * `send` and `sendKey` may return the resulting pane content when the transport
 * can produce it in the same round trip — the remote one does, because waiting
 * for the next poll is most of the latency a remote keystroke appears to have.
 * Returning null means "nothing to show; poll as usual".
 */
export interface SessionTransport {
  /** Matches TargetRef.kind. */
  kind: string;
  capture(ref: string, opts: CaptureOptions): Promise<string>;
  send(ref: string, text: string, appendEnter: boolean): Promise<string | null>;
  sendKey(ref: string, key: string): Promise<string | null>;
  /**
   * Read a transcript that lives where this transport reaches rather than on
   * this host, given the path the provider recorded as `remoteJsonlPath`.
   * Omitted by transports whose sessions always have a readable host JSONL.
   */
  readTranscript?(ref: string, remotePath: string): Promise<string>;
  /**
   * How often the UI should poll capture for these sessions, in ms. Omit for
   * the default. A transport whose round trip has a different cost says so here
   * rather than having the UI hardcode a per-source special case.
   */
  pollIntervalMs?: number;
  /**
   * Keep a hidden session on the dashboard while it is running.
   *
   * Set by transports that reach a container — something you hid last week and
   * restarted today should reappear rather than stay invisible, because there
   * is no other cue that it is burning tokens. A plain tmux session on this
   * machine leaves it off: hiding one means hiding it.
   */
  keepVisibleWhenRunning?: boolean;
}

/**
 * A source of sessions.
 *
 * Two shapes, distinguished by `scanIntervalMs`:
 *
 * - Omitted — `discover()` is awaited inline on every tick of the main
 *   discovery loop. Right for anything backed by the local filesystem or a
 *   local process.
 * - Set — the provider gets its own loop at that cadence, and the main loop
 *   merges whatever `discover()` last produced without waiting for it. Right
 *   for anything whose reads are slow or can hang: a remote host over a tunnel
 *   must never be able to stall the local scan.
 */
export interface DiscoverOptions {
  /**
   * Include sessions older than the dashboard's normal age cutoff. Set by the
   * "show everything" request, not by the polling loop. Providers that have no
   * age cutoff ignore it.
   */
  includeOld?: boolean;
}

export interface SessionProvider {
  /** Stable id, and the value that lands in `Session.source`. */
  id: string;
  /** Shown on the session card. Defaults to `id`. */
  label?: string;
  /** Own loop cadence in ms; omit to ride the main discovery loop. */
  scanIntervalMs?: number;
  discover(opts?: DiscoverOptions): Promise<Session[]>;
  /** Called once at startup, before the first discover. */
  start?(): Promise<void>;
  /**
   * Release long-lived resources. Must be safe to call synchronously from a
   * process `exit` handler — an ssh child holding a tunnel open is orphaned
   * otherwise.
   */
  stop?(): void;
}
