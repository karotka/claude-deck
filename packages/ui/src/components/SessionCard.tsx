import { Link } from 'react-router-dom';
import { type Session, type WorkItem, hideSession, unhideSession } from '../lib/api';
import { WorkItemBadge } from './WorkItemBadge';
import { workItemUrl, shortenItemLinks } from '../lib/work-item-url';
import { stopPlanText, canDrive, interrupt, stop } from '../lib/session-actions';
import { SourceBadge } from './SourceBadge';
import { cn, formatTokens, formatCost, timeAgo, truncate, projectName, containerLabel } from '../lib/utils';

const statusColors: Record<string, string> = {
  running: 'bg-green-500',
  idle: 'bg-yellow-500',
  stopped: 'bg-gray-500',
};

const statusLabels: Record<string, string> = {
  running: 'RUNNING',
  idle: 'IDLE',
  stopped: 'STOPPED',
};

interface Props {
  session: Session;
  workItem?: WorkItem;
  /** Where a key links to, from the server. Empty when nothing is configured. */
  itemUrlTemplate?: string;
  /** What a key looks like, from the server — never guessed at here. */
  tagPattern?: string;
  onToggleHide?: () => void;
  /** Called after an action that changes what the board should show. */
  onChanged?: () => void;
}

export function SessionCard({
  session,
  workItem,
  onToggleHide,
  onChanged,
  itemUrlTemplate,
  tagPattern,
}: Props) {
  // stopPropagation on the anchor, not just preventDefault: the card is a link,
  // and opening a ticket should not also open the session behind it.
  const itemHref = workItem ? workItemUrl(workItem.tag, itemUrlTemplate, workItem.url) : null;
  const shortId = session.id.slice(0, 12);
  const project = projectName(session.projectPath);
  const modelShort = session.model
    ?.replace('claude-', '')
    .replace(/-\d+$/, '') ?? 'unknown';

  /*
   * The card is a link, so every control on it has to say so explicitly: a
   * click that reaches the anchor navigates, and "I meant the button" is not
   * something the browser infers.
   */
  const act = (fn: () => Promise<unknown>) => async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await fn();
    onChanged?.();
  };

  const handleInterrupt = act(() => interrupt(session.id));

  const handleStop = act(async () => {
    if (!window.confirm(stopPlanText(session))) return;
    const error = await stop(session.id);
    if (error) window.alert(error);
  });

  const handleToggleHide = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (session.hidden) {
      await unhideSession(session.id);
    } else {
      await hideSession(session.id);
    }
    onToggleHide?.();
  };

  return (
    <Link
      to={`/session/${session.id}`}
      className={cn(
        'block rounded-lg border border-border bg-card p-4 hover:border-muted-foreground/50 transition-colors',
        session.hidden && 'opacity-50',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
        <span className={cn('inline-block h-2 w-2 rounded-full', statusColors[session.status])} />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {statusLabels[session.status]}
        </span>
        {/* A name the user chose beats anything derived: eight sessions can
            share a working directory, but "Browse ML ranker" is only ever one. */}
        <span className="text-sm font-semibold">
          {session.sessionName ?? containerLabel(session) ?? project}
        </span>
        {session.sessionName && (
          <span className="text-xs text-muted-foreground">{project}</span>
        )}
        <SourceBadge source={session.source} remote={session.remote} />
        {session.pids && session.pids.length > 1 && (
          <span
            title={`This conversation is open ${session.pids.length} times (pids ${session.pids.join(', ')}). Reopening a session that was still running in a terminal does this; both processes keep writing to the same transcript.`}
            className="text-[10px] px-1.5 py-0.5 rounded border tracking-wide shrink-0 bg-amber-500/15 text-amber-300 border-amber-500/40 font-semibold"
          >
            OPEN ×{session.pids.length}
          </span>
        )}
        {session.live && (
          <span
            title="Claude Code has a live registry entry for this session"
            className="text-[10px] px-1.5 py-0.5 rounded border tracking-wide shrink-0 bg-green-500/15 text-green-300 border-green-500/40 font-semibold"
          >
            LIVE
          </span>
        )}
        {session.gitBranch && (
          <span className="text-xs text-muted-foreground ml-auto">{truncate(session.gitBranch, 30)}</span>
        )}
        {canDrive(session) && (
          <>
            {/* Only where there is something to drive. A card for a stopped
                session offering to interrupt it would be a button that lies. */}
            <button
              onClick={handleInterrupt}
              title="Send Escape — stops what Claude is doing without ending the session"
              className={cn(
                'text-xs px-2 py-0.5 rounded transition-colors',
                'text-muted-foreground/50 hover:text-yellow-400 hover:bg-muted',
                !session.gitBranch && 'ml-auto',
              )}
            >
              Interrupt
            </button>
            <button
              onClick={handleStop}
              title="End the session. What that means depends on how it was started — you'll be told before it happens."
              className="text-xs px-2 py-0.5 rounded transition-colors text-muted-foreground/50 hover:text-red-400 hover:bg-muted"
            >
              Stop
            </button>
          </>
        )}
        <button
          onClick={handleToggleHide}
          className={cn(
            'text-xs px-2 py-0.5 rounded transition-colors',
            session.hidden
              ? 'bg-muted text-muted-foreground hover:bg-accent'
              : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted',
            !session.gitBranch && !canDrive(session) && 'ml-auto',
          )}
        >
          {session.hidden ? 'Show' : 'Hide'}
        </button>
      </div>

      {workItem && (
        <div className="flex items-center gap-2 mb-1">
          {itemHref ? (
            <a
              href={itemHref}
              target="_blank"
              rel="noreferrer"
              onClick={e => e.stopPropagation()}
              title="Open in the tracker"
              className="text-xs font-semibold text-primary hover:underline"
            >
              {workItem.tag} &#8599;
            </a>
          ) : (
            <span className="text-xs font-semibold">{workItem.tag}</span>
          )}
          <WorkItemBadge item={workItem} />
        </div>
      )}

      <div className="text-xs text-muted-foreground mb-1">
        Session: {shortId}
        {session.entrypoint && <> ({session.entrypoint}, {modelShort})</>}
        {session.permissionMode && <> &middot; {session.permissionMode}</>}
      </div>

      {session.firstUserMessage && (
        <div className="text-sm text-foreground/80 mb-2 italic">
          &ldquo;{truncate(shortenItemLinks(session.firstUserMessage, tagPattern), 120)}&rdquo;
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {session.subagents.length > 0 && (
          <span>{session.subagents.length} subagent{session.subagents.length !== 1 ? 's' : ''}</span>
        )}
        <span>{session.messageCount} msgs</span>
        <span>{timeAgo(session.lastActivityAt)}</span>
      </div>

      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
        <span>
          {formatTokens(session.totalInputTokens)} in / {formatTokens(session.totalOutputTokens)} out
        </span>
        <span className="ml-auto font-medium text-foreground">
          ~{formatCost(session.estimatedCost)}
        </span>
      </div>
    </Link>
  );
}
