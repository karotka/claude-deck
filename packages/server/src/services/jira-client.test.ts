import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildStatusJql,
  mapStatusCategory,
  parseSearchResponse,
  getIssueStatuses,
  clearJiraStatusCache,
} from './jira-client.js';

const CREDS = {
  baseUrl: 'https://acme.atlassian.net',
  email: 'me@example.com',
  apiToken: 'secret',
};

function searchResponse(issues: Array<{ key: string; status: string; category: string; summary?: string }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      issues: issues.map((i) => ({
        key: i.key,
        fields: {
          summary: i.summary ?? `Summary for ${i.key}`,
          status: { name: i.status, statusCategory: { key: i.category } },
        },
      })),
    }),
  } as unknown as Response;
}

describe('buildStatusJql', () => {
  it('builds a key-in clause from valid keys', () => {
    expect(buildStatusJql(['PROJ-1', 'OPS-22'])).toBe('key in (PROJ-1, OPS-22)');
  });

  it('uppercases and drops invalid keys', () => {
    expect(buildStatusJql(['proj-7', 'not a key', 'X'])).toBe('key in (PROJ-7)');
  });
});

describe('mapStatusCategory', () => {
  it('maps Jira category keys to our buckets', () => {
    expect(mapStatusCategory('new')).toBe('todo');
    expect(mapStatusCategory('indeterminate')).toBe('inprogress');
    expect(mapStatusCategory('done')).toBe('done');
    expect(mapStatusCategory('weird')).toBe('unknown');
  });
});

describe('parseSearchResponse', () => {
  it('maps issues to JiraIssueStatus', () => {
    const parsed = parseSearchResponse({
      issues: [
        {
          key: 'PROJ-1',
          fields: {
            summary: 'Fix the thing',
            status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
          },
        },
      ],
    });
    expect(parsed).toEqual([
      { key: 'PROJ-1', status: 'In Review', statusCategory: 'inprogress', summary: 'Fix the thing' },
    ]);
  });

  it('tolerates missing/garbage shapes', () => {
    expect(parseSearchResponse({})).toEqual([]);
    expect(parseSearchResponse(null)).toEqual([]);
  });
});

describe('getIssueStatuses', () => {
  beforeEach(() => clearJiraStatusCache());

  it('returns an empty map and does not fetch when there are no credentials', async () => {
    const fetchFn = vi.fn();
    const result = await getIssueStatuses(['PROJ-1'], { credentials: null, fetchFn });
    expect(result.size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fetches statuses and maps them by key', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      searchResponse([
        { key: 'PROJ-1', status: 'In Progress', category: 'indeterminate' },
        { key: 'PROJ-2', status: 'Done', category: 'done' },
      ]),
    );
    const result = await getIssueStatuses(['PROJ-1', 'PROJ-2'], {
      credentials: CREDS,
      fetchFn,
      now: () => 1000,
    });

    expect(result.get('PROJ-1')).toMatchObject({ status: 'In Progress', statusCategory: 'inprogress' });
    expect(result.get('PROJ-2')).toMatchObject({ status: 'Done', statusCategory: 'done' });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe('https://acme.atlassian.net/rest/api/3/search/jql');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.body).toContain('PROJ-1');
    expect(init.body).toContain('PROJ-2');
  });

  it('serves cached statuses within the TTL without re-fetching', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      searchResponse([{ key: 'PROJ-1', status: 'Done', category: 'done' }]),
    );
    await getIssueStatuses(['PROJ-1'], { credentials: CREDS, fetchFn, now: () => 1000, cacheTtlMs: 60_000 });
    await getIssueStatuses(['PROJ-1'], { credentials: CREDS, fetchFn, now: () => 50_000, cacheTtlMs: 60_000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has expired', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      searchResponse([{ key: 'PROJ-1', status: 'Done', category: 'done' }]),
    );
    await getIssueStatuses(['PROJ-1'], { credentials: CREDS, fetchFn, now: () => 1000, cacheTtlMs: 60_000 });
    await getIssueStatuses(['PROJ-1'], { credentials: CREDS, fetchFn, now: () => 1000 + 60_001, cacheTtlMs: 60_000 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('only fetches the keys not already cached', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(searchResponse([{ key: 'PROJ-1', status: 'Done', category: 'done' }]))
      .mockResolvedValueOnce(searchResponse([{ key: 'PROJ-2', status: 'To Do', category: 'new' }]));

    await getIssueStatuses(['PROJ-1'], { credentials: CREDS, fetchFn, now: () => 1000 });
    const result = await getIssueStatuses(['PROJ-1', 'PROJ-2'], { credentials: CREDS, fetchFn, now: () => 2000 });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const secondBody = fetchFn.mock.calls[1][1].body as string;
    expect(secondBody).toContain('PROJ-2');
    expect(secondBody).not.toContain('PROJ-1');
    expect(result.get('PROJ-1')?.status).toBe('Done');
    expect(result.get('PROJ-2')?.status).toBe('To Do');
  });

  it('does not throw and returns cached data when the request fails', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await getIssueStatuses(['PROJ-1'], { credentials: CREDS, fetchFn, now: () => 1000 });
    expect(result.size).toBe(0);
  });
});
