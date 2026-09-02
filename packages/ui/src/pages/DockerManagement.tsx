import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchDockerContainers,
  fetchWorkItems,
  removeDockerContainer,
  type ManagedContainer,
  type WorkItem,
} from '../lib/api';
import { WorkItemBadge } from '../components/WorkItemBadge';
import {
  containersWithFinishedWork,
  filterContainers,
  timeAgo,
  vmRemovalWarning,
  type ContainerFilters,
} from '../lib/utils';

type StateFilter = ContainerFilters['state'];
type LocationFilter = ContainerFilters['location'];

const LOCATION_LABELS: Record<LocationFilter, string> = {
  all: 'Everywhere',
  local: 'This machine',
  vm: 'Agent VM',
};

/**
 * Jira column for one container: the issue key linking out to Jira (plain text
 * when Jira isn't configured, so the key stays readable) plus its live status
 * once fetched.
 */
function WorkItemCell({
  issueKey,
  item,
}: {
  issueKey: string | null;
  item?: WorkItem;
}) {
  if (!issueKey) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="flex items-center gap-1.5">
      {/* Only the tracker knows its own URL format, so the link is whatever it
          returned — and absent when there is no tracker. */}
      {item?.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          title="Open in the tracker"
          className="font-medium text-primary hover:underline whitespace-nowrap"
        >
          {issueKey} &#8599;
        </a>
      ) : (
        <span className="font-medium whitespace-nowrap">{issueKey}</span>
      )}
      {item && <WorkItemBadge item={item} />}
    </div>
  );
}

