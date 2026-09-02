import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  readClaudeJson?: () => unknown;
}

/** Read and parse ~/.claude.json, returning null on any error. */
function defaultReadClaudeJson(): unknown {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Atlassian keys we know how to read out of an MCP server's `env` block. */
const ATLASSIAN_KEYS = ['ATLASSIAN_SITE_NAME', 'ATLASSIAN_USER_EMAIL', 'ATLASSIAN_API_TOKEN'];

function envBlock(server: unknown): Record<string, string> {
  const env = (server as any)?.env;
  return env && typeof env === 'object' ? (env as Record<string, string>) : {};
}

/**
 * Atlassian credentials carried by an MCP server entry in ~/.claude.json.
 *
 * The entry's name is whatever the user called it, so it is configurable
 * (JIRA_MCP_SERVER). With nothing configured, any entry whose `env` carries
 * ATLASSIAN_* keys is used — which covers the common case of a single Atlassian
 * MCP server under an arbitrary name.
 */
function atlassianMcpEnv(claudeJson: unknown, serverName: string): Record<string, string> {
  const servers = (claudeJson as any)?.mcpServers;
  if (!servers || typeof servers !== 'object') return {};

  if (serverName) return envBlock(servers[serverName]);

  for (const server of Object.values(servers)) {
    const env = envBlock(server);
    if (ATLASSIAN_KEYS.some(key => env[key])) return env;
  }
  return {};
}

function siteToBaseUrl(site: string | undefined): string | undefined {
  return site ? `https://${site}.atlassian.net` : undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Resolve Jira Cloud credentials from (in priority order, per field):
 *   1. explicit env vars: JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN
 *   2. Atlassian env vars: ATLASSIAN_SITE_NAME / ATLASSIAN_USER_EMAIL / ATLASSIAN_API_TOKEN
 *   3. an Atlassian MCP server entry in ~/.claude.json — the one named by
 *      JIRA_MCP_SERVER, or any entry carrying ATLASSIAN_* env vars
 *
 * Returns null when base url, email, or token cannot be resolved — callers
 * treat that as "Jira status disabled" rather than an error.
 */
export function resolveJiraCredentials(opts: ResolveOptions = {}): JiraCredentials | null {
  const env = opts.env ?? process.env;
  let claudeJson: unknown = null;
  try {
    claudeJson = (opts.readClaudeJson ?? defaultReadClaudeJson)();
  } catch {
    claudeJson = null;
  }
  const fileEnv = atlassianMcpEnv(claudeJson, env.JIRA_MCP_SERVER ?? '');

  const baseUrl =
    env.JIRA_BASE_URL ??
    siteToBaseUrl(env.ATLASSIAN_SITE_NAME) ??
    siteToBaseUrl(fileEnv.ATLASSIAN_SITE_NAME);

  const email =
    env.JIRA_EMAIL ??
    env.ATLASSIAN_USER_EMAIL ??
    fileEnv.ATLASSIAN_USER_EMAIL;

  const apiToken =
    env.JIRA_API_TOKEN ??
    env.ATLASSIAN_API_TOKEN ??
    fileEnv.ATLASSIAN_API_TOKEN;

  if (!baseUrl || !email || !apiToken) return null;

  return { baseUrl: stripTrailingSlash(baseUrl), email, apiToken };
}
