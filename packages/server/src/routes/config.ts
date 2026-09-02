import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getTransports } from '../providers/registry.js';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';

/**
 * The slice of server configuration the UI needs to render itself: what to
 * prefill, and which features this installation actually has. Everything here
 * is non-sensitive — no paths, no credentials — so it is safe to hand to the
 * browser.
 */
export interface AppConfig {
  /** Prefilled in the launch dialog's input, e.g. 'PROJ-'. May be empty. */
  tagPrefix: string;
  /**
   * Regular expression source matching one tag. Published because the launch
   * dialog parses a pasted batch client-side, and a second opinion about what a
   * tag looks like is exactly the duplication this refactor removes.
   */
  tagPattern: string;
  /** False when DOCKER_ENABLED=false — agent containers aren't scanned at all. */
  dockerEnabled: boolean;
  /**
   * Per-transport UI hints, keyed by TargetRef.kind — currently how fast to
   * poll the terminal panel. Published so a transport declares its own cadence
   * instead of the UI carrying a table of which source names are cheap to read;
   * a transport this installation doesn't have simply isn't in the map.
   */
  transports: Record<string, { pollIntervalMs?: number }>;
  /**
   * Largest file the terminal will accept on a drop or paste. Published so the
   * browser can refuse an oversized file with an explanation instead of sending
   * a body the server drops at the transport layer, which surfaces as a reset
   * connection and no message at all.
   */
  maxAttachmentBytes: number;
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config', async (): Promise<AppConfig> => ({
    tagPrefix: config.tagPrefix,
    tagPattern: config.tagPattern,
    dockerEnabled: config.dockerEnabled,
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    transports: Object.fromEntries(
      getTransports().map(t => [t.kind, { pollIntervalMs: t.pollIntervalMs }]),
    ),
  }));
}
