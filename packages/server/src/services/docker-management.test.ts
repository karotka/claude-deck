import { describe, it, expect } from 'vitest';
import {
  DAY_MS,
  filterCleanupTargets,
  parseRunningForMs,
  toManagedVmContainer,
  type ManagedContainer,
} from './docker-management.js';
import type { VmContainer } from './vm-bridge.js';

const NOW = Date.parse('2026-08-20T12:00:00Z');
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function vmContainer(overrides: Partial<VmContainer> = {}): VmContainer {
  return {
    name: 'jira-agent-proj-1234',
    issueKey: 'PROJ-1234',
    state: 'running',
    status: 'Up 3 hours',
    runningFor: '3 hours ago',
    ...overrides,
  };
}

function managed(overrides: Partial<ManagedContainer> = {}): ManagedContainer {
  return {
    id: 'abc123',
    name: 'jira-agent-proj-1',
    image: 'jira-agent:latest',
    state: 'exited',
    status: 'Exited (0) 9 days ago',
    createdAt: '2026-08-01 10:00:00 +0200 CEST',
    createdAtIso: '2026-08-01T08:00:00.000Z',
    ageDays: 19,
    issueKey: 'PROJ-1',
    matchingSessionIds: [],
    hiddenInApp: true,
    location: 'local',
    ...overrides,
  };
}

describe('parseRunningForMs', () => {
  // The VM's `docker ps` table gives a humanized age instead of a timestamp,
  // and it is the only age signal the tab has for a remote container.
  it('parses every unit docker emits', () => {
    expect(parseRunningForMs('Less than a second ago')).toBe(0);
    expect(parseRunningForMs('1 second ago')).toBe(1_000);
    expect(parseRunningForMs('45 seconds ago')).toBe(45_000);
    expect(parseRunningForMs('About a minute ago')).toBe(MINUTE_MS);
    expect(parseRunningForMs('7 minutes ago')).toBe(7 * MINUTE_MS);
    expect(parseRunningForMs('About an hour ago')).toBe(HOUR_MS);
    expect(parseRunningForMs('3 hours ago')).toBe(3 * HOUR_MS);
    expect(parseRunningForMs('5 days ago')).toBe(5 * DAY_MS);
    expect(parseRunningForMs('2 weeks ago')).toBe(14 * DAY_MS);
    expect(parseRunningForMs('3 months ago')).toBe(90 * DAY_MS);
    expect(parseRunningForMs('2 years ago')).toBe(730 * DAY_MS);
  });

  it('tolerates the string without the trailing "ago"', () => {
    expect(parseRunningForMs('5 days')).toBe(5 * DAY_MS);
  });

  it('returns null for anything it does not recognise', () => {
    expect(parseRunningForMs('')).toBeNull();
    expect(parseRunningForMs('whenever')).toBeNull();
  });
});

describe('toManagedVmContainer', () => {
  it('derives the age the local scanner reads off CreatedAt', () => {
    const c = toManagedVmContainer(vmContainer({ runningFor: '5 days ago' }), NOW, []);

    expect(c.ageDays).toBe(5);
    expect(c.createdAtIso).toBe(new Date(NOW - 5 * DAY_MS).toISOString());
    // The humanized string is all the VM gives us — keep it for the row tooltip.
    expect(c.createdAt).toBe('5 days ago');
  });

  it('marks the row as remote and namespaces the id', () => {
    const c = toManagedVmContainer(vmContainer(), NOW, []);

    expect(c.location).toBe('vm');
    // The VM list carries no container ID, and the same agent can exist locally
    // and on the VM under the identical name — an un-namespaced id would give
    // two table rows the same React key.
    expect(c.id).toBe('vm:jira-agent-proj-1234');
    expect(c.name).toBe('jira-agent-proj-1234');
    expect(c.issueKey).toBe('PROJ-1234');
  });

  it('is hidden in app when no discovered session matches it', () => {
    const c = toManagedVmContainer(vmContainer(), NOW, []);

    expect(c.hiddenInApp).toBe(true);
    expect(c.matchingSessionIds).toEqual([]);
  });

  it('is visible when a discovered VM session matches it', () => {
    const c = toManagedVmContainer(vmContainer(), NOW, ['session-1']);

    expect(c.hiddenInApp).toBe(false);
    expect(c.matchingSessionIds).toEqual(['session-1']);
  });

  it('reports zero age when the duration is unreadable, so cleanup skips it', () => {
    const c = toManagedVmContainer(vmContainer({ runningFor: 'whenever' }), NOW, []);

    expect(c.ageDays).toBe(0);
    expect(c.createdAtIso).toBe(new Date(NOW).toISOString());
  });
});

describe('filterCleanupTargets', () => {
  const criteria = { olderThanDays: 7, onlyHidden: true, onlyStopped: true };

  it('keeps old, hidden, stopped containers from either location', () => {
    const local = managed();
    const vm = managed({ id: 'vm:jira-agent-proj-2', name: 'jira-agent-proj-2', location: 'vm' });

    expect(filterCleanupTargets([local, vm], criteria)).toEqual([local, vm]);
  });

  it('drops containers younger than the age threshold', () => {
    expect(filterCleanupTargets([managed({ ageDays: 3 })], criteria)).toEqual([]);
  });

  it('drops running containers unless onlyStopped is off', () => {
    const running = managed({ state: 'running' });

    expect(filterCleanupTargets([running], criteria)).toEqual([]);
    expect(filterCleanupTargets([running], { ...criteria, onlyStopped: false })).toEqual([running]);
  });

  it('drops containers still visible in the app unless onlyHidden is off', () => {
    const visible = managed({ hiddenInApp: false });

    expect(filterCleanupTargets([visible], criteria)).toEqual([]);
    expect(filterCleanupTargets([visible], { ...criteria, onlyHidden: false })).toEqual([visible]);
  });
});
