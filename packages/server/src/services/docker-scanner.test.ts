import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const h = vi.hoisted(() => ({
  execCalls: [] as { file: string; args: string[] }[],
  spawnCalls: [] as { file: string; args: string[]; stdin: string }[],
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    h.execCalls.push({ file, args });
    cb(null, { stdout: '', stderr: '' });
  },
  spawn: (file: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { on: () => void; write: (d: string) => void; end: (d?: string) => void };
      stderr: EventEmitter;
    };
    child.stderr = new EventEmitter();
    let stdin = '';
    child.stdin = {
      on: () => {},
      write: (d: string) => { stdin += d; },
      end: (d?: string) => {
        if (d) stdin += d;
        h.spawnCalls.push({ file, args, stdin });
        queueMicrotask(() => child.emit('close', 0, null));
      },
    };
    return child;
  },
}));

import {
  parseSampleOutput,
  dockerExecSend,
  parseSubagentListOutput,
  parseSubagentContentOutput,
  chunkStatsByByteBudget,
  type ContainerSubagentStat,
} from './docker-scanner.js';

beforeEach(() => {
  h.execCalls.length = 0;
  h.spawnCalls.length = 0;
});

describe('dockerExecSend', () => {
  it('pastes the whole payload into the container via one bracketed paste', async () => {
    const big = 'y'.repeat(3000) + '\n{"json":true}';

    await dockerExecSend('jira-agent-x', big, true);

    // `docker exec -i ... tmux load-buffer -` streams the full payload on stdin.
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0].file).toBe('docker');
    expect(h.spawnCalls[0].args).toContain('-i');
    expect(h.spawnCalls[0].args).toContain('load-buffer');
    expect(h.spawnCalls[0].args.at(-1)).toBe('-');
    expect(h.spawnCalls[0].stdin).toBe(big);

    // Bracketed paste into the container's `agent` tmux session, then one Enter.
    const paste = h.execCalls.find(c => c.args.includes('paste-buffer'));
    expect(paste!.args).toContain('-p');
    expect(paste!.args).toContain('agent:0.0');
    expect(h.execCalls.filter(c => c.args.includes('Enter'))).toHaveLength(1);
    // No literal keystroke chunking.
    expect(h.execCalls.some(c => c.args.includes('-l'))).toBe(false);
  });

  it('skips Enter when appendEnter is false', async () => {
    await dockerExecSend('jira-agent-x', 'partial', false);
    expect(h.execCalls.some(c => c.args.includes('Enter'))).toBe(false);
  });
});

describe('parseSampleOutput', () => {
  it('extracts the path and head/tail lines from the exec output', () => {
    const stdout = [
      'PATH=/home/agent/.claude/projects/-workspace/125efb8b.jsonl',
      '@@@HEAD@@@',
      '{"type":"permission-mode","sessionId":"x"}',
      '{"type":"user","message":{"content":"resolve PROJ-1"}}',
      '@@@TAIL@@@',
      '{"partial":"line-to-drop"', // truncated tail head — must be dropped
      '{"type":"assistant","message":{"usage":{"output_tokens":5}}}',
      '',
    ].join('\n');

    const res = parseSampleOutput(stdout);
    expect(res).not.toBeNull();
    expect(res!.jsonlPath).toBe('/home/agent/.claude/projects/-workspace/125efb8b.jsonl');
    // head lines kept in order; the first (possibly truncated) tail line dropped
    expect(res!.lines).toEqual([
      '{"type":"permission-mode","sessionId":"x"}',
      '{"type":"user","message":{"content":"resolve PROJ-1"}}',
      '{"type":"assistant","message":{"usage":{"output_tokens":5}}}',
    ]);
  });

  it('deduplicates lines that appear in both head and tail (small file)', () => {
    const line = '{"type":"user","message":{"content":"hi"}}';
    const stdout = [
      'PATH=/x/y.jsonl',
      '@@@HEAD@@@',
      '{"type":"permission-mode"}',
      line,
      '@@@TAIL@@@',
      '{"type":"permission-mode"}', // dropped as the truncated-first tail line
      line, // duplicate of a head line → deduped
    ].join('\n');

    const res = parseSampleOutput(stdout);
    expect(res!.lines).toEqual(['{"type":"permission-mode"}', line]);
  });

  it('returns null when the sentinel markers are missing', () => {
    expect(parseSampleOutput('')).toBeNull();
    expect(parseSampleOutput('NO_SESSION')).toBeNull();
    expect(parseSampleOutput('PATH=/x\n@@@HEAD@@@\nonly head, no tail marker')).toBeNull();
  });

  it('returns null when no PATH= line is present', () => {
    expect(parseSampleOutput('@@@HEAD@@@\nfoo\n@@@TAIL@@@\nbar')).toBeNull();
  });
});

