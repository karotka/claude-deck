import { describe, it, expect } from 'vitest';
import { sessionWorkItems, MAX_SECONDARY } from './session-work-items.js';
import type { Tracker, WorkItem } from '../trackers/types.js';

function item(tag: string): WorkItem {
  return { tag, status: 'In Progress', state: 'inprogress', summary: null, url: null };
}

/** A tracker that knows exactly the tags it was told about. */
function trackerKnowing(...known: string[]): Tracker {
  return {
    id: 'test',
    label: 'Test',
    isConfigured: () => true,
    lookup: async tags =>
      new Map(tags.filter(t => known.includes(t)).map(t => [t, item(t)])),
  };
}

/** A conversation where the person raised every tag themselves. */
const said = (text: string) => ({ user: text, all: text });

describe('without a tracker', () => {
  it('reports the primary and nothing else', async () => {
    // Every other candidate would be a string that merely looks like a key,
    // and nothing local can tell those apart — so claiming them is guessing.
    const res = await sessionWorkItems('PROJ-1', said('PROJ-2'), null);
    expect(res.tags).toEqual([{ tag: 'PROJ-1', mentions: 0 }]);
    expect(res.trackerConfigured).toBe(false);
  });

  it('reports nothing at all for a session with no primary', async () => {
    // The case that exposed the first cut: a session that discusses ticket
    // handling without touching a ticket listed half a dozen of them.
    const res = await sessionWorkItems(null, said('PROJ-2'), null);
    expect(res.tags).toEqual([]);
  });
});

describe('with a tracker', () => {
  it('keeps a repeatedly-mentioned item the tracker recognises', async () => {
    const res = await sessionWorkItems(null, said('PROJ-2'), trackerKnowing('PROJ-2'));
    expect(res.tags).toEqual([{ tag: 'PROJ-2', mentions: 1 }]);
    expect(res.items['PROJ-2'].state).toBe('inprogress');
  });

  it('drops a key only Claude ever said', async () => {
    // A session that discusses ticket handling quotes plenty of keys. Counting
    // those filled the sidebar with tickets the session had nothing to do with;
    // what the *person* raised is the signal.
    const res = await sessionWorkItems(
      null,
      { user: 'nothing here', all: 'I printed PROJ-2 PROJ-2 PROJ-2 as an example' },
      trackerKnowing('PROJ-2'),
    );
    expect(res.tags).toEqual([]);
  });

  it('caps the list, keeping the most-mentioned', async () => {
    // A long session touches dozens; all of them is a wall, not a list.
    const tags = Array.from({ length: 12 }, (_, i) => `PROJ-${i + 1}`);
    // Later tags are repeated more, so they should lead.
    const all = tags.flatMap((t, i) => Array(i + 1).fill(t)).join(' ');
    const res = await sessionWorkItems(null, { user: tags.join(' '), all }, trackerKnowing(...tags));
    expect(res.tags).toHaveLength(MAX_SECONDARY);
    expect(res.tags[0].tag).toBe('PROJ-12');
  });

  it('drops a lookalike the tracker does not recognise', async () => {
    // "CLAUDE-502" is a directory name; it matches every pattern a key does.
    const res = await sessionWorkItems(null, said('CLAUDE-502'), trackerKnowing('PROJ-2'));
    expect(res.tags).toEqual([]);
  });

  it('puts the primary first and never counts it as a mention', async () => {
    const res = await sessionWorkItems(
      'PROJ-1', said('PROJ-2 PROJ-1'), trackerKnowing('PROJ-1', 'PROJ-2'),
    );
    expect(res.tags.map(t => t.tag)).toEqual(['PROJ-1', 'PROJ-2']);
    expect(res.tags[0].mentions).toBe(0);
  });

  it('keeps the primary even when the tracker has never heard of it', async () => {
    // The container is named after it. That is a fact about this machine, not
    // a claim about the tracker's contents.
    const res = await sessionWorkItems('PROJ-1', said(''), trackerKnowing());
    expect(res.tags).toEqual([{ tag: 'PROJ-1', mentions: 0 }]);
    expect(res.items).toEqual({});
  });

  it('does not call the tracker when there is nothing to ask about', async () => {
    let called = false;
    const tracker: Tracker = {
      ...trackerKnowing(),
      lookup: async tags => { called = true; return new Map(); },
    };
    const res = await sessionWorkItems(null, said('nothing key-shaped here'), tracker);
    expect(res.tags).toEqual([]);
    expect(called).toBe(false);
  });
});
