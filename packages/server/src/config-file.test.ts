import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigFile, configFileCandidates, CONFIG_FILE_NAME } from './config-file.js';

const tmpDirs: string[] = [];

function writeConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-'));
  tmpDirs.push(dir);
  const file = path.join(dir, CONFIG_FILE_NAME);
  fs.writeFileSync(file, contents);
  return file;
}

function load(contents: string) {
  return loadConfigFile({ CLAUDE_DECK_CONFIG: writeConfig(contents) } as NodeJS.ProcessEnv);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadConfigFile', () => {
  it('runs with no config file at all', () => {
    // The whole file is optional: a fresh install is expected to have none.
    const loaded = loadConfigFile({ CLAUDE_DECK_CONFIG: '/nope/missing.json' } as NodeJS.ProcessEnv);
    expect(loaded).toEqual({ path: null, values: {} });
  });

  it('honours CLAUDE_DECK_CONFIG over the default locations', () => {
    expect(configFileCandidates({ CLAUDE_DECK_CONFIG: '/etc/deck.json' } as NodeJS.ProcessEnv))
      .toEqual(['/etc/deck.json']);
    expect(configFileCandidates({} as NodeJS.ProcessEnv).length).toBe(2);
  });

  it('reads launchers and a workflow', () => {
    const { values } = load(JSON.stringify({
      tag: { pattern: '#\\d+' },
      launchers: [{ id: 'x', label: 'X', command: ['./go.sh', '{{tag}}'] }],
      workflow: { phases: [{ label: 'Done', signal: 'done.md' }] },
    }));
    expect(values.tag?.pattern).toBe('#\\d+');
    expect(values.launchers?.[0].command).toEqual(['./go.sh', '{{tag}}']);
    expect(values.workflow?.phases[0].label).toBe('Done');
  });
});

describe('validation', () => {
  // A typo should stop the server with the offending key named, not start it
  // with a launcher silently missing and a bug report three days later.
  it('rejects malformed JSON, naming the file', () => {
    expect(() => load('{ not json')).toThrow(/is not valid JSON/);
  });

  it('rejects a tag pattern that is not a regular expression', () => {
    expect(() => load(JSON.stringify({ tag: { pattern: '[unclosed' } })))
      .toThrow(/tag\.pattern is not a valid regular expression/);
  });

  it('rejects a launcher with no command', () => {
    expect(() => load(JSON.stringify({ launchers: [{ id: 'x', label: 'X' }] })))
      .toThrow(/launchers\[0\]\.command/);
  });

  it('rejects duplicate launcher ids, which would make one unreachable', () => {
    expect(() => load(JSON.stringify({
      launchers: [
        { id: 'x', label: 'A', command: ['a'] },
        { id: 'x', label: 'B', command: ['b'] },
      ],
    }))).toThrow(/is not unique/);
  });

  it('rejects a phase whose signal is not a recognised shape', () => {
    expect(() => load(JSON.stringify({
      workflow: { phases: [{ label: 'X', signal: 42 }] },
    }))).toThrow(/workflow\.phases\[0\]\.signal/);
  });

  it('rejects everyGroup without groups configured, which could never be met', () => {
    expect(() => load(JSON.stringify({
      workflow: { phases: [{ label: 'Ship', signal: { everyGroup: 'pr.md' } }] },
    }))).toThrow(/workflow\.groups is not configured/);
  });

  it('rejects an empty phase list', () => {
    expect(() => load(JSON.stringify({ workflow: { phases: [] } })))
      .toThrow(/non-empty array/);
  });
});