describe('parseSubagentListOutput', () => {
  it('parses one meta+stat entry per subagent', () => {
    const stdout = [
      '@@@SA@@@agent-1',
      '{"agentType":"Explore","description":"find X"}',
      '1786635093 1270574',
      '@@@SA@@@agent-2',
      '{"agentType":"general-purpose","description":"iteration 3"}',
      '1786635200 500',
      '',
    ].join('\n');

    const stats = parseSubagentListOutput(stdout);

    expect(stats).toEqual([
      { agentId: 'agent-1', metaRaw: '{"agentType":"Explore","description":"find X"}', jsonlMtimeMs: 1786635093_000, jsonlSize: 1270574 },
      { agentId: 'agent-2', metaRaw: '{"agentType":"general-purpose","description":"iteration 3"}', jsonlMtimeMs: 1786635200_000, jsonlSize: 500 },
    ]);
  });

  it('returns [] for empty output (no subagents dir)', () => {
    expect(parseSubagentListOutput('')).toEqual([]);
  });

  it('skips an entry with a malformed stat line rather than throwing', () => {
    const stdout = [
      '@@@SA@@@agent-broken',
      '{"agentType":"x"}',
      'not-a-stat-line',
    ].join('\n');
    expect(parseSubagentListOutput(stdout)).toEqual([]);
  });
});

describe('parseSubagentContentOutput', () => {
  it('splits multi-line subagent transcripts by marker, dropping the trailing separator blank line', () => {
    // Each subagent's real output is `cat file; echo;` — the fetch script's
    // own separator, not part of the transcript.
    const stdout = [
      '@@@SAC@@@agent-1',
      '{"type":"assistant","message":{"model":"claude-opus-5","usage":{"output_tokens":5}}}',
      '{"type":"assistant","message":{"model":"claude-opus-5","usage":{"output_tokens":7}}}',
      '', // separator after cat agent-1.jsonl
      '@@@SAC@@@agent-2',
      '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"output_tokens":3}}}',
      '', // separator after cat agent-2.jsonl
    ].join('\n');

    const contents = parseSubagentContentOutput(stdout);

    expect(contents.get('agent-1')).toBe(
      '{"type":"assistant","message":{"model":"claude-opus-5","usage":{"output_tokens":5}}}\n' +
      '{"type":"assistant","message":{"model":"claude-opus-5","usage":{"output_tokens":7}}}',
    );
    expect(contents.get('agent-2')).toBe(
      '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"output_tokens":3}}}',
    );
  });

  it('returns an empty map for output with no markers', () => {
    expect(parseSubagentContentOutput('').size).toBe(0);
    expect(parseSubagentContentOutput('no markers here').size).toBe(0);
  });
});

describe('chunkStatsByByteBudget', () => {
  const stat = (agentId: string, jsonlSize: number): ContainerSubagentStat => ({
    agentId, metaRaw: '{}', jsonlMtimeMs: 0, jsonlSize,
  });

  it('keeps a single exec under the byte budget instead of one 72MB call for 75 subagents', () => {
    // Regression for the "one docker exec pulling 72MB blows past maxBuffer,
    // the call throws, and the caller wrongly caches that as zero cost" bug.
    const stats = Array.from({ length: 75 }, (_, i) => stat(`agent-${i}`, 1_000_000)); // ~72MB total
    const budget = 20 * 1024 * 1024;

    const chunks = chunkStatsByByteBudget(stats, budget);

    expect(chunks.flat()).toHaveLength(75);
    for (const chunk of chunks) {
      const size = chunk.reduce((sum, s) => sum + s.jsonlSize, 0);
      // A single oversized file is still let through as its own chunk (see
      // the next test) — but with uniform 1MB files, every chunk must respect
      // the budget.
      expect(size).toBeLessThanOrEqual(budget);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('gives an oversized single file its own chunk rather than looping forever', () => {
    const stats = [stat('huge', 50 * 1024 * 1024), stat('small', 1000)];
    const chunks = chunkStatsByByteBudget(stats, 20 * 1024 * 1024);
    expect(chunks).toEqual([[stats[0]], [stats[1]]]);
  });

  it('returns [] for empty input', () => {
    expect(chunkStatsByByteBudget([], 1000)).toEqual([]);
  });
});
