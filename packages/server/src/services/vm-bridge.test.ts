import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[] }[],
  listOutput: '',
  shellOutput: '',
  /** null = no connection to reuse, so calls go through the script. */
  recorded: null as { sshArgs: string[]; runnerPath: string } | null,
  fastFails: false,
  /** Whether a shared SSH connection could be established. */
  masterOk: true,
}));

// Stubbed so tests never touch the real /tmp control-socket directory, and so
// the fast path is opt-in per test rather than depending on machine state.
vi.mock('./ssh-mux.js', () => ({
  sshMuxPathPrefix: () => null,
  recordedSshInvocation: () => h.recorded,
  sshMuxOptions: () => ['-o', 'ControlMaster=auto'],
  sshReuseOptions: () => ['-o', 'ControlMaster=no'],
  ensureSshMaster: async () => h.masterOk,
  isMasterAlive: async () => h.masterOk,
  systemSshPath: () => '/usr/bin/ssh',
}));

vi.mock('node:fs/promises', () => ({
  default: { access: async () => undefined },
  access: async () => undefined,
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    h.calls.push({ file, args });
    if (file === '/usr/bin/ssh' && h.fastFails) {
      cb(new Error('ssh: connection closed'), { stdout: '', stderr: '' });
      return;
    }
    const stdout = args[0] === 'list' ? h.listOutput : h.shellOutput;
    cb(null, { stdout, stderr: '' });
  },
  spawn: () => { throw new Error('not used'); },
}));

import {
  wrapPayload,
  extractPayloadOutput,
  parseVmListOutput,
  isSafeRemoteRef,
  refreshVmStatus,
  resetVmAvailability,
  vmExec,
  vmSend,
  vmSendKey,
  removeVmContainer,
} from './vm-bridge.js';

const RUNNING_LIST = [
  'VM agent-vm (example-project/example-zone): RUNNING',
  'NAMES                  STATUS          CREATED',
  'jira-agent-proj-1234   Up 3 hours      3 hours ago',
].join('\n');

const OK_SHELL = '\n@@@VMOUT@@@\nhello\n';

/** Decode the base64 payload back out of a wrapped `shell` argument. */
function decodeWrapped(wrapped: string): string {
  const b64 = wrapped.replace(/^'echo /, '').replace(/ \| base64 -d \| sh'$/, '');
  return Buffer.from(b64, 'base64').toString('utf8');
}

beforeEach(async () => {
  h.calls.length = 0;
  h.listOutput = RUNNING_LIST;
  h.shellOutput = OK_SHELL;
  h.recorded = null;
  h.fastFails = false;
  h.masterOk = true;
  resetVmAvailability();
  // Prime the cached VM state so vmExec's "is the VM up?" guard passes.
  await refreshVmStatus(true);
  h.calls.length = 0;
});

describe('wrapPayload', () => {
  it('produces one shell word: single-quoted, with no interior quotes', () => {
    const wrapped = wrapPayload('tmux capture-pane -p');

    expect(wrapped.startsWith("'")).toBe(true);
    expect(wrapped.endsWith("'")).toBe(true);
    // The quotes are consumed by the *remote* shell, keeping the pipeline one
    // word. An interior quote would end it early and split the command.
    expect(wrapped.slice(1, -1)).not.toContain("'");
  });

  it('survives payloads full of shell metacharacters', () => {
    const nasty = `echo 'quoted'; rm -rf / & $(whoami) \`id\` "dq" | tee /tmp/x\nnewline`;

    const wrapped = wrapPayload(nasty);

    expect(wrapped.slice(1, -1)).not.toContain("'");
    expect(decodeWrapped(wrapped)).toContain(nasty);
  });

  it('round-trips the script through base64 with the output marker first', () => {
    const decoded = decodeWrapped(wrapPayload('my-command --flag'));

    expect(decoded).toBe("printf '%s\\n' '@@@VMOUT@@@'\nmy-command --flag\n");
  });
});

describe('extractPayloadOutput', () => {
  it('drops login-shell noise emitted before the marker', () => {
    const raw = 'Welcome to Ubuntu 24.04\nLast login: Tue\n@@@VMOUT@@@\nreal output\n';

    expect(extractPayloadOutput(raw)).toBe('real output\n');
  });

  it('normalizes CRLF from a pty-allocated ssh session', () => {
    expect(extractPayloadOutput('@@@VMOUT@@@\r\nline one\r\nline two\r\n'))
      .toBe('line one\nline two\n');
  });

  it('returns empty for a command that printed nothing', () => {
    expect(extractPayloadOutput('@@@VMOUT@@@\n')).toBe('');
  });

  it('throws when the marker is missing — the payload never ran', () => {
    expect(() => extractPayloadOutput('Error: No such container: jira-agent-x'))
      .toThrow(/no output marker/i);
  });
});

