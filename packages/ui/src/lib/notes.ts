import { saveSessionNote } from './api';

/**
 * Where session notes lived before they were persisted server-side. Notes under
 * this key only ever existed in one browser, so they are pushed up once and the
 * key is dropped.
 */
export const LEGACY_NOTES_KEY = 'claude-monitor-session-notes';

export interface NoteStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export function readLegacyNotes(storage: NoteStorage): Record<string, string> {
  try {
    const raw = storage.getItem(LEGACY_NOTES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/** The server is the source of truth, so it wins wherever both have a note. */
export function legacyOnlyNotes(
  legacy: Record<string, string>,
  server: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(legacy).filter(([id, note]) => note.trim() && !server[id]),
  );
}

/** A note whose write is still in flight; null means "being cleared". */
export type PendingNotes = Record<string, string | null>;

/**
 * Locally-committed notes win over polled server state until their write lands,
 * so a just-typed note doesn't blink away when a poll started before the save.
 */
export function mergePendingNotes(
  server: Record<string, string>,
  pending: PendingNotes,
): Record<string, string> {
  const merged = { ...server };
  for (const [id, note] of Object.entries(pending)) {
    if (note) merged[id] = note;
    else delete merged[id];
  }
  return merged;
}

export async function migrateLegacyNotes(
  serverNotes: Record<string, string>,
  deps: {
    storage?: NoteStorage;
    save?: (sessionId: string, note: string) => Promise<void>;
  } = {},
): Promise<Record<string, string>> {
  const storage = deps.storage ?? localStorage;
  const save = deps.save ?? saveSessionNote;

  const legacy = readLegacyNotes(storage);
  if (Object.keys(legacy).length === 0) return serverNotes;

  const pending = legacyOnlyNotes(legacy, serverNotes);
  try {
    for (const [id, note] of Object.entries(pending)) {
      await save(id, note.trim());
    }
  } catch {
    // Leave the legacy key in place so the notes survive until the next load.
    return { ...serverNotes, ...pending };
  }

  storage.removeItem(LEGACY_NOTES_KEY);
  return { ...serverNotes, ...pending };
}
