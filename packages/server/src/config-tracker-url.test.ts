import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The template is read at import time, so each case needs its own module.
 */
async function trackerItemUrlWith(env: Record<string, string>): Promise<string> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const { config } = await import('./config.js');
  return config.trackerItemUrl;
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('trackerItemUrl', () => {
  it('is empty when nothing says where the tracker is', async () => {
    expect(await trackerItemUrlWith({})).toBe('');
  });

  it('builds a browse URL from a Jira base', async () => {
    expect(await trackerItemUrlWith({ JIRA_BASE_URL: 'https://acme.atlassian.net' }))
      .toBe('https://acme.atlassian.net/browse/{key}');
  });

  it('does not double a slash the user left on the end', async () => {
    expect(await trackerItemUrlWith({ JIRA_BASE_URL: 'https://acme.atlassian.net/' }))
      .toBe('https://acme.atlassian.net/browse/{key}');
  });

  it('takes a bare Atlassian site name', async () => {
    expect(await trackerItemUrlWith({ ATLASSIAN_SITE_NAME: 'acme' }))
      .toBe('https://acme.atlassian.net/browse/{key}');
  });

  it('takes a full Atlassian host too, since both name the same site', async () => {
    expect(await trackerItemUrlWith({ ATLASSIAN_SITE_NAME: 'acme.atlassian.net' }))
      .toBe('https://acme.atlassian.net/browse/{key}');
  });

  it('lets an explicit template win, for a tracker that is not Jira', async () => {
    expect(await trackerItemUrlWith({
      JIRA_BASE_URL: 'https://acme.atlassian.net',
      TRACKER_ITEM_URL: 'https://linear.app/acme/issue/{key}',
    })).toBe('https://linear.app/acme/issue/{key}');
  });
});
