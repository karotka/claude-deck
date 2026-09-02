import { useState, useEffect, useRef } from 'react';
import {
  startLaunch,
  fetchLaunchStatus,
  fetchLaunchers,
  fetchVmStatus,
  fetchAppConfig,
  type LaunchResult,
  type LaunchStatus,
  type Launcher,
  type VmStatus,
} from '../lib/api';
import { parseTags } from '../lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  onStarted?: (results: LaunchResult[]) => void;
}

const POLL_MS = 1500;
// Shown when no TAG_PREFIX is configured — an example, not a default.
const EXAMPLE_KEY = 'PROJ-1234';

/** One entry per tag we attempted to launch. */
type LaunchOutcome =
  | { status: 'ok'; result: LaunchResult }
  | { status: 'error'; tag: string; error: string };

/** Merge already-committed chips with freshly parsed keys, keeping order & uniqueness. */
function mergeKeys(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing);
  const merged = [...existing];
  for (const key of incoming) {
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(key);
    }
  }
  return merged;
}

export function StartDevelopmentDialog({ open, onClose, onStarted }: Props) {
  const [keys, setKeys] = useState<string[]>([]);
  // Prefilled from the server's TAG_PREFIX, so the project everyone here works
  // in is one keystroke away without being baked into the build.
  const [prefix, setPrefix] = useState('');
  // What counts as a tag is the server's call; see parseTags.
  const [tagPattern, setTagPattern] = useState<string>();
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<LaunchOutcome[] | null>(null);
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  // Always the first launcher on open, never the last one used: a remote
  // launcher boots a shared machine, so choosing it should be a deliberate act
  // each time rather than something inherited from an earlier session.
  const [launcherId, setLauncherId] = useState<string | null>(null);
  const [vm, setVm] = useState<VmStatus | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const launcher = launchers.find(l => l.id === launcherId) ?? null;

  const reset = () => {
    setKeys([]);
    setDraft(prefix);
    setError(null);
    setOutcomes(null);
    setSubmitting(false);
  };

  useEffect(() => {
    if (open) {
      reset();
      fetchVmStatus().then(setVm).catch(() => setVm(null));
      fetchLaunchers()
        .then((list) => {
          setLaunchers(list);
          setLauncherId(list[0]?.id ?? null);
        })
        .catch(() => setLaunchers([]));
      fetchAppConfig()
        .then((cfg) => {
          setPrefix(cfg.tagPrefix);
          setTagPattern(cfg.tagPattern);
          // Only prefill an untouched field: the fetch can land after the user
          // has started typing.
          setDraft((d) => (d === '' ? cfg.tagPrefix : d));
        })
        .catch(() => {});
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      }, 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Move any complete keys in the draft into the chip list, keeping the
  // configured prefix in the input to type the next key against.
  const commitDraft = (): string[] => {
    const parsed = parseTags(draft, tagPattern);
    if (parsed.length === 0) return keys;
    const merged = mergeKeys(keys, parsed);
    setKeys(merged);
    setDraft(prefix);
    return merged;
  };

  const removeKey = (key: string) => setKeys((prev) => prev.filter((k) => k !== key));

  const handleDraftKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && draft === '' && keys.length > 0) {
      setKeys((prev) => prev.slice(0, -1));
    }
  };

  const handleStart = async () => {
    const allKeys = mergeKeys(keys, parseTags(draft, tagPattern));
    if (allKeys.length === 0) {
      setError(`Enter at least one key (e.g. ${prefix || EXAMPLE_KEY}).`);
      return;
    }
    if (!launcher) {
      setError('No launcher is configured on this server.');
      return;
    }
    setKeys(allKeys);
    setDraft('');
    setSubmitting(true);
    setError(null);

    const settled = await Promise.allSettled(
      allKeys.map((k) => startLaunch(k, launcher.id)),
    );
    const next: LaunchOutcome[] = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? { status: 'ok', result: s.value }
        : {
            status: 'error',
            tag: allKeys[i],
            error: s.reason instanceof Error ? s.reason.message : 'start failed',
          },
    );

    setOutcomes(next);
    setSubmitting(false);

    const started = next
      .filter((o): o is Extract<LaunchOutcome, { status: 'ok' }> => o.status === 'ok')
      .map((o) => o.result);
    if (started.length > 0) onStarted?.(started);
  };

  const pendingCount = mergeKeys(keys, parseTags(draft, tagPattern)).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-lg shadow-xl w-full max-w-2xl p-5 mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Start Development</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            ✕
          </button>
        </div>

        {!outcomes ? (
          <div className="space-y-4 overflow-y-auto">
            <div>
              <label htmlFor="issueKey" className="block text-xs font-medium mb-1.5">
                {launcher?.inputLabel ? `${launcher.inputLabel}s` : 'Keys'}
              </label>
              <div
                className="w-full bg-muted border border-border rounded-md px-2 py-1.5 flex flex-wrap items-center gap-1.5 focus-within:border-primary"
                onClick={() => inputRef.current?.focus()}
              >
                {keys.map((key) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 bg-background border border-border rounded px-1.5 py-0.5 text-xs font-mono"
                  >
                    {key}
                    <button
                      type="button"
                      onClick={() => removeKey(key)}
                      disabled={submitting}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                      aria-label={`Remove ${key}`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <input
                  ref={inputRef}
                  id="issueKey"
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={handleDraftKeyDown}
                  onBlur={commitDraft}
                  placeholder={
                    keys.length === 0 ? `e.g. ${prefix ? `${prefix}1234` : EXAMPLE_KEY}` : 'add another…'
                  }
                  disabled={submitting}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1 min-w-[8rem] bg-transparent px-1 py-0.5 text-sm font-mono focus:outline-none disabled:opacity-50"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Add several keys with Enter, comma, or by pasting a list. Each runs
                the selected launcher's command in its own detached tmux session.
              </p>
            </div>

            <LauncherPicker
              launchers={launchers}
              selectedId={launcherId}
              onSelect={setLauncherId}
              disabled={submitting}
              vm={vm}
            />

            {error && (
              <div className="text-xs text-red-400 bg-red-950/20 border border-red-800 rounded-md p-2">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleStart}
                disabled={submitting || pendingCount === 0}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting
                  ? 'Starting…'
                  : pendingCount > 1
                    ? `Start ${pendingCount}`
                    : 'Start'}
              </button>
            </div>
          </div>
        ) : (
          <LaunchList outcomes={outcomes} onStartMore={reset} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

/**
 * Which launcher to run. One radio per entry the server declared — this
 * component knows none of them by name, so an installation that adds a third
 * way to start work gets a third option here with no change.
 *
 * A remote launcher also carries the state of the machine it targets, and what
 * choosing it costs: a shared host that is asleep takes minutes to boot, which
 * is worth knowing before the click rather than after.
 */
function LauncherPicker({
  launchers,
  selectedId,
  onSelect,
  disabled,
  vm,
}: {
  launchers: Launcher[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled: boolean;
  vm: VmStatus | null;
}) {
  if (launchers.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
        No launchers are configured. Add a <span className="font-mono">launchers</span> entry
        to <span className="font-mono">claude-deck.config.json</span> (see{' '}
        <span className="font-mono">examples/</span>), or set{' '}
        <span className="font-mono">JIRA_RESOLVE_SCRIPT</span>.
      </div>
    );
  }

  // A single launcher is not a choice; showing one radio button would be noise.
  if (launchers.length === 1) return null;

  const asleep = vm !== null && vm.enabled && vm.state !== 'RUNNING';

  return (
    <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-2">
      {launchers.map((l) => {
        const unavailable = l.remote && vm !== null && !vm.enabled;
        return (
          <label key={l.id} className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="radio"
              name="launcher"
              checked={selectedId === l.id}
              onChange={() => onSelect(l.id)}
              disabled={disabled || unavailable}
              className="mt-0.5 border-border disabled:opacity-40"
            />
            <span className="text-xs">
              <span className="font-medium">{l.label}</span>
              {l.remote && vm?.name && (
                <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                  {vm.name}
                </span>
              )}
              {l.remote && vm && (
                <span
                  className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                    vm.state === 'RUNNING'
                      ? 'bg-green-950/40 text-green-400 border-green-800'
                      : 'bg-muted text-muted-foreground border-border'
                  }`}
                >
                  {vm.state.toLowerCase()}
                </span>
              )}
              <span className="block text-muted-foreground mt-0.5">
                {unavailable
                  ? 'Remote support is disabled on this server.'
                  : l.remote && selectedId === l.id && asleep
                    ? 'The remote machine is not running — starting will boot it first, which takes a few minutes.'
                    : l.description ?? ''}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

interface LaunchListProps {
  outcomes: LaunchOutcome[];
  onStartMore: () => void;
  onClose: () => void;
}

function LaunchList({ outcomes, onStartMore, onClose }: LaunchListProps) {
  const okCount = outcomes.filter((o) => o.status === 'ok').length;
  const single = outcomes.length === 1;

  return (
    <div className="flex flex-col min-h-0">
      <div className="text-sm font-medium mb-3">
        Launching {okCount} {okCount === 1 ? 'item' : 'items'}
        {okCount !== outcomes.length && ` (${outcomes.length - okCount} failed to start)`}
      </div>

      <div className="space-y-3 overflow-y-auto pr-1">
        {outcomes.map((o) =>
          o.status === 'ok' ? (
            <LaunchCard key={o.result.tag} result={o.result} defaultOpen={single} />
          ) : (
            <div
              key={o.tag}
              className="text-xs text-red-400 bg-red-950/20 border border-red-800 rounded-md p-2"
            >
              <span className="font-mono">{o.tag}</span> — {o.error}
            </div>
          ),
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-3">
        <button
          onClick={onStartMore}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80"
        >
          Start more
        </button>
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80"
        >
          Close
        </button>
      </div>
    </div>
  );
}

interface LaunchCardProps {
  result: LaunchResult;
  defaultOpen: boolean;
}

function LaunchCard({ result, defaultOpen }: LaunchCardProps) {
  const [status, setStatus] = useState<LaunchStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(defaultOpen);
  const outputRef = useRef<HTMLPreElement>(null);
  const lastSeenStateRef = useRef<LaunchStatus['containerState'] | null>(null);

  // Each card polls its own launch status independently.
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const s = await fetchLaunchStatus(result.tag, result.launcherId);
        if (cancelled) return;

        // `docker inspect` races during the create→recreate window can briefly
        // return "missing" between two real states. While the launch tmux is
        // still alive, hold the last real state instead of flickering.
        let smoothed = s;
        if (s.containerState !== 'missing') {
          lastSeenStateRef.current = s.containerState;
        } else if (s.tmuxAlive && lastSeenStateRef.current) {
          smoothed = {
            ...s,
            containerState: lastSeenStateRef.current,
            phase: lastSeenStateRef.current === 'running' ? 'ready' : s.phase,
          };
        }

        setStatus(smoothed);
        setStatusError(null);
      } catch (err) {
        if (cancelled) return;
        setStatusError(err instanceof Error ? err.message : 'status failed');
      }
    };

    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [result.tag, result.launcherId]);

  // Auto-scroll output to bottom when it changes.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [status?.tmuxOutput, showOutput]);

  const phase = status?.phase ?? 'starting';
  const isReady = phase === 'ready';
  const isFailed = phase === 'failed';
  // Whether this launch runs elsewhere is answered by the status the server
  // sent back, not by the launcher's name — a launcher that turns out to have
  // no remote host simply reports null and reads as local.
  const isRemote = status?.remoteState != null;
  const headerColor = isReady
    ? 'text-green-400'
    : isFailed
      ? 'text-red-400'
      : 'text-amber-400';
  const headerText = isReady
    ? `Ready — container is running${isRemote ? ' remotely' : ''}`
    : isFailed
      ? 'Launch failed'
      : phase === 'booting'
        ? 'Booting the remote machine… (a few minutes)'
        : phase === 'building'
          ? 'Building the image…'
          : 'Starting…';

  return (
    <div className="border border-border rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-mono font-semibold">{result.tag}</span>
          {isRemote && (
            <span
              title="Runs on another machine"
              className="text-[9px] leading-none px-1 py-0.5 rounded font-semibold bg-violet-500/20 text-violet-300 border border-violet-500/40"
            >
              ↗
            </span>
          )}
        </div>
        <span className={`text-xs font-medium ${headerColor}`}>{headerText}</span>
      </div>

      <dl className="text-xs grid grid-cols-2 gap-x-4 gap-y-1">
        {result.containerName && (
          <>
            <dt className="text-muted-foreground">Container</dt>
            <dd className="font-mono text-right truncate">{result.containerName}</dd>
          </>
        )}
        {isRemote && (
          <>
            <dt className="text-muted-foreground">Remote state</dt>
            <dd className="text-right font-mono">{status?.remoteState?.toLowerCase() ?? '—'}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Container state</dt>
        <dd className="text-right">
          <StateBadge
            state={status?.containerState ?? 'missing'}
            exitCode={status?.containerExitCode ?? null}
            tmuxAlive={status?.tmuxAlive ?? false}
          />
        </dd>
        <dt className="text-muted-foreground">Launch tmux</dt>
        <dd className="text-right">
          <TmuxBadge alive={status?.tmuxAlive ?? false} />
        </dd>
      </dl>

      <div>
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowOutput((v) => !v)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {showOutput ? '▾ Output' : '▸ Output'}
          </button>
          <span className="text-[10px] text-muted-foreground font-mono">
            tmux attach -t {result.launchSession}
          </span>
        </div>
        {showOutput && (
          <pre
            ref={outputRef}
            className="mt-1 bg-black/60 border border-border rounded-md p-2 text-[11px] font-mono text-foreground/90 overflow-auto h-40 whitespace-pre-wrap"
          >
{status?.tmuxOutput || (statusError ? `status error: ${statusError}` : 'Waiting for output…')}
          </pre>
        )}
      </div>

      {statusError && (
        <div className="text-xs text-red-400 bg-red-950/20 border border-red-800 rounded-md p-2">
          {statusError}
        </div>
      )}
    </div>
  );
}

function StateBadge({
  state,
  exitCode,
  tmuxAlive,
}: {
  state: LaunchStatus['containerState'];
  exitCode: number | null;
  tmuxAlive: boolean;
}) {
  // "missing" while the launch tmux is still alive really means "not created
  // yet" — render as pending rather than the alarming gray "missing".
  const displayAsPending = state === 'missing' && tmuxAlive;
  const color = displayAsPending
    ? 'bg-amber-950/30 text-amber-400 border-amber-800'
    : state === 'running'
      ? 'bg-green-950/40 text-green-400 border-green-800'
      : state === 'missing'
        ? 'bg-muted text-muted-foreground border-border'
        : state === 'exited' || state === 'dead'
          ? 'bg-red-950/30 text-red-400 border-red-800'
          : 'bg-amber-950/30 text-amber-400 border-amber-800';
  const label = displayAsPending
    ? 'pending'
    : state === 'exited' && exitCode != null
      ? `exited (${exitCode})`
      : state;
  return (
    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border font-mono ${color}`}>
      {label}
    </span>
  );
}

function TmuxBadge({ alive }: { alive: boolean }) {
  return (
    <span
      className={`inline-block text-[10px] px-1.5 py-0.5 rounded border font-mono ${
        alive
          ? 'bg-green-950/40 text-green-400 border-green-800'
          : 'bg-muted text-muted-foreground border-border'
      }`}
    >
      {alive ? 'alive' : 'gone'}
    </span>
  );
}
