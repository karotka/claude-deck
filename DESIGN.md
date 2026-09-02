# claude-deck — Design Document

> **Read this second.** This is `claude-monitor`'s original design document,
> kept because the parts of it that describe *how the app works* are still
> accurate and still hard-won: the JSONL format, the discovery strategy, the
> cost model, the interaction relay, the UI pages.
>
> What the fork changed, and where the current answer lives:
>
> | Superseded here | Current source |
> |---|---|
> | "Data Sources" as a fixed list of four | `SessionProvider` — README, "How it finds sessions" |
> | `InteractionRelay` switching on session kind | `SessionTransport` — `providers/types.ts` |
> | "Jira Issues Overview (/jira)" | the configured workflow — README, "Workflow progress" |
> | The REST API section | `routes/` — `/api/work-items`, `/api/artifacts`, `/api/launch`, `/api/launchers` |
> | The Configuration section | `.env.example` and `examples/claude-deck.config.json` |
> | "Implementation Phases" | historical; the app is built |
>
> `CLAUDE.md` holds the rules that apply when changing the code, including the
> four extension points. Where this document and `CLAUDE.md` disagree,
> `CLAUDE.md` is right.

---

A local dashboard for monitoring and interacting with all Claude Code sessions running on this machine, including Docker-containerized agents.

## Problem

Multiple Claude Code sessions run simultaneously — CLI sessions in terminals, tmux sessions, Docker containers resolving Jira issues. There's no unified way to:
- See all active sessions at a glance
- Know what each agent is doing right now
- Track token usage and costs
- Send messages to a running session
- See subagent trees (leader → analyst → dev → reviewer)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser UI (React)                    │
│  Dashboard  │  Session Detail  │  Session Interaction    │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket + REST
┌──────────────────────┴──────────────────────────────────┐
│                  Backend (Node.js / Fastify)             │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Session       │  │ JSONL        │  │ Interaction   │  │
│  │ Discovery     │  │ Parser       │  │ Relay         │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘  │
│         │                 │                  │           │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴────────┐  │
│  │ Process      │  │ File         │  │ tmux          │  │
│  │ Scanner      │  │ Watcher      │  │ Bridge        │  │
│  │ (ps, docker) │  │ (chokidar)   │  │ (send-keys)   │  │
│  └──────────────┘  └──────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                 │                  │
    OS processes    ~/.claude/projects/    tmux sessions
    Docker API      sessions/ (bind-mount)  Docker exec
```

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Backend | **Node.js + Fastify** | Fast, TypeScript, good fs/process APIs |
| Frontend | **React + Vite** | Standard, fast dev loop |
| UI components | **shadcn/ui + Tailwind** | Clean dashboard look, minimal deps |
| Real-time | **WebSocket** (via fastify-websocket) | Push session updates to browser |
| File watching | **chokidar** | Cross-platform fs.watch wrapper |
| Process inspection | **child_process** (ps, pgrep, docker) | No native Node API needed |
| Terminal interaction | **node-pty** or tmux CLI | Send input to running sessions |

## Data Sources

### 1. Local CLI Sessions (filesystem)

**Location:** `~/.claude/projects/<project-hash>/<session-id>.jsonl`

**JSONL record types** (one JSON object per line):

| Type | Key Fields | What It Tells Us |
|------|-----------|-----------------|
| `permission-mode` | `permissionMode`, `sessionId` | Session start, mode (auto/manual) |
| `system` | `subtype`, `cwd`, `gitBranch`, `entrypoint`, `version`, `url` | Project context, Claude version, remote URL |
| `user` | `timestamp`, `message.content[]`, `promptId` | User messages + tool results |
| `assistant` | `timestamp`, `message.model`, `message.usage`, `message.content[]`, `message.stop_reason` | Model responses, token counts, tool calls |
| `file-history-snapshot` | `snapshot` | File state before edits |
| `attachment` | content | Attached files/images |

**Subagents:** `<session-dir>/subagents/agent-<id>.jsonl` + `agent-<id>.meta.json`
- Meta contains: `{ "agentType": "...", "description": "..." }`
- Subagent JSONL has same format as parent, shares `sessionId`

**Tool results spill:** `<session-dir>/tool-results/` (large outputs stored separately)

### 2. Running Processes

```bash
# Find all claude processes
pgrep -x claude                          # PIDs
ps -eo pid,command | grep "[c]laude"     # PIDs + args (--resume <id>, etc.)
```

Map process → session:
- Parse `--resume <session-id>` from command args
- Parse `--session-id <uuid>` from command args
- For sessions without explicit IDs: match by checking which JSONL file was most recently modified in the project dir matching the process's cwd

### 3. Docker Containers

```bash
# List jira agent containers
docker ps -a --filter "name=jira-agent-" --format json

