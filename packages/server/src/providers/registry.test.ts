import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider,
  registerTransport,
  transportFor,
  isInteractive,
  inlineProviders,
  backgroundProviders,
  getTransports,
  resetRegistry,
  target,
} from './registry.js';
import type { Session } from '../types.js';
import type { SessionProvider, SessionTransport } from './types.js';

function session(overrides: Partial<Session> = {}): Session {
  return { id: 's1', source: 'local', ...overrides } as Session;
}

function transport(kind: string, extra: Partial<SessionTransport> = {}): SessionTransport {
  return {
    kind,
    capture: async () => '',
    send: async () => null,
    sendKey: async () => null,
    ...extra,
  };
}

function provider(id: string, extra: Partial<SessionProvider> = {}): SessionProvider {
  return { id, discover: async () => [], ...extra };
}

beforeEach(resetRegistry);

describe('transportFor', () => {
  it('resolves a session by its target kind', () => {
    const docker = transport('docker');
    registerTransport(docker);
    expect(transportFor(session({ target: target('docker', 'agent-1') }))).toBe(docker);
  });

  it('drives a target kind registered after this file was written', () => {
    // The whole point of the registry: a backend added later needs no change
    // here, in the routes, or in the Session type.
    const nomad = transport('nomad');
    registerTransport(nomad);
    expect(isInteractive(session({ target: target('nomad', 'alloc-77') }))).toBe(true);
  });

  it('reports a session with no target as observe-only', () => {
    expect(transportFor(session())).toBeUndefined();
    expect(isInteractive(session())).toBe(false);
  });

  it('reports a target whose transport this installation lacks as observe-only', () => {
    // DOCKER_ENABLED=false leaves stale targets on cached sessions; they must
    // read as observe-only rather than dispatching into nothing.
    expect(isInteractive(session({ target: target('docker', 'agent-1') }))).toBe(false);
  });
});

describe('provider cadence', () => {
  it('separates providers that ride the main loop from those with their own', () => {
    registerProvider(provider('local'));
    registerProvider(provider('remote', { scanIntervalMs: 30_000 }));

    expect(inlineProviders().map(p => p.id)).toEqual(['local']);
    expect(backgroundProviders().map(p => p.id)).toEqual(['remote']);
  });
});

describe('getTransports', () => {
  it('exposes each transport once, for /api/config to publish', () => {
    registerTransport(transport('tmux'));
    registerTransport(transport('remote', { pollIntervalMs: 500 }));

    expect(getTransports().map(t => [t.kind, t.pollIntervalMs])).toEqual([
      ['tmux', undefined],
      ['remote', 500],
    ]);
  });
});

describe('target', () => {
  it('omits the label rather than storing undefined, so payloads stay clean', () => {
    expect(target('tmux', 'cm-1')).toEqual({ kind: 'tmux', ref: 'cm-1' });
    expect(target('remote', 'PROJ-1', 'agent-proj-1'))
      .toEqual({ kind: 'remote', ref: 'PROJ-1', label: 'agent-proj-1' });
  });
});
