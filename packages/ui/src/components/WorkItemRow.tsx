import type { WorkItem } from '../lib/api';
import { WorkItemBadge } from './WorkItemBadge';
import { cn } from '../lib/utils';

/**
 * One piece of work a session touches.
 *
 * A session routinely mentions several tickets — the one it was started for, a
 * follow-up, something it noticed on the way — so the list distinguishes them:
 * the primary is the one the session is *about*, the rest are mentions. Without
 * that, a passing reference reads as equal to the work in hand.
 *
 * The link is whatever the tracker returned, since only it knows its own URL
 * format; with no tracker configured there is no link and no badge, just the
 * key, which is still worth showing.
 */
export function WorkItemRow({
  tag,
  mentions,
  item,
  primary,
}: {
  tag: string;
  /** How often the transcript mentions it — the ranking, made visible. */
  mentions: number;
  item?: WorkItem;
  primary: boolean;
}) {
  return (
    <div className="flex items-start gap-2 flex-wrap">
      {item?.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          title="Open in the tracker"
          className={cn(
            'hover:underline text-primary',
            primary ? 'font-semibold' : 'text-xs',
          )}
        >
          {tag} &#8599;
        </a>
      ) : (
        <span className={cn(primary ? 'font-semibold' : 'text-xs')}>{tag}</span>
      )}
      {primary && (
        <span
          title="The work this session was started for"
          className="text-[9px] leading-none px-1 py-0.5 rounded bg-muted text-muted-foreground border border-border shrink-0 self-center"
        >
          MAIN
        </span>
      )}
      {item && <WorkItemBadge item={item} />}
      {!primary && mentions > 0 && (
        <span
          title={`Mentioned ${mentions} ${mentions === 1 ? 'time' : 'times'} in this session`}
          className="text-[10px] text-muted-foreground self-center"
        >
          ×{mentions}
        </span>
      )}
      {primary && item?.summary && (
        <div className="w-full text-xs text-muted-foreground">{item.summary}</div>
      )}
    </div>
  );
}