# Get session files from running container
docker exec <container> ls /workspace/sessions/

# Get claude process inside container
docker exec <container> pgrep -x claude
```

The `sessions/` dir is bind-mounted to `<monorepo>/sessions/` on the host, so session artifacts (analysis.md, implementation.md, etc.) are directly readable.

Docker container JSONL is inside the container at `~/.claude/projects/` — NOT bind-mounted. To read it:
```bash
docker exec <container> cat /home/agent/.claude/projects/-workspace/<session>.jsonl
```

### 4. tmux Sessions

```bash
# List all tmux sessions
tmux ls -F '#{session_name} #{session_created} #{session_attached}'

# Capture current pane content (last N lines)
tmux capture-pane -t <session>:0.0 -p -S -50

# Send input to a session
tmux send-keys -t <session>:0.0 "message text" Enter
```

## Core Modules

### SessionDiscovery

Scans all data sources and produces a unified session list. Runs on a 5-second poll interval.

```typescript
interface Session {
  id: string;                    // UUID from JSONL sessionId
  projectHash: string;           // e.g. "-Users-alice-code-my-repo"
  projectPath: string;           // decoded: /Users/alice/code/my-repo
  jsonlPath: string;             // absolute path to the .jsonl file
  
  // State
  status: 'running' | 'idle' | 'stopped';
  pid: number | null;            // OS process ID if running
  
  // Context (from system messages)
  cwd: string;
  gitBranch: string;
  entrypoint: 'cli' | 'web' | 'ide';
  claudeVersion: string;
  model: string;                 // e.g. "claude-opus-4-6"
  permissionMode: string;        // auto, manual, etc.
  sessionName: string | null;    // from --name flag
  remoteUrl: string | null;      // claude.ai URL if connected
  
  // Timing
  startedAt: string;             // ISO timestamp of first message
  lastActivityAt: string;        // ISO timestamp of last message
  
  // Usage (aggregated from assistant messages)
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  messageCount: number;
  toolCallCount: number;
  
  // Hierarchy
  subagents: SubagentInfo[];
  
  // Source
  source: 'local' | 'docker' | 'tmux';
  dockerContainer?: string;      // container name if source=docker
  tmuxSession?: string;          // tmux session name if source=tmux
}

