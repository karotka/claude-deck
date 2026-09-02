/**
 * A tracker answers "what is the state of the work this tag names?".
 *
 * The app has no opinion about what a tag refers to. Jira is one answer, and
 * for a long time it was the only one — its status shape, its credential
 * resolution and its URL format reached into the routes, the dashboard, the
 * container page and the session header. Behind this interface it is a plugin,
 * and an installation with no tracker simply shows no status column rather than
 * showing errors.
 */

export type WorkItemState = 'todo' | 'inprogress' | 'done' | 'unknown';

export interface WorkItem {
  /** The tag this describes. */
  tag: string;
  /** The tracker's own name for the state, shown verbatim: "In Review", "Blocked". */
  status: string;
  /**
   * That status mapped onto the four states the UI can colour. Trackers name
   * their statuses whatever they like, so the UI colours the category and
   * prints the name.
   */
  state: WorkItemState;
  /** One-line title, shown as a tooltip. */
  summary: string | null;
  /** Link to the item, or null when the tracker has no web view. */
  url: string | null;
}

export interface Tracker {
  /** Stable id, published to the UI so it can name what it is showing. */
  id: string;
  /** Human name, e.g. "Jira". */
  label: string;
  /**
   * Whether this installation has the tracker configured. Checked per request
   * rather than once at startup, because credentials can come from a file the
   * user edits (an MCP server entry in ~/.claude.json) while the server runs.
   */
  isConfigured(): boolean;
  /**
   * Look up several tags at once — the dashboard asks about every visible
   * session, so a per-tag call would be a request storm. Tags with no item are
   * simply absent from the result. Must not throw: a tracker that is down
   * returns what it has (typically its cache, possibly nothing), because a
   * failed status lookup is not a reason to fail the page.
   */
  lookup(tags: string[]): Promise<Map<string, WorkItem>>;
}
