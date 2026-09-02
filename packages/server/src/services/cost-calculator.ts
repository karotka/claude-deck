import { config } from '../config.js';
import type { TokenUsage } from '../types.js';

// Shorthand model ids Claude Code sometimes writes in place of the full id
// (e.g. a subagent's `.meta.json`, or older transcript formats).
const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
};

/**
 * Resolve a raw model id from a JSONL transcript to a pricing-table key.
 * Real transcripts contain dated snapshots (`claude-haiku-4-5-20251001`),
 * bare aliases (`haiku`), and non-billed markers (`<synthetic>`) alongside
 * plain ids (`claude-opus-5`) — this normalizes all of them onto the keys in
 * `config.pricing` so a model isn't silently priced at $0 just because its
 * id has a suffix the pricing table doesn't.
 */
function resolvePricingKey(model: string): string | null {
  if (!model) return null;
  if (config.pricing[model]) return model;

  const aliased = MODEL_ALIASES[model];
  if (aliased && config.pricing[aliased]) return aliased;

  // Strip a trailing dated-snapshot suffix, e.g. "-20251001".
  const withoutDate = model.replace(/-\d{8}$/, '');
  if (config.pricing[withoutDate]) return withoutDate;

  return null;
}

export function calculateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
): number {
  const key = resolvePricingKey(model);
  const pricing = key ? config.pricing[key] : undefined;
  if (!pricing) return 0;

  const perM = 1_000_000;
  return (
    (usage.inputTokens / perM) * pricing.input +
    (usage.outputTokens / perM) * pricing.output +
    (usage.cacheCreationTokens / perM) * pricing.cacheWrite +
    (usage.cacheReadTokens / perM) * pricing.cacheRead
  );
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
