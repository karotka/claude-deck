import type { GroupState, PhaseState } from '../lib/api';
import { cn } from '../lib/utils';

interface Props {
  phases: PhaseState[];
  /** Index into `phases` of the phase currently in progress. */
  currentPhase: number;
  groups: GroupState[];
  /** What one group is called, e.g. "repo". Plain "group" when unset. */
  groupNoun?: string;
}

/**
 * One item's progress through the configured workflow.
 *
 * Both the phase list and the per-group columns are whatever the config
 * declared — there is no fixed set of six phases and four columns any more, so
 * this renders what it is given and knows none of the labels.
 */
export function WorkflowProgress({ phases, currentPhase, groups, groupNoun }: Props) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {phases.map((p, i) => (
          <div key={p.label} className="flex items-center gap-2 text-xs">
            <span className={cn(
              'inline-block h-2 w-2 rounded-full shrink-0',
              p.done ? 'bg-green-500' : i === currentPhase ? 'bg-yellow-500' : 'bg-muted',
            )} />
            <span className={cn(
              p.done || i === currentPhase ? 'text-foreground' : 'text-muted-foreground',
            )}>
              {i + 1}. {p.label}
              {/* A side track never blocks progress, so saying so stops an
                  unticked one from reading as "stuck here". */}
              {!p.linear && <span className="text-muted-foreground"> (optional)</span>}
            </span>
          </div>
        ))}
      </div>

      {groups.length > 0 && (
        <div>
          <div className="text-xs font-medium mb-2 capitalize">
            {groupNoun ? `${groupNoun}s` : 'Groups'}
          </div>
          <div className="space-y-2">
            {groups.map(group => (
              <div key={group.name} className="text-xs border-l-2 border-muted-foreground/30 pl-3">
                <div className="font-medium">{group.name}</div>
                <div className="flex flex-wrap gap-2 mt-0.5 text-muted-foreground">
                  {Object.entries(group.signals).map(([label, done]) => (
                    <StatusPill key={label} done={done} label={label} />
                  ))}
                </div>
                {group.detail && (
                  <div className="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap">
                    {group.detail}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={cn(
      'px-1.5 py-0.5 rounded text-[10px]',
      done ? 'bg-green-500/20 text-green-400' : 'bg-muted text-muted-foreground',
    )}>
      {label}
    </span>
  );
}
