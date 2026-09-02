import { config } from '../config.js';
import { discoverLocalSessions } from '../services/session-discovery.js';
import {
  getVmSessions,
  startVmDiscoveryLoop,
  stopVmDiscoveryLoop,
} from '../services/vm-discovery.js';
import { registerProvider, registerTransport } from './registry.js';
import { registerTracker } from '../trackers/registry.js';
import { jiraTracker } from '../trackers/jira.js';
import { dockerTransport, remoteTransport, tmuxTransport } from './transports.js';
import type { SessionProvider } from './types.js';

/**
 * Sessions on this machine: transcripts under CLAUDE_DIR, the processes running
 * them, the tmux sessions they can be driven through, and — when Docker is
 * enabled — the agent containers here.
 *
 * Docker is inside this provider rather than beside it because the two scans
 * are one algorithm, not two: the container list decides which older workspace
 * transcripts the filesystem scan may admit, and the transcripts decide which
 * container each card belongs to. Splitting them would mean passing that state
 * between providers, which is worse than keeping the local host as one unit.
 */
const localProvider: SessionProvider = {
  id: 'local',
  label: 'This machine',
  discover: opts => discoverLocalSessions(opts),
};

/**
 * Sessions in containers on another host, reached through the user's own
 * script.
 *
 * Runs its own loop because each of its reads is a tunnel round trip that can
 * hang: `discover()` here returns whatever that loop last produced, so an
 * unreachable host costs the main scan nothing.
 */
const remoteProvider: SessionProvider = {
  id: 'remote',
  label: 'Remote host',
  scanIntervalMs: config.vmScanIntervalMs,
  start: startVmDiscoveryLoop,
  stop: stopVmDiscoveryLoop,
  discover: async () => getVmSessions(),
};

/**
 * Register what this installation actually has.
 *
 * Called once from the server entry point rather than by import side effect: a
 * registry populated by whichever modules happened to be imported is exactly
 * the implicit coupling this layer removes, and it would leave tests unable to
 * start from an empty registry.
 */
export function registerBuiltins(): void {
  registerProvider(localProvider);
  if (config.vmEnabled) registerProvider(remoteProvider);

  // Transports are registered independently of providers: a session found by
  // one provider can perfectly well be driven by another's transport, and the
  // local provider emits sessions of two different kinds.
  if (config.tmuxEnabled) registerTransport(tmuxTransport);
  if (config.dockerEnabled) registerTransport(dockerTransport);
  if (config.vmEnabled) registerTransport(remoteTransport);

  // The tracker is registered unconditionally and reports itself unconfigured
  // when there are no credentials — they can appear while the server runs (an
  // MCP entry added to ~/.claude.json), so this is not a startup decision.
  registerTracker(jiraTracker);
}
