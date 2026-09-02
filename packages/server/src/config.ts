import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadConfigFile,
  type LauncherConfig,
  type WorkflowConfig,
} from './config-file.js';

// Load `.env` from the repo root (and the current working directory, when that
// differs) before reading anything below. Values already present in the real
// environment win — `process.loadEnvFile` never overwrites them — so an
// explicit `FOO=bar npm run dev` still beats the file. Missing files are fine:
// every setting has a default or is optional.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// src/config.ts in dev, dist/config.js after a build — three levels up either way.
const repoRoot = path.resolve(moduleDir, '../../..');
// Skipped under vitest: tests set exactly the environment they need, and a
// developer's own .env must not decide whether they pass.
if (!process.env.VITEST) {
  for (const dir of new Set([repoRoot, process.cwd()])) {
    try {
      process.loadEnvFile(path.join(dir, '.env'));
    } catch {
      // No .env there — configuration comes from the real environment.
    }
  }
}

/** A name that is safe to interpolate into a shell script or a tmux target. */
function envName(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && /^[a-zA-Z0-9_.-]+$/.test(raw) ? raw : fallback;
}

// Claude runs inside an agent container under tmux. The monitor reads that pane
// and types into it, so the session name is part of the contract with whatever
// image you use — see "Bring your own agent containers" in README.md.
const containerTmuxSession = envName('CONTAINER_TMUX_SESSION', 'agent');

/**
 * The first of these environment variables that is set.
 *
 * Several settings were named after the one integration they were built for —
 * JIRA_ISSUE_PREFIX, VM_RESOLVE_SCRIPT, DOCKER_PREFIX, SESSIONS_DIR — which
 * stopped being true once the app grew tags, launchers and providers. The
 * neutral name comes first and the original is accepted after it, so an
 * existing .env keeps working unchanged and nothing has to be migrated.
 */
function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Read a path setting, expanding a leading `~` to the home directory. */
function envPath(names: string | string[], fallback = ''): string {
  const raw = envFirst(...(Array.isArray(names) ? names : [names]));
  if (!raw) return fallback;
  return raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
}

/** A boolean setting that defaults to on; any of `names` set to "false" turns it off. */
function envFlagOn(...names: string[]): boolean {
  return envFirst(...names) !== 'false';
}

// The optional claude-deck.config.json, for the settings a flat environment
// variable cannot express: a list of launchers, a workflow's phases. Loaded
// once, here, so config.ts stays the only place that reads configuration.
// Skipped under vitest for the same reason as .env: a developer's own file must
// not decide whether tests pass.
const file = process.env.VITEST ? { path: null, values: {} } : loadConfigFile();

/** The default tag shape: a Jira/Linear-style key, e.g. PROJ-1234. */
const DEFAULT_TAG_PATTERN = '[A-Z][A-Z0-9]+-\\d+';

/**
 * Launchers defined the old way, as one script per target. Synthesized so an
 * existing .env keeps working with no config file: the two scripts become two
 * entries in the same list a config file would have supplied, and everything
 * downstream sees only the list. Suppressed entirely once the file defines its
 * own launchers, so a config file is never merged with guesses.
 */
function launchersFromEnv(): LauncherConfig[] {
  const local = envPath(['LAUNCH_SCRIPT', 'JIRA_RESOLVE_SCRIPT']);
  const remote = envPath(['REMOTE_SCRIPT', 'VM_RESOLVE_SCRIPT']);
  const prefix = envFirst('CONTAINER_PREFIX', 'DOCKER_PREFIX') ?? 'jira-agent-';
  const launchers: LauncherConfig[] = [];
  if (local) {
    launchers.push({
      id: 'local',
      label: 'Start development',
      command: [local, '{{tag}}'],
      inputLabel: 'Issue key',
      containerPrefix: prefix,
      launchPrefix: 'jira-launch-',
    });
  }
  if (remote && envFlagOn('REMOTE_ENABLED', 'VM_ENABLED')) {
    launchers.push({
      id: 'vm',
      label: 'Run on VM',
      command: [remote, 'start', '{{tag}}'],
      inputLabel: 'Issue key',
      containerPrefix: prefix,
      // Distinct from the local one so the same tag can be started in both
      // places at once without one launch killing the other's tmux session.
      launchPrefix: 'jira-launch-vm-',
      remote: true,
    });
  }
  return launchers;
}

