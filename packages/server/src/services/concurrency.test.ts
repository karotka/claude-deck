import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([...Array(24).keys()], 4, async n => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n;
    });

    // The point of the limit: 24 containers must not spawn 24 processes at once.
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('returns results in input order, not completion order', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async n => {
      await new Promise(resolve => setTimeout(resolve, n));
      return n;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it('passes the index to the worker', async () => {
    const seen = await mapWithConcurrency(['a', 'b', 'c'], 2, async (v, i) => `${i}:${v}`);
    expect(seen).toEqual(['0:a', '1:b', '2:c']);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async v => v)).toEqual([]);
  });

  it('propagates a worker rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async n => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
