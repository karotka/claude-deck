import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  parseSessionMetadataFromLines,
  parseFullSessionFromContent,
  aggregateSubagentUsageFromContent,
  parseSubagents,
} from './jsonl-parser.js';
import { calculateCost } from './cost-calculator.js';

// These lines mirror the format Claude Code writes *inside* a Docker container
// (newer CLI): the `user`/`assistant` envelopes carry cwd/gitBranch/version and
// the user content is a plain string rather than a content-block array.
const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

const lines = [
  JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: SESSION_ID }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'resolve PROJ-8995' },
    timestamp: '2026-07-02T08:15:25.000Z',
    sessionId: SESSION_ID,
    cwd: '/workspace',
    gitBranch: 'oncall/decoration-lazlo-monitoring',
    entrypoint: 'cli',
    version: '2.1.198',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6',
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 },
      content: [
        { type: 'text', text: 'Working on it' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
    timestamp: '2026-07-02T08:16:00.000Z',
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6',
      usage: { input_tokens: 200, output_tokens: 70, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'text', text: 'Done' }],
    },
    timestamp: '2026-07-02T08:17:00.000Z',
  }),
];

describe('parseSessionMetadataFromLines', () => {
  it('aggregates metadata from raw JSONL lines', () => {
    const meta = parseSessionMetadataFromLines(lines, null);
    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe(SESSION_ID);
    expect(meta!.firstUserMessage).toBe('resolve PROJ-8995');
    expect(meta!.model).toBe('claude-opus-4-6');
    expect(meta!.totalInputTokens).toBe(300);
    expect(meta!.totalOutputTokens).toBe(120);
    expect(meta!.totalCacheWriteTokens).toBe(10);
    expect(meta!.totalCacheReadTokens).toBe(5);
    expect(meta!.toolCallCount).toBe(1);
    expect(meta!.startedAt).toBe('2026-07-02T08:15:25.000Z');
    expect(meta!.lastActivityAt).toBe('2026-07-02T08:17:00.000Z');
  });

  it('reads cwd/gitBranch/entrypoint/version from the user envelope', () => {
    const meta = parseSessionMetadataFromLines(lines, null);
    expect(meta!.cwd).toBe('/workspace');
    expect(meta!.gitBranch).toBe('oncall/decoration-lazlo-monitoring');
    expect(meta!.entrypoint).toBe('cli');
    expect(meta!.claudeVersion).toBe('2.1.198');
  });

  it('ignores malformed lines and blank lines', () => {
    const meta = parseSessionMetadataFromLines(['not json', '', '  ', ...lines], null);
    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe(SESSION_ID);
    expect(meta!.totalOutputTokens).toBe(120);
  });

  it('falls back to the id argument when no line carries a sessionId', () => {
    const noId = [
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-6', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
        timestamp: '2026-07-02T08:16:00.000Z',
      }),
    ];
    const meta = parseSessionMetadataFromLines(noId, 'bbbbbbbb-1111-2222-3333-444444444444');
    expect(meta!.sessionId).toBe('bbbbbbbb-1111-2222-3333-444444444444');
  });

  it('returns null for an empty or fully-unparseable input', () => {
    expect(parseSessionMetadataFromLines([], null)).toBeNull();
    expect(parseSessionMetadataFromLines(['garbage', '{oops'], null)).toBeNull();
  });

  it('prices each turn by its own model rather than the session\'s last model', () => {
    // A session that switches models mid-way (e.g. opus for the main loop,
    // then a cheaper model for a tail turn) must price each turn at its own
    // rate — pricing every turn at whichever model happened to run last would
    // over- or under-charge every earlier turn.
    const mixed = [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
          content: [],
        },
        timestamp: '2026-08-01T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          usage: { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [],
        },
        timestamp: '2026-08-01T00:01:00.000Z',
      }),
    ];
    const meta = parseSessionMetadataFromLines(mixed, 'cccccccc-1111-2222-3333-444444444444');

    const expected =
      calculateCost('claude-opus-5', { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 100, cacheReadTokens: 200 }) +
      calculateCost('claude-sonnet-5', { inputTokens: 2000, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 0 });

    expect(meta!.estimatedCost).toBeCloseTo(expected, 10);
    // Sanity: pricing both turns at the last model (sonnet-5) would give a
    // different, wrong total — this asserts the fix actually changes behavior.
    const wrongIfLastModelWon = calculateCost('claude-sonnet-5', {
      inputTokens: 3000, outputTokens: 800, cacheCreationTokens: 100, cacheReadTokens: 200,
    });
    expect(meta!.estimatedCost).not.toBeCloseTo(wrongIfLastModelWon, 5);
  });

  it('keeps the startup cwd/gitBranch, not the last subdir a tool ran in', () => {
    // A monorepo session launched at /workspace whose tool calls cd into
    // per-repo subdirs must stay labeled by its root, not by the last subdir.
    const monorepo = [
      JSON.stringify({ type: 'system', subtype: 'init', sessionId: SESSION_ID, cwd: '/workspace', gitBranch: 'main' }),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-6', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
        timestamp: '2026-07-02T08:16:00.000Z',
      }),
      JSON.stringify({ type: 'system', sessionId: SESSION_ID, cwd: '/workspace/sessions/PROJ-8995/repos/indexer', gitBranch: 'feature/idx' }),
      JSON.stringify({ type: 'system', sessionId: SESSION_ID, cwd: '/workspace/sessions/PROJ-8995/repos/api', gitBranch: 'feature/api' }),
    ];
    const meta = parseSessionMetadataFromLines(monorepo, null);
    expect(meta!.cwd).toBe('/workspace');
    expect(meta!.gitBranch).toBe('main');
  });
});