describe('parseVmListOutput', () => {
  it('reads the instance state and the container table', () => {
    const { state, containers } = parseVmListOutput(RUNNING_LIST, 'jira-agent-');

    expect(state).toBe('RUNNING');
    expect(containers).toEqual([
      {
        name: 'jira-agent-proj-1234',
        issueKey: 'PROJ-1234',
        state: 'running',
        status: 'Up 3 hours',
        runningFor: '3 hours ago',
      },
    ]);
  });

  it('handles a stopped VM, which prints no table at all', () => {
    const out = 'VM agent-vm (example-project/example-zone): TERMINATED';

    expect(parseVmListOutput(out, 'jira-agent-')).toEqual({
      state: 'TERMINATED',
      containers: [],
    });
  });

  it('classifies exited and paused containers', () => {
    const out = [
      'VM agent-vm (p/z): RUNNING',
      'NAMES                  STATUS                     CREATED',
      'jira-agent-proj-1      Exited (0) 2 hours ago     3 hours ago',
      'jira-agent-proj-2      Up 5 minutes (Paused)      5 minutes ago',
    ].join('\n');

    const states = parseVmListOutput(out, 'jira-agent-').containers.map(c => c.state);
    expect(states).toEqual(['exited', 'paused']);
  });

  it('ignores the header and any other output', () => {
    const out = [
      'VM agent-vm (p/z): RUNNING',
      'WARNING: something unrelated',
      'NAMES   STATUS   CREATED',
    ].join('\n');

    expect(parseVmListOutput(out, 'jira-agent-').containers).toEqual([]);
  });

  it('reports an unrecognized state rather than guessing', () => {
    expect(parseVmListOutput('VM x (p/z): WEIRD', 'jira-agent-').state).toBe('UNKNOWN');
  });
});

describe('isSafeRemoteRef', () => {
  it('accepts real keys and rejects anything that could reach a shell', () => {
    expect(isSafeRemoteRef('PROJ-1234')).toBe(true);
    // Case is not the point — shell safety is. The handle reaches the far side
    // unquoted, so anything a shell would act on has to be refused.
    expect(isSafeRemoteRef('proj-1234')).toBe(true);
    expect(isSafeRemoteRef('PROJ-1234; rm -rf /')).toBe(false);
    expect(isSafeRemoteRef('$(id)')).toBe(false);
    expect(isSafeRemoteRef('`id`')).toBe(false);
    expect(isSafeRemoteRef("a'b")).toBe(false);
    expect(isSafeRemoteRef('a b')).toBe(false);
    // Narrower than a tag may be, deliberately: this guard must not widen with
    // TAG_PATTERN, so a '#42' scheme is refused here rather than interpolated.
    expect(isSafeRemoteRef('#42')).toBe(false);
    expect(isSafeRemoteRef('')).toBe(false);
  });
});

describe('vmExec', () => {
  it('invokes the script as `shell <KEY> <wrapped payload>`', async () => {
    const out = await vmExec('PROJ-1234', 'echo hi');

    expect(h.calls).toHaveLength(1);
    const { args } = h.calls[0];
    expect(args[0]).toBe('shell');
    expect(args[1]).toBe('PROJ-1234');
    expect(decodeWrapped(args[2])).toContain('echo hi');
    expect(out).toBe('hello\n');
  });

  it('refuses a handle that could reach the far side\'s shell', async () => {
    await expect(vmExec('PROJ-1; curl evil', 'echo hi'))
      .rejects.toThrow(/cannot be used as a remote container handle/);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses to run while the VM is down, so a poll never boots it', async () => {
    h.listOutput = 'VM agent-vm (p/z): TERMINATED';
    await refreshVmStatus(true);
    h.calls.length = 0;

    await expect(vmExec('PROJ-1234', 'echo hi')).rejects.toThrow(/terminated/i);
    // Only the status refresh may have run — never `shell`, which boots the VM.
    expect(h.calls.every(c => c.args[0] !== 'shell')).toBe(true);
  });
});

describe('vmSend', () => {
  it('pastes the message as base64 so quotes and newlines cannot break out', async () => {
    const message = `line one\nit's "tricky" $(whoami)`;

    await vmSend('PROJ-1234', message);

    const script = decodeWrapped(h.calls.at(-1)!.args[2]);
    const b64 = script.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)![1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(message);
    expect(script).toContain('tmux load-buffer -b cm-paste -');
    expect(script).toContain('tmux paste-buffer -t agent:0.0 -b cm-paste -d -p');
    expect(script).toContain('tmux send-keys -t agent:0.0 Enter');
  });

  it('waits for the paste to be consumed before pressing Enter', async () => {
    await vmSend('PROJ-1234', 'hello');

    const script = decodeWrapped(h.calls.at(-1)!.args[2]);
    const paste = script.indexOf('paste-buffer');
    const settle = script.indexOf('sleep', paste);
    const enter = script.indexOf('send-keys -t agent:0.0 Enter', paste);

    // Without a gap the Enter lands mid-paste and Claude swallows it, so every
    // message needs a second Enter. Locally the gap comes for free from three
    // separate `docker exec` spawns; in one payload it has to be explicit.
    expect(paste).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(paste);
    expect(enter).toBeGreaterThan(settle);
  });

  it('omits the trailing Enter when asked not to submit', async () => {
    await vmSend('PROJ-1234', 'partial', false);

    const script = decodeWrapped(h.calls.at(-1)!.args[2]);
    expect(script).not.toContain('send-keys -t agent:0.0 Enter');
  });
});

