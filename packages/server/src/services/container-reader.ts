import { aggregateSubagentUsageFromContent, type SubagentUsage } from './jsonl-parser.js';
import type { SubagentInfo } from '../types.js';

/**
 * Reading a Claude session out of an agent container is the same work wherever
 * the container runs — only the transport differs. Locally that is
 * `docker exec <name> sh -c <script>`; on the agent VM it is the same script
 * relayed through `<REMOTE_SCRIPT> shell <TAG>` over a tunnel.
 *
 * Everything here is transport-agnostic: callers pass an `ExecScript` that runs
 * a `sh` script inside the container and hands back its stdout. The scripts,
 * their output parsers, and the caches that keep repeat reads cheap live here so
 * both transports behave identically.
 */

/** Runs `script` under `sh` inside a container and resolves with its stdout. */
export type ExecScript = (
  script: string,
  opts: { timeoutMs: number; maxBuffer: number },
) => Promise<string>;

const HEAD_MARKER = '@@@HEAD@@@';
const TAIL_MARKER = '@@@TAIL@@@';

const SAFE_PATH_RE = /^[a-zA-Z0-9_./-]+$/;
const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9_.-]+$/;

/** A container path is only ever interpolated into a script if it looks inert. */
export function isSafeContainerPath(p: string): boolean {
  return SAFE_PATH_RE.test(p);
}

// --- Primary session sample --------------------------------------------------

/**
 * Parse the output of the session-sample exec (see buildSampleScript). Pure so
 * it can be unit-tested without a container.
 *
 * Expected shape:
 *   PATH=<jsonl path>
 *   @@@HEAD@@@
 *   <first bytes of file>
 *   @@@TAIL@@@
 *   <last bytes of file>
 *
 * `head -c` can end mid-line (the trailing partial line simply fails to parse
 * later); `tail -c` can start mid-line, so the first tail line is dropped.
 */
export function parseSampleOutput(
  stdout: string,
): { jsonlPath: string; lines: string[] } | null {
  const headIdx = stdout.indexOf(HEAD_MARKER);
  const tailIdx = stdout.indexOf(TAIL_MARKER);
  if (headIdx === -1 || tailIdx === -1 || tailIdx < headIdx) return null;

  const pathSection = stdout.slice(0, headIdx);
  const pathMatch = pathSection.match(/^PATH=(.+)$/m);
  if (!pathMatch) return null;
  const jsonlPath = pathMatch[1].trim();
  if (!jsonlPath) return null;

  const headLines = stdout
    .slice(headIdx + HEAD_MARKER.length, tailIdx)
    .split('\n')
    .filter(l => l.trim());

  const tailLines = stdout
    .slice(tailIdx + TAIL_MARKER.length)
    .split('\n')
    .filter(l => l.trim());
  // Drop the first tail line — `tail -c` may have sliced it mid-line.
  if (tailLines.length > 0) tailLines.shift();

  const seen = new Set(headLines);
  const lines = [...headLines];
  for (const l of tailLines) {
    if (!seen.has(l)) {
      lines.push(l);
      seen.add(l);
    }
  }

  return { jsonlPath, lines };
}

const UUID_GLOB = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Script that locates the container's *primary* Claude session JSONL and emits a
 * head/tail sample of it. An agent container running Claude's multi-session
 * conductor hosts several session files; this picks the one the live
 * (foreground) claude is resuming — the session shown in the tmux 'agent' pane.
 *
 * Selection, most-correct first, each falling through on failure:
 *   1. The session id the foreground `claude --resume <id>` is running. Forks
 *      resume the same parent id, so this resolves to the primary session, never
 *      a fork's fresh id or a repo-scoped sub-session.
 *   2. Newest JSONL with real content (>= 1KB skips sub-1KB title/agent-name stubs).
 *   3. Newest JSONL overall.
 */
