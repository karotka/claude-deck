import type { Session } from '../types.js';
import type { SessionProvider, SessionTransport, TargetRef } from './types.js';

const providers = new Map<string, SessionProvider>();
const transports = new Map<string, SessionTransport>();

/**
 * Registration is explicit and happens once at startup (see ./index.ts), rather
 * than by module side effect at import time. Import-time registration would
 * make the set of active providers depend on which modules happened to be
 * pulled in, which is exactly the coupling this layer exists to remove — and
 * would leave tests unable to run against a known-empty registry.
 */
export function registerProvider(provider: SessionProvider): void {
  providers.set(provider.id, provider);
}

export function registerTransport(transport: SessionTransport): void {
  transports.set(transport.kind, transport);
}

export function getProviders(): SessionProvider[] {
  return Array.from(providers.values());
}

export function getProvider(id: string): SessionProvider | undefined {
  return providers.get(id);
}

/** Providers awaited inline on each tick of the main discovery loop. */
export function inlineProviders(): SessionProvider[] {
  return getProviders().filter(p => p.scanIntervalMs === undefined);
}

/** Providers that run their own loop and are merged from cache. */
export function backgroundProviders(): SessionProvider[] {
  return getProviders().filter(p => p.scanIntervalMs !== undefined);
}

/** The transport that can drive this session, or undefined if observe-only. */
export function transportFor(session: Session): SessionTransport | undefined {
  const kind = session.target?.kind;
  return kind ? transports.get(kind) : undefined;
}

export function getTransport(kind: string): SessionTransport | undefined {
  return transports.get(kind);
}

export function getTransports(): SessionTransport[] {
  return Array.from(transports.values());
}

/** A session is interactive when something registered can drive it. */
export function isInteractive(session: Session): boolean {
  return transportFor(session) !== undefined;
}

export function target(kind: string, ref: string, label?: string): TargetRef {
  return label === undefined ? { kind, ref } : { kind, ref, label };
}

/** Test seam: drop every registration. */
export function resetRegistry(): void {
  providers.clear();
  transports.clear();
}
