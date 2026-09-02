import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { registerProvider, resetRegistry } from './registry.js';
import { discoverSessions } from '../services/session-discovery.js';
import type { Session } from '../types.js';

function session(id: string, overrides: Partial<Session> = {}): Session {
  return { id, source: 'test', ...overrides } as Session;
}

beforeEach(resetRegistry);
afterEach(() => vi.restoreAllMocks());

describe('discoverSessions', () => {
  it('merges every registered provider', async () => {
    registerProvider({ id: 'a', discover: async () => [session('1')] });
    registerProvider({ id: 'b', discover: async () => [session('2')] });

    const sessions = await discoverSessions({ writeCache: false });
    expect(sessions.map(s => s.id).sort()).toEqual(['1', '2']);
  });

  it('lets the first provider to claim an id keep it', async () => {
    // A container whose transcript is also bind-mounted onto this host is
    // visible to two providers. It must appear once, as the version the
    // earlier-registered provider produced.
    registerProvider({ id: 'a', discover: async () => [session('1', { source: 'local' })] });
    registerProvider({ id: 'b', discover: async () => [session('1', { source: 'remote' })] });

    const sessions = await discoverSessions({ writeCache: false });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe('local');
  });

  it('keeps going when a provider throws', async () => {
    // An unreachable remote host must cost its own cards, not the dashboard.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerProvider({ id: 'broken', discover: async () => { throw new Error('tunnel down'); } });
    registerProvider({ id: 'ok', discover: async () => [session('1')] });

    const sessions = await discoverSessions({ writeCache: false });
    expect(sessions.map(s => s.id)).toEqual(['1']);
  });

  it('passes includeOld through to the providers', async () => {
    const discover = vi.fn(async () => []);
    registerProvider({ id: 'a', discover });

    await discoverSessions({ includeOld: true, writeCache: false });
    expect(discover).toHaveBeenCalledWith({ includeOld: true });
  });
});