interface SubagentInfo {
  agentId: string;               // e.g. "agent-a024eb3cab8e63d35"
  agentType: string;             // from .meta.json: "claude-code-guide", "general-purpose", etc.
  description: string;           // from .meta.json
  jsonlPath: string;
  messageCount: number;
  lastActivityAt: string;
  model: string;
  totalOutputTokens: number;
}
```

**Discovery logic:**

1. **Scan filesystem:** List all `~/.claude/projects/*/` directories. For each, find `*.jsonl` files modified in last 24h (configurable). Parse first + last few lines for metadata.

2. **Scan processes:** Run `pgrep -x claude` + `ps -eo pid,command`. Extract session IDs from `--resume` / `--session-id` args. Match remaining PIDs by finding which project dir's JSONL was most recently written.

3. **Scan Docker:** Run `docker ps --filter name=jira-agent- --format json`. For running containers, exec into them to get session metadata.

4. **Scan tmux:** Run `tmux ls`. Match tmux session names to Docker containers (e.g., `jira-PROJ-7746` → `jira-agent-proj-7746`) or to local sessions.

5. **Merge:** Deduplicate across sources. A session might appear as both a local file + a running process + a tmux session.

### JSONLParser

Reads and tails JSONL files, emitting structured events.

```typescript
interface ParsedMessage {
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  timestamp: string;
  
  // For assistant messages
  model?: string;
  usage?: TokenUsage;
  content?: ContentBlock[];    // text blocks + tool_use blocks
  stopReason?: string;
  
  // For system messages
  subtype?: string;            // bridge_status, stop_hook_summary, etc.
  
  // For user messages
  promptId?: string;
  isInterrupt?: boolean;       // "[Request interrupted by user]"
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
```

**Tail mode:** Use `chokidar` to watch the JSONL file. On change, read only new bytes from the last known offset. Parse new lines and emit to WebSocket subscribers.

**Initial parse:** For the session list view, only parse the first 5 lines (metadata) and last 10 lines (recent activity) of each JSONL. Full parsing only when a user opens session detail.

### InteractionRelay

Routes user input to the correct session depending on its source.

| Source | Interaction Method |
|--------|-------------------|
| tmux session | `tmux send-keys -t <session>:0.0 "text" Enter` |
| Docker + tmux | `tmux send-keys -t jira-<KEY>:0.0 "text" Enter` |
| Docker (no tmux) | `docker exec -it <container> claude --resume <id>` (opens new terminal — limited) |
| Local CLI (foreground) | Not possible from external process |
| Local CLI (resumed) | `claude --resume <id>` in a new terminal (creates new turn, doesn't inject into running session) |

**Honest limitations:**
- You CANNOT inject input into a running foreground Claude CLI session from outside.
- tmux `send-keys` is the most reliable interaction path — it simulates keyboard input.
- For non-tmux sessions, the monitor can only **observe**, not **interact**.
- The UI should clearly indicate which sessions are interactive vs. observe-only.

### Docker Session Artifacts

For Jira issue resolution containers, the most useful monitoring comes from the **session files**, not the JSONL:

```
<monorepo>/sessions/<ISSUE_KEY>/
├── analysis.md                 → Analyst phase complete?
├── architecture-decision.md    → Architecture ready for approval?
├── questions/user.md           → Questions log
└── repos/<name>/
    ├── implementation.md       → Dev done?
    ├── review-findings.md      → Review verdict
    ├── test-results.md         → Test verdict
    └── pr-info.md              → PR created?
```

The monitor should parse these to show **workflow phase progress** per Jira issue:
- Phase 1 (Analyst): check `analysis.md` exists + has content
- Phase 2 (Architect): check `architecture-decision.md` exists
- Phase 3 (Approval): check `questions/user.md` for approval entry
- Phase 4 (Implementation): per-repo, check implementation.md + review + test + pr-info
- Phase 5 (Docs): check `doc-updates.md`
- Phase 6 (Jira): check for final comment

## UI Pages

### 1. Dashboard (/)

Grid of session cards showing:

```
┌─────────────────────────────────────────────┐
│ ● RUNNING   my-repo   main       │
│ Session: a1637340...  (CLI, Opus 4.6)       │
│ "how does tmux work? I have tried..."       │
│ ↳ 3 subagents  │  45 msgs  │  12m ago      │
│ Tokens: 156K in / 8.2K out  │  ~$2.40      │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ● RUNNING   Docker: jira-agent-proj-7901    │
│ Issue: PROJ-7901  │  Phase 4/6 (Impl)       │
│ Repos: api (dev ██░░), indexer (done) │
│ ↳ 2 subagents active  │  38m ago            │
│ [Attach tmux]  [View Session Files]         │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ○ STOPPED   Docker: jira-agent-proj-7883    │
│ Issue: PROJ-7883  │  Completed              │
│ PRs: api#142 ✓, indexer#87 ✓          │
│ Exited 1h ago                               │
│ [View Session Files]  [Remove Container]    │
└─────────────────────────────────────────────┘
```

**Filters:** running/stopped/all, source (local/docker/tmux), project

**Sort:** last activity, token usage, start time

### 2. Session Detail (/session/:id)

Left panel: conversation transcript (parsed from JSONL)
- User messages, assistant responses (markdown rendered)
- Tool calls shown as collapsible blocks
- Token usage per turn
- Subagent launches shown as expandable tree nodes

Right panel: metadata sidebar
- Session info (model, project, branch, version)
- Cumulative token usage + cost estimate
- Subagent tree with status
- For Docker/Jira: workflow phase progress

### 3. Session Interaction (/session/:id/interact)

Only available for tmux-backed sessions.

Split view:
- Top: live terminal output (captured via `tmux capture-pane` on 2s interval)
- Bottom: input field that sends via `tmux send-keys`

Warning banner for non-tmux sessions: "This session is observe-only. To interact, restart it in a tmux session."

### 4. Jira Issues Overview (/jira)

Aggregated view of all Jira issue sessions (from `<monorepo>/sessions/`):

| Issue | Status | Phase | Repos | PRs | Container |
|-------|--------|-------|-------|-----|-----------|
| PROJ-7901 | Running | 4 - Implementation | api, indexer | 0/2 | jira-agent-proj-7901 |
| PROJ-7883 | Done | 6 - Complete | api | api#142 | Exited |

Click to expand: shows per-repo status (dev/review/test/PR) and links to session files.

## Cost Estimation

Token prices (hardcoded, updateable via config):

```typescript
const PRICING = {
  'claude-opus-4-6': {
    input: 15.0,       // per 1M tokens
    output: 75.0,
    cacheWrite: 18.75,
    cacheRead: 1.50,
  },
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.30,
  },
  'claude-haiku-4-5': {
    input: 0.80,
    output: 4.0,
    cacheWrite: 1.0,
    cacheRead: 0.08,
  },
};
```

## Project Structure

```
claude-monitor/
├── DESIGN.md                  # this file
├── CLAUDE.md                  # instructions for the implementing agent
├── package.json               # monorepo root (workspaces)
├── packages/
│   ├── server/                # Fastify backend
│   │   ├── src/
│   │   │   ├── index.ts              # server entry
│   │   │   ├── routes/
│   │   │   │   ├── sessions.ts       # GET /api/sessions, GET /api/sessions/:id
│   │   │   │   ├── jira.ts           # GET /api/jira-issues
│   │   │   │   └── interact.ts       # POST /api/sessions/:id/send
│   │   │   ├── services/
│   │   │   │   ├── session-discovery.ts    # unified session scanner
│   │   │   │   ├── jsonl-parser.ts         # JSONL reading + tailing
│   │   │   │   ├── process-scanner.ts      # OS process inspection
│   │   │   │   ├── docker-scanner.ts       # Docker container inspection
│   │   │   │   ├── tmux-bridge.ts          # tmux list/capture/send
│   │   │   │   ├── jira-session-parser.ts  # session/ dir workflow parser
│   │   │   │   └── cost-calculator.ts      # token → dollar estimates
│   │   │   ├── ws/
│   │   │   │   └── session-stream.ts       # WebSocket: live session updates
│   │   │   └── types.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── ui/                    # React frontend
│       ├── src/
│       │   ├── App.tsx
│       │   ├── pages/
│       │   │   ├── Dashboard.tsx
│       │   │   ├── SessionDetail.tsx
│       │   │   ├── SessionInteract.tsx
│       │   │   └── JiraOverview.tsx
│       │   ├── components/
│       │   │   ├── SessionCard.tsx
│       │   │   ├── ConversationView.tsx
│       │   │   ├── SubagentTree.tsx
│       │   │   ├── TokenUsageBadge.tsx
│       │   │   ├── WorkflowProgress.tsx
│       │   │   └── TerminalCapture.tsx
│       │   ├── hooks/
│       │   │   ├── useWebSocket.ts
│       │   │   └── useSessions.ts
│       │   └── lib/
│       │       └── api.ts
│       ├── tsconfig.json
│       └── package.json
└── tsconfig.base.json
```

## API

### REST

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List all discovered sessions (query: `?status=running&source=docker`) |
| GET | `/api/sessions/:id` | Session detail with full metadata + aggregated usage |
| GET | `/api/sessions/:id/messages` | Parsed conversation (paginated: `?offset=0&limit=50`) |
| GET | `/api/sessions/:id/subagents` | Subagent tree for a session |
| POST | `/api/sessions/:id/send` | Send input to a tmux-backed session. Body: `{ "text": "..." }` |
| GET | `/api/sessions/:id/capture` | Capture current tmux pane content (last 100 lines) |
| GET | `/api/jira-issues` | List all Jira issue sessions with workflow phase status |
| GET | `/api/jira-issues/:key` | Detail for one Jira issue: per-repo status, artifacts |
| GET | `/api/jira-issues/:key/files/:path` | Read a session artifact file (analysis.md, etc.) |
| GET | `/api/stats` | Aggregate stats: total sessions, total tokens, total cost |

### WebSocket

Connect to `ws://localhost:3456/ws`

**Client → Server:**
```json
{ "type": "subscribe", "sessionId": "abc-123" }
{ "type": "unsubscribe", "sessionId": "abc-123" }
{ "type": "subscribe_all" }
```

**Server → Client:**
```json
{ "type": "session_updated", "session": { ... } }
{ "type": "session_new", "session": { ... } }
{ "type": "session_stopped", "sessionId": "abc-123" }
{ "type": "new_message", "sessionId": "abc-123", "message": { ... } }
{ "type": "subagent_started", "sessionId": "abc-123", "subagent": { ... } }
```

## Implementation Phases

### Phase 1 — Core backend + minimal UI (MVP)
- SessionDiscovery (filesystem + process scanner)
- JSONLParser (metadata + tail mode)
- REST API for sessions list + detail
- Dashboard page with session cards (status, project, last activity, token count)
- Session detail page with conversation viewer

### Phase 2 — Docker + Jira integration
- DockerScanner (container list, exec for session data)
- JiraSessionParser (workflow phase from session files)
- Jira overview page
- Docker container status on session cards

### Phase 3 — Real-time + interaction
- WebSocket streaming (file watcher → browser)
- tmux bridge (capture + send-keys)
- Session interaction page
- Live-updating dashboard

### Phase 4 — Polish
- Cost tracking with per-session and daily aggregates
- Subagent tree visualization
- Session filtering and search
- Auto-refresh and notifications (session finished, approval needed)

## Configuration

Every setting is an environment variable, read in one place (`config.ts`) and
loaded from `.env` at the repo root at startup. `.env.example` is the reference
list; README.md groups the same settings by what they unlock. Nothing
machine-specific is baked in: paths default to `~`, and each optional
integration (Jira, the local start script, the VM) stays off until it is
configured.

```typescript
// config.ts — all configurable via env vars
export const config = {
  // Server
  port: Number(process.env.PORT ?? 3456),
  host: process.env.HOST ?? 'localhost',
  
  // Claude paths
  claudeDir: envPath('CLAUDE_DIR', path.join(os.homedir(), '.claude')),
  issueSessionsDir: envPath('SESSIONS_DIR') || null, // per-issue artifacts, optional
  
  // Discovery
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? 5000),
  maxSessionAgeDays: Number(process.env.MAX_SESSION_AGE_DAYS ?? 1),
  
  // Docker
  dockerEnabled: process.env.DOCKER_ENABLED !== 'false',
  dockerContainerPrefix: process.env.DOCKER_PREFIX ?? 'jira-agent-',
  
  // tmux
  tmuxEnabled: process.env.TMUX_ENABLED !== 'false',
  tmuxSessionPrefix: process.env.TMUX_PREFIX ?? 'jira-',
  
  // Launch scripts — the user's own; unset disables "Start development".
  // VM support switches itself off unless VM_RESOLVE_SCRIPT is set.
  jiraResolveScript: envPath('JIRA_RESOLVE_SCRIPT'),
  vmResolveScript: envPath('VM_RESOLVE_SCRIPT'),
  
  // Cost (per 1M tokens)
  pricing: { /* see Cost Estimation section */ },
};
```

## Running

```bash
cd claude-monitor
npm install
cp .env.example .env   # optional — every setting has a default
npm run dev          # starts backend (3456) + frontend (5173) with hot reload

# Production
npm run build
npm start            # serves built frontend from backend
```

Open `http://localhost:3456` in browser.
