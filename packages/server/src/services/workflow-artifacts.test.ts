import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readArtifacts } from './workflow-artifacts.js';
import type { WorkflowConfig } from '../config-file.js';

const dirs: string[] = [];

/** Build an item directory from a map of relative path → contents. */
function itemDir(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-artifacts-'));
  dirs.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const WORKFLOW: WorkflowConfig = {
  phases: [
    { label: 'Analysis', signal: 'analysis.md' },
    { label: 'Design', signal: ['design.md', 'architecture.md'] },
    { label: 'Docs', signal: 'docs.md', linear: false },
    { label: 'Ship', signal: { everyGroup: 'pr.md' } },
  ],
  groups: {
    dir: 'repos',
    noun: 'repo',
    signals: { impl: 'impl.md', PR: 'pr.md' },
  },
};

describe('readArtifacts', () => {
  it('treats an empty file as not done', () => {
    // Workflows touch a file when they start a step and fill it when they
    // finish; an empty stub means in progress.
    const dir = itemDir({ 'analysis.md': '' });
    return readArtifacts(dir, 'PROJ-1', WORKFLOW).then(item => {
      expect(item.phases[0].done).toBe(false);
      expect(item.phaseLabel).toBe('Analysis');
    });
  });

  it('accepts any one of a list of alternative signals', async () => {
    const dir = itemDir({ 'analysis.md': 'x', 'architecture.md': 'y' });
    const item = await readArtifacts(dir, 'PROJ-1', WORKFLOW);
    expect(item.phases[1].done).toBe(true);
  });

  it('implies earlier linear phases from a later one', async () => {
    // A pushed PR means the design was agreed, whether or not anyone wrote the
    // file saying so — otherwise a workflow that skips a step shows as stuck.
    const dir = itemDir({ 'repos/api/pr.md': 'https://pr/1' });
    const item = await readArtifacts(dir, 'PROJ-1', WORKFLOW);
    expect(item.phases.map(p => p.done)).toEqual([true, true, false, true]);
  });

  it('never lets a side track decide the current phase', async () => {
    // Docs is non-linear: having it does not advance anything, and lacking it
    // does not hold anything up.
    const dir = itemDir({ 'analysis.md': 'x', 'docs.md': 'y' });
    const item = await readArtifacts(dir, 'PROJ-1', WORKFLOW);
    expect(item.phases[2].done).toBe(true);
    expect(item.phaseLabel).toBe('Design');
  });

  it('requires every group for an everyGroup phase', async () => {
    const dir = itemDir({
      'repos/api/pr.md': 'link',
      'repos/web/impl.md': 'started',
    });
    const item = await readArtifacts(dir, 'PROJ-1', WORKFLOW);
    expect(item.phases[3].done).toBe(false);
    expect(item.groups.map(g => g.name)).toEqual(['api', 'web']);
    expect(item.groups[1].signals).toEqual({ impl: true, PR: false });
  });

  it('does not count zero groups as everything shipped', async () => {
    // "All zero of them shipped" is not progress, and treating it as done would
    // mark every untouched item complete.
    const dir = itemDir({ 'analysis.md': 'x' });
    const item = await readArtifacts(dir, 'PROJ-1', WORKFLOW);
    expect(item.phases[3].done).toBe(false);
  });

  it('stays on the last linear phase once everything is done', async () => {
    const dir = itemDir({ 'repos/api/impl.md': 'x', 'repos/api/pr.md': 'link' });
    const item = await readArtifacts(dir, 'PROJ-1', WORKFLOW);
    expect(item.phase).toBe(3);
    expect(item.phaseLabel).toBe('Ship');
  });

  it('carries a signal file\'s contents through as detail', async () => {
    const dir = itemDir({ 'repos/api/pr.md': '  https://github.com/x/y/pull/1  ' });
    const item = await readArtifacts(dir, 'PROJ-1', WORKFLOW);
    expect(item.groups[0].detail).toBe('https://github.com/x/y/pull/1');
  });

  it('copes with an item that has nothing in it yet', async () => {
    const item = await readArtifacts(itemDir({}), 'PROJ-1', WORKFLOW);
    expect(item.phase).toBe(0);
    expect(item.groups).toEqual([]);
  });
});
