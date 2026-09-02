# claude-deck

A local dashboard for every Claude Code session running on your machine — the
ones in your terminals, the ones inside containers, and the ones on another
machine entirely. It reads Claude Code's own transcript files and the OS, so
there is no database, no daemon to install, and nothing to sign up for.

What you get out of the box, with no configuration at all:

- **One list of every session**, with live status, model, token usage and an
  estimated cost per session.
- **Full transcripts**, rendered — user turns, assistant turns, tool calls, and
  each subagent's own transcript priced separately.
- **A live terminal** for sessions that run under tmux, with the ability to type
  into them from the browser.
- **Notes and tabs**, so a dozen parallel sessions stay navigable.

And, once you point it at your own tooling:

- **Agent containers**, here or on another machine, discovered and driven the
  same way.
- **Launchers** — your commands, run from the dashboard, one click per piece of
  work.
- **A tracker** — live issue status beside each session.
- **Workflow progress** — read off the artifacts your agent workflow writes.

Everything in the second list is optional and switches itself off when it isn't
configured.

> claude-deck is a fork of `claude-monitor` by Michal Hybler. The session
> discovery, the JSONL parsing, the cost model and the remote-transport latency
> work are his; this fork generalizes the parts that assumed one company's Jira,
> Docker and VM setup.

---

## Requirements

| | |
|---|---|
| **Node.js** | 20.12 or newer (the server uses `process.loadEnvFile`); 22+ recommended |
| **OS** | macOS or Linux |
| **Claude Code** | any version that writes `~/.claude/projects/**.jsonl` |
| **tmux** | needed for the live terminal and for "New session" |
| **Docker** *(optional)* | needed for agent containers |

**tmux is what makes sessions interactive.** Claude Code offers no IPC to write
into a running session, so the only way to type into one from the browser is for
it to be running under tmux — that is also why "New session" launches into a
detached tmux session. Without tmux the dashboard still works: sessions,
transcripts, subagent trees and costs are all read from files. Everything
interactive degrades to observe-only.

```bash
brew install tmux          # macOS
sudo apt install tmux      # Debian/Ubuntu
sudo dnf install tmux      # Fedora
```

## Quick start

```bash
git clone <this-repo> claude-deck
cd claude-deck
npm install
npm run dev
```

Then open **http://localhost:5173**. The API runs on `:3456` and the Vite dev
server proxies to it.

For a single-process production run:

```bash
npm run build
npm start                 # serves the built UI and the API on :3456
```

Or use the helper script, which runs it in the background and tracks the PID:

```bash
./restart.sh              # dev mode (:3456 + :5173)
./restart.sh prod         # built server only (:3456)
./restart.sh stop         # stop
```

Logs land in `.run/app.log`.

---

## Configuration

Two files, both optional:

- **`.env`** in the repo root — every scalar setting. `.env.example` documents
  them all with their defaults. Anything exported in your shell wins over the
  file.
- **`claude-deck.config.json`** — the settings that are a *list*: launchers, and
  a workflow's phases. An environment variable cannot express one of those
  without inventing an encoding nobody can read.
  `examples/claude-deck.config.json` is a worked example you can copy and cut
  down. Point `CLAUDE_DECK_CONFIG` elsewhere if you'd rather keep it outside the
  checkout.

Neither is required. With neither, you get the session dashboard, transcripts,
costs and terminals.

A malformed config file stops the server with the offending key named, rather
than starting with a launcher silently missing.

### Tags

A **tag** is the short identifier a session belongs to — the thing that ties a
container's name, a session's opening prompt and a tracker item together. The
default shape is a Jira/Linear-style key (`PROJ-1234`), and one setting changes
it everywhere:

```bash
TAG_PATTERN='#\d+'        # GitHub issues
```

Container matching, the tab label, the launch dialog's paste parser and the
tracker lookup all follow. Nothing else in the app carries its own idea of what
an identifier looks like.

One deliberate exception: driving a container on **another machine** accepts
only letters, digits, dot, dash and underscore, whatever `TAG_PATTERN` says. The
handle is interpolated into a shell command on the far side, and a guard that
configuration could widen would not be a guard. A `#42`-style scheme therefore
works everywhere except the remote transport, which reports it rather than
mangling the command.

