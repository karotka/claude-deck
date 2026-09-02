import { describe, it, expect, beforeEach, vi } from 'vitest';

// The VM transport and the long-lived stream/channel plumbing are stubbed: this
// exercises the discovery loop's own bookkeeping, not the tunnel.
vi.mock('./vm-bridge.js', () => ({
  isVmAvailable: vi.fn(async () => true),
  refreshVmStatus: vi.fn(async () => ({
    state: 'RUNNING',
    containers: [
      {
        name: 'jira-agent-proj-1',
        issueKey: 'PROJ-1',
        state: 'running',
        status: 'Up 2 hours',
        runningFor: '2 hours',
      },
    ],
    checkedAt: null,
    error: null,
  })),
  getCachedVmStatus: vi.fn(() => ({
    state: 'RUNNING',
    containers: [],
    checkedAt: null,
    error: null,
  })),
  readVmSessionSample: vi.fn(),
  readVmSubagents: vi.fn(async () => []),
  stopVmStream: vi.fn(),
}));

vi.mock('./vm-stream.js', () => ({
  startStreamReaper: vi.fn(),
  stopStreamReaper: vi.fn(),
  stopAllStreams: vi.fn(),
}));

vi.mock('./vm-channel.js', () => ({
  stopAllChannels: vi.fn(),
}));

import { refreshVmSessions } from './vm-discovery.js';
import { readVmSessionSample } from './vm-bridge.js';
import { resolveSessionId, clearSessionAliases } from './session-aliases.js';

/**
 * The two JSONL lines the sample reader hands back, carrying a chosen session
 * id and a first user message naming the container's issue key (without which
 * the shared-`~/.claude` guard rejects the read).
 */
function sampleFor(sessionId: string) {
  return {
    jsonlPath: `/root/.claude/projects/-workspace/${sessionId}.jsonl`,
    lines: [
      JSON.stringify({
        type: 'user',
        sessionId,
        timestamp: '2026-08-27T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'resolve PROJ-1 please' }] },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        sessionId,
        cwd: '/workspace',
        gitBranch: 'main',
        version: '2.0.0',
      }),
    ],
  };
}

describe('refreshVmSessions — session id succession', () => {
  beforeEach(() => {
    clearSessionAliases();
    vi.mocked(readVmSessionSample).mockReset();
  });

  it('records the succession when a restart gives the container a new transcript', async () => {
    vi.mocked(readVmSessionSample).mockResolvedValueOnce(sampleFor('11111111-1111-4111-8111-111111111111'));
    const first = await refreshVmSessions();
    expect(first.map(s => s.id)).toEqual(['11111111-1111-4111-8111-111111111111']);

    // The VM restarted: same container, brand new transcript.
    vi.mocked(readVmSessionSample).mockResolvedValueOnce(sampleFor('22222222-2222-4222-8222-222222222222'));
    const second = await refreshVmSessions();
    expect(second.map(s => s.id)).toEqual(['22222222-2222-4222-8222-222222222222']);

    // Anything still holding the pre-restart id — an open tab, a bookmark, the
    // terminal's capture poll — now resolves to the live session.
    expect(resolveSessionId('11111111-1111-4111-8111-111111111111')).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('records nothing while the container keeps the same transcript', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    vi.mocked(readVmSessionSample).mockResolvedValueOnce(sampleFor(id));
    await refreshVmSessions();
    vi.mocked(readVmSessionSample).mockResolvedValueOnce(sampleFor(id));
    await refreshVmSessions();

    expect(resolveSessionId(id)).toBe(id);
  });

  it('follows a container across two restarts', async () => {
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    for (const id of ids) {
      vi.mocked(readVmSessionSample).mockResolvedValueOnce(sampleFor(id));
      await refreshVmSessions();
    }

    expect(resolveSessionId(ids[0])).toBe(ids[2]);
    expect(resolveSessionId(ids[1])).toBe(ids[2]);
  });

  it('treats a failed read as a hiccup, not a restart', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    vi.mocked(readVmSessionSample).mockResolvedValueOnce(sampleFor(id));
    await refreshVmSessions();

    // Exec timed out this tick; the card is held from cache and no succession
    // is recorded, so the id keeps resolving to itself.
    vi.mocked(readVmSessionSample).mockResolvedValueOnce(null);
    const held = await refreshVmSessions();

    expect(held.map(s => s.id)).toEqual([id]);
    expect(resolveSessionId(id)).toBe(id);
  });
});
