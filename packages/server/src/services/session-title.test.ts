import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionTitle } from './session-discovery.js';

const dirs: string[] = [];

function sessionDir(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-title-'));
  dirs.push(dir);
  if (contents !== undefined) {
    fs.writeFileSync(path.join(dir, 'custom-title.json'), contents);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('readSessionTitle', () => {
  it('reads the name the user gave the session', async () => {
    // Claude Code keeps it beside the transcript, not inside it, which is why
    // parsing the JSONL never found one.
    expect(await readSessionTitle(sessionDir('{"customTitle":"Browse ML ranker"}')))
      .toBe('Browse ML ranker');
  });

  it('trims surrounding whitespace', async () => {
    expect(await readSessionTitle(sessionDir('{"customTitle":"  Pen plotter  "}')))
      .toBe('Pen plotter');
  });

  it('treats an unnamed session as unnamed, not an error', async () => {
    // The common case by far: this runs for every transcript on every tick.
    expect(await readSessionTitle(sessionDir())).toBeNull();
  });

  it('survives a file that is not what we expect', async () => {
    expect(await readSessionTitle(sessionDir('not json'))).toBeNull();
    expect(await readSessionTitle(sessionDir('{}'))).toBeNull();
    expect(await readSessionTitle(sessionDir('{"customTitle":42}'))).toBeNull();
    expect(await readSessionTitle(sessionDir('{"customTitle":"   "}'))).toBeNull();
    expect(await readSessionTitle('/nope/missing')).toBeNull();
  });
});
