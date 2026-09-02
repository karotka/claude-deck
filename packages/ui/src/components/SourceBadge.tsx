import { cn } from '../lib/utils';

/**
 * Where a session runs. Local sessions get no badge — they're the default and
 * labelling them would be noise. Sessions that are not on this machine get a
 * deliberately distinct colour: wherever local and remote sessions sit side by
 * side (dashboard, tab bar, detail header), the difference has to be readable
 * at a glance, because typing into one is a very different act from typing into
 * the other.
 *
 * The badge reads `remote` off the session rather than matching source names,
 * so a provider added later gets the right treatment by declaring itself remote
 * — no change here.
 */
export function SourceBadge({
  source,
  remote,
  className,
  title,
}: {
  source: string;
  remote?: boolean;
  className?: string;
  title?: string;
}) {
  if (source === 'local') return null;

  return (
    <span
      title={title ?? (remote ? 'Runs on another machine' : undefined)}
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0',
        remote
          ? 'bg-violet-500/15 text-violet-300 border border-violet-500/40 font-semibold'
          : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {source}
    </span>
  );
}

/**
 * Compact marker for space-constrained rows (session tabs), where a full badge
 * would crowd out the label.
 */
export function RemoteDot({ className }: { className?: string }) {
  return (
    <span
      title="Runs on another machine"
      className={cn(
        'text-[9px] leading-none px-1 py-0.5 rounded font-semibold shrink-0',
        'bg-violet-500/20 text-violet-300 border border-violet-500/40',
        className,
      )}
    >
      ↗
    </span>
  );
}
