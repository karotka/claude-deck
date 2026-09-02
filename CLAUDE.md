# CLAUDE.md — claude-deck

## What This Is

A local dashboard for monitoring and interacting with Claude Code sessions,
wherever they run. A fork of `claude-monitor` by Michal Hybler, generalized so
that nothing about Jira, Docker or one particular VM is part of the data model.
See `DESIGN.md` for the architecture.

## The Extension Points

Four, and the rule is the same for all of them: **nothing generic may switch on
a backend's name.** If you find yourself writing `source === 'docker'` or
`if (target === 'vm')`, the thing you want belongs on one of these interfaces.

| Concept | Where | What it answers |
|---|---|---|
| `SessionProvider` | `providers/types.ts` | Where do sessions come from? |
| `SessionTransport` | `providers/types.ts` | How is one read and driven? |
| `Tracker` | `trackers/types.ts` | What is the state of the work a tag names? |
| Launcher | `config-file.ts` | How is work started? (data, not code) |

Supporting rules:

- **A tag is defined in exactly one place**, `services/tagging.ts`, from
  `config.tagPattern`. Never write a key-shaped regex anywhere else — that was
  the original sin here, seven copies of `/[A-Z][A-Z0-9]+-\d+/`. The one
  legitimate exception is `isSafeRemoteRef` in `vm-payload.ts`, which is an
  injection guard, not an identity check: the handle reaches the far side
  unquoted, so that pattern must stay fixed and narrow. Never wire it to
  `tagPattern`.
- **`Session.source` is a label, not a discriminator.** Behaviour comes from
  `target` (how to drive it), `remote` (is it on this machine) and `tag`.
- **Never derive a work item from transcript text without a tracker.** `tag` is
  authoritative — it comes from the name of the container or tmux session the
  work runs in. Anything read out of a prompt or a transcript is a string that
  merely looks like a key, and the UI used to show those as if they were facts.
  Secondary items require a tracker to confirm them *and* repeated mentions;
  see services/session-work-items.ts.
- **`Session.target.ref` is opaque** to everything but the transport that owns
  that `kind`.
- Providers and transports are registered explicitly in `providers/builtin.ts`,
  never by import side effect — a registry populated by whichever modules
  happened to be imported is the coupling this layer exists to remove.
- **`SessionProvider.stop` must be synchronous.** It is called from a process
  `exit` handler, where nothing async runs.

## Tech Stack

- **Monorepo:** npm workspaces (`packages/server` + `packages/ui`)
- **Backend:** Node.js, Fastify, TypeScript, chokidar (file watching), fastify-websocket
- **Frontend:** React, Vite, TypeScript, shadcn/ui, Tailwind CSS
- **No database** — reads directly from `~/.claude/projects/` JSONL files and OS processes

## Commands

```bash
# Prerequisites
brew install tmux        # macOS; apt/dnf install tmux elsewhere
                         # Required: it is the only way to type into a running
                         # Claude Code session, and what "New session" launches
                         # into. Without it everything degrades to observe-only
                         # and /api/claude/launch fails with spawn tmux ENOENT.

# Development
npm install              # install all workspace deps
npm run dev              # start both server (3456) + ui (5173)

# Server only
npm -w packages/server run dev

# UI only
npm -w packages/ui run dev

# Build
npm run build
npm start
```

## Configuration

Two sources, both read in one place, `packages/server/src/config.ts`:

- **`.env`** — every scalar setting (real env wins over the file).
  `.env.example` documents them all.
- **`claude-deck.config.json`** — settings that are a *list*: launchers,
  workflow phases. Shape and validation live in `config-file.ts`.

Rules when touching configuration:

- **No machine- or org-specific defaults.** Paths default to `~` or to nothing,
  and every optional feature stays off until configured. The workflow schema has
  no default at all: those filenames belong to whoever writes them.
- **Read env vars in `config.ts`, not at the point of use**, so `.env.example`
  stays a complete list. The one exception is `jira-credentials.ts`, which reads
  `JIRA_*`/`ATLASSIAN_*` through an injectable `env` for testability.
- **Anything user-visible that names a project, prefix, pattern or script** comes
  from the server (`/api/config`, `/api/launchers`), never a literal in the UI
  bundle. The tag pattern is the clearest case: the launch dialog parses a
  pasted batch client-side, and a second opinion about what a tag looks like is
  exactly what this refactor removed.
- **Renaming a setting keeps the old name working.** `envFirst()` takes a list
  and the neutral name comes first; nobody should have to migrate a working
  `.env` to keep it working.
- **A malformed config file fails startup, naming the key.** Starting with a
  launcher silently missing turns a typo into a bug report three days later.
