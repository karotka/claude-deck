import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { ParsedMessage, TokenUsage, ContentBlock, SubagentInfo } from '../types.js';
import { calculateCost } from './cost-calculator.js';

export interface SessionMetadata {
  sessionId: string;
  permissionMode: string;
  cwd: string;
  gitBranch: string;
  entrypoint: string;
  claudeVersion: string;
  model: string;
  remoteUrl: string | null;
  startedAt: string;
  lastActivityAt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  messageCount: number;
  toolCallCount: number;
  firstUserMessage: string;
  lastUserMessage: string;
  /**
   * Claude Code's own recap of what the session is for, most recent first-hand
   * wins. Null for a session that has never been away long enough to write one.
   */
  recap: { text: string; at: string } | null;
  /**
   * Every git branch the session worked on, first seen first. One is normal;
   * several means it covered more than one piece of work.
   */
  branches: string[];
  /**
   * Sum of calculateCost() applied per assistant turn, at that turn's own
   * model — not totalTokens priced at whatever model happened to run last.
   * Sessions that switch models mid-way (main loop upgraded models, a tail
   * turn ran on a cheaper model, ...) would otherwise be mis-priced.
   */
  estimatedCost: number;
}

function parseJsonlLine(raw: string): ParsedMessage | null {
  try {
    const obj = JSON.parse(raw);
    const type = obj.type as string;

    if (type === 'permission-mode') {
      return {
        type: 'permission-mode',
        timestamp: obj.timestamp ?? '',
        permissionMode: obj.permissionMode,
        sessionId: obj.sessionId,
      };
    }

    if (type === 'system') {
      return {
        type: 'system',
        timestamp: obj.timestamp ?? '',
        sessionId: obj.sessionId,
        subtype: obj.subtype,
        cwd: obj.cwd,
        gitBranch: obj.gitBranch,
        entrypoint: obj.entrypoint,
        claudeVersion: obj.version,
        permissionMode: obj.permissionMode,
        remoteUrl: obj.url ?? null,
        // away_summary carries its text as a plain string, not content blocks.
        // It is Claude Code's own recap of what the session is for, which is a
        // better answer to "what is this session" than anything derived.
        summary: typeof obj.content === 'string' ? obj.content : undefined,
      };
    }

    if (type === 'user') {
      const content: ContentBlock[] = [];
      if (obj.message?.content) {
        // Collect consecutive plain strings and join them as one text block
        const strings: string[] = [];
        for (const block of obj.message.content) {
          if (typeof block === 'string') {
            strings.push(block);
          } else {
            // Flush accumulated strings first
            if (strings.length > 0) {
              content.push({ type: 'text', text: strings.join('') });
              strings.length = 0;
            }
            if (block.type === 'text') {
              content.push({ type: 'text', text: block.text });
            } else if (block.type === 'tool_result') {
              content.push({ type: 'tool_result', id: block.tool_use_id, content: block.content });
            }
          }
        }
        if (strings.length > 0) {
          content.push({ type: 'text', text: strings.join('') });
        }
      }
      return {
        type: 'user',
        timestamp: obj.timestamp ?? '',
        sessionId: obj.sessionId,
        promptId: obj.promptId,
        // Newer CLI writes cwd/gitBranch/entrypoint/version on the message
        // envelope (there is no separate `system` init line in container logs).
        cwd: obj.cwd,
        gitBranch: obj.gitBranch,
        entrypoint: obj.entrypoint,
        claudeVersion: obj.version,
        content,
      };
    }

    if (type === 'assistant') {
      const msg = obj.message;
      const usage: TokenUsage | undefined = msg?.usage
        ? {
            inputTokens: msg.usage.input_tokens ?? 0,
            outputTokens: msg.usage.output_tokens ?? 0,
            cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          }
        : undefined;

      const content: ContentBlock[] = [];
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
          } else if (block.type === 'thinking') {
            content.push({ type: 'text', text: block.thinking });
          }
        }
      }

      return {
        type: 'assistant',
        timestamp: obj.timestamp ?? '',
        model: msg?.model,
        usage,
        content,
        stopReason: msg?.stop_reason,
        sessionId: obj.sessionId,
        cwd: obj.cwd,
        gitBranch: obj.gitBranch,
        entrypoint: obj.entrypoint,
        claudeVersion: obj.version,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/** Derive a session id from a `<uuid>.jsonl` filename, or null if it doesn't look like one. */
function filenameSessionId(jsonlPath: string): string | null {
  const basename = path.basename(jsonlPath, '.jsonl');
  return /^[0-9a-f]{8}-/.test(basename) ? basename : null;
}

/**
 * Aggregate session metadata from a list of already-parsed messages. Pure — the
 * single source of truth shared by the file- and container-based parsers.
 */
/**
 * Claude Code appends a UI hint to every recap. It is an instruction to
 * somebody sitting at the terminal, not part of what the session is about.
 */
function cleanRecap(text: string): string {
  return text.replace(/\s*\(disable recaps in \/config\)\s*$/i, '').trim();
}

function aggregateSessionMetadata(
  messages: ParsedMessage[],
  sessionIdFallback: string | null,
): SessionMetadata | null {
  if (messages.length === 0) return null;

  const noteBranch = (branch: string | undefined) => {
    // 'HEAD' is a detached checkout, which says nothing about what was worked
    // on and would otherwise look like a branch of its own.
    if (branch && branch !== 'HEAD' && !branches.includes(branch)) branches.push(branch);
  };

  let sessionId = '';
  let permissionMode = '';
  let cwd = '';
  let gitBranch = '';
  let entrypoint = '';
  let claudeVersion = '';
  let model = '';
  let remoteUrl: string | null = null;
  let startedAt = '';
  let lastActivityAt = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let messageCount = 0;
  // The most recent recap wins: it describes the session as it stands.
  let recap: SessionMetadata['recap'] = null;
  // Every branch the session worked on, in the order first seen. One is the
  // normal case; several means the session covered more than one thing.
  const branches: string[] = [];
  let toolCallCount = 0;
  let firstUserMessage = '';
  let lastUserMessage = '';
  let estimatedCost = 0;

  for (const parsed of messages) {
    if (parsed.timestamp) {
      if (!startedAt) startedAt = parsed.timestamp;
      lastActivityAt = parsed.timestamp;
    }

    // Pick up sessionId from any message type that carries it
    if (parsed.sessionId && !sessionId) {
      sessionId = parsed.sessionId;
    }

    if (parsed.type === 'permission-mode') {
      sessionId = parsed.sessionId ?? sessionId;
      permissionMode = parsed.permissionMode ?? permissionMode;
    }

    if (parsed.type === 'system') {
      sessionId = parsed.sessionId ?? sessionId;
      permissionMode = parsed.permissionMode ?? permissionMode;
      // cwd/gitBranch are first-seen (the session's startup location), NOT
      // last-seen: a monorepo session rooted at /workspace stamps a subdir cwd
      // on every tool call that runs deeper (e.g. repos/indexer), and
      // overwriting would mislabel the whole session by whichever subdir it
      // touched last.
      if (!cwd) cwd = parsed.cwd ?? cwd;
      if (!gitBranch) gitBranch = parsed.gitBranch ?? gitBranch;
      noteBranch(parsed.gitBranch);
      if (parsed.subtype === 'away_summary' && parsed.summary) {
        recap = { text: cleanRecap(parsed.summary), at: parsed.timestamp };
      }
      entrypoint = parsed.entrypoint ?? entrypoint;
      claudeVersion = parsed.claudeVersion ?? claudeVersion;
      remoteUrl = parsed.remoteUrl ?? remoteUrl;
    }

    if (parsed.type === 'assistant') {
      model = parsed.model ?? model;
      messageCount++;
      if (parsed.usage) {
        totalInputTokens += parsed.usage.inputTokens;
        totalOutputTokens += parsed.usage.outputTokens;
        totalCacheReadTokens += parsed.usage.cacheReadTokens;
        totalCacheWriteTokens += parsed.usage.cacheCreationTokens;
        // Price this turn at its own model, not whatever model runs last.
        estimatedCost += calculateCost(model, parsed.usage);
      }
      if (parsed.content) {
        for (const block of parsed.content) {
          if (block.type === 'tool_use') toolCallCount++;
        }
      }
    }

    if (parsed.type === 'user') {
      messageCount++;
      const textBlock = parsed.content?.find(b => b.type === 'text');
      if (textBlock?.text) {
        if (!firstUserMessage) firstUserMessage = textBlock.text;
        lastUserMessage = textBlock.text;
      }
    }

    // Newer CLI carries these on the user/assistant envelope rather than a
    // dedicated `system` init line. Fill from any message when still unset —
    // a real `system` cwd (host sessions) still wins because it assigns above.
    if (!cwd && parsed.cwd) cwd = parsed.cwd;
    if (!gitBranch && parsed.gitBranch) gitBranch = parsed.gitBranch;
    if (!entrypoint && parsed.entrypoint) entrypoint = parsed.entrypoint;
    if (!claudeVersion && parsed.claudeVersion) claudeVersion = parsed.claudeVersion;
  }

  if (!sessionId) sessionId = sessionIdFallback ?? '';
  if (!sessionId) return null;

  return {
    recap,
    branches,
    sessionId,
    permissionMode,
    cwd,
    gitBranch,
    entrypoint,
    claudeVersion,
    model,
    remoteUrl,
    startedAt,
    lastActivityAt,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    messageCount,
    toolCallCount,
    firstUserMessage,
    lastUserMessage,
    estimatedCost,
  };
}

/**
 * Aggregate metadata from raw JSONL lines (unmerged). Used for the file
 * quick-parse and for sessions read out of a Docker container via `docker exec`.
 */
export function parseSessionMetadataFromLines(
  lines: string[],
  sessionIdFallback: string | null,
): SessionMetadata | null {
  const messages: ParsedMessage[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseJsonlLine(line);
    if (parsed) messages.push(parsed);
  }
  return aggregateSessionMetadata(messages, sessionIdFallback);
}

/**
 * Quick parse: read first N + last M lines of a JSONL file to extract metadata
 * without reading the entire file.
 */
export async function parseSessionMetadata(jsonlPath: string): Promise<SessionMetadata | null> {
  try {
    const stat = await fsp.stat(jsonlPath);
    if (stat.size === 0) return null;

    const lines = await readFirstAndLastLines(jsonlPath, 10, 20);
    return parseSessionMetadataFromLines(lines, filenameSessionId(jsonlPath));
  } catch {
    return null;
  }
}

/**
 * Cheap peek: read only the first ~8KB to find the first user message.
 * Used to admit JSONL files past the age cutoff when they match a running container.
 */
export async function peekFirstUserMessage(jsonlPath: string): Promise<string | null> {
  try {
    const fh = await fsp.open(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytesRead).toString('utf-8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type !== 'user') continue;
          const content = obj.message?.content;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            return content
              .filter((p: { type?: string }) => p?.type === 'text')
              .map((p: { text?: string }) => p.text ?? '')
              .join('\n');
          }
        } catch { /* incomplete or non-JSON line, keep scanning */ }
      }
      return null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * When the transcript itself was last appended to, in ms — or null when the
 * tail carries no readable timestamp.
 *
 * Distinct from the file's mtime, which is what the age cutoff used to use.
 * mtime is an *upper* bound on real activity: appending moves it, but so does
 * anything else that touches the file — a backup, an indexer, a sync client.
 * A month-old conversation whose file was touched this morning then reads as
 * today's work. This asks the transcript instead.
 *
 * Reads only the last 64KB. Transcripts run to tens of MB and this is called
 * per file on every scan tick, so reading the whole thing is not an option.
 */
export async function peekLastActivity(jsonlPath: string): Promise<number | null> {
  try {
    const stat = await fsp.stat(jsonlPath);
    if (stat.size === 0) return null;

    const chunkSize = Math.min(64 * 1024, stat.size);
    const fh = await fsp.open(jsonlPath, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(chunkSize);
      const { bytesRead } = await fh.read(buf, 0, chunkSize, stat.size - chunkSize);
      text = buf.subarray(0, bytesRead).toString('utf-8');
    } finally {
      await fh.close();
    }

    // Backwards: the newest turn is at the end, and stopping at the first hit
    // avoids parsing a whole chunk of large tool-result lines. The first line of
    // the chunk is usually cut mid-record, which simply fails to parse.
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
        if (typeof ts !== 'string') continue;
        const ms = Date.parse(ts);
        if (!Number.isNaN(ms)) return ms;
      } catch { /* truncated or non-JSON line, keep scanning backwards */ }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parsed transcripts keyed by file path. The conversation view polls every few
 * seconds and the largest transcripts run to tens of MB, so re-streaming the
 * whole file each time is the dominant cost of that endpoint. A stat is enough
 * to prove the cache is current — JSONL files are append-only, so any change
 * moves mtime and size together.
 */
const fullSessionCache = new Map<
  string,
  { mtimeMs: number; size: number; messages: ParsedMessage[] }
>();

/**
 * Full parse: read all lines for the detail view.
 * Merges consecutive assistant or user lines into single turns.
 *
 * The returned array is shared with the cache — callers must not mutate it
 * (no in-place `reverse()`/`sort()`); copy first.
 */
export async function parseFullSession(jsonlPath: string): Promise<ParsedMessage[]> {
  const stat = await fsp.stat(jsonlPath);
  const cached = fullSessionCache.get(jsonlPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.messages;
  }

  const raw: ParsedMessage[] = [];

  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const parsed = parseJsonlLine(line);
    if (parsed) raw.push(parsed);
  }

  const messages = mergeMessages(raw);
  fullSessionCache.set(jsonlPath, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
  return messages;
}

/**
 * Parse a full session transcript from raw JSONL content already in memory.
 * Used for container-internal sessions, whose JSONL is read from inside the
 * container via `docker exec` (no host file to stream).
 */
export function parseFullSessionFromContent(content: string): ParsedMessage[] {
  const raw: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseJsonlLine(line);
    if (parsed) raw.push(parsed);
  }
  return mergeMessages(raw);
}

/** Merge consecutive assistant/user lines into single turns. */
function mergeMessages(raw: ParsedMessage[]): ParsedMessage[] {
  const merged: ParsedMessage[] = [];
  for (const msg of raw) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.type === msg.type &&
      (msg.type === 'assistant' || msg.type === 'user')
    ) {
      // Merge content blocks
      prev.content = [...(prev.content ?? []), ...(msg.content ?? [])];
      // Keep latest timestamp
      if (msg.timestamp) prev.timestamp = msg.timestamp;
      // Accumulate usage
      if (msg.usage && prev.usage) {
        prev.usage.inputTokens += msg.usage.inputTokens;
        prev.usage.outputTokens += msg.usage.outputTokens;
        prev.usage.cacheCreationTokens += msg.usage.cacheCreationTokens;
        prev.usage.cacheReadTokens += msg.usage.cacheReadTokens;
      } else if (msg.usage) {
        prev.usage = { ...msg.usage };
      }
      // Keep model from whichever has it
      prev.model = msg.model ?? prev.model;
      prev.stopReason = msg.stopReason ?? prev.stopReason;
    } else {
      merged.push({ ...msg, content: msg.content ? [...msg.content] : [] });
    }
  }

  // Number the turns oldest-first. Appending to the transcript never renumbers
  // earlier turns, which is what lets the client merge polled pages by seq.
  for (let i = 0; i < merged.length; i++) {
    merged[i].seq = i;
  }

  return merged;
}

