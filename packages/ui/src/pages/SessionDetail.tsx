import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  fetchSession,
  fetchSessions,
  fetchWorkItems,
  fetchSessionTags,
  resumeSession,
  fetchSessionNotes,
  saveSessionNote,
  type Session,
  type WorkItem,
  type TagMention,
  ApiError,
} from '../lib/api';
import { migrateLegacyNotes, mergePendingNotes, type PendingNotes } from '../lib/notes';
import { isInteractive } from '../lib/tabs';
import { ConversationView } from '../components/ConversationView';
import { TerminalCapture } from '../components/TerminalCapture';
import { TokenUsageBadge } from '../components/TokenUsageBadge';
import { SubagentTree } from '../components/SubagentTree';
import { SessionTabBar } from '../components/SessionTabBar';
import { WorkItemBadge } from '../components/WorkItemBadge';
import { WorkItemRow } from '../components/WorkItemRow';
import { SourceBadge } from '../components/SourceBadge';
import { timeAgo } from '../lib/utils';
import { useAppConfig, capturePollMs } from '../hooks/useAppConfig';

const INTERACTIVE_ONLY_KEY = 'claude-monitor-tabs-interactive-only';
const NOTES_POLL_MS = 5000;

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  // Why the session isn't on screen, when it isn't. A dead server and a session
  // that does not exist look identical from here otherwise, and the page used to
  // report the second for both — so a stopped server read as "Session not
  // found", which is wrong and no help at all.
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [activeTab, setActiveTab] = useState<'conversation' | 'terminal'>('terminal');
  // How fast to poll the terminal is the transport's call, not this page's — a
  // streamed remote pane is served from server memory and wants a much shorter
  // interval than a local one. See providers/transports.ts.
  const appConfig = useAppConfig();
  const [interactiveOnly, setInteractiveOnly] = useState(
    () => localStorage.getItem(INTERACTIVE_ONLY_KEY) === 'true',
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const pendingNotes = useRef<PendingNotes>({});
  // Below lg the sidebar can't sit beside the panel, so it swaps in for it.
  const [showInfo, setShowInfo] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  // Every ticket the conversation touches, not just the one the session was
  // started for. Fetched once per session: deriving it means walking the whole
  // transcript, and which tickets a conversation mentions barely changes, while
  // their *status* does — so the two are polled separately.
  const [tags, setTags] = useState<TagMention[]>([]);
  const [trackerConfigured, setTrackerConfigured] = useState(true);
  // Reopening runs `claude --resume` in a tmux session this app owns, which is
  // the only way to make a session someone started in their own terminal
  // typeable from here.
  const [resuming, setResuming] = useState(false);
  const [acting, setActing] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [workItems, setWorkItems] = useState<Record<string, WorkItem>>({});

  // The URL may hold a retired transcript id — the server resolves it, but the
  // tab bar keys notes off the live id, so key off the same thing here.
  const noteKey = session?.id ?? id;
  const note = noteKey ? notes[noteKey] : undefined;

  // The one the session is *about*. Taken from the same field the server marks
  // as primary, so the two cannot disagree about which entry to highlight.
  const primaryTag = session?.tag ?? null;

  const drive = async (key: string) => {
    if (!id || acting) return;
    setActing(true);
    try {
      await fetch(`/api/sessions/${id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
    } catch { /* the pane will show whether it landed */ }
    setActing(false);
  };

  const interrupt = () => drive('Escape');

  /**
   * What stopping this session will actually do, said before it happens.
   *
   * "Stop" means three different things depending on how the session was
   * started, and the difference is exactly what someone needs to know before
   * clicking: one of them is reversible and two of them close a terminal.
   */
  const stopPlan = (): string => {
    switch (session?.stopMethod) {
      case 'claude stop':
        return `Stop this background session?\n\nRuns \`claude stop ${session.id.slice(0, 8)}\`. `
          + 'The conversation is kept and you can resume it later.';
      case 'tmux kill-session':
        return `Stop this session?\n\nCloses the tmux session ${session.target?.ref}, which this `
          + 'dashboard started. The transcript is kept, so Reopen here brings it back.';
      case 'SIGTERM':
        return 'Stop this session?\n\nSends SIGTERM to the process — the same signal closing '
          + 'its terminal sends. The transcript is kept; an answer in flight is lost.';
      default:
        return 'Stop this session?\n\nThere is no process here to stop, so this may do nothing.';
    }
  };

  const stop = async () => {
    if (!id || acting || !window.confirm(stopPlan())) return;
    setActing(true);
    try {
      const res = await fetch(`/api/sessions/${id}/stop`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setResumeError(body.error || 'Failed to stop the session.');
      }
    } catch {
      setResumeError('Failed to stop the session.');
    }
    setActing(false);
  };

  const handleResume = async () => {
    if (!session) return;
    setResuming(true);
    setResumeError(null);
    try {
      await resumeSession(session.id);
      // The tmux session exists now, but the card only learns about it on the
      // next discovery tick — switch to the terminal so the pane appears there.
      setActiveTab('terminal');
      setShowInfo(false);
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : 'reopen failed');
    } finally {
      setResuming(false);
    }
  };

  const startEditNote = () => {
    setNoteDraft(note ?? '');
    setEditingNote(true);
  };

  const commitNote = () => {
    if (!noteKey) return;
    const trimmed = noteDraft.trim();
    const updated = { ...notes };
    if (trimmed) updated[noteKey] = trimmed;
    else delete updated[noteKey];
    // Render optimistically and hold the value against in-flight polls until the
    // write lands; the next poll then reconciles with the server.
    pendingNotes.current = { ...pendingNotes.current, [noteKey]: trimmed || null };
    setNotes(updated);
    setEditingNote(false);
    saveSessionNote(noteKey, trimmed)
      .catch(() => {})
      .finally(() => {
        const { [noteKey]: _settled, ...rest } = pendingNotes.current;
        pendingNotes.current = rest;
      });
  };

  const toggleInteractiveOnly = () => {
    setInteractiveOnly(prev => {
      const next = !prev;
      localStorage.setItem(INTERACTIVE_ONLY_KEY, String(next));
      return next;
    });
  };

  const refresh = () => {
    if (!id) return;
    return Promise.all([
      fetchSession(id),
      fetchSessions(),
    ]).then(([s, all]) => {
      setSession(s);
      setAllSessions(all);
      setLoadError(null);
    }).catch((err: unknown) => {
      setLoadError(err instanceof ApiError ? err : new ApiError(String(err), 0));
    });
  };

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    refresh()!.finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [id]);

  // Notes are persisted server-side, so they follow the session across devices.
  // Poll for them: a note added on the phone should appear on the desktop too.
  // Notes written by the older browser-local build are pushed up once on mount.
  useEffect(() => {
    let cancelled = false;
    const apply = (server: Record<string, string>) => {
      if (!cancelled) setNotes(mergePendingNotes(server, pendingNotes.current));
    };

    fetchSessionNotes()
      .then(server => migrateLegacyNotes(server))
      .then(apply)
      .catch(() => {});

    const interval = setInterval(() => {
      fetchSessionNotes().then(apply).catch(() => {});
    }, NOTES_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Which tickets: once per session. The server has to read the transcript for
  // this, and transcripts run to tens of MB.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchSessionTags(id)
      .then((res) => {
        if (cancelled) return;
        setTags(res.tags);
        setWorkItems(res.items);
        setTrackerConfigured(res.trackerConfigured);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  // What state they are in: polled. Cheap — the server caches per tag.
  const tagSignature = tags.map(t => t.tag).join(',');
  useEffect(() => {
    if (!tagSignature) return;
    let cancelled = false;
    const run = () =>
      fetchWorkItems(tagSignature.split(','))
        .then((res) => { if (!cancelled) setWorkItems(res.items); })
        .catch(() => {});
    const interval = setInterval(run, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tagSignature]);

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading session...</div>;
  }

  if (!session) {
    // Unreachable is worth saying out loud, and it is fixable by the person
    // reading it; the poll keeps running, so the page recovers on its own once
    // the server is back.
    if (loadError?.status === 0) {
      return (
        <div className="p-6 space-y-2">
          <div className="text-sm text-red-400">{loadError.message}</div>
          <div className="text-xs text-muted-foreground">
            Retrying every 5 seconds — this page comes back on its own.
          </div>
        </div>
      );
    }
    return <div className="p-6 text-muted-foreground">Session not found.</div>;
  }

  // The same test the tab bar filters on, so "Interactive only" and the
  // Terminal button can never disagree about what a session can do.
  const canInteract = isInteractive(session);

  return (
    <div className="h-[100dvh] flex flex-col">
      {/* Session tabs */}
      <SessionTabBar
        sessions={allSessions}
        activeId={session.id}
        interactiveOnly={interactiveOnly}
        notes={notes}
      />

      {/*
        Top bar, in three groups separated by rules: where you can go, what you
        can do, and what this session is.

        It grew the other way round — identity first, actions pushed to
        whichever edge had room, the checkbox and the buttons each claiming
        `ml-auto` so they fought over the same gap. Reading it meant scanning
        the whole width. Now the things you click are together and always in
        the same place, and the things you read follow them.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 sm:px-4 py-2 border-b border-border bg-muted/20">
        <Link to="/" className="text-xs text-muted-foreground hover:text-foreground whitespace-nowrap">
          Overview
        </Link>
        <Rule />

        {canInteract && (
          <>
            <button
              onClick={() => { setActiveTab('terminal'); setShowInfo(false); }}
              className={`text-xs px-2 py-1 rounded ${activeTab === 'terminal' && !showInfo ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
            >
              Terminal
            </button>
            <button
              onClick={() => { setActiveTab('conversation'); setShowInfo(false); }}
              className={`text-xs px-2 py-1 rounded ${activeTab === 'conversation' && !showInfo ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
            >
              Conversation
            </button>
            <Rule />
            {/* Controls that drive the session rather than the view. Kept a
                rule away from the view switch: one of them ends the session,
                and it should not sit flush against the button you press all
                day. */}
            <button
              onClick={interrupt}
              disabled={acting}
              title="Send Escape — stops what Claude is doing without ending the session"
              className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-accent hover:text-yellow-400 disabled:opacity-40"
            >
              Interrupt
            </button>
            <button
              onClick={stop}
              disabled={acting}
              title="End the session. What that means depends on how it was started — you'll be told before it happens."
              className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-accent hover:text-red-400 disabled:opacity-40"
            >
              Stop
            </button>
          </>
        )}

        {/* An action, so it sits with the actions. */}
        {session.target?.kind === 'tmux'
          ? <AttachCommand tmuxSession={session.target.ref} />
          : <SourceBadge source={session.source} remote={session.remote} />}

        {!canInteract && (
          <>
            <button
              onClick={handleResume}
              disabled={resuming || !!session.live}
              title={
                session.live
                  ? 'Running in a terminal already. Reopening would start a second Claude Code on the same conversation, and the two would answer independently.'
                  : `Runs \`claude --resume ${session.id.slice(0, 8)}\` in a tmux session here, so you can type into it.`
              }
              className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {resuming ? 'Reopening…' : 'Reopen here'}
            </button>
            {session.live && (
              <span className="text-[11px] text-muted-foreground">
                running in a terminal — exit it there first
              </span>
            )}
          </>
        )}

        <button
          onClick={() => setShowInfo(v => !v)}
          className={`lg:hidden text-xs px-2 py-1 rounded ${showInfo ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
        >
          Info
        </button>

        <label
          // "Interactive only" said nothing about what it filters. It hides
          // tabs for sessions with no live terminal — everything not running
          // under tmux — which is most of them until you reopen one.
          title="Hide tabs for sessions with no terminal to type into (anything not running under tmux)"
          className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap"
        >
          <input
            type="checkbox"
            checked={interactiveOnly}
            onChange={toggleInteractiveOnly}
            className="rounded border-border"
          />
          Typeable only
        </label>

        {/* No identity group. The folder, the branch and the working directory
            are all in Session Info, the tab strip names the session and marks
            it, and a status dot with no label was the very thing that meant
            nothing to anyone. Saying it a second time here only competed with
            the controls for the width. */}

        {editingNote ? (
          <input
            autoFocus
            value={noteDraft}
            onChange={e => setNoteDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitNote();
              if (e.key === 'Escape') setEditingNote(false);
            }}
            onBlur={commitNote}
            placeholder="Note for this session..."
            className="ml-auto bg-transparent outline-none border-b border-primary/40 focus:border-primary text-xs py-0.5 w-64"
          />
        ) : (
          <button
            type="button"
            onClick={startEditNote}
            title={note ? 'Click to edit note' : 'Click to add a note'}
            className={
              'ml-auto text-xs text-right truncate max-w-[140px] sm:max-w-[300px] hover:text-foreground transition-colors ' +
              (note ? 'italic text-muted-foreground' : 'text-muted-foreground/40')
            }
          >
            {note ?? '+ note'}
          </button>
        )}
      </div>

      {/* Main content */}
      {loadError?.status === 0 && (
        <div className="mx-2 sm:mx-4 mb-1 text-xs text-red-400 bg-red-950/20 border border-red-800 rounded-md p-2">
          {loadError.message} Showing the last state it reported.
        </div>
      )}
      {resumeError && (
        <div className="mx-2 sm:mx-4 mb-1 text-xs text-red-400 bg-red-950/20 border border-red-800 rounded-md p-2">
          {resumeError}
        </div>
      )}
      {resuming && !canInteract && (
        <div className="mx-2 sm:mx-4 mb-1 text-xs text-muted-foreground">
          Running <span className="font-mono">claude --resume {session.id.slice(0, 8)}</span> in a
          tmux session — the terminal appears here once the scan picks it up.
        </div>
      )}

      <div className="flex-1 flex gap-4 p-2 sm:p-4 min-h-0">
        {/* Left: Conversation + Terminal */}
        <div className={`flex-1 min-w-0 border border-border rounded-lg overflow-hidden flex-col ${showInfo ? 'hidden lg:flex' : 'flex'}`}>
          <div className="flex-1 min-h-0">
            {activeTab === 'terminal' && canInteract && id ? (
              <TerminalCapture
                sessionId={id}
                canInteract={canInteract}
                pollMs={capturePollMs(appConfig, session.target?.kind)}
              />
            ) : (
              <ConversationView sessionId={session.id} />
            )}
          </div>
        </div>

        {/* Right: Sidebar */}
        <div className={`w-full lg:w-72 shrink-0 space-y-3 overflow-y-auto ${showInfo ? 'block' : 'hidden lg:block'}`}>
          {tags.length > 0 && (
            <div className="rounded-md border border-border bg-muted/50 p-3 text-sm space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                {tags.length === 1 ? 'Work item' : `Work items (${tags.length})`}
              </div>
              {tags.map((t) => (
                <WorkItemRow
                  key={t.tag}
                  tag={t.tag}
                  mentions={t.mentions}
                  item={workItems[t.tag]}
                  primary={t.tag === primaryTag}
                />
              ))}
              {!trackerConfigured && (
                <div className="text-[11px] text-muted-foreground pt-1">
                  Other work items this session touches need a tracker to
                  identify — a key-shaped string is not a key.
                </div>
              )}
            </div>
          )}

          {session.recap && (
            <div className="rounded-md border border-border bg-muted/50 p-3 text-sm">
              <div className="text-xs font-medium text-muted-foreground mb-1">Goal</div>
              {/* Claude Code's own recap, not something derived here. It is the
                  session's account of itself, which beats guessing from the
                  first message — a long session's opening line is rarely still
                  what it is about. */}
              <div className="text-xs leading-snug whitespace-pre-wrap">{session.recap.text}</div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                as of {timeAgo(session.recap.at)}
              </div>
            </div>
          )}

          {session.branches && session.branches.length > 1 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              <div className="font-medium text-amber-300 mb-1">
                Covers {session.branches.length} branches
              </div>
              {/* A fact rather than a verdict: several branches in one session
                  usually means several pieces of work, and that is worth seeing
                  before scrolling 2000 messages for the part you remember. */}
              <div className="text-muted-foreground">
                {session.branches.join(' · ')}
              </div>
            </div>
          )}

          <div className="rounded-md border border-border bg-muted/50 p-3 text-sm space-y-2">
            <div className="font-medium mb-2">Session Info</div>
            <SessionIdRow id={session.id} />
            {/* Status and mode belong together: what it is doing, and under what
                permissions. Model next, because it is the other thing that
                changes what you get. */}
            <InfoRow label="Status" value={`${session.status.toUpperCase()} · ${session.permissionMode || 'default'}`} />
            <InfoRow label="Model" value={session.model} />
            <InfoRow label="Branch" value={session.gitBranch} />
            <InfoRow label="CWD" value={session.cwd} />
            <InfoRow label="Activity" value={`${session.messageCount} msgs · ${session.toolCallCount} tools`} />
            <InfoRow
              label="Age"
              value={
                session.startedAt
                  ? `${timeAgo(session.startedAt)} · last ${session.lastActivityAt ? timeAgo(session.lastActivityAt) : '?'}`
                  : 'unknown'
              }
            />
            {session.tag && <InfoRow label="Tag" value={session.tag} />}
            {/* Entrypoint is always "cli", the Claude Code version rarely
                matters, and the tmux name is the attach command in the header —
                three rows that were only ever taking up space. The pid stays:
                it is what you need to go and kill something. */}
            {session.pid && <InfoRow label="PID" value={String(session.pid)} />}
          </div>

          <TokenUsageBadge
            inputTokens={session.totalInputTokens}
            outputTokens={session.totalOutputTokens}
            cacheReadTokens={session.totalCacheReadTokens}
            cacheWriteTokens={session.totalCacheWriteTokens}
            cost={session.estimatedCost}
          />

          <SubagentTree subagents={session.subagents} />
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right truncate ml-2 max-w-[60%]">{value}</span>
    </div>
  );
}

/**
 * The command that opens this session in a terminal, ready to paste.
 *
 * It replaces a badge that said "TMUX" — true, and useless. The session is in a
 * pane you can attach to, and the only thing worth knowing about that is the
 * name, which is exactly what the command carries. Attaching gives you the same
 * process the browser is driving, not a copy.
 */
/** The divider between the bar's three groups. */
function Rule() {
  return <span className="text-muted-foreground/25 select-none">|</span>;
}

function AttachCommand({ tmuxSession }: { tmuxSession: string }) {
  const [copied, setCopied] = useState(false);
  const command = `tmux attach -t ${tmuxSession}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (insecure context, permissions). The command is on
      // screen either way, which is the point.
    }
  };

  // Six characters instead of thirty. The command was spelled out in full
  // across the bar, which is a lot of permanent width for a line nobody reads
  // — you copy it, once, and paste it into a terminal. The word says what the
  // click does and the tooltip carries the command itself.
  return (
    <button
      type="button"
      onClick={copy}
      title={`${command}\n\nCopy. Attaching gives you this same session in your terminal, in sync with the browser.`}
      className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border hover:text-foreground hover:border-foreground/40 whitespace-nowrap"
    >
      {copied ? 'copied' : 'attach'}
    </button>
  );
}

function SessionIdRow({ id }: { id: string }) {
  const [copied, setCopied] = useState<'id' | 'cmd' | null>(null);

  const copy = async (text: string, kind: 'id' | 'cmd') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="text-xs space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-muted-foreground">Session ID</span>
        <div className="flex gap-1">
          <button
            onClick={() => copy(id, 'id')}
            className="px-1.5 py-0.5 rounded bg-muted hover:bg-accent text-[10px]"
            title="Copy session id"
          >
            {copied === 'id' ? 'Copied' : 'Copy id'}
          </button>
          <button
            onClick={() => copy(`claude -r ${id}`, 'cmd')}
            className="px-1.5 py-0.5 rounded bg-muted hover:bg-accent text-[10px]"
            title="Copy claude -r command"
          >
            {copied === 'cmd' ? 'Copied' : 'Copy -r'}
          </button>
        </div>
      </div>
      <div className="font-mono text-[10px] break-all bg-background/50 rounded px-1.5 py-1 select-all">
        {id}
      </div>
    </div>
  );
}
