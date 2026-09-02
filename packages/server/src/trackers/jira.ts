import { getIssueStatuses } from '../services/jira-client.js';
import { resolveJiraCredentials } from '../services/jira-credentials.js';
import type { Tracker, WorkItem, WorkItemState } from './types.js';

/**
 * Jira as one tracker among however many there turn out to be.
 *
 * Everything Jira-shaped stays behind this file: the credential resolution, the
 * JQL search, the status-category vocabulary, and the /browse/ URL format. What
 * comes out is a WorkItem, which says nothing about Jira.
 */
export const jiraTracker: Tracker = {
  id: 'jira',
  label: 'Jira',

  isConfigured: () => resolveJiraCredentials() !== null,

  async lookup(tags: string[]): Promise<Map<string, WorkItem>> {
    const credentials = resolveJiraCredentials();
    const items = new Map<string, WorkItem>();
    if (!credentials) return items;

    // getIssueStatuses already caches per key and swallows network failures,
    // which is exactly the "must not throw" contract this interface asks for.
    const statuses = await getIssueStatuses(tags, { credentials });
    const base = credentials.baseUrl.replace(/\/+$/, '');
    for (const [key, status] of statuses) {
      items.set(key, {
        tag: key,
        status: status.status,
        // The client's category vocabulary happens to be the same four values;
        // mapped explicitly so a change on either side is a type error rather
        // than a silently wrong colour.
        state: status.statusCategory as WorkItemState,
        summary: status.summary,
        url: `${base}/browse/${encodeURIComponent(key)}`,
      });
    }
    return items;
  },
};
