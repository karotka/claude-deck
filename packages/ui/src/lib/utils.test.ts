import { describe, it, expect } from 'vitest';
import {
  parseTags,
  containersWithFinishedWork,
  containerLabel,
  filterContainers,
  vmRemovalWarning,
} from './utils';
import type { ManagedContainer, Session, WorkItem, WorkItemState } from './api';

function session(overrides: Partial<Session>): Session {
  return { id: 's1', source: 'local', firstUserMessage: '', ...overrides } as Session;
}

function container(
  name: string,
  issueKey: string | null,
  overrides: Partial<ManagedContainer> = {},
): ManagedContainer {
  return {
    id: name,
    name,
    image: 'jira-agent',
    state: 'exited',
    status: 'Exited (0)',
    createdAt: '',
    createdAtIso: '2026-07-01T00:00:00.000Z',
    ageDays: 5,
    issueKey,
    matchingSessionIds: [],
    hiddenInApp: false,
    location: 'local',
    ...overrides,
  };
}

/** The default tag shape, which is what the server publishes unless configured. */
const TAG_PATTERN = '[A-Z][A-Z0-9]+-\\d+';

function item(tag: string, state: WorkItemState): WorkItem {
  return { tag, status: state, state, summary: null, url: null };
}

describe('parseTags', () => {
  it('splits keys separated by commas, spaces, and newlines', () => {
    expect(parseTags('PROJ-1, PROJ-2\nOPS-3 PROJ-4', TAG_PATTERN)).toEqual([
      'PROJ-1',
      'PROJ-2',
      'OPS-3',
      'PROJ-4',
    ]);
  });

  it('upper-cases keys and preserves first-seen order', () => {
    expect(parseTags('proj-7901 ops-3456', TAG_PATTERN)).toEqual(['PROJ-7901', 'OPS-3456']);
  });

  it('drops duplicates (case-insensitive)', () => {
    expect(parseTags('PROJ-1, proj-1, PROJ-2', TAG_PATTERN)).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('ignores tokens that are not full issue keys', () => {
    expect(parseTags('PROJ- , 1234, hello, PROJ-42', TAG_PATTERN)).toEqual(['PROJ-42']);
  });

  it('returns an empty array for blank or prefix-only input', () => {
    expect(parseTags('', TAG_PATTERN)).toEqual([]);
    expect(parseTags('   ', TAG_PATTERN)).toEqual([]);
    expect(parseTags('PROJ-', TAG_PATTERN)).toEqual([]);
  });
});

describe('containersWithFinishedWork', () => {
  const items: Record<string, WorkItem> = {
    'PROJ-1': item('PROJ-1', 'done'),
    'PROJ-2': item('PROJ-2', 'inprogress'),
    'PROJ-3': item('PROJ-3', 'todo'),
    'PROJ-4': item('PROJ-4', 'unknown'),
  };

  it('keeps only containers whose work item is finished', () => {
    const done = container('jira-agent-proj-1', 'PROJ-1');
    const others = [
      container('jira-agent-proj-2', 'PROJ-2'),
      container('jira-agent-proj-3', 'PROJ-3'),
      container('jira-agent-proj-4', 'PROJ-4'),
    ];
    expect(containersWithFinishedWork([done, ...others], items)).toEqual([done]);
  });

  it('excludes containers with no issue key', () => {
    const c = container('orphan', null);
    expect(containersWithFinishedWork([c], items)).toEqual([]);
  });

  it('excludes containers whose tag has no item yet, since unknown is not done', () => {
    const c = container('jira-agent-proj-9', 'PROJ-9');
    expect(containersWithFinishedWork([c], items)).toEqual([]);
  });

  it('returns an empty array when nothing is done', () => {
    expect(containersWithFinishedWork([], items)).toEqual([]);
    expect(containersWithFinishedWork([container('c', 'PROJ-2')], items)).toEqual([]);
  });
});

describe('containerLabel', () => {
  it('names where a container-backed session runs', () => {
    expect(containerLabel(session({
      source: 'remote',
      target: { kind: 'remote', ref: 'PROJ-1234', label: 'jira-agent-proj-1234' },
    }))).toBe('Remote: jira-agent-proj-1234');
    expect(containerLabel(session({
      source: 'docker',
      target: { kind: 'docker', ref: 'jira-agent-proj-1234' },
    }))).toBe('Docker: jira-agent-proj-1234');
  });

  it('returns null for a plain local session, whose project name reads better', () => {
    expect(containerLabel(session({ source: 'local' }))).toBeNull();
    expect(containerLabel(session({ source: 'tmux', target: { kind: 'tmux', ref: 'jira-PROJ-1' } }))).toBeNull();
  });
});

describe('filterContainers', () => {
  const localRunning = container('jira-agent-proj-1', 'PROJ-1', { state: 'running' });
  const localExited = container('jira-agent-proj-2', 'PROJ-2', { hiddenInApp: true });
  const vmRunning = container('jira-agent-proj-3', 'PROJ-3', {
    state: 'running',
    location: 'vm',
  });
  const all = [localRunning, localExited, vmRunning];
  const noFilters = { state: 'all', location: 'all', hiddenOnly: false } as const;

  it('returns everything when nothing is narrowed', () => {
    expect(filterContainers(all, noFilters)).toEqual(all);
  });

  it('narrows to one docker daemon', () => {
    expect(filterContainers(all, { ...noFilters, location: 'vm' })).toEqual([vmRunning]);
    expect(filterContainers(all, { ...noFilters, location: 'local' }))
      .toEqual([localRunning, localExited]);
  });

  it('combines state, location and hidden filters', () => {
    expect(filterContainers(all, { ...noFilters, state: 'running', location: 'local' }))
      .toEqual([localRunning]);
    expect(filterContainers(all, { ...noFilters, hiddenOnly: true })).toEqual([localExited]);
    expect(filterContainers(all, { ...noFilters, state: 'exited', location: 'vm' })).toEqual([]);
  });
});

describe('vmRemovalWarning', () => {
  it('says nothing when every target is local', () => {
    expect(vmRemovalWarning([container('jira-agent-proj-1', 'PROJ-1')])).toBe('');
  });

  it('warns that a VM removal also destroys the transcript', () => {
    const targets = [
      container('jira-agent-proj-1', 'PROJ-1'),
      container('jira-agent-proj-2', 'PROJ-2', { location: 'vm' }),
      container('jira-agent-proj-3', 'PROJ-3', { location: 'vm' }),
    ];

    const warning = vmRemovalWarning(targets);

    // The VM's rm drops the session volume too, unlike the local one — the
    // dialog has to say so before someone deletes a transcript by habit.
    expect(warning).toContain('2');
    expect(warning).toMatch(/session volume/i);
    expect(warning).toMatch(/transcript/i);
  });
});