- Server tests pin their environment in `packages/server/test/setup-env.ts`;
  `.env` and the config file are both skipped under vitest so a developer's own
  files can't decide whether tests pass.

## Key Data Sources

1. **JSONL files:** `~/.claude/projects/<project-hash>/<session-id>.jsonl`
   - Subagents: `<session-dir>/subagents/agent-<id>.jsonl` + `.meta.json`
   - Tool results: `<session-dir>/tool-results/`
   - Session name: `<session-dir>/custom-title.json` → `{"customTitle": "..."}`.
     Beside the transcript, not inside it — parsing the JSONL will never find
     one. The live registry (below) is the better source and wins where it has
     an answer; this is the fallback for a session that has stopped.
   - **Age is judged by the transcript, not the file.** mtime is only an upper
     bound on real activity — a backup or an indexer moves it — so a stale mtime
     short-circuits the check (cheap, and never wrong) while a fresh one is
     confirmed against the tail of the transcript. A session with a live
     `claude` process skips the check entirely: hiding a running session is the
     one failure the dashboard cannot afford.
2. **OS processes:** `pgrep -x claude` + `ps -eo pid,command`
3. **Live sessions:** `~/.claude/sessions/<pid>.json` — Claude Code's own
   registry, one file per running session, carrying `sessionId`, `name`, `cwd`
   and a busy/idle `status`. **Undocumented Claude Code internal**, so it is an
   enrichment and never a requirement: a missing directory means less detail,
   not missing sessions, and `live` being unset means "unknown", never
   "stopped". Read only `<pid>.json`; the `<pid>.<hash>.key` files beside them
   are credentials. Entries outlive an unclean exit, so confirm the pid.
4. **Containers:** `docker ps --filter name=<CONTAINER_PREFIX>`
5. **tmux sessions:** `tmux ls`
6. **Workflow artifacts:** an optional directory of per-tag artifacts (`ARTIFACTS_DIR`), evaluated against the configured `workflow` schema
7. **Remote containers:** the same agent containers on another machine. See below.

## Remote host

Agent containers can run on another machine. Those sessions carry
`source: 'remote'` and `remote: true`, are marked distinctly throughout the UI,
and are as interactive as local ones.

Every remote operation shells out to the user's own script (`REMOTE_SCRIPT`) —
the same one used by hand from a terminal. claude-deck owns no part of that
contract: not the instance, the tunnel, the image, nor the secrets. The script
must accept `list`, `start <TAG>`, `shell <TAG> <command…>` and `rm <TAG> -f`;
with it unset, remote support is off.

The transport modules still carry `vm-` names and `VM_` env vars. That is
deliberate: they implement one specific ssh-over-gcloud-IAP transport, and their
tuning knobs are meaningful only for it. The *interfaces* above them
(`remoteTransport`, the `remote` provider) are the general ones.

Constraints that shape the code:

- **`list` is the only pollable command.** It checks instance state first and
  returns without connecting when the host is down. Every other subcommand runs
  `ensure_vm_up`, which *boots the VM* — so a background poll must never call
  one. `vmExec` refuses unless a recent `list` said `RUNNING`.
