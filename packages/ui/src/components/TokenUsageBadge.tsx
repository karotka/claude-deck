import { formatTokens, formatCost } from '../lib/utils';

interface Props {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export function TokenUsageBadge({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost }: Props) {
  return (
    <div className="rounded-md border border-border bg-muted/50 p-3 text-sm space-y-1">
      <div className="font-medium mb-2">Token Usage</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-muted-foreground">Input</span>
        <span>{formatTokens(inputTokens)}</span>
        <span className="text-muted-foreground">Output</span>
        <span>{formatTokens(outputTokens)}</span>
        <span className="text-muted-foreground">Cache Read</span>
        <span>{formatTokens(cacheReadTokens)}</span>
        <span className="text-muted-foreground">Cache Write</span>
        <span>{formatTokens(cacheWriteTokens)}</span>
      </div>
      <div className="pt-2 border-t border-border mt-2 text-sm font-medium">
        Est. Cost: {formatCost(cost)}
      </div>
    </div>
  );
}
