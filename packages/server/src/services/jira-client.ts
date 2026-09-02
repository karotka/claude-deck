import { resolveJiraCredentials, type JiraCredentials } from './jira-credentials.js';

export type JiraStatusCategory = 'todo' | 'inprogress' | 'done' | 'unknown';

export interface JiraIssueStatus {
  key: string;
  status: string;
  statusCategory: JiraStatusCategory;
  summary: string | null;
}

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const DEFAULT_CACHE_TTL_MS = 60_000;

/** Normalize, uppercase, dedupe, and drop anything that isn't a valid issue key. */
function normalizeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = raw.trim().toUpperCase();
    if (ISSUE_KEY_PATTERN.test(key)) seen.add(key);
  }
  return [...seen];
}

export function buildStatusJql(keys: string[]): string {
  return `key in (${normalizeKeys(keys).join(', ')})`;
}

export function mapStatusCategory(categoryKey: string | undefined): JiraStatusCategory {
  switch (categoryKey) {
    case 'new':
      return 'todo';
    case 'indeterminate':
      return 'inprogress';
    case 'done':
      return 'done';
    default:
      return 'unknown';
  }
}

export function parseSearchResponse(json: unknown): JiraIssueStatus[] {
  const issues = (json as any)?.issues;
  if (!Array.isArray(issues)) return [];
  const result: JiraIssueStatus[] = [];
  for (const issue of issues) {
    const key = issue?.key;
    if (typeof key !== 'string') continue;
    const status = issue?.fields?.status;
    result.push({
      key,
      status: typeof status?.name === 'string' ? status.name : 'Unknown',
      statusCategory: mapStatusCategory(status?.statusCategory?.key),
      summary: typeof issue?.fields?.summary === 'string' ? issue.fields.summary : null,
    });
  }
  return result;
}

interface CacheEntry {
  value: JiraIssueStatus;
  at: number;
}
const cache = new Map<string, CacheEntry>();

export function clearJiraStatusCache(): void {
  cache.clear();
}

export interface GetIssueStatusesOptions {
  credentials?: JiraCredentials | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
}

async function fetchStatuses(
  keys: string[],
  creds: JiraCredentials,
  fetchFn: typeof fetch,
): Promise<JiraIssueStatus[]> {
  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64');
  const res = await fetchFn(`${creds.baseUrl}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      jql: buildStatusJql(keys),
      fields: ['status', 'summary'],
      maxResults: keys.length,
    }),
  });
  if (!res.ok) {
    throw new Error(`Jira search failed: ${res.status}`);
  }
  return parseSearchResponse(await res.json());
}

/**
 * Resolve live Jira status for the given issue keys. Results are cached per key
 * for `cacheTtlMs` so repeated polling (e.g. the Docker page) does not hammer
 * Jira. Only keys missing or stale in the cache are fetched. Network/auth
 * failures are swallowed — callers get whatever is currently cached.
 */
export async function getIssueStatuses(
  keys: string[],
  opts: GetIssueStatusesOptions = {},
): Promise<Map<string, JiraIssueStatus>> {
  // Explicit `null` means "disabled"; only resolve when not provided at all.
  const credentials =
    opts.credentials !== undefined ? opts.credentials : resolveJiraCredentials();
  const result = new Map<string, JiraIssueStatus>();
  if (!credentials) return result;

  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const wanted = normalizeKeys(keys);

  const stale = wanted.filter((key) => {
    const entry = cache.get(key);
    return !entry || now() - entry.at >= ttl;
  });

  if (stale.length > 0) {
    try {
      const fetched = await fetchStatuses(stale, credentials, fetchFn);
      for (const status of fetched) {
        cache.set(status.key, { value: status, at: now() });
      }
    } catch {
      // keep serving cached data on failure
    }
  }

  for (const key of wanted) {
    const entry = cache.get(key);
    if (entry) result.set(key, entry.value);
  }
  return result;
}
