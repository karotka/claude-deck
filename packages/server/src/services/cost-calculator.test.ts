import { describe, it, expect } from 'vitest';
import { calculateCost, formatCost } from './cost-calculator.js';

const USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheCreationTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
};

describe('calculateCost', () => {
  it('prices a model id that matches the pricing table exactly', () => {
    // claude-sonnet-5: $3 in / $15 out / $3.75 cache-write / $0.30 cache-read per MTok
    expect(calculateCost('claude-sonnet-5', USAGE)).toBeCloseTo(3 + 15 + 3.75 + 0.3, 5);
  });

  it('prices every model id actually observed in ~/.claude/projects JSONLs', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-fable-5']) {
      expect(calculateCost(model, USAGE)).toBeGreaterThan(0);
    }
  });

  it('strips a dated snapshot suffix to match the base model id', () => {
    // haiku-4-5 ships as claude-haiku-4-5-20251001 in real transcripts, but the
    // pricing table is keyed by the bare alias.
    const dated = calculateCost('claude-haiku-4-5-20251001', USAGE);
    const bare = calculateCost('claude-haiku-4-5', USAGE);
    expect(dated).toBeGreaterThan(0);
    expect(dated).toBe(bare);
  });

  it('treats the bare "haiku" shorthand as claude-haiku-4-5', () => {
    expect(calculateCost('haiku', USAGE)).toBe(calculateCost('claude-haiku-4-5', USAGE));
  });

  it('returns 0 for synthetic (non-billed) turns', () => {
    expect(calculateCost('<synthetic>', USAGE)).toBe(0);
  });

  it('returns 0 for an unrecognized model id rather than throwing', () => {
    expect(calculateCost('some-future-model-nobody-has-heard-of', USAGE)).toBe(0);
  });

  it('scales linearly with usage', () => {
    const half = calculateCost('claude-opus-5', { ...USAGE, inputTokens: 500_000 });
    const full = calculateCost('claude-opus-5', USAGE);
    expect(half).toBeCloseTo(full - 2.5, 5); // opus-5 input is $5/MTok
  });
});

describe('formatCost', () => {
  it('shows extra precision for sub-cent amounts', () => {
    expect(formatCost(0.0042)).toBe('$0.0042');
  });

  it('shows two decimal places once a cost reaches a cent', () => {
    expect(formatCost(1.2345)).toBe('$1.23');
  });

  it('formats zero as a plain dollar amount', () => {
    expect(formatCost(0)).toBe('$0.0000');
  });
});
