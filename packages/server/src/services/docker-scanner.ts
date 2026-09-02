import { config } from '../config.js';
import { ALLOWED_RAW_KEYS, execFileWithInput, wheelBytes } from './tmux-bridge.js';
import { execFileRetrying } from './exec-retry.js';
import { sanitizePane, stripAnsi } from './ansi.js';
import {
  readSessionSample,
  readSessionFull,
  readSubagents,
  type ExecScript,
} from './container-reader.js';
import type { SubagentInfo } from '../types.js';

// The pure parsers and the byte-budget chunker now live in container-reader,
// shared with the VM transport. Re-exported here because this module is where
// callers (and their tests) have always found them.
export {
  parseSampleOutput,
  parseSubagentListOutput,
  parseSubagentContentOutput,
  chunkStatsByByteBudget,
  type ContainerSubagentStat,
} from './container-reader.js';

// Every docker call here runs on a poll (containers each scan tick, the pane
// capture every couple of seconds), so a one-off EAGAIN under host process
// pressure would otherwise surface as a real failure. Retrying is safe for all
// of them: a spawn that failed never ran the command.
const execFileAsync = execFileRetrying;

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: 'running' | 'exited' | 'paused';
  status: string;
  createdAt: string;
}

// Reuse the last successful scan for up to STALE_TTL_MS when `docker ps` fails
// transiently (timeout, daemon restart). Without this, a single hiccup wipes
// every session's dockerContainer assignment and flips the UI from "edit" to
// "observe only" until the next scan succeeds.
let lastSuccess: { containers: DockerContainer[]; at: number } | null = null;
const STALE_TTL_MS = 60_000;

/**
 * True when the most recent `scanDockerContainers` call returned authoritative
 * data (either a fresh `docker ps` success, or a cached success younger than
 * STALE_TTL_MS). Callers use this to decide whether the absence of a container
 * from the scan result means "the container is gone" vs "I didn't see it".
 */
export function wasDockerScanRecent(): boolean {
  return !!lastSuccess && Date.now() - lastSuccess.at < STALE_TTL_MS;
}

/** Parse one `docker ps --format '{{json .}}'` line into a container. */
function parsePsLine(line: string): DockerContainer | null {
  try {
    const obj = JSON.parse(line);
    return {
      id: obj.ID,
      name: obj.Names,
      image: obj.Image,
      state: obj.State === 'running' ? 'running' : obj.State === 'paused' ? 'paused' : 'exited',
      status: obj.Status,
      createdAt: obj.CreatedAt,
    };
  } catch {
    return null;
  }
}

export async function scanDockerContainers(): Promise<DockerContainer[]> {
  if (!config.dockerEnabled) return [];

  try {
    // Only running containers — we never use stopped ones in matching, and
    // `docker ps -a` scales linearly with total container count (can take 8s+
    // with many stopped containers and hit the timeout, wiping all docker
    // assignments). Bumped timeout to 20s as a further safety net.
    const { stdout } = await execFileAsync('docker', [
      'ps',
      '--filter', `name=${config.dockerContainerPrefix}`,
      '--format', '{{json .}}',
    ], { timeout: 20000 });

    const containers: DockerContainer[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parsed = parsePsLine(line);
      if (parsed) containers.push(parsed);
    }

    lastSuccess = { containers, at: Date.now() };
    return containers;
  } catch {
    if (lastSuccess && Date.now() - lastSuccess.at < STALE_TTL_MS) {
      return lastSuccess.containers;
    }
    return [];
  }
}

/**
 * Capture the Claude tmux pane inside a Docker container.
 * Falls back to `docker logs` if tmux capture fails.
 */
export async function dockerExecCapture(
  containerName: string,
  lines = 1000,
  cols?: number,
  rows = 50,
): Promise<string> {
  // Try tmux capture-pane first (Claude runs in tmux session "agent")
  try {
    // Detached tmux sessions default to 80x24 — capture returns 80-char lines
    // even when the UI panel is much wider. Resize the window to match the
    // client's visible width so captured lines fill the panel. `resize-window`
    // with the same size is a no-op, so calling it on every capture is safe.
    if (cols && cols > 0) {
      try {
        await execFileAsync('docker', [
          'exec', containerName,
          'tmux', 'resize-window', '-t', config.containerTmuxWindow, '-x', String(cols), '-y', String(rows),
        ], { timeout: 5000 });
      } catch { /* best-effort — fall through to capture at current size */ }
    }
    const { stdout } = await execFileAsync('docker', [
      'exec', containerName,
      // -J joins wrapped lines so URLs/text broken across pane width come back intact.
      'tmux', 'capture-pane', '-t', config.containerTmuxPane, '-p', '-J', '-e', '-S', `-${lines}`,
    ], { timeout: 10000 });
    return sanitizePane(stdout);
  } catch { /* tmux not available or session doesn't exist — fall back */ }

  // Fallback: container logs
  try {
    const { stdout, stderr } = await execFileAsync('docker', [
      'logs', '--tail', String(lines), containerName,
    ], { timeout: 10000 });
    return stripAnsi(stdout + stderr);
  } catch (err) {
    throw new Error(`Failed to capture logs for ${containerName}: ${err}`);
  }
}

