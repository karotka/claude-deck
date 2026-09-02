import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { peekLastActivity } from './jsonl-parser.js';

const dirs: string[] = [];

function transcript(lines: string[], padToBytes = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tail-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  const pad = padToBytes
    ? Array.from({ length: padToBytes / 200 }, (_, i) =>
        JSON.stringify({ type: 'user', timestamp: '2020-01-01T00:00:00.000Z', filler: 'x'.repeat(150), i }),
      ).join('\n') + '\n'
    : '';
  fs.writeFileSync(file, pad + lines.join('\n') + '\n');
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('peekLastActivity', () => {
  it('reports when the transcript was last appended to, not when the file was touched', async () => {
    // The whole point: a backup or an indexer moves mtime, and a month-old
    // conversation then reads as today's work.
    const file = transcript([
      JSON.stringify({ type: 'user', timestamp: '2026-07-30T07:14:00.000Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-30T07:15:30.000Z' }),
    ]);
    await fsp.utimes(file, new Date(), new Date());

    expect(await peekLastActivity(file)).toBe(Date.parse('2026-07-30T07:15:30.000Z'));
  });

  it('reads only the tail, so a huge transcript stays cheap', async () => {
    // 300KB of older turns ahead of the real last one; only the last 64KB is
    // read, and the answer must still be the newest timestamp.
    const file = transcript(
      [JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T10:00:00.000Z' })],
      300_000,
    );
    expect(await peekLastActivity(file)).toBe(Date.parse('2026-08-20T10:00:00.000Z'));
  });

  it('scans backwards past trailing lines that carry no timestamp', async () => {
    const file = transcript([
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T10:00:00.000Z' }),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
    ]);
    expect(await peekLastActivity(file)).toBe(Date.parse('2026-08-20T10:00:00.000Z'));
  });

  it('survives a tail cut mid-record, which a 64KB window usually produces', async () => {
    const file = transcript(
      [
        '{"type":"assistant","timestamp":"2026-08-20T',  // truncated on purpose
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-21T11:00:00.000Z' }),
      ],
      300_000,
    );
    expect(await peekLastActivity(file)).toBe(Date.parse('2026-08-21T11:00:00.000Z'));
  });

  it('returns null rather than guessing when nothing readable is there', async () => {
    expect(await peekLastActivity(transcript(['not json at all']))).toBeNull();
    expect(await peekLastActivity(transcript(['{"type":"user"}']))).toBeNull();
    expect(await peekLastActivity(transcript([]))).toBeNull();
    expect(await peekLastActivity('/nope/missing.jsonl')).toBeNull();
  });

  it('ignores a timestamp that is not a parseable date', async () => {
    const file = transcript([
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T10:00:00.000Z' }),
      JSON.stringify({ type: 'assistant', timestamp: 'whenever' }),
    ]);
    expect(await peekLastActivity(file)).toBe(Date.parse('2026-08-20T10:00:00.000Z'));
  });
});
