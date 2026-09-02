import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchJson, ApiError, fetchWorkItems } from './api';

function mockFetch(response: Partial<Response> & { text: () => Promise<string> }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response as Response));
}

describe('fetchJson', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a JSON body on success', async () => {
    mockFetch({ ok: true, status: 200, text: async () => '{"hello":"world"}' });
    const data = await fetchJson<{ hello: string }>('/api/x');
    expect(data).toEqual({ hello: 'world' });
  });

  it('throws ApiError with a clear message on empty body (proxy down / 504)', async () => {
    // Vite dev proxy returns an empty body when the upstream backend is down.
    // `res.json()` on that would throw the cryptic
    // "Unexpected end of JSON input" — fetchJson should turn it into something
    // a user can actually read.
    mockFetch({ ok: true, status: 200, text: async () => '' });
    await expect(fetchJson('/api/sessions')).rejects.toBeInstanceOf(ApiError);
    await expect(fetchJson('/api/sessions')).rejects.toThrow(/empty response/i);
  });

  it('throws ApiError with status on non-OK responses', async () => {
    mockFetch({ ok: false, status: 500, text: async () => '' });
    await expect(fetchJson('/api/sessions')).rejects.toMatchObject({
      status: 500,
      message: expect.stringMatching(/500/),
    });
  });

  it('surfaces server-provided error message on non-OK JSON responses', async () => {
    mockFetch({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'issueKey is required' }),
    });
    await expect(fetchJson('/api/docker/start-development')).rejects.toThrow(
      'issueKey is required',
    );
  });

  it('throws ApiError on invalid JSON body (e.g. SPA fallback returned HTML)', async () => {
    mockFetch({ ok: true, status: 200, text: async () => '<!doctype html>' });
    await expect(fetchJson('/api/sessions')).rejects.toThrow(/invalid json/i);
  });

  it('throws ApiError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchJson('/api/sessions')).rejects.toMatchObject({
      status: 0,
      message: expect.stringMatching(/network error/i),
    });
  });
});

describe('fetchWorkItems', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty without calling the network when there are no tags', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await fetchWorkItems([]);
    expect(res).toEqual({ enabled: false, tracker: null, items: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requests the given tags and returns parsed items', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          enabled: true,
          tracker: { id: 'jira', label: 'Jira' },
          items: {
            'PROJ-1': {
              tag: 'PROJ-1',
              status: 'In Review',
              state: 'inprogress',
              summary: 'x',
              url: 'https://acme.atlassian.net/browse/PROJ-1',
            },
          },
        }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const res = await fetchWorkItems(['PROJ-1', 'PROJ-2']);

    expect(fetchSpy).toHaveBeenCalledWith('/api/work-items?tags=PROJ-1%2CPROJ-2', undefined);
    expect(res.enabled).toBe(true);
    expect(res.items['PROJ-1'].state).toBe('inprogress');
    // The link is the tracker's, not something the UI assembled.
    expect(res.items['PROJ-1'].url).toBe('https://acme.atlassian.net/browse/PROJ-1');
  });
});