- **Each call is a gcloud round trip.** Measured against the live VM: ~11.5s per
  call, of which only ~5s is SSH — the rest is gcloud's own startup (Python +
  instance/OS-Login API calls), which connection reuse cannot remove. Two
  mitigations, both measured:
  - `ssh-mux.ts` puts an `ssh` shim on the PATH of *script child processes only*,
    enabling ControlMaster. ~11.5s → ~6s per call. `VM_SSH_MUX=false` opts out.
    Note `ControlMaster=auto` **races**: concurrent calls each find no master and
    each run gcloud's ProxyCommand, which was observed leaving six IAP tunnels
    open with calls still paying full startup. So the master is established
    explicitly and once (`ensureSshMaster`, serialized), and every other call
    uses `ControlMaster=no` — reuse-only, never able to build a tunnel of its
    own — retrying once through `ensureSshMaster` if the master vanished.
  - `vm-stream.ts` keeps one long-lived connection per session running a capture
    loop inside the container, so the terminal costs one startup per session
    rather than one per poll: **~1 frame/second**, and the capture endpoint
    answers in ~0.03s. Polling one call at a time left the panel ~11s stale.
    `VM_STREAM=false` falls back to one-shot captures. A stream is torn down
    only when a client needs *more* scrollback — never on a width change, since
    each client measures its own `cols` and restarting on width made two
    viewers (or one whose measured width drifts) tear the stream down on
    alternate polls, each teardown costing a ~6s one-shot. Width is applied by
    resizing the live pane out of band, debounced.
  - The **fast path** removes gcloud from the loop entirely. The `ssh` shim also
    *records* the invocation gcloud generated (NUL-separated, temp-file +
    rename). Later calls replay those arguments over the connection gcloud
    already opened, skipping its startup: **~0.6s per call**, which is what
    makes keystrokes feel immediate (they were ~10s). Everything is learned from
    the script's own invocation — VM, user, tunnel and runner path are never
    hardcoded — and `parseRecordedSsh` refuses any recording whose command isn't
    `vm-resolve-runner.sh`. Any failure falls back to the script, which also
    refreshes the recording. `VM_FAST_EXEC=false` opts out.
  - `vm-channel.ts` keeps a **persistent request/response channel** per session:
    a shell loop on the VM reading commands from stdin, one per line, marking
    the end of each one's output. Measured layer by layer, a ~0.55s keystroke is
    0.42s to open an SSH channel, 0.09s for `docker exec` and ~0.04s for the
    runner and tmux — the remote work was never the problem, opening a channel
    per keystroke was. Commands are serialized (the remote loop is strictly
    ordered, so overlapping writes would interleave two commands' output around
    one end marker) and the payload carries **no outer quotes**, since it is
    read as a line rather than parsed by a shell on the way in.
    `VM_CHANNEL=false` opts out.
  - A send pauses between pasting and pressing Enter
    (`VM_PASTE_SETTLE_SECONDS`). Locally the three tmux commands are three
    separate `docker exec` calls, and the spawn latency between them lets the
    TUI consume the bracketed paste before Enter arrives; in one remote payload
    there is no gap, the Enter lands mid-paste and is swallowed, and every
    message needs a second Enter.
  - Sends read the resulting pane back in the same round trip and inject it into
    the stream, so a keystroke doesn't cost a send *plus* a frame interval *plus*
    a poll interval before anything shows, and the next poll can't briefly
    render an older frame and appear to undo it. End to end: **~0.52s with the
    pane already in hand**.

  Every long-lived ssh child holds an IAP tunnel open, so they are killed on
  `exit` as well as on signals — without that, each dev-server reload orphaned
  one and the tunnels accumulated.
- Remote discovery runs on its own slow loop (`VM_SCAN_INTERVAL_MS`, default
  30s) and the local 5s tick only merges its last result — an unreachable host
  never delays the dashboard. This is now a general property of any provider
  with `scanIntervalMs` set, not a special case.