describe('parseFullSessionFromContent', () => {
  it('numbers turns oldest-first so the client can key on seq', () => {
    const turns = parseFullSessionFromContent(lines.join('\n'));
    expect(turns.map(t => t.seq)).toEqual([0, 1, 2]);
    expect(turns[0].type).toBe('permission-mode');
    expect(turns[1].type).toBe('user');
    expect(turns[2].type).toBe('assistant');
  });

  it('keeps existing seq values stable as the append-only transcript grows', () => {
    // The client dedupes polled turns by seq, so a turn's number must not shift
    // when new lines land at the end of the file.
    const before = parseFullSessionFromContent(lines.join('\n'));
    const appended = [
      ...lines,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'and now deploy it' },
        timestamp: '2026-07-02T08:18:00.000Z',
      }),
    ];
    const after = parseFullSessionFromContent(appended.join('\n'));

    expect(after).toHaveLength(before.length + 1);
    for (const turn of before) {
      expect(after[turn.seq!].type).toBe(turn.type);
    }
    expect(after[after.length - 1].seq).toBe(3);
  });

  it('preserves tool_use inputs and tool_result payloads for the transcript view', () => {
    const withResult = [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a.ts' } }],
        },
        timestamp: '2026-07-02T08:16:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'line one\nline two' }],
        },
        timestamp: '2026-07-02T08:16:01.000Z',
      }),
    ];
    const turns = parseFullSessionFromContent(withResult.join('\n'));
    expect(turns[0].content![0]).toMatchObject({ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.ts' } });
    expect(turns[1].content![0]).toMatchObject({ type: 'tool_result', id: 't1', content: 'line one\nline two' });
  });

  it('renumbers after merging consecutive same-type lines', () => {
    // Two assistant lines in a row collapse into one turn, so seq stays a dense
    // 0..n-1 index over the merged turns rather than the raw line numbers.
    const turns = parseFullSessionFromContent(lines.join('\n'));
    expect(turns).toHaveLength(3);
    expect(turns[2].content).toHaveLength(3); // text + tool_use + text
    expect(turns[2].usage!.outputTokens).toBe(120);
  });
});