export function DockerManagement() {
  const [containers, setContainers] = useState<ManagedContainer[]>([]);
  const [workItems, setWorkItems] = useState<Record<string, WorkItem>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [locationFilter, setLocationFilter] = useState<LocationFilter>('all');
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = async () => {
    setRefreshing(true);
    try {
      const list = await fetchDockerContainers();
      setContainers(list);
      setError(null);

      // Fetch tracker state in the background — don't block (or fail) the
      // container list on a slow or absent tracker. The server caches per tag,
      // so refreshing repeatedly is cheap.
      const tags = [...new Set(list.map((c) => c.issueKey).filter((k): k is string => !!k))];
      fetchWorkItems(tags)
        .then((res) => setWorkItems(res.items))
        .catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    return filterContainers(containers, {
      state: stateFilter,
      location: locationFilter,
      hiddenOnly,
    }).sort((a, b) => new Date(a.createdAtIso).getTime() - new Date(b.createdAtIso).getTime());
  }, [containers, stateFilter, locationFilter, hiddenOnly]);

  const doneTargets = useMemo(
    () => containersWithFinishedWork(containers, workItems),
    [containers, workItems],
  );

  const handleRemove = async (c: ManagedContainer) => {
    const isRunning = c.state === 'running';
    const msg = isRunning
      ? `Force-remove RUNNING container ${c.name}? This stops and deletes it.`
      : `Remove container ${c.name}?`;
    if (!confirm(msg + vmRemovalWarning([c]))) return;
    setBusy(c.id);
    try {
      await removeDockerContainer(c.name, isRunning, c.location);
      // Optimistic: drop from local state instead of reloading (a full reload
      // hits `docker ps -a` again which is slow).
      setContainers((prev) => prev.filter((x) => x.id !== c.id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'remove failed');
    } finally {
      setBusy(null);
    }
  };

  const handleCloseDone = async () => {
    const targets = doneTargets;
    if (targets.length === 0) return;
    const runningCount = targets.filter((c) => c.state === 'running').length;
    const names = targets.map((c) => c.name).join('\n');
    const warning =
      (runningCount > 0
        ? `\n\nWARNING: ${runningCount} of these are RUNNING and will be force-stopped.`
        : '') + vmRemovalWarning(targets);
    if (
      !confirm(
        `Close ${targets.length} container${targets.length === 1 ? '' : 's'} whose Jira issue is Done?\n\n${names}${warning}`,
      )
    )
      return;

    setProgress({ done: 0, total: targets.length });
    const failed: Array<{ name: string; error: string }> = [];
    for (let i = 0; i < targets.length; i++) {
      const c = targets[i];
      try {
        await removeDockerContainer(c.name, c.state === 'running', c.location);
        setContainers((prev) => prev.filter((x) => x.id !== c.id));
      } catch (err) {
        failed.push({
          name: c.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      setProgress({ done: i + 1, total: targets.length });
    }
    setProgress(null);
    if (failed.length) {
      alert(`Failed:\n${failed.map((f) => `  ${f.name}: ${f.error}`).join('\n')}`);
    }
  };

  // Selection is keyed by container id rather than name: the same agent can run
  // locally and on the VM under the identical name, and ticking one row must
  // never queue the other for removal.
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allFilteredIds = filtered.map((c) => c.id);
    const allSelected = allFilteredIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of allFilteredIds) next.delete(id);
      } else {
        for (const id of allFilteredIds) next.add(id);
      }
      return next;
    });
  };

  const handleRemoveSelected = async () => {
    const targets = filtered.filter((c) => selected.has(c.id));
    if (targets.length === 0) return;
    const runningCount = targets.filter((c) => c.state === 'running').length;
    const names = targets.map((c) => c.name).join('\n');
    const warning = (runningCount > 0
      ? `\n\nWARNING: ${runningCount} of these are RUNNING and will be force-stopped.`
      : '') + vmRemovalWarning(targets);
    if (!confirm(`Remove ${targets.length} containers?\n\n${names}${warning}`)) return;

    setProgress({ done: 0, total: targets.length });
    const failed: Array<{ name: string; error: string }> = [];
    for (let i = 0; i < targets.length; i++) {
      const c = targets[i];
      try {
        await removeDockerContainer(c.name, c.state === 'running', c.location);
        setContainers((prev) => prev.filter((x) => x.id !== c.id));
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(c.id);
          return next;
        });
      } catch (err) {
        failed.push({
          name: c.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      setProgress({ done: i + 1, total: targets.length });
    }
    setProgress(null);
    if (failed.length) {
      alert(`Failed:\n${failed.map((f) => `  ${f.name}: ${f.error}`).join('\n')}`);
    }
  };

  const totals = useMemo(() => {
    const running = containers.filter((c) => c.state === 'running').length;
    const exited = containers.filter((c) => c.state === 'exited').length;
    const hidden = containers.filter((c) => c.hiddenInApp).length;
    const onVm = containers.filter((c) => c.location === 'vm').length;
    return { running, exited, hidden, onVm, total: containers.length };
  }, [containers]);

  return (
    <div className="max-w-5xl mx-auto p-3 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Overview
          </Link>
          <h1 className="text-xl sm:text-2xl font-bold">Docker Containers</h1>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{totals.total} total</span>
          <span>{totals.running} running</span>
          <span>{totals.exited} exited</span>
          <span>{totals.hidden} hidden</span>
          <span>{totals.onVm} on VM</span>
        </div>
      </div>

      <div className="rounded-md border border-border bg-muted/30 p-3 mb-4 flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-medium">Close done</span>
          <span className="text-xs text-muted-foreground">
            Containers whose Jira issue is Done
          </span>
          <span className="text-xs text-muted-foreground">
            → {doneTargets.length} match
            {doneTargets.length === 1 ? '' : 'es'}
          </span>
          <button
            onClick={handleCloseDone}
            disabled={!!progress || doneTargets.length === 0}
            className="ml-auto px-3 py-1 rounded-md text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {progress
              ? `Closing ${progress.done}/${progress.total}...`
              : `Close ${doneTargets.length}`}
          </button>
        </div>
        {progress && (
          <div className="h-1 bg-muted rounded overflow-hidden">
            <div
              className="h-full bg-red-600 transition-all"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {(['all', 'running', 'exited'] as StateFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setStateFilter(f)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              stateFilter === f
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <span className="text-border select-none">|</span>
        {(['all', 'local', 'vm'] as LocationFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setLocationFilter(f)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              locationFilter === f
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {LOCATION_LABELS[f]}
          </button>
        ))}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none sm:ml-2">
          <input
            type="checkbox"
            checked={hiddenOnly}
            onChange={(e) => setHiddenOnly(e.target.checked)}
            className="rounded border-border"
          />
          Hidden in app only
        </label>
        {selected.size > 0 && (
          <button
            onClick={handleRemoveSelected}
            disabled={!!progress}
            className="px-3 py-1 rounded-md text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
          >
            {progress ? `Removing ${progress.done}/${progress.total}...` : `Remove selected (${selected.size})`}
          </button>
        )}
        <button
          onClick={load}
          disabled={refreshing}
          className="ml-auto px-3 py-1 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing... (docker ps is slow)' : 'Refresh'}
        </button>
      </div>

      {loading && (
        <div className="text-sm text-muted-foreground border border-border rounded-lg p-8 text-center">
          Loading containers... <span className="text-xs">(docker ps -a takes a few seconds)</span>
        </div>
      )}
      {error && (
        <div className="text-sm text-red-400 bg-red-950/20 border border-red-800 rounded-md p-3">
          {error}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-sm text-muted-foreground border border-border rounded-lg p-8 text-center">
          No containers match the current filters.
          {locationFilter === 'vm' && (
            <div className="mt-2 text-xs">
              VM rows come from the background VM scan — none appear while the VM is
              down or VM support is off.
            </div>
          )}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="border border-border rounded-md overflow-x-auto">
          <table className="w-full min-w-[840px] text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every((c) => selected.has(c.id))}
                    ref={(el) => {
                      if (!el) return;
                      const selectedCount = filtered.filter((c) => selected.has(c.id)).length;
                      el.indeterminate = selectedCount > 0 && selectedCount < filtered.length;
                    }}
                    onChange={toggleSelectAll}
                    className="rounded border-border"
                  />
                </th>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Where</th>
                <th className="text-left px-3 py-2 font-medium">Jira</th>
                <th className="text-left px-3 py-2 font-medium">State</th>
                <th className="text-left px-3 py-2 font-medium">Age</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">In app</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-t border-border hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggleSelect(c.id)}
                      className="rounded border-border"
                    />
                  </td>
                  <td className="px-3 py-2 font-mono">{c.name}</td>
                  <td className="px-3 py-2">
                    {c.location === 'vm' ? (
                      <span className="px-1.5 py-0.5 rounded bg-blue-950/40 text-blue-300 border border-blue-900">
                        VM
                      </span>
                    ) : (
                      <span className="text-muted-foreground">local</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <WorkItemCell
                      issueKey={c.issueKey}
                      item={c.issueKey ? workItems[c.issueKey] : undefined}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full mr-1.5 ${
                        c.state === 'running' ? 'bg-green-500' : c.state === 'paused' ? 'bg-yellow-500' : 'bg-gray-500'
                      }`}
                    />
                    {c.state}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground" title={c.createdAt}>
                    {c.location === 'vm' ? c.createdAt : `${c.ageDays}d (${timeAgo(c.createdAtIso)})`}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{c.status}</td>
                  <td className="px-3 py-2">
                    {c.hiddenInApp ? (
                      <span className="text-muted-foreground">hidden</span>
                    ) : (
                      <span className="text-green-400">visible</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => handleRemove(c)}
                      disabled={busy === c.id}
                      className="px-2 py-0.5 rounded text-xs bg-muted hover:bg-red-900/30 hover:text-red-400 disabled:opacity-50"
                    >
                      {busy === c.id ? '...' : c.state === 'running' ? 'Force remove' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