/**
 * Parse full session and aggregate all token usage (not just sampled lines).
 */
export async function parseFullSessionMetadata(jsonlPath: string): Promise<SessionMetadata | null> {
  try {
    const stat = await fsp.stat(jsonlPath);
    if (stat.size === 0) return null;

    const messages = await parseFullSession(jsonlPath);
    return aggregateSessionMetadata(messages, filenameSessionId(jsonlPath));
  } catch {
    return null;
  }
}

export interface SubagentUsage {
  messageCount: number;
  lastActivityAt: string;
  /** Last model seen — for display only; cost is priced per-turn (see below). */
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  estimatedCost: number;
}

function emptySubagentUsage(): SubagentUsage {
  return {
    messageCount: 0,
    lastActivityAt: '',
    model: '',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    estimatedCost: 0,
  };
}

/**
 * Fold one raw JSONL line into a subagent usage accumulator, in place.
 * Deliberately skips content blocks (text/tool_use/tool_result) — subagent
 * transcripts are only ever summarized in the UI, never rendered turn by
 * turn, so there's no reason to hold potentially-huge tool outputs in memory
 * just to price a turn.
 */
function foldSubagentLine(acc: SubagentUsage, rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;

  let obj: { type?: string; timestamp?: string; message?: { model?: string; usage?: Record<string, number> } };
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  if (obj.timestamp) acc.lastActivityAt = obj.timestamp;

  if (obj.type === 'assistant') {
    acc.messageCount++;
    acc.model = obj.message?.model ?? acc.model;
    const u = obj.message?.usage;
    if (u) {
      const usage: TokenUsage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
      };
      acc.totalInputTokens += usage.inputTokens;
      acc.totalOutputTokens += usage.outputTokens;
      acc.totalCacheReadTokens += usage.cacheReadTokens;
      acc.totalCacheWriteTokens += usage.cacheCreationTokens;
      acc.estimatedCost += calculateCost(acc.model, usage);
    }
  } else if (obj.type === 'user') {
    acc.messageCount++;
  }
}