describe('vmSendKey', () => {
  it('forwards an allowed key', async () => {
    await vmSendKey('PROJ-1234', 'Escape');

    expect(decodeWrapped(h.calls.at(-1)!.args[2])).toContain('tmux send-keys -t agent:0.0 Escape');
  });

  it('rejects a key outside the allowlist', async () => {
    await expect(vmSendKey('PROJ-1234', 'C-x; rm -rf /')).rejects.toThrow(/Disallowed key/);
    expect(h.calls).toHaveLength(0);
  });
});

describe('fast path over the already-open connection', () => {
  const RECORDED = {
    sshArgs: ['-T', '-i', '/home/me/.ssh/google_compute_engine', 'me@compute.123', '--'],
    runnerPath: '$HOME/proj-agent/src/docker/vm-resolve-runner.sh',
  };

  it('replays the runner command over ssh instead of paying gcloud startup', async () => {
    h.recorded = RECORDED;

    const out = await vmExec('PROJ-1234', 'echo hi');

    // The script is never invoked: that ~6s of gcloud startup per keystroke is
    // exactly what this path exists to avoid.
    const shell = h.calls.filter(c => c.args[0] === 'shell');
    expect(shell).toHaveLength(0);

    const ssh = h.calls.find(c => c.file === '/usr/bin/ssh')!;
    expect(ssh.args).toContain('me@compute.123');
    // The remote command is the same runner call the script would have made.
    const remote = ssh.args.at(-1)!;
    expect(remote.startsWith(`${RECORDED.runnerPath} shell PROJ-1234 `)).toBe(true);
    expect(decodeWrapped(remote.slice(remote.indexOf("'")))).toContain('echo hi');
    expect(out).toBe('hello\n');
  });

  it('falls back to the script when the reused connection fails', async () => {
    h.recorded = RECORDED;
    h.fastFails = true;

    // A stale recording or expired master must never be why an interaction
    // fails — the script path also refreshes the recording for next time.
    const out = await vmExec('PROJ-1234', 'echo hi');

    expect(h.calls.some(c => c.file === '/usr/bin/ssh')).toBe(true);
    expect(h.calls.some(c => c.args[0] === 'shell')).toBe(true);
    expect(out).toBe('hello\n');
  });

  it('uses the script when nothing has been recorded yet', async () => {
    h.recorded = null;

    await vmExec('PROJ-1234', 'echo hi');

    expect(h.calls.some(c => c.file === '/usr/bin/ssh')).toBe(false);
    expect(h.calls.some(c => c.args[0] === 'shell')).toBe(true);
  });

  it('falls back to the script when no shared connection can be established', async () => {
    h.recorded = RECORDED;
    h.masterOk = false;

    // Reuse-only calls must never build their own tunnel: letting each call do
    // that is what left six concurrent IAP tunnels open and made calls slow.
    await vmExec('PROJ-1234', 'echo hi');

    expect(h.calls.some(c => c.file === '/usr/bin/ssh')).toBe(false);
    expect(h.calls.some(c => c.args[0] === 'shell')).toBe(true);
  });
});

describe('removeVmContainer', () => {
  it('always passes -f, because the script prompts without it', async () => {
    await removeVmContainer('PROJ-1234');

    const rm = h.calls.find(c => c.args[0] === 'rm');
    // The script's -f skips its own `read -p` confirmation — not docker's
    // force. Without it the remote read blocks forever on a non-TTY exec.
    expect(rm?.args).toEqual(['rm', 'PROJ-1234', '-f']);
  });

  it('refuses a handle that could reach the far side\'s shell', async () => {
    await expect(removeVmContainer('PROJ-1; curl evil'))
      .rejects.toThrow(/cannot be used as a remote container handle/);
    expect(h.calls.some(c => c.args[0] === 'rm')).toBe(false);
  });

  it('refuses when the VM is down instead of booting it', async () => {
    h.listOutput = 'VM agent-vm (p/z): TERMINATED';
    await refreshVmStatus(true);
    h.calls.length = 0;

    // `rm` runs ensure_vm_up on the far side — a click on a stale row would
    // otherwise start (and bill) the instance just to delete a container.
    await expect(removeVmContainer('PROJ-1234')).rejects.toThrow(/terminated/i);
    expect(h.calls.some(c => c.args[0] === 'rm')).toBe(false);
  });
});
