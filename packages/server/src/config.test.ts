import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const KEYS = [
  'VM_RESOLVE_SCRIPT',
  'VM_ENABLED',
  'JIRA_RESOLVE_SCRIPT',
  'SPAWN_DEFAULT_CWD',
  'SESSIONS_DIR',
  'AGENT_VM_NAME',
  'JIRA_ISSUE_PREFIX',
  'TAG_PREFIX',
  'LAUNCH_SCRIPT',
  'REMOTE_SCRIPT',
  'REMOTE_ENABLED',
  'CONTAINER_TMUX_SESSION',
  'VM_RUNNER_SCRIPT',
] as const;

const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

/** Re-read config.ts under a specific environment. */
async function loadConfig(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  return (await import('./config.js')).config;
}

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

describe('config', () => {
  it('switches VM support off when no resolve script is configured', async () => {
    const config = await loadConfig({});
    expect(config.vmEnabled).toBe(false);
    expect(config.vmResolveScript).toBe('');
  });

  it('enables VM support once a resolve script is configured', async () => {
    const config = await loadConfig({ VM_RESOLVE_SCRIPT: '/opt/agent/on-vm.sh' });
    expect(config.vmEnabled).toBe(true);
  });

  it('honours VM_ENABLED=false even with a script configured', async () => {
    const config = await loadConfig({
      VM_RESOLVE_SCRIPT: '/opt/agent/on-vm.sh',
      VM_ENABLED: 'false',
    });
    expect(config.vmEnabled).toBe(false);
  });

  it('leaves launch scripts unset rather than guessing a path', async () => {
    const config = await loadConfig({});
    expect(config.launchScript).toBe('');
    expect(config.issueSessionsDir).toBeNull();
  });

  it('accepts the original environment variable names, so an old .env still works', async () => {
    // The neutral names came later; nobody should have to migrate a working
    // configuration to keep it working.
    const legacy = await loadConfig({
      JIRA_RESOLVE_SCRIPT: '/opt/legacy.sh',
      JIRA_ISSUE_PREFIX: 'OLD-',
    });
    expect(legacy.launchScript).toBe('/opt/legacy.sh');
    expect(legacy.tagPrefix).toBe('OLD-');
  });

  it('prefers the neutral name when both are set', async () => {
    const both = await loadConfig({
      LAUNCH_SCRIPT: '/opt/new.sh',
      JIRA_RESOLVE_SCRIPT: '/opt/legacy.sh',
    });
    expect(both.launchScript).toBe('/opt/new.sh');
  });

  it('defaults the launch directory to the home directory', async () => {
    const config = await loadConfig({});
    expect(config.spawnDefaultCwd).toBe(os.homedir());
  });

  it('expands a leading ~ in path settings', async () => {
    const config = await loadConfig({ SPAWN_DEFAULT_CWD: '~/code/app' });
    expect(config.spawnDefaultCwd).toBe(path.join(os.homedir(), 'code/app'));
  });

  it('derives the container tmux targets from the session name', async () => {
    const def = await loadConfig({});
    expect(def.containerTmuxWindow).toBe('agent:0');
    expect(def.containerTmuxPane).toBe('agent:0.0');

    const custom = await loadConfig({ CONTAINER_TMUX_SESSION: 'claude' });
    expect(custom.containerTmuxWindow).toBe('claude:0');
    expect(custom.containerTmuxPane).toBe('claude:0.0');
  });

  it('ignores a tmux session name that could break out of a shell script', async () => {
    const config = await loadConfig({ CONTAINER_TMUX_SESSION: 'agent; rm -rf /' });
    expect(config.containerTmuxPane).toBe('agent:0.0');
  });

  it('takes the remote runner name from the environment', async () => {
    expect((await loadConfig({})).vmRunnerScript).toBe('vm-resolve-runner.sh');
    expect((await loadConfig({ VM_RUNNER_SCRIPT: 'agent-runner.sh' })).vmRunnerScript)
      .toBe('agent-runner.sh');
  });

  it('carries no instance name unless one is configured', async () => {
    expect((await loadConfig({})).vmName).toBe('');
    expect((await loadConfig({ AGENT_VM_NAME: 'agents-1' })).vmName).toBe('agents-1');
  });
});
