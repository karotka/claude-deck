import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Free-text note the user pins to a session ("waiting on review", "flaky test
 * repro"). Kept server-side rather than in the browser so the same note shows
 * up on every device pointed at this monitor — a note typed on the desktop is
 * visible on the phone.
 */
export const NOTES_FILE_NAME = '.claude-monitor-notes.json';

const notesFilePath = path.join(config.claudeDir, NOTES_FILE_NAME);

let notes = new Map<string, string>();

function isNoteMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadSessionNotes(): Promise<void> {
  try {
    const data = await fsp.readFile(notesFilePath, 'utf-8');
    const parsed: unknown = JSON.parse(data);
    const entries: [string, string][] = isNoteMap(parsed)
      ? Object.entries(parsed)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([id, note]): [string, string] => [id, note.trim()])
          .filter(([, note]) => note.length > 0)
      : [];
    notes = new Map(entries);
  } catch {
    notes = new Map();
  }
}

async function save(): Promise<void> {
  await fsp.writeFile(notesFilePath, JSON.stringify(Object.fromEntries(notes)), 'utf-8');
}

export function getSessionNotes(): Record<string, string> {
  return Object.fromEntries(notes);
}

export function getSessionNote(sessionId: string): string | undefined {
  return notes.get(sessionId);
}

/** An empty or blank note clears the entry. */
export async function setSessionNote(sessionId: string, note: string): Promise<void> {
  const trimmed = note.trim();
  if (trimmed) notes.set(sessionId, trimmed);
  else if (!notes.delete(sessionId)) return;
  await save();
}