export function buildSampleScript(projectsDir: string): string {
  return (
    `d='${projectsDir}'; ` +
    `id=$(ps -eo args 2>/dev/null | grep -oE -e '--resume[= ][^ ]*${UUID_GLOB}' | grep -oE -e '${UUID_GLOB}' | head -1); ` +
    `f=''; ` +
    `[ -n "$id" ] && f=$(ls "$d"/*/"$id".jsonl 2>/dev/null | head -1); ` +
    `[ -z "$f" ] && f=$(ls -t "$d"/*/*.jsonl 2>/dev/null | while read p; do s=$(wc -c < "$p" 2>/dev/null || echo 0); [ "$s" -ge 1024 ] && { echo "$p"; break; }; done); ` +
    `[ -z "$f" ] && f=$(ls -t "$d"/*/*.jsonl 2>/dev/null | head -1); ` +
    `[ -z "$f" ] && exit 0; ` +
    `echo "PATH=$f"; ` +
    `echo "${HEAD_MARKER}"; head -c 16384 "$f"; ` +
    `printf '\\n${TAIL_MARKER}\\n'; tail -c 131072 "$f"`
  );
}

/**
 * Read the primary Claude session JSONL from inside a container, returning its
 * path and a head/tail sample of lines. Best-effort: null on any failure.
 */
export async function readSessionSample(
  exec: ExecScript,
  projectsDir: string,
  timeoutMs = 10_000,
): Promise<{ jsonlPath: string; lines: string[] } | null> {
  if (!isSafeContainerPath(projectsDir)) return null;
  try {
    const stdout = await exec(buildSampleScript(projectsDir), {
      timeoutMs,
      maxBuffer: 512 * 1024,
    });
    return parseSampleOutput(stdout);
  } catch {
    return null;
  }
}

// --- Full transcript ---------------------------------------------------------

/**
 * Container transcripts have no host file to stat, so they get a short TTL
 * instead. The conversation view polls every few seconds; without this every
 * poll re-reads a multi-MB file over the transport.
 */
const SESSION_TTL_MS = 2000;
const sessionCache = new Map<string, { readAt: number; content: string }>();

/**
 * Read one session JSONL in full, for rendering its complete transcript (the
 * host has no copy of the file). `namespace` scopes the cache to one container.
 * Best-effort: empty string on failure.
 */
export async function readSessionFull(
  exec: ExecScript,
  namespace: string,
  jsonlPath: string,
  opts: { timeoutMs?: number; ttlMs?: number } = {},
): Promise<string> {
  if (!isSafeContainerPath(jsonlPath)) return '';

  const ttl = opts.ttlMs ?? SESSION_TTL_MS;
  const cacheKey = `${namespace}:${jsonlPath}`;
  const cached = sessionCache.get(cacheKey);
  if (cached && Date.now() - cached.readAt < ttl) return cached.content;

  try {
    const content = await exec(`cat '${jsonlPath}' 2>/dev/null`, {
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    sessionCache.set(cacheKey, { readAt: Date.now(), content });
    return content;
  } catch {
    return '';
  }
}

// --- Subagents ---------------------------------------------------------------
//
// An agent container's subagent fan-out can dwarf its coordinator's own token
// usage (dozens of subagents, each with its own transcript). Reading all of that
// on every discovery tick would mean transferring potentially hundreds of MB
// every few seconds, so this is a two-phase read:
//   1. listSubagentStats — one cheap exec: each subagent's full (small)
//      .meta.json plus its .jsonl's mtime/size. No transcript content.
//   2. fetchSubagentContent — a second exec, but only for subagents whose
//      (mtime, size) changed since the last read; a finished subagent's
//      transcript is fetched once and then served from cache forever.

const SUBAGENT_ENTRY_MARKER = '@@@SA@@@';
const SUBAGENT_CONTENT_MARKER = '@@@SAC@@@';

export interface ContainerSubagentStat {
  agentId: string;
  metaRaw: string;
  jsonlMtimeMs: number;
  jsonlSize: number;
}

/**
 * Parse the output of the subagent-listing exec. Pure.
 *
 * Expected shape, repeated per subagent:
 *   @@@SA@@@<agentId>
 *   <meta.json content, single line>
 *   <mtime-epoch-seconds> <size-bytes>
 */
export function parseSubagentListOutput(stdout: string): ContainerSubagentStat[] {
  const lines = stdout.split('\n');
  const results: ContainerSubagentStat[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(SUBAGENT_ENTRY_MARKER)) continue;

    const agentId = lines[i].slice(SUBAGENT_ENTRY_MARKER.length).trim();
    const metaRaw = lines[i + 1] ?? '';
    const [mtimeStr, sizeStr] = (lines[i + 2] ?? '').trim().split(/\s+/);
    const jsonlMtimeMs = Number(mtimeStr) * 1000;
    const jsonlSize = Number(sizeStr);

    if (agentId && Number.isFinite(jsonlMtimeMs) && Number.isFinite(jsonlSize)) {
      results.push({ agentId, metaRaw, jsonlMtimeMs, jsonlSize });
    }
    i += 2; // consumed the meta + stat lines for this entry
  }

  return results;
}

/**
 * Parse the output of the subagent-content exec: marker lines delimiting each
 * subagent's full raw JSONL content. Pure.
 */
export function parseSubagentContentOutput(stdout: string): Map<string, string> {
  const result = new Map<string, string>();
  let currentId: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (currentId === null) return;
    // Our own script emits `echo;` as a separator right after each subagent's
    // `cat`, which shows up as exactly one trailing blank line — not part of
    // the transcript itself.
    if (buf.length > 0 && buf[buf.length - 1] === '') buf = buf.slice(0, -1);
    result.set(currentId, buf.join('\n'));
  };

  for (const line of stdout.split('\n')) {
    if (line.startsWith(SUBAGENT_CONTENT_MARKER)) {
      flush();
      currentId = line.slice(SUBAGENT_CONTENT_MARKER.length).trim();
      buf = [];
    } else if (currentId !== null) {
      buf.push(line);
    }
  }
  flush();

  return result;
}