/**
 * Aggregate a subagent's usage from raw JSONL content already in memory —
 * used for subagent transcripts read out of a Docker container via
 * `docker exec` (no host file to stream).
 */
export function aggregateSubagentUsageFromContent(content: string): SubagentUsage {
  const acc = emptySubagentUsage();
  for (const line of content.split('\n')) {
    foldSubagentLine(acc, line);
  }
  return acc;
}

/**
 * Cache of full subagent usage aggregates, keyed by jsonl path. Mirrors
 * `fullSessionCache`'s mtime+size invalidation, but stores only the small
 * rolled-up totals (not parsed messages) since subagent transcripts are
 * never rendered — just priced and summarized.
 */
const subagentUsageCache = new Map<string, { mtimeMs: number; size: number; data: SubagentUsage }>();

async function aggregateSubagentUsageFromFile(jsonlPath: string): Promise<SubagentUsage> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(jsonlPath);
  } catch {
    return emptySubagentUsage();
  }
  if (stat.size === 0) return emptySubagentUsage();

  const cached = subagentUsageCache.get(jsonlPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.data;
  }

  const acc = emptySubagentUsage();
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    foldSubagentLine(acc, line);
  }

  subagentUsageCache.set(jsonlPath, { mtimeMs: stat.mtimeMs, size: stat.size, data: acc });
  return acc;
}

