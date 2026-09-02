import { describe, it, expect } from 'vitest';
import { collectSessionSuccessions } from './container-sessions.js';
import type { Session } from '../types.js';

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectHash: '-workspace',
    projectPath: '/workspace',
    jsonlPath: '',
    status: 'running',
    pid: null,
    cwd: '/workspace',
    gitBranch: '',
    entrypoint: 'cli',
    claudeVersion: '',
    model: '',
    permissionMode: '',
    sessionName: null,
    remoteUrl: null,
    startedAt: '',
    lastActivityAt: '',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    messageCount: 0,
    toolCallCount: 0,
    estimatedCost: 0,
    firstUserMessage: '',
    lastUserMessage: '',
    subagents: [],
    source: 'vm',
    ...overrides,
  } as Session;
}

describe('collectSessionSuccessions', () => {
  it('reports nothing when a container keeps the same session', () => {
    const cache = new Map([['jira-agent-proj-1', session('id-1')]]);
    const fresh = [{ containerName: 'jira-agent-proj-1', session: session('id-1') }];
    expect(collectSessionSuccessions(cache, fresh)).toEqual([]);
  });

  it('reports the succession when a container comes back with a new transcript', () => {
    // What a VM restart looks like: same container, new session JSONL.
    const cache = new Map([['jira-agent-proj-9699', session('419df495')]]);
    const fresh = [{ containerName: 'jira-agent-proj-9699', session: session('710ae80c') }];
    expect(collectSessionSuccessions(cache, fresh)).toEqual([
      { from: '419df495', to: '710ae80c' },
    ]);
  });

  it('ignores a failed read, which is not evidence of a new session', () => {
    const cache = new Map([['jira-agent-proj-1', session('id-1')]]);
    const fresh = [{ containerName: 'jira-agent-proj-1', session: null }];
    expect(collectSessionSuccessions(cache, fresh)).toEqual([]);
  });

  it('ignores a container with no cached session yet', () => {
    const fresh = [{ containerName: 'jira-agent-proj-1', session: session('id-1') }];
    expect(collectSessionSuccessions(new Map(), fresh)).toEqual([]);
  });

  it('reports one succession per restarted container', () => {
    const cache = new Map([
      ['jira-agent-proj-1', session('a-old')],
      ['jira-agent-proj-2', session('b-stable')],
      ['jira-agent-proj-3', session('c-old')],
    ]);
    const fresh = [
      { containerName: 'jira-agent-proj-1', session: session('a-new') },
      { containerName: 'jira-agent-proj-2', session: session('b-stable') },
      { containerName: 'jira-agent-proj-3', session: session('c-new') },
    ];
    expect(collectSessionSuccessions(cache, fresh)).toEqual([
      { from: 'a-old', to: 'a-new' },
      { from: 'c-old', to: 'c-new' },
    ]);
  });
});
