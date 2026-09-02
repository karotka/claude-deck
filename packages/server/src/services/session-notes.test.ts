import { describe, it, expect, beforeEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// config.claudeDir is captured when the module is first imported, so the temp
// dir has to be in the environment before session-notes (and config) load.
const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-monitor-notes-'));
process.env.CLAUDE_DIR = tmpDir;

const {
  NOTES_FILE_NAME,
  loadSessionNotes,
  getSessionNotes,
  getSessionNote,
  setSessionNote,
} = await import('./session-notes.js');

const notesFile = path.join(tmpDir, NOTES_FILE_NAME);
const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER_SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

async function writeNotesFile(contents: string): Promise<void> {
  await fsp.writeFile(notesFile, contents, 'utf-8');
}

beforeEach(async () => {
  await fsp.rm(notesFile, { force: true });
  await loadSessionNotes();
});

describe('session notes store', () => {
  it('starts empty when no notes file exists yet', () => {
    expect(getSessionNotes()).toEqual({});
    expect(getSessionNote(SESSION_ID)).toBeUndefined();
  });

  it('persists a note so another client reading the file sees it', async () => {
    await setSessionNote(SESSION_ID, 'waiting on review');

    // A phone hitting the API is a different process/load — reload from disk.
    await loadSessionNotes();

    expect(getSessionNote(SESSION_ID)).toBe('waiting on review');
    expect(getSessionNotes()).toEqual({ [SESSION_ID]: 'waiting on review' });
  });

  it('keeps notes for other sessions when one is updated', async () => {
    await setSessionNote(SESSION_ID, 'first');
    await setSessionNote(OTHER_SESSION_ID, 'second');
    await setSessionNote(SESSION_ID, 'first updated');

    await loadSessionNotes();

    expect(getSessionNotes()).toEqual({
      [SESSION_ID]: 'first updated',
      [OTHER_SESSION_ID]: 'second',
    });
  });

  it('trims surrounding whitespace', async () => {
    await setSessionNote(SESSION_ID, '   padded note \n');
    expect(getSessionNote(SESSION_ID)).toBe('padded note');
  });

  it('clears the note when set to an empty or blank string', async () => {
    await setSessionNote(SESSION_ID, 'temporary');
    await setSessionNote(SESSION_ID, '   ');

    await loadSessionNotes();

    expect(getSessionNote(SESSION_ID)).toBeUndefined();
    expect(getSessionNotes()).toEqual({});
  });

  it('hands back a snapshot that cannot mutate the store', async () => {
    await setSessionNote(SESSION_ID, 'stable');

    const snapshot = getSessionNotes();
    snapshot[SESSION_ID] = 'tampered';
    delete snapshot[OTHER_SESSION_ID];

    expect(getSessionNote(SESSION_ID)).toBe('stable');
  });

  it('falls back to empty notes when the file is corrupt', async () => {
    await writeNotesFile('{not json');

    await loadSessionNotes();

    expect(getSessionNotes()).toEqual({});
  });

  it('ignores a file whose contents are not a note map', async () => {
    await writeNotesFile(JSON.stringify(['nope']));

    await loadSessionNotes();

    expect(getSessionNotes()).toEqual({});
  });
});