/**
 * Parse subagent metadata from .meta.json plus a *full* parse of each
 * subagent's own JSONL (every turn, not a first/last-lines sample) — subagent
 * fan-out can dwarf the coordinator's own token usage, so estimatedCost has
 * to reflect every turn to be meaningful.
 */
export async function parseSubagents(sessionDir: string): Promise<SubagentInfo[]> {
  const subagentsDir = `${sessionDir}/subagents`;
  try {
    const entries = await fsp.readdir(subagentsDir);
    const metaFiles = entries.filter(e => e.endsWith('.meta.json'));

    const results = await Promise.all(metaFiles.map(async (metaFile): Promise<SubagentInfo | null> => {
      try {
        const metaContent = await fsp.readFile(`${subagentsDir}/${metaFile}`, 'utf-8');
        const meta = JSON.parse(metaContent);
        const agentId = metaFile.replace('.meta.json', '');
        const jsonlPath = `${subagentsDir}/${agentId}.jsonl`;
        const usage = await aggregateSubagentUsageFromFile(jsonlPath);

        return {
          agentId,
          agentType: meta.agentType ?? 'unknown',
          description: meta.description ?? '',
          jsonlPath,
          messageCount: usage.messageCount,
          lastActivityAt: usage.lastActivityAt,
          model: usage.model,
          totalOutputTokens: usage.totalOutputTokens,
          estimatedCost: usage.estimatedCost,
        };
      } catch {
        return null; // skip broken meta files
      }
    }));

    return results.filter((r): r is SubagentInfo => r !== null);
  } catch {
    return [];
  }
}

