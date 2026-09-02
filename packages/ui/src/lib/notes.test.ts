import { describe, it, expect, vi } from 'vitest';
import {
  LEGACY_NOTES_KEY,
  legacyOnlyNotes,
  mergePendingNotes,
  migrateLegacyNotes,
  readLegacyNotes,
  type NoteStorage,
} from './notes';

const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER_SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

function storageWith(value: string | null): NoteStorage & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    getItem: (key: string) => (key === LEGACY_NOTES_KEY ? value : null),
    removeItem: (key: string) => {
      removed.push(key);
    },
  };
}

describe('readLegacyNotes', () => {
  it('reads the browser-local notes written by the old build', () => {
    const storage = storageWith(JSON.stringify({ [SESSION_ID]: 'local note' }));
    expect(readLegacyNotes(storage)).toEqual({ [SESSION_ID]: 'local note' });
  });

  it('returns nothing when the key is absent or unreadable', () => {
    expect(readLegacyNotes(storageWith(null))).toEqual({});
    expect(readLegacyNotes(storageWith('{not json'))).toEqual({});
    expect(readLegacyNotes(storageWith(JSON.stringify(['nope'])))).toEqual({});
  });
});

describe('legacyOnlyNotes', () => {
  it('keeps only notes the server does not have yet', () => {
    const legacy = { [SESSION_ID]: 'local only', [OTHER_SESSION_ID]: 'stale local' };
    const server = { [OTHER_SESSION_ID]: 'server wins' };

    expect(legacyOnlyNotes(legacy, server)).toEqual({ [SESSION_ID]: 'local only' });
  });

  it('drops blank legacy notes', () => {
    expect(legacyOnlyNotes({ [SESSION_ID]: '   ' }, {})).toEqual({});
  });
});

describe('mergePendingNotes', () => {
  it('keeps a just-typed note that the polled server state does not have yet', () => {
    const merged = mergePendingNotes(
      { [OTHER_SESSION_ID]: 'from server' },
      { [SESSION_ID]: 'just typed' },
    );
    expect(merged).toEqual({
      [OTHER_SESSION_ID]: 'from server',
      [SESSION_ID]: 'just typed',
    });
  });

  it('keeps a just-cleared note cleared', () => {
    expect(mergePendingNotes({ [SESSION_ID]: 'stale' }, { [SESSION_ID]: null })).toEqual({});
  });

  it('passes server state through when nothing is in flight', () => {
    expect(mergePendingNotes({ [SESSION_ID]: 'from server' }, {})).toEqual({
      [SESSION_ID]: 'from server',
    });
  });
});

describe('migrateLegacyNotes', () => {
  it('uploads browser-local notes and drops the legacy key', async () => {
    const storage = storageWith(JSON.stringify({ [SESSION_ID]: 'local only' }));
    const save = vi.fn().mockResolvedValue(undefined);

    const merged = await migrateLegacyNotes({ [OTHER_SESSION_ID]: 'from server' }, { storage, save });

    expect(save).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'local only');
    expect(storage.removed).toEqual([LEGACY_NOTES_KEY]);
    expect(merged).toEqual({
      [OTHER_SESSION_ID]: 'from server',
      [SESSION_ID]: 'local only',
    });
  });

  it('does not re-upload notes the server already has', async () => {
    const storage = storageWith(JSON.stringify({ [SESSION_ID]: 'stale local' }));
    const save = vi.fn().mockResolvedValue(undefined);

    const merged = await migrateLegacyNotes({ [SESSION_ID]: 'server wins' }, { storage, save });

    expect(save).not.toHaveBeenCalled();
    expect(storage.removed).toEqual([LEGACY_NOTES_KEY]);
    expect(merged).toEqual({ [SESSION_ID]: 'server wins' });
  });

  it('keeps the legacy key when the upload fails, so nothing is lost', async () => {
    const storage = storageWith(JSON.stringify({ [SESSION_ID]: 'local only' }));
    const save = vi.fn().mockRejectedValue(new Error('offline'));

    const merged = await migrateLegacyNotes({}, { storage, save });

    expect(storage.removed).toEqual([]);
    expect(merged).toEqual({ [SESSION_ID]: 'local only' });
  });

  it('is a no-op when there is nothing in local storage', async () => {
    const storage = storageWith(null);
    const save = vi.fn().mockResolvedValue(undefined);

    const merged = await migrateLegacyNotes({ [SESSION_ID]: 'from server' }, { storage, save });

    expect(save).not.toHaveBeenCalled();
    expect(storage.removed).toEqual([]);
    expect(merged).toEqual({ [SESSION_ID]: 'from server' });
  });
});