- **A container session's id is not stable.** A session is addressed by its
  transcript id, but that id is whichever JSONL `buildSampleScript` picks
  (`--resume <uuid>` from the container's `ps`, else newest by `ls -t`). A VM or
  container restart writes a *new* transcript, and a container with more than
  one live transcript makes the pick oscillate — so the id in an open tab
  retires while the container keeps running, and every id-addressed route
  (detail, messages, subagents, capture, send) 404s "Session not found" on a
  live session. `session-aliases.ts` records `old id → new id` each time a
  container's session changes and `getCachedSession` resolves through it, so a
  retired id still reaches the live session. Applies to local agent containers
  too, not just the VM.

  The UI deliberately does **not** rewrite the URL to the resolved id. An effect
  comparing `session.id` to the URL param reads the *previous* session while the
  new one is still being fetched, so every tab switch navigates straight back to
  the session you just left, and the id also oscillates when the pick is
  unstable — together that reads as the URL jumping until it settles. The URL is
  the stable handle and the server dereferences it on every request;
  `SessionDetail` keys notes off the resolved `session.id` instead, which is what
  the tab bar uses.
- **Payloads cross three shells** (the script's `$*`, the remote login shell,
  the runner's `$*`) before reaching `bash -lc`. They are base64-encoded and
  wrapped in literal single quotes; see `wrapPayload` in `vm-bridge.ts`.
- **Subagent transcripts are not streamed by default.** VM sessions list their
  subagents but don't price them (`VM_SUBAGENT_COSTS=true` opts in, at the cost
  of much slower ticks).

Container reads are transport-agnostic: `container-reader.ts` holds the scripts
and parsers, and both `docker exec` and the VM tunnel supply an `ExecScript`.

## JSONL Format Reference

Each line is a JSON object. Key types:

| type | Notable fields |
|------|---------------|
| `permission-mode` | `permissionMode`, `sessionId` |
| `system` | `subtype`, `cwd`, `gitBranch`, `entrypoint`, `version`, `url` |
| `user` | `timestamp`, `message.content[]`, `promptId` |
| `assistant` | `timestamp`, `message.model`, `message.usage`, `message.content[]` |
| `file-history-snapshot` | `snapshot` |

`message.usage` on assistant messages:
```json
{
  "input_tokens": 3,
  "cache_creation_input_tokens": 14888,
  "cache_read_input_tokens": 11360,
  "output_tokens": 31,
  "service_tier": "standard"
}
```

Subagent `.meta.json`:
```json
{ "agentType": "claude-code-guide", "description": "Claude Code tmux integration" }
```

## Interaction Constraints

- **tmux sessions:** interact via `tmux send-keys`, observe via `tmux capture-pane`
- **Non-tmux local sessions:** observe-only (no IPC mechanism in Claude Code)
- **Containers:** observe the transcript either way; interact only if Claude is
  wrapped in tmux inside the container
- **Remote containers:** the same tmux interaction, relayed through
  `<REMOTE_SCRIPT> shell <TAG>`; only while the host is already running

A session is interactive exactly when it has a `target` whose `kind` has a
registered transport. Nothing else should be asked.

Sessions reach a tmux target two ways. The naming-convention matcher pairs a
`TMUX_PREFIX`-named tmux session with a transcript by the tag in its opening
prompt — built for the container workflow, and fitting nothing a person starts
by hand. `tmux-ownership.ts` is the general one, and it answers two different questions.
Ownership — which pane is this *process* in — binds a session running in a pane.
Attachment — which pane is a *view* of this session — binds one that isn't in a
pane at all, which is every `claude --bg` session, since those live under the
daemon. The attach map is keyed by the short id `claude attach` takes, so
callers match by prefix (`paneForSessionId`). For ownership: tmux reports each pane's
process, `ps` gives the parentage, and Claude Code's registry says which
transcript a pid is writing, so ownership is established rather than guessed.
It runs *after* the placeholder pass — a session opened moments ago has no
transcript yet, and binding before it exists misses the very case it is for.

## Resuming

`claude --resume <id>` is how an observe-only session becomes typeable, but it
**must not run against a session that is already live**. It does not attach —
Claude Code starts a second process on the same transcript, each with its own
in-memory conversation, and they generate divergent replies to the same message.
`claude --resume` does not refuse this, so the route does (409 on
`session.live`) and the button is disabled. Verified the hard way: two processes
on one session produced two different answers, one in the terminal and one in
the browser.

## Terminal Colour

Panes are captured with `capture-pane -e`, so the TUI's SGR sequences survive.
`services/ansi.ts` has two functions and the distinction matters: `sanitizePane`
keeps colour and drops everything else — cursor moves and OSC titles are
instructions to a terminal that is redrawing itself, and the browser is handed a
finished frame — while `stripAnsi` removes the lot, for the paths that match on
text (launch-phase detection, the pane splitter's structural checks).

The pane is sized to the panel, width **and height**, because there is nothing
behind the frame: the TUI runs on the alternate screen, so `history_size` is 0
and `capture-pane -S -1000` returns exactly the visible rows. A pane shorter
than the panel leaves dead space nothing can scroll into; a taller one hides its
own top. The browser measures both and adds the rows `splitPane` hands to the
footer, since those are drawn outside the box.

For the same reason **the wheel is forwarded, not handled**. Claude Code's TUI
turns on SGR mouse reporting, so a turn is sent as `ESC [ < 64 ; 1 ; 1 M`
(`wheelBytes`) through `send-keys -l` and the application scrolls itself. Not
on the remote path: those bytes would cross three shells, which is the one
place in the app where quoting is a security question.

`lib/ansi.ts` in the UI parses SGR into styled runs. Style carries across lines
on purpose: a TUI sets a colour and draws several rows in it.

Never colour the pane by guessing. An earlier version classified lines by the
glyph in the first column because the capture arrived monochrome; with `-e`
there is nothing to guess.

## Transcript Rendering

Prose goes through `components/Markdown.tsx` (react-markdown + remark-gfm).
Two constraints:

- **Stay terminal-shaped.** Everything is monospaced and body-sized; headings
  are distinguished by weight and colour, never scale. The gutter's line rhythm
  depends on it. Tables and code blocks scroll inside their own box rather than
  wrapping.
- **Never enable `rehype-raw`.** Transcripts quote files, web pages and command
  output; none of that should be able to inject markup into the dashboard.
  react-markdown escapes HTML and sanitizes link targets by default.

Tool *results* are not markdown — they are command output, and stay in a `<pre>`.

## Style

- TypeScript strict mode
- Functional components in React
- No class components
- Prefer `async/await` over callbacks
- Keep services stateless where possible — SessionDiscovery holds the cache
