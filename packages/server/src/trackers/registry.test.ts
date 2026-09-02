import { describe, it, expect, beforeEach } from 'vitest';
import { registerTracker, getTracker, resetTracker } from './registry.js';
import type { Tracker } from './types.js';

function tracker(configured: boolean): Tracker {
  return {
    id: 'test',
    label: 'Test',
    isConfigured: () => configured,
    lookup: async () => new Map(),
  };
}

beforeEach(resetTracker);

describe('getTracker', () => {
  it('reports none when this installation has no tracker', () => {
    expect(getTracker()).toBeNull();
  });

  it('hides a registered tracker that is not configured', () => {
    // Registration is unconditional; being usable is not. The UI hides the
    // status column rather than showing errors from a tracker with no
    // credentials.
    registerTracker(tracker(false));
    expect(getTracker()).toBeNull();
  });

  it('returns a configured tracker', () => {
    const t = tracker(true);
    registerTracker(t);
    expect(getTracker()).toBe(t);
  });
});
