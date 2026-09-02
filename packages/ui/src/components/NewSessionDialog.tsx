import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchLaunchDefaults, launchClaudeSession } from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onLaunched?: () => void;
}

const RECENT_KEY = 'claude-monitor-recent-cwds';
const MAX_RECENT = 8;

function loadRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberRecent(cwd: string): void {
  const next = [cwd, ...loadRecent().filter(p => p !== cwd)].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

export function NewSessionDialog({ open, onClose, onLaunched }: Props) {
  const [cwd, setCwd] = useState('');
  const [defaultCwd, setDefaultCwd] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    setRecent(loadRecent());
    fetchLaunchDefaults()
      .then(({ defaultCwd: d }) => {
        setDefaultCwd(d);
        // Only prefill an untouched field, so reopening keeps what was typed.
        setCwd(prev => prev || d);
      })
      .catch(() => {});
    setTimeout(() => inputRef.current?.select(), 0);
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    const target = cwd.trim() || defaultCwd;
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await launchClaudeSession(target);
      rememberRecent(target);
      onLaunched?.();
      onClose();
      // Straight into the terminal view — a new session usually opens with
      // Claude's trust-this-folder prompt, which has to be answered there.
      navigate(`/session/${session.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'launch failed');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-lg shadow-xl w-full max-w-xl p-5 mx-4 max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">New Claude Session</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">
            Close
          </button>
        </div>

        <label htmlFor="cwd" className="block text-xs font-medium mb-1.5">
          Working directory
        </label>
        <input
          id="cwd"
          ref={inputRef}
          value={cwd}
          onChange={e => setCwd(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onClose();
          }}
          disabled={submitting}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={defaultCwd}
          className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-base sm:text-sm font-mono focus:outline-none focus:border-primary disabled:opacity-50"
        />

        {recent.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
              Recent
            </div>
            <div className="flex flex-wrap gap-1.5">
              {recent.map(p => (
                <button
                  key={p}
                  onClick={() => setCwd(p)}
                  disabled={submitting}
                  title={p}
                  className="px-2 py-0.5 rounded border border-border bg-muted/60 hover:bg-accent text-[11px] font-mono max-w-full truncate disabled:opacity-50"
                >
                  {p.split('/').slice(-2).join('/')}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-3">
          Starts <span className="font-mono">claude</span> in a detached tmux session, so you can
          drive it from here. A folder Claude hasn&apos;t seen before opens with a trust prompt —
          answer it in the terminal view.
        </p>

        {error && (
          <div className="mt-3 text-xs text-red-400 bg-red-950/20 border border-red-800 rounded-md p-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-4">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !(cwd.trim() || defaultCwd)}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Starting...' : 'Start Session'}
          </button>
        </div>
      </div>
    </div>
  );
}
