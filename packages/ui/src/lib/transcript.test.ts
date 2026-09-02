import { describe, it, expect } from 'vitest';
import {
  summarizeToolInput,
  normalizeToolResult,
  summarizeToolResult,
  formatSystemEvent,
  mergeTurns,
  SUMMARY_MAX_CHARS,
} from './transcript';
import type { ParsedMessage } from './api';

function turn(seq: number, type: ParsedMessage['type'], text?: string): ParsedMessage {
  return {
    seq,
    type,
    timestamp: `2026-07-02T08:${String(seq).padStart(2, '0')}:00.000Z`,
    content: text ? [{ type: 'text', text }] : [],
  };
}

describe('summarizeToolInput', () => {
  it('prefers the most identifying key for each tool', () => {
    expect(summarizeToolInput('Read', { file_path: '/tmp/a.ts', offset: 3 })).toBe('/tmp/a.ts');
    expect(summarizeToolInput('Bash', { command: 'ls -la', description: 'List files' })).toBe('ls -la');
    expect(summarizeToolInput('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO');
    expect(summarizeToolInput('WebFetch', { url: 'https://example.com' })).toBe('https://example.com');
    expect(summarizeToolInput('Agent', { description: 'Find flaky tests' })).toBe('Find flaky tests');
  });

  it('collapses newlines so a row stays one line', () => {
    expect(summarizeToolInput('Bash', { command: 'set -e\ncd /tmp\nls' })).toBe('set -e ⏎ cd /tmp ⏎ ls');
  });

  it('caps long values', () => {
    const long = 'x'.repeat(500);
    const out = summarizeToolInput('Bash', { command: long });
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to compact JSON when no known key is present', () => {
    expect(summarizeToolInput('Weird', { alpha: 1, beta: 'two' })).toBe('{"alpha":1,"beta":"two"}');
  });

  it('returns an empty string for absent or empty input', () => {
    expect(summarizeToolInput('Read', undefined)).toBe('');
    expect(summarizeToolInput('Read', {})).toBe('');
    expect(summarizeToolInput('Read', null)).toBe('');
  });
});

describe('normalizeToolResult', () => {
  it('passes plain strings through', () => {
    expect(normalizeToolResult('all good')).toBe('all good');
  });

  it('joins the text blocks of an array payload', () => {
    expect(
      normalizeToolResult([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond');
  });

  it('describes non-text blocks rather than dropping them', () => {
    expect(normalizeToolResult([{ type: 'image', source: { type: 'base64' } }])).toBe('[image]');
  });

  it('stringifies object payloads', () => {
    expect(normalizeToolResult({ ok: true })).toBe('{\n  "ok": true\n}');
  });

  it('returns an empty string for null/undefined', () => {
    expect(normalizeToolResult(null)).toBe('');
    expect(normalizeToolResult(undefined)).toBe('');
  });
});

describe('summarizeToolResult', () => {
  it('shows the first non-empty line plus a line count', () => {
    expect(summarizeToolResult('\n\nfirst line\nsecond\nthird')).toBe('first line  (5 lines)');
  });

  it('omits the count for a single line', () => {
    expect(summarizeToolResult('only line')).toBe('only line');
  });

  it('caps the preview line', () => {
    const out = summarizeToolResult('y'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 1);
  });

  it('labels an empty result', () => {
    expect(summarizeToolResult('')).toBe('(empty)');
    expect(summarizeToolResult('   \n  ')).toBe('(empty)');
  });
});

describe('formatSystemEvent', () => {
  it('renders a permission-mode change', () => {
    expect(formatSystemEvent({ ...turn(0, 'permission-mode'), permissionMode: 'acceptEdits' })).toBe(
      'permission-mode → acceptEdits',
    );
  });

  it('renders a system line with the fields it carries', () => {
    const msg: ParsedMessage = {
      ...turn(0, 'system'),
      subtype: 'init',
      cwd: '/workspace',
      gitBranch: 'main',
      claudeVersion: '2.1.198',
    };
    expect(formatSystemEvent(msg)).toBe('system: init  cwd=/workspace  branch=main  v2.1.198');
  });

  it('falls back to the bare type when a system line carries nothing', () => {
    expect(formatSystemEvent(turn(0, 'system'))).toBe('system');
  });

  it('labels a file-history snapshot', () => {
    expect(formatSystemEvent(turn(0, 'file-history-snapshot'))).toBe('file history snapshot');
  });
});

describe('mergeTurns', () => {
  it('appends newly polled turns in seq order', () => {
    const existing = [turn(0, 'user', 'a'), turn(1, 'assistant', 'b')];
    const merged = mergeTurns(existing, [turn(2, 'assistant', 'c')]);
    expect(merged.map(t => t.seq)).toEqual([0, 1, 2]);
  });

  it('prepends an older page without duplicating the overlap', () => {
    const existing = [turn(5, 'user', 'e'), turn(6, 'assistant', 'f')];
    const older = [turn(3, 'user', 'c'), turn(4, 'assistant', 'd'), turn(5, 'user', 'e')];
    const merged = mergeTurns(existing, older);
    expect(merged.map(t => t.seq)).toEqual([3, 4, 5, 6]);
  });

  it('lets an incoming turn replace the one it supersedes', () => {
    // The tail turn grows as the server merges new lines into it, so the freshly
    // polled copy must win over the one already on screen.
    const existing = [turn(0, 'assistant', 'partial')];
    const merged = mergeTurns(existing, [turn(0, 'assistant', 'partial and then some')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].content![0].text).toBe('partial and then some');
  });

  it('returns the identical array reference when nothing changed', () => {
    // The view polls every few seconds; an unchanged result must not trigger a
    // re-render of the whole transcript.
    const existing = [turn(0, 'user', 'a'), turn(1, 'assistant', 'b')];
    expect(mergeTurns(existing, [turn(1, 'assistant', 'b')])).toBe(existing);
    expect(mergeTurns(existing, [])).toBe(existing);
  });

  it('tolerates turns without a seq by keying on timestamp and type', () => {
    const legacy: ParsedMessage[] = [
      { type: 'user', timestamp: '2026-07-02T08:00:00.000Z', content: [] },
    ];
    const merged = mergeTurns(legacy, [
      { type: 'assistant', timestamp: '2026-07-02T08:01:00.000Z', content: [] },
    ]);
    expect(merged).toHaveLength(2);
  });
});
