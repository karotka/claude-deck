import { useEffect, useState } from 'react';
import { fetchAppConfig, type AppConfig } from '../lib/api';

/**
 * The server's self-description, fetched once per page load and shared.
 *
 * It only changes when the server restarts, and several unrelated components
 * need it (which features exist, what to prefill, how fast to poll a given
 * transport), so a module-level promise keeps that to one request rather than
 * one per mount. A failed fetch resolves to null and every caller falls back to
 * its own default — the dashboard still works without it.
 */
let pending: Promise<AppConfig | null> | null = null;

function load(): Promise<AppConfig | null> {
  pending ??= fetchAppConfig().catch(() => null);
  return pending;
}

export function useAppConfig(): AppConfig | null {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    let alive = true;
    load().then(c => { if (alive) setConfig(c); });
    return () => { alive = false; };
  }, []);
  return config;
}

/**
 * How often to poll the terminal for a session, in ms — the transport's own
 * answer, or undefined to let the terminal panel use its default. This is why
 * the UI no longer has to know that one particular backend is cheap to read.
 */
export function capturePollMs(
  config: AppConfig | null,
  targetKind: string | undefined,
): number | undefined {
  if (!config || !targetKind) return undefined;
  return config.transports[targetKind]?.pollIntervalMs;
}