### Launchers

A launcher is a command of yours with `{{tag}}` substituted, plus the names it
will produce:

```json
{
  "launchers": [
    {
      "id": "container",
      "label": "Start development",
      "inputLabel": "Issue key",
      "command": ["~/code/my-repo/start-agent.sh", "{{tag}}"],
      "containerPrefix": "agent-",
      "launchPrefix": "agent-launch-"
    },
    {
      "id": "worktree",
      "label": "New worktree",
      "command": ["~/bin/new-worktree.sh", "{{tag}}"]
    }
  ]
}
```

The dialog shows one option per entry. Each runs in its own detached tmux
session — which is also how a command that ends by attaching to a TTY still
works — and the launch view follows it until the container is up. A launcher
with no `containerPrefix` produces no container, and its progress is simply what
its tmux pane says.

The command is passed as argv, never through a shell, so no quoting rules apply
and a tag can only ever land in one argument slot.

For the common case of a single script taking a single tag, `LAUNCH_SCRIPT` in
`.env` is a shorthand that produces the same thing.

### Agent containers

claude-deck discovers, reads and drives containers whose name starts with
`CONTAINER_PREFIX`, however they were started. It contains no agent tooling and
fetches nothing — it reads containers you started, and shells out to scripts you
supply.

What it needs from a container:

| | |
|---|---|
| **Name** | `<CONTAINER_PREFIX><tag-lowercase>`, e.g. `agent-proj-1234`. The tag is read back out of the name. |
| **tmux** | Claude runs under tmux in session `CONTAINER_TMUX_SESSION` (default `agent`), window 0, pane 0. This is what gets captured and typed into. |
| **Transcripts** | Claude Code's JSONLs at `CONTAINER_CLAUDE_PROJECTS_DIR` (default `/home/agent/.claude/projects`). |
| **`sh`, `ps`, `tmux`** | Present in the image — reads run as `docker exec <name> sh -c …`. |

Without tmux the container still appears with its transcript; only the live
terminal degrades to `docker logs`, which is read-only.

`CONTAINER_PREFIX` bounds every container operation: a container outside it is
never read, never sent to, and refused for removal.

### A tracker

Live issue status beside each session. Jira ships as the one implementation;
without credentials the badges are simply absent and nothing else changes.