/**
 * Keep a batched content fetch under a total-bytes budget, using each
 * subagent's already-known `jsonlSize`. A single busy agent session can spawn
 * dozens of subagents whose transcripts sum to tens of MB — one exec for all of
 * them can exceed Node's `maxBuffer` and throw, and (before this existed) a
 * thrown fetch got silently cached as "zero cost" forever since the file's
 * mtime/size never changes again. Splitting into budget-sized chunks keeps each
 * individual exec small regardless of how many subagents changed at once. Pure.
 */
export function chunkStatsByByteBudget(
  stats: ContainerSubagentStat[],
  budgetBytes: number,
): ContainerSubagentStat[][] {
  const chunks: ContainerSubagentStat[][] = [];
  let current: ContainerSubagentStat[] = [];
  let currentSize = 0;

  for (const s of stats) {
    if (current.length > 0 && currentSize + s.jsonlSize > budgetBytes) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(s);
    currentSize += s.jsonlSize;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

// Keep each content-fetch exec comfortably under Node's maxBuffer for that
// call (set with headroom below).
const DEFAULT_CONTENT_BYTE_BUDGET = 20 * 1024 * 1024;

async function listSubagentStats(
  exec: ExecScript,
  subagentsDir: string,
  timeoutMs: number,
): Promise<ContainerSubagentStat[]> {
  const script =
    `d='${subagentsDir}'; ` +
    `[ -d "$d" ] || exit 0; ` +
    `for f in "$d"/*.meta.json; do ` +
    `[ -f "$f" ] || continue; ` +
    `b=$(basename "$f" .meta.json); ` +
    `echo "${SUBAGENT_ENTRY_MARKER}$b"; ` +
    `cat "$f"; echo; ` +
    `j="$d/$b.jsonl"; ` +
    `if [ -f "$j" ]; then stat -c '%Y %s' "$j" 2>/dev/null || echo '0 0'; else echo '0 0'; fi; ` +
    `done`;

  try {
    const stdout = await exec(script, { timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return parseSubagentListOutput(stdout);
  } catch {
    return [];
  }
}

async function fetchSubagentContent(
  exec: ExecScript,
  subagentsDir: string,
  agentIds: string[],
  timeoutMs: number,
): Promise<Map<string, string>> {
  const safeIds = agentIds.filter(id => SAFE_AGENT_ID_RE.test(id));
  if (safeIds.length === 0) return new Map();

  const body = safeIds
    .map(id => `echo "${SUBAGENT_CONTENT_MARKER}${id}"; cat "$d/${id}.jsonl" 2>/dev/null; echo;`)
    .join(' ');
  const script = `d='${subagentsDir}'; ${body}`;

  try {
    const stdout = await exec(script, {
      timeoutMs,
      // Headroom above the byte budget — chunking keeps the *sum* of file sizes
      // under budget, but an oversized single file still gets its own chunk
      // (see chunkStatsByByteBudget), so this needs slack.
      maxBuffer: 256 * 1024 * 1024,
    });
    return parseSubagentContentOutput(stdout);
  } catch {
    return new Map();
  }
}

/**
 * Cache of aggregated subagent usage, keyed by `<namespace>:<agentId>`.
 * Invalidated per-agent by (mtime, size) — see the two-phase note above.
 */
const subagentCache = new Map<string, { mtimeMs: number; size: number; usage: SubagentUsage }>();

export interface ReadSubagentsOptions {
  byteBudget?: number;
  listTimeoutMs?: number;
  contentTimeoutMs?: number;
  /**
   * Skip the content phase entirely and report only what the cheap stats phase
   * knows. Used where the transport is too slow to stream transcripts (the VM
   * over an IAP tunnel): subagents still appear, but contribute no cost.
   */
  statsOnly?: boolean;
}

/**
 * Read every subagent for a container's primary session, pricing each one from
 * its full transcript (not a sample). `namespace` scopes the usage cache to one
 * container. Best-effort: [] on any failure or when the session has no
 * subagents dir (yet).
 */
export async function readSubagents(
  exec: ExecScript,
  namespace: string,
  primaryJsonlPath: string,
  opts: ReadSubagentsOptions = {},
): Promise<SubagentInfo[]> {
  if (!isSafeContainerPath(primaryJsonlPath)) return [];

  const subagentsDir = `${primaryJsonlPath.replace(/\.jsonl$/, '')}/subagents`;
  const stats = await listSubagentStats(exec, subagentsDir, opts.listTimeoutMs ?? 15_000);
  if (stats.length === 0) return [];

  const cacheKey = (agentId: string) => `${namespace}:${agentId}`;

  if (!opts.statsOnly) {
    const toFetch = stats.filter(s => {
      const cached = subagentCache.get(cacheKey(s.agentId));
      return !cached || cached.mtimeMs !== s.jsonlMtimeMs || cached.size !== s.jsonlSize;
    });

    const budget = opts.byteBudget ?? DEFAULT_CONTENT_BYTE_BUDGET;
    for (const chunk of chunkStatsByByteBudget(toFetch, budget)) {
      const contents = await fetchSubagentContent(
        exec,
        subagentsDir,
        chunk.map(s => s.agentId),
        opts.contentTimeoutMs ?? 30_000,
      );
      for (const s of chunk) {
        // A whole-chunk exec failure (timeout, maxBuffer) yields an empty map —
        // every id in it comes back `undefined`, not an empty string. Leave
        // those uncached so they're retried next tick instead of being locked
        // in at zero cost forever (their mtime/size won't change again).
        const content = contents.get(s.agentId);
        if (content === undefined) continue;

        subagentCache.set(cacheKey(s.agentId), {
          mtimeMs: s.jsonlMtimeMs,
          size: s.jsonlSize,
          usage: aggregateSubagentUsageFromContent(content),
        });
      }
    }
  }

  const results: SubagentInfo[] = [];
  for (const s of stats) {
    const cached = subagentCache.get(cacheKey(s.agentId));
    // statsOnly runs price nothing, but the subagent still exists and belongs on
    // the card — surface it with zero usage rather than dropping it.
    if (!cached && !opts.statsOnly) continue;

    let meta: { agentType?: string; description?: string } = {};
    try {
      meta = JSON.parse(s.metaRaw);
    } catch { /* keep defaults below */ }

    results.push({
      agentId: s.agentId,
      agentType: meta.agentType ?? 'unknown',
      description: meta.description ?? '',
      jsonlPath: `${subagentsDir}/${s.agentId}.jsonl`,
      messageCount: cached?.usage.messageCount ?? 0,
      lastActivityAt: cached?.usage.lastActivityAt ?? '',
      model: cached?.usage.model ?? '',
      totalOutputTokens: cached?.usage.totalOutputTokens ?? 0,
      estimatedCost: cached?.usage.estimatedCost ?? 0,
    });
  }

  return results;
}
