import { describe, it, expect } from 'vitest';
import { resolveJiraCredentials } from './jira-credentials.js';

const claudeJsonWithJira = {
  mcpServers: {
    'jira': {
      env: {
        ATLASSIAN_SITE_NAME: 'acme',
        ATLASSIAN_USER_EMAIL: 'dev@example.com',
        ATLASSIAN_API_TOKEN: 'token-from-claude-json',
      },
    },
  },
};

describe('resolveJiraCredentials', () => {
  it('uses explicit JIRA_* env vars when all present', () => {
    const creds = resolveJiraCredentials({
      env: {
        JIRA_BASE_URL: 'https://example.atlassian.net',
        JIRA_EMAIL: 'me@example.com',
        JIRA_API_TOKEN: 'env-token',
      },
      readClaudeJson: () => null,
    });
    expect(creds).toEqual({
      baseUrl: 'https://example.atlassian.net',
      email: 'me@example.com',
      apiToken: 'env-token',
    });
  });

  it('strips a trailing slash from JIRA_BASE_URL', () => {
    const creds = resolveJiraCredentials({
      env: {
        JIRA_BASE_URL: 'https://example.atlassian.net/',
        JIRA_EMAIL: 'me@example.com',
        JIRA_API_TOKEN: 'env-token',
      },
      readClaudeJson: () => null,
    });
    expect(creds?.baseUrl).toBe('https://example.atlassian.net');
  });

  it('falls back to an Atlassian MCP entry in ~/.claude.json', () => {
    const creds = resolveJiraCredentials({
      env: {},
      readClaudeJson: () => claudeJsonWithJira,
    });
    expect(creds).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@example.com',
      apiToken: 'token-from-claude-json',
    });
  });

  it('skips MCP entries that carry no Atlassian credentials', () => {
    const creds = resolveJiraCredentials({
      env: {},
      readClaudeJson: () => ({
        mcpServers: {
          github: { env: { GITHUB_TOKEN: 'gh' } },
          'my-jira': claudeJsonWithJira.mcpServers.jira,
        },
      }),
    });
    expect(creds?.apiToken).toBe('token-from-claude-json');
  });

  it('reads the MCP entry named by JIRA_MCP_SERVER', () => {
    const creds = resolveJiraCredentials({
      env: { JIRA_MCP_SERVER: 'work' },
      readClaudeJson: () => ({
        mcpServers: {
          personal: { env: { ATLASSIAN_SITE_NAME: 'personal', ATLASSIAN_USER_EMAIL: 'me@example.com', ATLASSIAN_API_TOKEN: 'personal-token' } },
          work: { env: { ATLASSIAN_SITE_NAME: 'acme', ATLASSIAN_USER_EMAIL: 'dev@example.com', ATLASSIAN_API_TOKEN: 'work-token' } },
        },
      }),
    });
    expect(creds).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@example.com',
      apiToken: 'work-token',
    });
  });

  it('returns null when JIRA_MCP_SERVER names a missing entry', () => {
    const creds = resolveJiraCredentials({
      env: { JIRA_MCP_SERVER: 'absent' },
      readClaudeJson: () => claudeJsonWithJira,
    });
    expect(creds).toBeNull();
  });

  it('lets individual env vars override claude.json fields', () => {
    const creds = resolveJiraCredentials({
      env: { JIRA_API_TOKEN: 'override-token' },
      readClaudeJson: () => claudeJsonWithJira,
    });
    expect(creds).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@example.com',
      apiToken: 'override-token',
    });
  });

  it('accepts ATLASSIAN_* env var names too', () => {
    const creds = resolveJiraCredentials({
      env: {
        ATLASSIAN_SITE_NAME: 'acme',
        ATLASSIAN_USER_EMAIL: 'me@acme.com',
        ATLASSIAN_API_TOKEN: 'acme-token',
      },
      readClaudeJson: () => null,
    });
    expect(creds).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      email: 'me@acme.com',
      apiToken: 'acme-token',
    });
  });

  it('returns null when no credentials can be resolved', () => {
    expect(resolveJiraCredentials({ env: {}, readClaudeJson: () => null })).toBeNull();
  });

  it('returns null when token is present but base url/email cannot be resolved', () => {
    const creds = resolveJiraCredentials({
      env: { JIRA_API_TOKEN: 'lonely-token' },
      readClaudeJson: () => null,
    });
    expect(creds).toBeNull();
  });

  it('does not throw if reading claude.json fails', () => {
    const creds = resolveJiraCredentials({
      env: {},
      readClaudeJson: () => {
        throw new Error('boom');
      },
    });
    expect(creds).toBeNull();
  });
});
