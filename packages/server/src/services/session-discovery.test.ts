import { describe, it, expect } from 'vitest';
import {
  reconcileContainerSessions,
  issueKeyForContainer,
  containerSessionMatchesKey,
} from './session-discovery.js';
import type { Session } from '../types.js';

// reconcileContainerSessions only reads `.id`; a minimal stub is enough.
const sess = (id: string): Session => ({ id } as unknown as Session);

describe('reconcileContainerSessions', () => {
  it('surfaces a freshly-read container session and caches it by container name', () => {
    const cache = new Map<string, Session>();
    const out = reconcileContainerSessions(
      [{ containerName: 'jira-agent-proj-8995', session: sess('s1') }],
      new Set(['jira-agent-proj-8995']),
      true,
      cache,
      new Set(),
    );
    expect(out.map(s => s.id)).toEqual(['s1']);
    expect(cache.get('jira-agent-proj-8995')?.id).toBe('s1');
  });

  it('reuses the cached session when the read transiently fails but the container is still running', () => {
    // The "8995 disappeared while I was typing" bug: one docker exec times out,
    // but the container is alive — the card must not vanish.
    const cache = new Map<string, Session>([['c', sess('s1')]]);
    const out = reconcileContainerSessions(
      [{ containerName: 'c', session: null }],
      new Set(['c']),
      true,
      cache,
      new Set(),
    );
    expect(out.map(s => s.id)).toEqual(['s1']);
    expect(cache.get('c')?.id).toBe('s1');
  });

  it('replaces the cached session when a later read returns a different one', () => {
    const cache = new Map<string, Session>([['c', sess('old')]]);
    const out = reconcileContainerSessions(
      [{ containerName: 'c', session: sess('new') }],
      new Set(['c']),
      true,
      cache,
      new Set(),
    );
    expect(out.map(s => s.id)).toEqual(['new']);
    expect(cache.get('c')?.id).toBe('new');
  });

  it('evicts the cached session once the container is authoritatively gone', () => {
    const cache = new Map<string, Session>([['c', sess('s1')]]);
    const out = reconcileContainerSessions([], new Set(), true, cache, new Set());
    expect(out).toEqual([]);
    expect(cache.has('c')).toBe(false);
  });

  it('re-surfaces cached sessions during a non-authoritative docker outage', () => {
    // The "all docker sessions disappeared and came back" bug: when `docker ps`
    // fails long enough that its stale cache expires, the scan reports zero
    // running containers (freshReads empty, non-authoritative). We can't prove
    // any container stopped, so the cached cards must stay up — both retained in
    // the cache AND re-emitted this tick — instead of vanishing until docker
    // recovers.
    const cache = new Map<string, Session>([
      ['c1', sess('s1')],
      ['c2', sess('s2')],
    ]);
    const out = reconcileContainerSessions([], new Set(), false, cache, new Set());
    expect(out.map(s => s.id).sort()).toEqual(['s1', 's2']);
    expect(cache.has('c1')).toBe(true);
    expect(cache.has('c2')).toBe(true);
  });

  it('does not duplicate a cached outage session already present as a host session', () => {
    // Re-emitting cached sessions during an outage must still respect host-side
    // dedup, so a session surfaced from the filesystem scan isn't shown twice.
    const cache = new Map<string, Session>([['c', sess('dup')]]);
    const out = reconcileContainerSessions([], new Set(), false, cache, new Set(['dup']));
    expect(out).toEqual([]);
    expect(cache.has('c')).toBe(true);
  });

  it('does not surface a container session already present as a host session', () => {
    const cache = new Map<string, Session>();
    const out = reconcileContainerSessions(
      [{ containerName: 'c', session: sess('dup') }],
      new Set(['c']),
      true,
      cache,
      new Set(['dup']),
    );
    expect(out).toEqual([]);
  });
});

describe('issueKeyForContainer', () => {
  it('derives the upper-cased issue key from the container name', () => {
    expect(issueKeyForContainer('jira-agent-proj-9152', 'jira-agent-')).toBe('PROJ-9152');
  });

  it('returns empty string when the prefix is absent', () => {
    expect(issueKeyForContainer('some-other-container', 'jira-agent-')).toBe('');
  });
});

describe('containerSessionMatchesKey', () => {
  it('accepts a session whose first message references the container key', () => {
    expect(containerSessionMatchesKey('resolve PROJ-9152', 'PROJ-9152')).toBe(true);
  });

  it('accepts even when the key runs into the next word (no boundary)', () => {
    expect(
      containerSessionMatchesKey('resolve PROJ-9114check agent-comm messages', 'PROJ-9114'),
    ).toBe(true);
  });

  it('rejects an unrelated session surfaced via a shared ~/.claude bind mount', () => {
    // The "51 twice" bug: a live local session with no mention of the key must
    // not be attributed to jira-agent-proj-9151.
    expect(
      containerSessionMatchesKey('I have updated /pending-prs and deployed', 'PROJ-9151'),
    ).toBe(false);
  });

  it('rejects when there is no first message or no container key', () => {
    expect(containerSessionMatchesKey(null, 'PROJ-1')).toBe(false);
    expect(containerSessionMatchesKey('resolve PROJ-1', '')).toBe(false);
  });
});
