import { describe, it, expect } from 'vitest';
import { parseRecordedSsh } from './ssh-mux.js';

/** Build a NUL-separated recording the way the shim writes it. */
const rec = (...args: string[]) => args.map(a => `${a}\0`).join('');

const RUNNER = '$HOME/proj-agent/src/docker/vm-resolve-runner.sh';

describe('parseRecordedSsh', () => {
  it('splits a real gcloud invocation into connection args and runner path', () => {
    const raw = rec(
      '-T',
      '-i', '/Users/me/.ssh/google_compute_engine',
      '-o', 'HostKeyAlias=compute.7198369224092873438',
      '-o', 'ProxyCommand /path/to/python gcloud.py compute start-iap-tunnel vm %p --listen-on-stdin',
      'me@compute.7198369224092873438',
      '--',
      RUNNER, 'list',
    );

    const parsed = parseRecordedSsh(raw)!;

    expect(parsed.runnerPath).toBe(RUNNER);
    // Everything up to and including `--`, so a new command can be appended.
    expect(parsed.sshArgs.at(-1)).toBe('--');
    expect(parsed.sshArgs).toContain('me@compute.7198369224092873438');
    expect(parsed.sshArgs).not.toContain('list');
  });

  it('keeps arguments containing spaces intact', () => {
    // ProxyCommand is one argument with many spaces — line-splitting would
    // shred it, which is why the shim writes NUL-separated.
    const proxy = 'ProxyCommand /a/python /b/gcloud.py compute start-iap-tunnel vm %p --zone=example-zone';
    const parsed = parseRecordedSsh(rec('-o', proxy, 'me@host', '--', RUNNER, 'list'))!;

    expect(parsed.sshArgs).toContain(proxy);
  });

  it('refuses a recording whose command is not the VM runner', () => {
    // Only ever replay a command aimed at the runner the script uses.
    expect(parseRecordedSsh(rec('-T', 'me@host', '--', '/bin/sh', '-c', 'rm -rf /'))).toBeNull();
    expect(parseRecordedSsh(rec('-T', 'me@host', '--', 'curl', 'evil.com'))).toBeNull();
  });

  it('refuses a recording with no command separator', () => {
    expect(parseRecordedSsh(rec('-T', 'me@host'))).toBeNull();
  });

  it('refuses a truncated recording that ends at the separator', () => {
    expect(parseRecordedSsh(rec('-T', 'me@host', '--'))).toBeNull();
  });

  it('returns null for an empty file rather than throwing', () => {
    expect(parseRecordedSsh('')).toBeNull();
  });
});
