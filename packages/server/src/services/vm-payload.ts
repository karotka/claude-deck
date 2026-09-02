/**
 * Getting a command intact into an agent container on the VM.
 *
 * `<REMOTE_SCRIPT> shell <TAG> <command…>` lands the command in
 * `docker exec … bash -lc` on the far side, but it crosses three layers of word
 * splitting on the way: the script's own `$*`, the remote login shell that
 * gcloud hands the command string to, and the runner's `$*`. A payload written
 * plainly would be torn apart by any of them.
 *
 * So a payload is base64-encoded — an alphabet with no shell metacharacters —
 * and wrapped in literal single quotes. The quotes are consumed by the *remote*
 * shell, which keeps the decode pipeline together as a single word until the
 * runner finally passes it to `bash -lc`.
 *
 * Kept separate from vm-bridge so the streaming transport can share it without
 * the two importing each other.
 */

/** Precedes a payload's own output, so `bash -l` profile noise can be dropped. */
export const OUTPUT_MARKER = '@@@VMOUT@@@';

/**
 * Characters a container handle may contain to be safe here.
 *
 * This is NOT the tag pattern and must never be wired to it. On the fast path
 * the handle is interpolated *unquoted* into a shell command string (see
 * buildRunnerShellCommand) that then crosses three shells, so this is the
 * injection guard — and a guard that a user could widen from configuration is
 * not a guard. It is deliberately narrower than what a tag may be: alphanumeric
 * plus dot, dash and underscore, which covers Jira/Linear-style keys and
 * refuses `#`, `;`, `$`, quotes, backticks and whitespace.
 *
 * The consequence is worth stating: an installation whose TAG_PATTERN admits
 * other characters can use the local providers fine, but cannot drive remote
 * containers, and gets the error below rather than a mangled command.
 */
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeRemoteRef(ref: string): boolean {
  return SAFE_REF_RE.test(ref);
}

/**
 * Wrap a `sh` script as a single argv element for the script's `shell` command.
 * Exported for tests, which assert the result survives shell word splitting.
 */
export function wrapForShell(script: string): string {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `'echo ${b64} | base64 -d | sh'`;
}

/** The marker-prefixed script both wrappers below encode. */
function markedScript(script: string): string {
  return `printf '%s\\n' '${OUTPUT_MARKER}'\n${script}\n`;
}

/**
 * As `wrapForShell`, plus the output marker that lets a one-shot caller tell
 * "the payload ran and printed nothing" from "the payload never ran".
 */
export function wrapPayload(script: string): string {
  return wrapForShell(markedScript(script));
}

/**
 * The same payload for the persistent channel, which needs no outer quotes: the
 * remote loop reads it as a line and hands it straight to the runner, so it is
 * never parsed as shell words on the way in. Quoting it anyway would make
 * `bash -lc` treat the whole pipeline as one command name.
 */
export function wrapPayloadForChannel(script: string): string {
  const b64 = Buffer.from(markedScript(script), 'utf8').toString('base64');
  return `echo ${b64} | base64 -d | sh`;
}

/**
 * Strip everything the payload didn't write: the login shell's own banner, and
 * any pty CRs if ssh happened to allocate one. Throws when the marker is absent,
 * which means the payload never ran (container gone, tunnel refused, script
 * error) rather than "ran and printed nothing".
 */
export function extractPayloadOutput(stdout: string): string {
  const normalized = stdout.replace(/\r\n/g, '\n');
  const idx = normalized.indexOf(OUTPUT_MARKER);
  if (idx === -1) {
    throw new Error('VM command produced no output marker — the container may be gone');
  }
  return normalized.slice(idx + OUTPUT_MARKER.length).replace(/^\n/, '');
}

/**
 * The remote command the VM script would run for `shell <KEY> <payload>`.
 * Used when replaying over an already-open connection: the runner path is read
 * from a recording of the script's own invocation, so this stays a replay of
 * what the script does rather than a second implementation of it.
 */
export function buildRunnerShellCommand(
  runnerPath: string,
  issueKey: string,
  wrapped: string,
): string {
  return `${runnerPath} shell ${issueKey} ${wrapped}`;
}