describe('aggregateSubagentUsageFromContent', () => {
  it('sums tokens and per-turn cost across every assistant line, not just a sample', () => {
    // Regression for the "subagent cost is entirely missing" bug: a subagent
    // transcript with many turns must have every turn counted, and each turn
    // priced at whatever model actually ran it.
    const turns = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          model: i < 25 ? 'claude-sonnet-5' : 'claude-opus-5',
          usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
          content: [{ type: 'text', text: 'ok' }],
        },
        timestamp: `2026-08-13T00:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    const content = turns.join('\n');

    const usage = aggregateSubagentUsageFromContent(content);

    expect(usage.messageCount).toBe(50);
    expect(usage.totalInputTokens).toBe(500);
    expect(usage.totalOutputTokens).toBe(1000);
    expect(usage.totalCacheWriteTokens).toBe(50);
    expect(usage.totalCacheReadTokens).toBe(100);
    expect(usage.model).toBe('claude-opus-5'); // last model seen, for display
    expect(usage.lastActivityAt).toBe('2026-08-13T00:49:00.000Z');

    const perTurn = { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 1, cacheReadTokens: 2 };
    const expectedCost =
      25 * calculateCost('claude-sonnet-5', perTurn) + 25 * calculateCost('claude-opus-5', perTurn);
    expect(usage.estimatedCost).toBeCloseTo(expectedCost, 10);
  });

  it('ignores malformed lines and returns zeros for empty content', () => {
    const usage = aggregateSubagentUsageFromContent(['not json', '', '  '].join('\n'));
    expect(usage.messageCount).toBe(0);
    expect(usage.estimatedCost).toBe(0);
    expect(aggregateSubagentUsageFromContent('')).toMatchObject({ messageCount: 0, estimatedCost: 0 });
  });

  it('counts user turns towards messageCount but not cost', () => {
    const content = [
      JSON.stringify({ type: 'user', timestamp: '2026-08-13T00:00:00.000Z' }),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        timestamp: '2026-08-13T00:01:00.000Z',
      }),
    ].join('\n');
    const usage = aggregateSubagentUsageFromContent(content);
    expect(usage.messageCount).toBe(2);
    expect(usage.estimatedCost).toBeGreaterThan(0);
  });
});

describe('parseSubagents', () => {
  async function withSessionDir(fn: (sessionDir: string) => Promise<void>): Promise<void> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-monitor-subagents-'));
    try {
      await fn(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  it('full-parses every subagent turn (not just first/last lines) and prices it', async () => {
    await withSessionDir(async (sessionDir) => {
      const subagentsDir = path.join(sessionDir, 'subagents');
      await fsp.mkdir(subagentsDir, { recursive: true });

      await fsp.writeFile(
        path.join(subagentsDir, 'agent-1.meta.json'),
        JSON.stringify({ agentType: 'Explore', description: 'find the thing' }),
      );

      // 40 turns — well beyond the old quick-parse's first-3/last-5 window —
      // so counting all of them (not a sample) is what proves the fix.
      const perTurn = { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 20 };
      const lines40 = Array.from({ length: 40 }, (_, i) =>
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-5',
            usage: {
              input_tokens: perTurn.inputTokens,
              output_tokens: perTurn.outputTokens,
              cache_creation_input_tokens: perTurn.cacheCreationTokens,
              cache_read_input_tokens: perTurn.cacheReadTokens,
            },
          },
          timestamp: `2026-08-13T01:${String(i).padStart(2, '0')}:00.000Z`,
        }),
      );
      await fsp.writeFile(path.join(subagentsDir, 'agent-1.jsonl'), lines40.join('\n'));

      const subagents = await parseSubagents(sessionDir);

      expect(subagents).toHaveLength(1);
      expect(subagents[0].agentId).toBe('agent-1');
      expect(subagents[0].agentType).toBe('Explore');
      expect(subagents[0].totalOutputTokens).toBe(40 * 50);
      expect(subagents[0].estimatedCost).toBeCloseTo(40 * calculateCost('claude-opus-5', perTurn), 8);
    });
  });

  it('returns [] when there is no subagents directory', async () => {
    await withSessionDir(async (sessionDir) => {
      expect(await parseSubagents(sessionDir)).toEqual([]);
    });
  });

  it('skips a subagent whose meta.json is broken rather than failing the whole batch', async () => {
    await withSessionDir(async (sessionDir) => {
      const subagentsDir = path.join(sessionDir, 'subagents');
      await fsp.mkdir(subagentsDir, { recursive: true });
      await fsp.writeFile(path.join(subagentsDir, 'agent-bad.meta.json'), '{not json');
      await fsp.writeFile(
        path.join(subagentsDir, 'agent-good.meta.json'),
        JSON.stringify({ agentType: 'general-purpose', description: 'ok' }),
      );
      expect(await parseSubagents(sessionDir)).toEqual([
        expect.objectContaining({ agentId: 'agent-good' }),
      ]);
    });
  });
});
