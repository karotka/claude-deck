import { useState, useEffect, useCallback } from 'react';
import { fetchSessions, fetchStats, type Session, type Stats } from '../lib/api';

export function useSessions(showHidden = false, recent = true, pollIntervalMs = 5000) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        fetchSessions({ showHidden, recent }),
        fetchStats(),
      ]);
      setSessions(s);
      setStats(st);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
    } finally {
      setLoading(false);
    }
  }, [showHidden, recent]);

  useEffect(() => {
    refresh();
    // Skip polling when showing all sessions — the full filesystem scan is
    // expensive. User can use the Refresh button.
    if (!recent) return;
    const id = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(id);
  }, [refresh, pollIntervalMs, recent]);

  return { sessions, stats, loading, error, refresh };
}
