import { Link } from 'react-router-dom';
import { type Session, type WorkItem, hideSession, unhideSession } from '../lib/api';
import { WorkItemBadge } from './WorkItemBadge';
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
  onToggleHide?: () => void;
}

export function SessionCard({ session, workItem, onToggleHide }: Props) {
  const shortId = session.id.slice(0, 12);
  const project = projectName(session.projectPath);
  const modelShort = session.model
    ?.replace('claude-', '')
    .replace(/-\d+$/, '') ?? 'unknown';

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
        <button
          onClick={handleToggleHide}
          className={cn(
            'text-xs px-2 py-0.5 rounded transition-colors',
            session.hidden
              ? 'bg-muted text-muted-foreground hover:bg-accent'
              : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted',
            !session.gitBranch && 'ml-auto',
          )}
        >
          {session.hidden ? 'Show' : 'Hide'}
        </button>
      </div>

      {workItem && (
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold">{workItem.tag}</span>
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
          &ldquo;{truncate(session.firstUserMessage, 120)}&rdquo;
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
