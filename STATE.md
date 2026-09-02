# Where this stands

A handover note, not documentation. `README.md` says what the app does,
`CLAUDE.md` says how to work on it; this says what is unfinished and what a
future session cannot find out by reading the code.

Written 2026-09-02.

## Nothing is published

26 commits sit on the `universal-refactor` branch. There is no `origin` — the
only remote is `upstream`, pointing at `relevance/claude-monitor` on the
internal GitHub Enterprise, for pulling.

`github.com/karotka/claude-deck` exists, is **public**, and is **empty**.
Nothing has been pushed to it, deliberately. Three things to settle first:

- The upstream commit is authored by Michal Hybler and the repository has no
  LICENSE. Publishing a fork of his internal work is his call as much as
  anyone's; the user said they would talk to him.
- README and CLAUDE.md have been rewritten to name no internal repository, and
  the example config and test fixtures name no real scripts. Worth re-checking
  before a push, since the internal names were scattered.
- The transport modules still carry `vm-` names and `VM_` environment
  variables. That is deliberate — they implement one specific
  ssh-over-gcloud-IAP transport — but a reader could take it for a leak.

## Not configured on this machine

- **No tracker.** `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` are unset,
  so the sidebar's related work items stay empty by design: without a tracker
  to confirm a key, everything found in a transcript is a guess. The user's
  Atlassian runs as a remote MCP with no local token, so nothing resolves on
  its own — a Jira API token in `.env` is the missing piece, and the only one.
  The path was verified end to end against a stub Jira: a working session came
  back with seven real tickets ranked by mentions, and a session that only
  discusses tickets came back with none.
- **No launchers, no workflow.** `Start development` and the Workflow page are
  therefore absent. `examples/claude-deck.config.json` is the worked example.
- Session `eb1c3b37` ("Radius prediction") is hidden, possibly on purpose.

## Known gaps

- **Reopen forks a live session.** `claude --resume <id>` on a session that is
  already running starts a *second* process on the same transcript and the two
  answer independently — it happened during development, and the second process
  wrote two commits of its own. The route refuses with 409 while the session is
  live. The only way to move a running session into the browser is to exit it in
  its terminal first, or to have started it under tmux in the first place.
- **Cloud sessions are not listed.** The sessions at claude.ai/code live on
  Anthropic's servers with no public API and no local trace. `~/.claude/sessions`
  holds only what runs on this machine. A provider that reads another
  claude-deck's `/api/sessions` would cover the user's other machines; it has not
  been written.
- **The registry is undocumented.** `~/.claude/sessions/<pid>.json` and
  `capture-pane -e` are internals of Claude Code. Everything built on them
  degrades rather than breaks when they change — an absent registry costs
  detail, not sessions — and that property is worth keeping.

## Verified by hand, not by tests

These needed a real session and were checked in the browser or against the live
process table; nothing in CI covers them:

- tmux capture, send, and the key allowlist, against a live pane.
- Reopen: a session went from observe-only to `tmux/cm-…` with its history.
- Binding a session started as `tmux new -s mojevlastni` + `claude`.
- Shift+Tab cycling `auto mode` to `manual mode`.
- Dropping a real PNG, and a `../../../etc` filename landing inside its own
  directory.
- Terminal colour, markdown tables, the tab strip, the auto-growing prompt.
