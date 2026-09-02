import type { WorkItem, WorkItemState } from '../lib/api';
import { cn } from '../lib/utils';

/**
 * The live state of the work a tag names.
 *
 * Trackers call their statuses whatever they like — "In Review", "Blocked",
 * "Needs QA" — so the name is printed verbatim and only the four-state category
 * decides the colour. That is the whole reason `state` exists beside `status`.
 */
const STATE_STYLES: Record<WorkItemState, string> = {
  todo: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  inprogress: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  done: 'bg-green-500/15 text-green-300 border-green-500/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};

export function WorkItemBadge({ item }: { item: WorkItem }) {
  return (
    <span
      title={item.summary ?? undefined}
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        STATE_STYLES[item.state],
      )}
    >
      {item.status}
    </span>
  );
}