const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

function containerProjectsDir(): string {
  return /^[a-zA-Z0-9_./-]+$/.test(config.containerClaudeProjectsDir)
    ? config.containerClaudeProjectsDir
    : '/home/agent/.claude/projects';
}

function isReadableContainer(containerName: string): boolean {
  return (
    config.dockerEnabled &&
    SAFE_NAME_RE.test(containerName) &&
    containerName.startsWith(config.dockerContainerPrefix)
  );
}

/** `docker exec`-backed script runner for the shared container reader. */
function dockerExecScript(containerName: string): ExecScript {
  return async (script, { timeoutMs, maxBuffer }) => {
    const { stdout } = await execFileAsync(
      'docker',
      ['exec', containerName, 'sh', '-c', script],
      { timeout: timeoutMs, maxBuffer },
    );
    return stdout;
  };
}

/**
 * Read the primary Claude session JSONL from inside a running container, so
 * containers that don't share ~/.claude with the host still show up on the
 * dashboard. Best-effort: null on any failure.
 */
export async function readContainerSessionSample(
  containerName: string,
): Promise<{ jsonlPath: string; lines: string[] } | null> {
  if (!isReadableContainer(containerName)) return null;
  return readSessionSample(dockerExecScript(containerName), containerProjectsDir());
}

/**
 * Read the full contents of one session JSONL inside a container, for rendering
 * its complete transcript. Best-effort: empty string on failure.
 */
export async function readContainerSessionFull(
  containerName: string,
  jsonlPath: string,
): Promise<string> {
  if (!isReadableContainer(containerName)) return '';
  return readSessionFull(dockerExecScript(containerName), containerName, jsonlPath);
}

/**
 * Read every subagent for a container's primary session, pricing each one from
 * its full transcript. Best-effort: [] on any failure.
 */
export async function readContainerSubagents(
  containerName: string,
  primaryJsonlPath: string,
): Promise<SubagentInfo[]> {
  if (!isReadableContainer(containerName)) return [];
  return readSubagents(dockerExecScript(containerName), containerName, primaryJsonlPath);
}

/**
 * Send input to the Claude tmux session inside a Docker container.
 * Uses `docker exec ... tmux send-keys` to type into the running session.
 */
export async function dockerExecSend(
  containerName: string,
  text: string,
  appendEnter = true,
): Promise<void> {
  const buf = 'cm-paste';
  try {
    // One bracketed paste rather than dozens of `docker exec ... send-keys -l`
    // chunks — see sendKeys for the full rationale. `docker exec -i` keeps stdin
    // open so `load-buffer -` reads the whole payload (no ARG_MAX limit and no
    // per-chunk exec that could blow the timeout on a large message).
    await execFileWithInput('docker', [
      'exec', '-i', containerName,
      'tmux', 'load-buffer', '-b', buf, '-',
    ], text, 15000);
    await execFileAsync('docker', [
      'exec', containerName,
      'tmux', 'paste-buffer', '-t', config.containerTmuxPane, '-b', buf, '-d', '-p',
    ], { timeout: 10000 });
    if (appendEnter) {
      await execFileAsync('docker', [
        'exec', containerName,
        'tmux', 'send-keys', '-t', config.containerTmuxPane, 'Enter',
      ], { timeout: 10000 });
    }
  } catch (err) {
    throw new Error(`Failed to send to ${containerName}: ${err}`);
  }
}

export async function dockerExecSendKey(
  containerName: string,
  key: string,
): Promise<void> {
  const wheel = wheelBytes(key);
  if (!wheel && !ALLOWED_RAW_KEYS.has(key)) {
    throw new Error(`Disallowed key: ${key}`);
  }
  try {
    await execFileAsync('docker', [
      'exec', containerName,
      'tmux', 'send-keys', '-t', config.containerTmuxPane,
      ...(wheel ? ['-l', wheel] : [key]),
    ], { timeout: 10000 });
  } catch (err) {
    throw new Error(`Failed to send key ${key} to ${containerName}: ${err}`);
  }
}

export async function removeDockerContainer(name: string, force: boolean): Promise<void> {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  if (!name.startsWith(config.dockerContainerPrefix)) {
    throw new Error(`Refusing to remove container outside prefix '${config.dockerContainerPrefix}': ${name}`);
  }
  const args = force ? ['rm', '-f', name] : ['rm', name];
  await execFileAsync('docker', args, { timeout: 30000 });
}

export async function listAllJiraContainers(): Promise<DockerContainer[]> {
  if (!config.dockerEnabled) return [];
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps', '-a',
      '--filter', `name=${config.dockerContainerPrefix}`,
      '--format', '{{json .}}',
    ], { timeout: 30000 });
    const containers: DockerContainer[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parsed = parsePsLine(line);
      if (parsed) containers.push(parsed);
    }
    return containers;
  } catch {
    return [];
  }
}
