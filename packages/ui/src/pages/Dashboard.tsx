import { useState, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useSessions } from '../hooks/useSessions';
import { SessionCard } from '../components/SessionCard';
import { StartDevelopmentDialog } from '../components/StartDevelopmentDialog';
import { NewSessionDialog } from '../components/NewSessionDialog';
import { fetchWorkItems, type WorkItem } from '../lib/api';
import { formatTokens, formatCost } from '../lib/utils';

/**
 * 'live' is not a status but a proof: the server holds an open socket for the
 * session. It sits beside the statuses because that is how it reads to a
 * person — "show me only what is actually running" — and because 'running' on
 * its own is derived from a process table that keeps month-old sessions in it.
 */
type StatusFilter = 'all' | 'live' | 'running' | 'idle' | 'stopped';

export function Dashboard() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [recent, setRecent] = useState(true);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [startDevOpen, setStartDevOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [workItems, setWorkItems] = useState<Record<string, WorkItem>>({});
  const { sessions, stats, loading, error, refresh } = useSessions(showHidden, recent);

  // Every distinct tag on the board, so one request covers the whole page.
  // Joined into a string so the effect below re-runs when the *set* changes
  // rather than on every poll that rebuilds an equal array.
  const tagSignature = useMemo(() => {
    const keys = new Set<string>();
    for (const s of sessions) {
      if (s.tag) keys.add(s.tag);
    }
    return [...keys].sort().join(',');
  }, [sessions]);

  // Refresh the tracker's view when the set of tags changes, and on an
  // interval. The server caches per tag, so this stays cheap — and returns
  // `enabled: false` with no items when no tracker is configured, which is
  // simply an empty map here.
  useEffect(() => {
    if (!tagSignature) {
      setWorkItems({});
      return;
    }
    const tags = tagSignature.split(',');
    let cancelled = false;
    const run = () =>
      fetchWorkItems(tags)
        .then((res) => {
          if (!cancelled) setWorkItems(res.items);
        })
        .catch(() => {});
    run();
    const id = setInterval(run, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tagSignature]);


  const filtered = useMemo(() => {
    let result =
      statusFilter === 'all'
        ? sessions
        : statusFilter === 'live'
          ? sessions.filter(s => s.live)
          : sessions.filter(s => s.status === statusFilter);

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(s =>
        s.sessionName?.toLowerCase().includes(q) ||
        s.projectPath.toLowerCase().includes(q) ||
        s.gitBranch?.toLowerCase().includes(q) ||
        s.firstUserMessage?.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.model?.toLowerCase().includes(q) ||
        s.target?.ref.toLowerCase().includes(q) ||
        s.target?.label?.toLowerCase().includes(q) ||
        s.tag?.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q) ||
        s.cwd?.toLowerCase().includes(q),
      );
    }

    const statusOrder: Record<string, number> = { running: 0, idle: 1, stopped: 2 };
    return result.sort((a, b) =>
      (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) ||
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
  }, [sessions, statusFilter, search]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-2xl font-bold">Claude Deck</h1>
          <Link to="/workflow" className="text-sm text-muted-foreground hover:text-foreground">
            Jira Issues
          </Link>
          <Link to="/docker" className="text-sm text-muted-foreground hover:text-foreground">
            Docker
          </Link>
          <button
            onClick={() => setStartDevOpen(true)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Start Development
          </button>
          <button
            onClick={() => setNewSessionOpen(true)}
            className="px-2.5 py-1 rounded-md text-xs font-medium bg-green-600 text-white hover:bg-green-700"
          >
            + New Session
          </button>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {stats && (
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>{stats.totalSessions} sessions</span>
              <span>{stats.runningSessions} running</span>
              <span>{formatTokens(stats.totalInputTokens + stats.totalOutputTokens)} tokens</span>
              <span>~{formatCost(stats.totalCost)}</span>
            </div>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80 transition-colors disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {(['all', 'live', 'running', 'idle', 'stopped'] as StatusFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              statusFilter === f
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search sessions..."
          // text-base below sm keeps iOS from zooming the page on focus.
          className="order-last sm:order-none basis-full sm:basis-auto sm:ml-2 flex-1 bg-muted border border-border rounded-md px-3 py-1.5 sm:py-1 text-base sm:text-xs focus:outline-none focus:border-primary"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={recent}
            onChange={e => setRecent(e.target.checked)}
            className="rounded border-border"
          />
          Recent
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={e => setShowHidden(e.target.checked)}
            className="rounded border-border"
          />
          Show hidden
        </label>
      </div>

      {loading && (
        <div className="text-sm text-muted-foreground">Loading sessions...</div>
      )}

      {error && (
        <div className="text-sm text-red-400 bg-red-950/20 border border-red-800 rounded-md p-3">
          {error}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-sm text-muted-foreground border border-border rounded-lg p-8 text-center">
          {search ? 'No sessions match your search.' : 'No sessions found. Claude sessions will appear here when active.'}
        </div>
      )}

      <div className="space-y-3">
        {filtered.map(session => {
          const key = session.tag;
          return (
            <SessionCard
              key={session.id}
              session={session}
              workItem={key ? workItems[key] : undefined}
              onToggleHide={refresh}
            />
          );
        })}
      </div>

      <StartDevelopmentDialog
        open={startDevOpen}
        onClose={() => setStartDevOpen(false)}
        onStarted={() => { refresh(); }}
      />

      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        onLaunched={() => { refresh(); }}
      />
    </div>
  );
}