| Variable | What it does |
|---|---|
| `JIRA_BASE_URL` | e.g. `https://your-site.atlassian.net` |
| `JIRA_EMAIL` | account email for the API token |
| `JIRA_API_TOKEN` | create one at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_MCP_SERVER` | which `mcpServers` entry in `~/.claude.json` to read credentials from |

Credentials resolve per field, in order: `JIRA_*`, then `ATLASSIAN_*`, then an
MCP server entry in `~/.claude.json` — the one named by `JIRA_MCP_SERVER`, or
any entry whose `env` block carries `ATLASSIAN_*` keys. So if you already run an
Atlassian MCP server in Claude Code, the status badges appear with no
configuration at all.

To add another tracker, implement `Tracker` in `packages/server/src/trackers/`
and register it. The interface is five lines: map a batch of tags to
`{status, state, summary, url}`. The status name is shown verbatim and the
four-value state decides the colour, so a tracker can call its statuses whatever
it likes.

### Workflow progress

If your agent workflow writes artifacts as it goes — an analysis, then a design,
then a PR link per repo — claude-deck can read that directory and show progress.
It needs two things: `ARTIFACTS_DIR` pointing at a directory with one
subdirectory per tag, and a `workflow` block saying what the files mean.

```json
{
  "workflow": {
    "phases": [
      { "label": "Analysis",       "signal": "analysis.md" },
      { "label": "Design",         "signal": ["design.md", "architecture.md"] },
      { "label": "Docs",           "signal": "docs.md", "linear": false },
      { "label": "Ship",           "signal": { "everyGroup": "pr.md" } }
    ],
    "groups": {
      "dir": "repos",
      "noun": "repo",
      "signals": { "impl": "impl.md", "PR": "pr.md" }
    }
  }
}
```

A phase is done when its signal file exists and is non-empty. A signal is a
path, a list of alternatives, or `{"everyGroup": file}` for "every repo has
shipped". Two rules make it read the way a person would:

- **Reaching a later linear phase implies the earlier ones.** A pushed PR means
  the design was agreed, whether or not anyone wrote the file that says so —
  otherwise a workflow that skips a step shows as stuck at it forever.
- **`"linear": false` marks a side track.** It can happen at any time, or never,
  and never holds anything up.

With neither half configured the page says so, rather than looking like an empty
list.

### Another machine

The same agent containers, running somewhere else. Every operation shells out to
*your* script — the same one you would run by hand — so claude-deck owns no part
of that contract: not the instance, not the tunnel, not the image, not the
secrets. Set `REMOTE_SCRIPT` and it turns on.

| Invocation | Must do |
|---|---|
| `<script> list` | Print the host state and the container table. **Must never boot the host** — this is the only command that gets polled. |
| `<script> start <TAG>` | Bring the host up if needed and start the container for that tag. |
| `<script> shell <TAG> <command…>` | Run the command inside that container, ending in `bash -lc` on the far side. |
| `<script> rm <TAG> -f` | Remove the container. |

`list` output is parsed, so its shape matters:

```
VM my-agent-vm (my-project/us-central1-a): RUNNING
NAMES                    STATUS          CREATED
agent-proj-1234          Up 3 hours      3 hours ago
```

The first line must match `VM <name> (<anything>): <STATE>`, where state is one
of `RUNNING`, `TERMINATED`, `STOPPING`, `STAGING`, `PROVISIONING`, `SUSPENDED`,
`MISSING`. Container rows are lines starting with `CONTAINER_PREFIX`, columns
separated by two or more spaces — i.e. plain `docker ps --format table`. When
the host is down, printing the state line alone is correct.

Instance targeting arrives in the script's environment as `AGENT_VM_NAME`,
`AGENT_VM_ZONE`, `AGENT_VM_PROJECT`, each only when configured.

Because a call over an SSH-plus-tunnel transport costs seconds of startup, the
transport layers four measured mitigations on top — connection multiplexing,
replaying the already-open connection, a persistent per-session command channel,
and a long-lived capture stream — which together take a keystroke from ~10s to
~0.5s. Each is independently switchable (`VM_SSH_MUX`, `VM_FAST_EXEC`,
`VM_CHANNEL`, `VM_STREAM`) if you need to bisect a problem. `CLAUDE.md`
documents what each one does and why it is shaped the way it is.

One coupling, and only for the fast path: claude-deck learns your script's SSH
invocation and replays it, but replays *only* commands aimed at the remote
runner your script uses — by default a script whose name ends in
`vm-resolve-runner.sh`. If yours is named differently, set `VM_RUNNER_SCRIPT`;
if it doesn't fit that shape at all, set `VM_FAST_EXEC=false` and everything
still works, just slower.

---

## Using the dashboard

### The session list

Every session found, newest activity first. Each card shows status
(running / idle / stopped), the model, token usage, an estimated cost, the
working directory and git branch, and where the session lives. Sessions that are
not on this machine are marked distinctly — typing into one is a different act
from typing into a local one.

- **Filter** by status, or search across directory, branch, model, container
  name and the first user message.
- **Live** filters to sessions that are actually running. Claude Code keeps its
  own registry of them, which states the session id, the name, the working
  directory and whether each is busy or idle — so this is exact rather than
  inferred from a process table full of sessions idle since July.
- **Close a tab** with its ×. That is local to your browser and reversible —
  opening the session again brings the tab back. It is deliberately *not* the
  same as hiding: closing a tab means "stop showing me this one here".
- **Hide** a session you don't care about; a toggle brings hidden ones back. A
  hidden session that is still *running* stays visible, dimmed — hiding is also
  what the tab bar's × does, so it is easy to do by accident, and a live session
  that vanished without trace would be the one thing this dashboard must not do.
- **Note** — a free-text label per session, kept locally, useful when eight
  sessions share a repo.
- **New session** launches Claude Code in a detached tmux session at a directory
  you choose, and opens it.

### Session detail

The sidebar lists **the work a session touches**: the item it was started for,
plus the ones it keeps coming back to, each with its live tracker state.

The two halves are found completely differently, and it is worth knowing which
you are looking at. The item a session was *started for* is not guessed — it
comes from the name of the container or tmux session the work runs in — so it is
always shown. Everything else is a string that looks like a key, and looking
like one is not enough: a directory called `claude-502` matches every pattern a
real key does, and a key printed once in an example is not work that was done.
So a second item has to clear two bars: **you** have to have raised it — a key
Claude merely echoed is not evidence the session worked on it, and a session
that discusses ticket handling quotes plenty — and a tracker has to recognise
it. The list is then ranked by how often the key comes up, since what gets
worked on gets repeated, and capped at eight. **With no tracker configured
there are no secondary items at all**, because there would be no way to be
right about them.

The scan reads the transcript, so it runs once when you open a session rather
than on every poll: the statuses refresh, the list does not.

The full transcript, rendered: user turns, assistant turns, tool calls with
their inputs summarized, and a subagent tree where each subagent's transcript is
priced on its own. Prose is rendered as markdown — tables, code blocks and lists
keep their shape rather than arriving as raw pipes and backticks — while staying
monospaced and terminal-sized, because this is a transcript rather than a
document. Raw HTML in a transcript is escaped, never rendered. Open sessions are kept in a tab bar so you can move between
them without losing your place.

### The terminal

For any session running under tmux — local, in a container, here or elsewhere —
the detail page has a live pane and an input box, in the terminal's own colours:
the status bar, diff counts, branch and mode all read the way they do in a
terminal, because the pane is captured with its escape sequences intact. What you type is pasted into
the real session, exactly as if you had typed it in the terminal, and the
resulting pane comes back in the same round trip. Escape, Ctrl-C and the arrow
keys are forwarded too — the allowlist is arrows, Enter, Escape, Tab, Backspace,
Space, Ctrl-C and Ctrl-D — so permission prompts and menus are answerable from
the browser.

**Drop or paste a file** onto the terminal and its path goes into the prompt.
A terminal carries text, not bytes, so an image has to arrive as somewhere to
look — claude-deck writes it to a temp directory on the machine the session
runs on, hands you the path, and cleans up when it exits. Say what you want
done with it and send.

Sessions that are *not* under tmux are observe-only: Claude Code offers no IPC
to write into them, and tmux has to be in place from the moment a session
starts — it cannot be added to a running one.

**Reopen here** is the way out for a session that has stopped. It runs
`claude --resume <id>` in a tmux session claude-deck owns — the same command you
would type — and the conversation comes back with its full history, now typeable
from the browser.

It refuses while the session is still running somewhere. `claude --resume` does
not attach to a running session: Claude Code starts a *second* process on the
same transcript, each with its own conversation state, and they answer
independently — the same message gets one reply in the terminal and a different
one in the browser. Exit the session where it is running, then reopen it here.

### Containers tab

Every agent container, running or exited, with the sessions each one holds.
Remove a container, or preview and run a cleanup of the exited ones. Containers
on another machine are listed alongside local ones and marked.

### Workflow tab

One row per tag with artifacts on disk, showing how far through the configured
workflow it is.

---

## How it finds sessions

No agent, no hook, no instrumentation of Claude Code:

1. **Transcripts** — `~/.claude/projects/<project-hash>/<session-id>.jsonl`,
   watched for changes, plus `subagents/` and `tool-results/` beside them.
2. **Processes** — `pgrep -x claude` and `ps -eo pid,command` for what is
   actually running.
3. **tmux** — `tmux ls` for what can be observed and typed into.
4. **Containers** — `docker ps --filter name=<CONTAINER_PREFIX>`, and
   `docker exec` to read transcripts from containers that don't share
   `~/.claude` with the host.
5. **Another machine** — your script's `list` output, on its own slower loop.

Each of these is a **provider** (`packages/server/src/providers/`). A provider
with its own scan interval runs its own loop and the main scan merges whatever
it last produced, so a slow or unreachable machine never delays the local scan;
a provider that throws costs its own cards, not the dashboard.

Driving a session is a **transport**, looked up by the session's `target.kind`.
Adding a backend — Kubernetes, a devcontainer, a second cluster — means writing
a provider and a transport and registering them. No enum to extend, no branch to
add in the UI.

A consequence worth knowing: **a container session's id is not stable.** A
restart writes a new transcript, so the id in an open tab retires while the
container keeps running. claude-deck records `old id → new id` and resolves
through it, which is why an open tab keeps working across a container restart.

---

## Security

This is a **local, unauthenticated** tool. Anything that can reach the API can
read every transcript on the machine and type into live Claude Code sessions.
The defaults are set accordingly:

- The server binds **loopback only** (`localhost`, meaning both `127.0.0.1` and
  `::1`). Set `HOST=0.0.0.0` only when you deliberately want to reach the
  dashboard from another device, and only on a network you trust.
- CORS allows same-origin requests and pages served from this machine; it does
  not reflect arbitrary origins. The WebSocket upgrade is checked the same way,
  since WebSockets bypass CORS entirely.
- `CONTAINER_PREFIX` bounds every container operation.
- Launcher commands are run as argv, never through a shell.
- Artifact file reads are contained to the item's own directory.
- Credentials come from your environment or your existing `~/.claude.json` MCP
  entry; claude-deck stores none of its own and logs none of them.

## Troubleshooting

**No sessions show up.** Check `CLAUDE_DIR` points at your real Claude Code
directory, and that a session has been active within `MAX_SESSION_AGE_DAYS`.
"Active" means the transcript was appended to — not that the file was touched,
so a backup or an indexer sweeping `~/.claude` doesn't resurrect old
conversations onto the dashboard. A running session is always listed, however
old its last turn is.

**A session's name is missing.** Names come from Claude Code's session registry
(`~/.claude/sessions`), which only covers sessions that are running. A stopped
session shows the name it was given in `<session-dir>/custom-title.json` if it
has one, and its directory otherwise.

**A session shows but the terminal is empty / read-only.** It isn't running
under tmux. Local sessions started outside claude-deck only become interactive
if you started them inside tmux yourself.

**"New session" fails with `spawn tmux ENOENT`.** tmux isn't installed — see
Requirements. Nothing else is affected.

**A container's terminal is empty.** The tmux session inside the container isn't
named `CONTAINER_TMUX_SESSION`, so the capture falls back to `docker logs`,
which is observe-only.

**The launch dialog says no launchers are configured.** Add a `launchers` entry
to `claude-deck.config.json`, or set `LAUNCH_SCRIPT`.

**Tracker badges are missing.** Credentials didn't resolve. Set `JIRA_BASE_URL`,
`JIRA_EMAIL` and `JIRA_API_TOKEN`, or point `JIRA_MCP_SERVER` at the right
`~/.claude.json` entry.

**The Workflow tab says nothing is configured.** It needs both `ARTIFACTS_DIR`
and a `workflow` block. One without the other leaves it off.

**The remote tab says unavailable.** `REMOTE_SCRIPT` is unset or not executable
(`chmod +x`).

**Remote interaction is slow.** Switch the mitigations off one at a time
(`VM_FAST_EXEC=false`, then `VM_CHANNEL=false`, then `VM_STREAM=false`) to find
which layer is failing and falling back.

**Port already in use.** `./restart.sh stop` clears both ports, or set `PORT`.

## Development

```bash
npm run dev                    # server (:3456) + UI (:5173)
npm -w packages/server run dev
npm -w packages/ui run dev
npm -w packages/server run test
npm -w packages/ui run test
npm run build
```

Layout:

```
packages/server/src/
  config.ts            all configuration, one place
  config-file.ts       claude-deck.config.json: shape and validation
  providers/           session sources and terminal transports, and their registry
  trackers/            work-item lookup; Jira is one implementation
  routes/              HTTP API
  services/            discovery, parsing, tagging, containers, launchers, transport
  ws/                  WebSocket broadcast
packages/ui/src/
  pages/               dashboard, session detail, containers, workflow
  components/          terminal, transcript, tabs, dialogs
  lib/                 API client and pure helpers
```

`DESIGN.md` covers the architecture and the JSONL format; `CLAUDE.md` covers the
constraints that shape the code — read that one before touching the remote
transport, the session-id aliasing, or the container readers.
