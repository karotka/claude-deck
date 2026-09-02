import type { ParsedMessage } from './api';

/** Longest one-line preview shown on a collapsed tool row. */
export const SUMMARY_MAX_CHARS = 120;

/** Keys that identify a tool call, most specific first. */
const IDENTIFYING_KEYS = [
  'file_path',
  'command',
  'pattern',
  'url',
  'path',
  'query',
  'prompt',
  'description',
  'notebook_path',
] as const;

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim();
}

function cap(value: string): string {
  return value.length > SUMMARY_MAX_CHARS ? `${value.slice(0, SUMMARY_MAX_CHARS)}…` : value;
}

/**
 * One-line gist of a tool call's input, for the collapsed row. Falls back to
 * compact JSON so an unrecognised tool still shows something meaningful rather
 * than a bare name.
 */
export function summarizeToolInput(_name: string, input: unknown): string {
  if (input == null || typeof input !== 'object') {
    return input == null ? '' : cap(oneLine(String(input)));
  }
  const record = input as Record<string, unknown>;
  for (const key of IDENTIFYING_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return cap(oneLine(value));
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return '';
  return cap(oneLine(JSON.stringify(record)));
}

/**
 * `tool_result.content` arrives as a plain string, an array of content blocks,
 * or an object, depending on the tool and CLI version. Flatten all three to
 * text so the expanded row can render it.
 */
export function normalizeToolResult(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as { type?: string; text?: string };
          if (b.type === 'text') return b.text ?? '';
          return `[${b.type ?? 'block'}]`;
        }
        return String(block);
      })
      .join('\n');
  }
  return JSON.stringify(content, null, 2);
}

/** First meaningful line of a tool result, plus its size when it spans more. */
export function summarizeToolResult(text: string): string {
  if (!text.trim()) return '(empty)';
  const lines = text.split('\n');
  const first = lines.find(l => l.trim()) ?? '';
  const preview = cap(oneLine(first));
  return lines.length > 1 ? `${preview}  (${lines.length} lines)` : preview;
}

/** Label for the dim divider rows that stand in for non-conversational turns. */
export function formatSystemEvent(message: ParsedMessage): string {
  if (message.type === 'permission-mode') {
    return `permission-mode → ${message.permissionMode ?? 'unknown'}`;
  }
  if (message.type === 'file-history-snapshot') {
    return 'file history snapshot';
  }
  if (message.type === 'system') {
    const head = message.subtype ? `system: ${message.subtype}` : 'system';
    const parts: string[] = [];
    if (message.cwd) parts.push(`cwd=${message.cwd}`);
    if (message.gitBranch) parts.push(`branch=${message.gitBranch}`);
    if (message.claudeVersion) parts.push(`v${message.claudeVersion}`);
    return [head, ...parts].join('  ');
  }
  return message.type;
}

/**
 * Turns are identified by `seq` — a stable, append-only index the server puts on
 * every turn. Older transcripts parsed before that existed fall back to
 * type+timestamp, which is unique enough to avoid duplicate rows.
 */
function turnKey(turn: ParsedMessage): string {
  return turn.seq != null ? `s${turn.seq}` : `${turn.type}|${turn.timestamp}`;
}

/**
 * Cheap stand-in for deep equality. The transcript is append-only, so a turn
 * only ever changes by gaining blocks or text — comparing block count, latest
 * timestamp and total text length catches that without stringifying payloads
 * that can run to hundreds of KB.
 */
function fingerprint(turn: ParsedMessage): string {
  const blocks = turn.content ?? [];
  let textLen = 0;
  for (const block of blocks) {
    textLen += (block.text?.length ?? 0) + (block.name?.length ?? 0);
  }
  return `${blocks.length}|${turn.timestamp}|${textLen}`;
}

/**
 * Fold a freshly fetched page (newer tail or older page) into the turns already
 * on screen. Returns the *same array reference* when nothing changed, so an
 * idle poll doesn't re-render the whole transcript.
 */
export function mergeTurns(existing: ParsedMessage[], incoming: ParsedMessage[]): ParsedMessage[] {
  if (incoming.length === 0) return existing;

  const byKey = new Map<string, ParsedMessage>();
  for (const turn of existing) byKey.set(turnKey(turn), turn);

  let changed = false;
  for (const turn of incoming) {
    const key = turnKey(turn);
    const current = byKey.get(key);
    if (!current || fingerprint(current) !== fingerprint(turn)) {
      byKey.set(key, turn);
      changed = true;
    }
  }
  if (!changed) return existing;

  return [...byKey.values()].sort((a, b) => {
    if (a.seq != null && b.seq != null) return a.seq - b.seq;
    return a.timestamp.localeCompare(b.timestamp);
  });
}
