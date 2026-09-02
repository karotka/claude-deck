import type { SubagentInfo } from '../lib/api';
import { formatTokens, formatCost, timeAgo } from '../lib/utils';

export function SubagentTree({ subagents }: { subagents: SubagentInfo[] }) {
  if (subagents.length === 0) return null;

  const totalCost = subagents.reduce((sum, sa) => sum + sa.estimatedCost, 0);

  return (
    <div className="rounded-md border border-border bg-muted/50 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-sm font-medium">Subagents ({subagents.length})</div>
        <div className="text-xs text-muted-foreground">{formatCost(totalCost)} total</div>
      </div>
      <div className="space-y-2">
        {subagents.map((sa) => (
          <div key={sa.agentId} className="text-xs border-l-2 border-muted-foreground/30 pl-3">
            <div className="font-medium">{sa.agentType}</div>
            <div className="text-muted-foreground">{sa.description}</div>
            <div className="text-muted-foreground mt-0.5">
              {sa.messageCount} msgs &middot; {formatTokens(sa.totalOutputTokens)} out &middot; {formatCost(sa.estimatedCost)}
              {sa.lastActivityAt && <> &middot; {timeAgo(sa.lastActivityAt)}</>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
