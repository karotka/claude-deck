import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { WorkflowProgress } from '../components/WorkflowProgress';
import { fetchArtifacts, type WorkItemArtifacts } from '../lib/api';
import { cn } from '../lib/utils';

const REFRESH_MS = 10_000;

/**
 * Progress for every item that has an artifact directory.
 *
 * The whole page is driven by the workflow declared in the config file: how
 * many phases there are, what they are called and what marks each one done. It
 * used to know one team's six phases and four per-repo files by name.
 */
export function WorkflowOverview() {
  const [items, setItems] = useState<WorkItemArtifacts[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetchArtifacts();
      setEnabled(res.enabled);
      setItems(res.items);
    } catch { /* keep whatever is on screen */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const toggleExpand = (tag: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            &larr; Dashboard
          </Link>
          <h1 className="text-xl sm:text-2xl font-bold">Workflow</h1>
        </div>
        <span className="text-sm text-muted-foreground">
          {items.length} item{items.length !== 1 ? 's' : ''}
        </span>
      </div>

      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {/* "Not configured" and "configured but nothing has run" look identical
          from an empty list, and the fix is different for each. */}
      {!loading && !enabled && (
        <div className="text-sm text-muted-foreground border border-border rounded-lg p-8 text-center">
          No workflow is configured. Set <code>SESSIONS_DIR</code> to the directory your
          agent workflow writes artifacts into, and describe its phases under{' '}
          <code>workflow</code> in <code>claude-deck.config.json</code>. See{' '}
          <code>examples/claude-deck.config.json</code> for a worked example.
        </div>
      )}

      {!loading && enabled && items.length === 0 && (
        <div className="text-sm text-muted-foreground border border-border rounded-lg p-8 text-center">
          Nothing in the artifacts directory yet.
        </div>
      )}

      <div className="space-y-2">
        {items.map(item => {
          const total = item.phases.length;
          const shipped = item.groups.filter(g => Object.values(g.signals).every(Boolean)).length;
          const progress = total > 1 ? item.phase / (total - 1) : 1;
          return (
            <div key={item.tag} className="rounded-lg border border-border bg-card p-4">
              <button
                onClick={() => toggleExpand(item.tag)}
                className="w-full text-left flex flex-wrap items-center gap-x-3 gap-y-1"
              >
                <span className={cn(
                  'inline-block h-2 w-2 rounded-full shrink-0',
                  progress >= 1 ? 'bg-green-500' : progress >= 0.5 ? 'bg-blue-500' : 'bg-yellow-500',
                )} />
                <span className="font-semibold">{item.tag}</span>
                <span className="text-sm text-muted-foreground">
                  Phase {item.phase + 1}/{total} — {item.phaseLabel}
                </span>
                {item.groups.length > 0 && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    {shipped}/{item.groups.length} complete
                  </span>
                )}
              </button>

              {expanded.has(item.tag) && (
                <div className="mt-3 pl-5 border-t border-border pt-3">
                  <WorkflowProgress
                    phases={item.phases}
                    currentPhase={item.phase}
                    groups={item.groups}
                    groupNoun={item.groupNoun}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