export const config = {
  /** Path of the config file in use, or null when running on env vars alone. */
  configFilePath: file.path,

  /**
   * Regular expression source matching one tag — the short identifier a session
   * belongs to. Everything that used to hardcode the Jira key shape reads this:
   * container naming, the tab label, the batch-launch parser, the tracker
   * lookup. Set it to your own scheme and the whole app follows.
   */
  tagPattern: envFirst('TAG_PATTERN') || file.values.tag?.pattern || DEFAULT_TAG_PATTERN,

  /**
   * How to read the per-item artifact directories under SESSIONS_DIR: which
   * phases exist and which file marks each one done. There is no default —
   * these filenames belong to whatever workflow writes them, so the overview is
   * simply absent until an installation describes its own. See
   * examples/ for a worked one.
   */
  workflow: (file.values.workflow ?? null) as WorkflowConfig | null,

  /**
   * What the "Start development" dialog can run. Each launcher is a command of
   * the user's, with {{tag}} substituted; the app owns no part of what it does.
   */
  launchers: file.values.launchers ?? launchersFromEnv(),


  port: Number(process.env.PORT ?? 3456),
  // Loopback by default. The API can read every transcript on this machine and
  // type into live sessions, and it has no authentication of its own, so it is
  // not something to expose on a shared network without meaning to. Set
  // HOST=0.0.0.0 to reach the dashboard from another device.
  //
  // 'localhost' rather than '127.0.0.1': Fastify binds every loopback address
  // for it, IPv6 included. Bound to 127.0.0.1 alone, anything that resolves
  // `localhost` to ::1 first — the UI dev server's proxy on macOS — gets
  // ECONNREFUSED.
  host: process.env.HOST ?? 'localhost',

  claudeDir: envPath('CLAUDE_DIR', path.join(os.homedir(), '.claude')),
  // Optional: a directory of per-issue session artifacts written by the agent
  // workflow (one subdirectory per Jira key). Unset disables the Jira overview's
  // artifact columns; nothing else depends on it.
  issueSessionsDir: envPath(['ARTIFACTS_DIR', 'SESSIONS_DIR']) || null,

  // Claude Code's own registry of live sessions: one <pid>.json per session,
  // carrying its session id, name, working directory and busy/idle status. It
  // is the only exact answer to "what is running right now, and which
  // transcript is it writing" — `ps` cannot tell an idle month-old session from
  // one in use, and a plain `claude` puts no session id on its command line.
  //
  // Undocumented internal, so it is an enrichment and never a requirement: a
  // missing directory means less detail, not missing sessions. Point this
  // elsewhere if a future version moves it.
  claudeSessionsDir: envPath('CLAUDE_SESSIONS_DIR', path.join(os.homedir(), '.claude', 'sessions')),

  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? 5000),
  maxSessionAgeDays: Number(process.env.MAX_SESSION_AGE_DAYS ?? 1),

  dockerEnabled: envFlagOn('CONTAINERS_ENABLED', 'DOCKER_ENABLED'),
  // Only containers whose name starts with this prefix are scanned, read from,
  // sent to, or removed — it is the blast radius of every docker operation
  // here, so keep it specific to the agent containers.
  dockerContainerPrefix: envFirst('CONTAINER_PREFIX', 'DOCKER_PREFIX') ?? 'jira-agent-',
  // Where Claude Code writes its session JSONLs *inside* an agent container.
  // Newer containers no longer bind-mount ~/.claude to the host, so the monitor
  // reads these sessions via `docker exec` instead of the host filesystem.
  containerClaudeProjectsDir:
    process.env.CONTAINER_CLAUDE_PROJECTS_DIR ?? '/home/agent/.claude/projects',
  // tmux targets inside the container: the window to resize, and the pane to
  // capture and type into.
  containerTmuxSession,
  containerTmuxWindow: `${containerTmuxSession}:0`,
  containerTmuxPane: `${containerTmuxSession}:0.0`,

  tmuxEnabled: process.env.TMUX_ENABLED !== 'false',
  tmuxSessionPrefix: process.env.TMUX_PREFIX ?? 'jira-',

  // Plain Claude Code sessions launched from the monitor itself. The prefix is
  // deliberately distinct from tmuxSessionPrefix so these names never reach the
  // Jira issue-key matcher, which would try to read a key out of the name.
  spawnTmuxPrefix: process.env.SPAWN_TMUX_PREFIX ?? 'cm-',
  // Prefilled in the "New session" dialog. Point it at the repo you start
  // sessions in most often; the home directory is only a neutral default.
  spawnDefaultCwd: envPath('SPAWN_DEFAULT_CWD', os.homedir()),
  // Launch runs `claude` through an interactive login shell rather than exec'ing
  // the binary: `claude` is commonly a shell function that injects an OAuth
  // token, so exec'ing the binary directly would start it unauthenticated.
  spawnShell: process.env.SPAWN_SHELL ?? process.env.SHELL ?? '/bin/zsh',

  // --- Jira -----------------------------------------------------------------
  // Prefilled in the "Start development" dialog, e.g. 'PROJ-'. Cosmetic only —
  // any valid key can still be typed.
  tagPrefix: envFirst('TAG_PREFIX', 'JIRA_ISSUE_PREFIX') ?? '',
  // Which `mcpServers` entry in ~/.claude.json to read Atlassian credentials
  // from when JIRA_*/ATLASSIAN_* env vars aren't set. Empty means "any entry
  // that carries them" — see jira-credentials.ts.
  jiraMcpServer: process.env.JIRA_MCP_SERVER ?? '',

  // Your own script that builds and starts an agent container for an issue
  // key, invoked as `<script> <ISSUE-KEY>`. The monitor owns no part of that
  // contract. Unset disables "Start development" for local containers;
  // everything else (discovery, transcripts, interaction) works without it.
  launchScript: envPath(['LAUNCH_SCRIPT', 'JIRA_RESOLVE_SCRIPT']),

  // --- Remote agent VM ------------------------------------------------------
  // The same agent containers, running on a GCE VM instead of this laptop.
  // Every VM operation goes through the script below — the identical one used
  // by hand from a terminal. The monitor never talks to gcloud, the IAP tunnel,
  // or the VM's docker daemon itself, so the VM's credential model (secrets
  // loaded on the VM under its own service account) is untouched.
  // VM support switches itself off unless VM_RESOLVE_SCRIPT names a script, so
  // an installation without a VM needs no configuration at all. VM_ENABLED=false
  // switches it off even when the script is present.
  vmEnabled: envFlagOn('REMOTE_ENABLED', 'VM_ENABLED')
    && !!envPath(['REMOTE_SCRIPT', 'VM_RESOLVE_SCRIPT']),
  // Must accept `list`, `start <KEY>` and `shell <KEY> <command…>`; see the VM
  // section of CLAUDE.md for the contract the transports rely on.
  vmResolveScript: envPath(['REMOTE_SCRIPT', 'VM_RESOLVE_SCRIPT']),
  // Instance targeting, forwarded to the script as AGENT_VM_* on every call.
  // Each is only passed when set — otherwise the script's own defaults apply.
  // Set AGENT_VM_NAME whenever the script's default names a different instance
  // than the one you want polled, or the UI will display one and poll the other.
  vmName: process.env.AGENT_VM_NAME ?? '',
  vmZone: process.env.AGENT_VM_ZONE ?? null,
  vmProject: process.env.AGENT_VM_PROJECT ?? null,

  // Every VM call is a gcloud IAP round trip: `list` alone measures ~9s against
  // a running instance. The VM therefore gets its own much slower discovery
  // loop rather than riding the local 5s tick.
  vmScanIntervalMs: Number(process.env.VM_SCAN_INTERVAL_MS ?? 30_000),
  // `gcloud compute instances describe` is cheap but not free; the state only
  // changes on boot/shutdown, so a short cache covers a whole burst of calls.
  vmStateTtlMs: Number(process.env.VM_STATE_TTL_MS ?? 15_000),
  // The terminal panel polls capture every 2s. Serving repeats from cache keeps
  // that from queuing several-second SSH round trips on top of each other.
  // Only used for the one-shot fallback; streamed frames are served directly.
  vmCaptureTtlMs: Number(process.env.VM_CAPTURE_TTL_MS ?? 2500),

  // Reuse one SSH connection across script calls (~11.5s → ~6s per call). See
  // ssh-mux.ts; set VM_SSH_MUX=false to fall back to plain connections.
  vmSshMux: process.env.VM_SSH_MUX !== 'false',
  vmSshMuxPersistSeconds: Number(process.env.VM_SSH_MUX_PERSIST_SECONDS ?? 600),

  // Reuse the connection the script opened, skipping gcloud's ~6s startup on
  // subsequent calls (~0.6s measured). Parameters are learned from the script's
  // own ssh invocation, never hardcoded; falls back to the script on any doubt.
  // This is what makes keystrokes feel immediate. VM_FAST_EXEC=false opts out.
  vmFastExec: process.env.VM_FAST_EXEC !== 'false',
  // The fast path replays the command your VM script sent over the connection
  // gcloud already opened. It only ever replays a command aimed at this script,
  // so a recording that isn't what we think it is can't be reused — which means
  // the monitor has to know what your script runs on the far side.
  vmRunnerScript: envName('VM_RUNNER_SCRIPT', 'vm-resolve-runner.sh'),

  // Live terminal frames over one long-lived connection instead of a call per
  // poll. Measured on the real VM: ~7.6s to first frame, then 1 frame/second.
  vmStreamEnabled: process.env.VM_STREAM !== 'false',
  // Frames are ~3KB, so the tunnel cost is negligible; what this buys is that a
  // keystroke's effect shows up in a fraction of a second rather than up to one.
  vmStreamIntervalSeconds: Number(process.env.VM_STREAM_INTERVAL_SECONDS ?? 0.4),
  // The remote loop is bounded so it can't outlive this process inside the
  // container; the monitor re-spawns while the panel is still open.
  vmStreamMaxFrames: Number(process.env.VM_STREAM_MAX_FRAMES ?? 900),
  // How long to wait between pasting a message and pressing Enter. Locally the
  // three tmux commands are three separate `docker exec` calls and the spawn
  // latency between them covers this; in a single remote payload there is no
  // gap, and the Enter lands mid-paste and is swallowed — which is why every
  // message used to need a second Enter. Raise it if that ever reappears.
  vmPasteSettleSeconds: Number(process.env.VM_PASTE_SETTLE_SECONDS ?? 0.25),

  // A persistent command channel per session, so a keystroke costs only the
  // remote work (~0.13s) instead of opening an SSH channel first (~0.42s of a
  // ~0.55s call). VM_CHANNEL=false falls back to one call per send.
  vmChannelEnabled: process.env.VM_CHANNEL !== 'false',
  vmChannelIdleMs: Number(process.env.VM_CHANNEL_IDLE_MS ?? 120_000),

  // Stop streaming for a session nothing has asked about recently.
  // How fast the UI polls the terminal panel for a remote session. Faster than
  // the local default because streamed frames are served from this process's
  // memory — the poll never leaves the machine. Published on /api/config so the
  // UI picks it up from the transport rather than special-casing a source name.
  remoteCapturePollMs: Number(process.env.REMOTE_CAPTURE_POLL_MS ?? 500),

  vmStreamIdleMs: Number(process.env.VM_STREAM_IDLE_MS ?? 30_000),
  // Beyond this, a frame is old enough that a one-shot read is worth its cost.
  vmStreamStaleMs: Number(process.env.VM_STREAM_STALE_MS ?? 15_000),
  // Subagent transcripts can run to tens of MB. Streaming those over the tunnel
  // on a poll is not viable, so VM sessions list their subagents (cheap stat
  // read) without pricing them. Set VM_SUBAGENT_COSTS=true to pull the
  // transcripts too — accurate cost, much slower ticks.
  vmSubagentCosts: process.env.VM_SUBAGENT_COSTS === 'true',
  vmSubagentByteBudget: Number(process.env.VM_SUBAGENT_BYTE_BUDGET ?? 8 * 1024 * 1024),

  // $ per million tokens, standard (non-batch) API rates. cacheWrite is the
  // 5-minute-TTL write price (1.25x input); cacheRead is 0.1x input. Keyed by
  // the bare model id Claude Code writes to JSONL (see cost-calculator.ts for
  // how dated snapshots / shorthand aliases are normalized onto these keys).
  // This is what a request would cost on metered API billing — i.e. what a
  // Claude subscription absorbs, and what you'd actually be charged once
  // subscription usage is exhausted and requests fall back to pay-per-token.
  pricing: {
    'claude-fable-5': { input: 10.0, output: 50.0, cacheWrite: 12.5, cacheRead: 1.0 },
    'claude-mythos-5': { input: 10.0, output: 50.0, cacheWrite: 12.5, cacheRead: 1.0 },
    'claude-opus-5': { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.50 },
    'claude-opus-4-8': { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.50 },
    'claude-opus-4-7': { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.50 },
    'claude-opus-4-6': { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.50 },
    'claude-opus-4-5': { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.50 },
    'claude-opus-4-1': { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
    'claude-opus-4-0': { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
    // Sonnet 5 has an introductory rate ($2/$10) through 2026-08-31; this uses
    // the standard post-intro sticker price so the estimate doesn't need to
    // change again once the promo ends.
    'claude-sonnet-5': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
    'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
    'claude-sonnet-4-0': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
    'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.10 },
  } as Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>,
} as const;

export function projectsDir(): string {
  return path.join(config.claudeDir, 'projects');
}