async function readFirstAndLastLines(
  filePath: string,
  firstN: number,
  lastN: number,
): Promise<string[]> {
  const stat = await fsp.stat(filePath);
  if (stat.size === 0) return [];

  // For small files, just read everything
  if (stat.size < 256 * 1024) {
    const content = await fsp.readFile(filePath, 'utf-8');
    return content.split('\n').filter(l => l.trim());
  }

  // Read first N lines
  const firstLines: string[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8', start: 0 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim()) firstLines.push(line);
    if (firstLines.length >= firstN) break;
  }
  stream.destroy();

  // Read last N lines from end of file
  const lastLines: string[] = [];
  const chunkSize = Math.min(64 * 1024, stat.size);
  const fd = await fsp.open(filePath, 'r');
  const buffer = Buffer.alloc(chunkSize);
  const { bytesRead } = await fd.read(buffer, 0, chunkSize, stat.size - chunkSize);
  await fd.close();

  const tail = buffer.subarray(0, bytesRead).toString('utf-8');
  const tailLines = tail.split('\n').filter(l => l.trim());
  lastLines.push(...tailLines.slice(-lastN));

  // Deduplicate (in case file is short enough that first and last overlap)
  const seen = new Set(firstLines);
  const combined = [...firstLines];
  for (const line of lastLines) {
    if (!seen.has(line)) {
      combined.push(line);
      seen.add(line);
    }
  }

  return combined;
}
