/**
 * Environment every server test runs against.
 *
 * The paths and instance name are configuration in a real installation, so
 * tests can't rely on defaults — they pin a fully-configured install here, and
 * the ones that care about the unconfigured case say so themselves. Nothing
 * here is ever executed: child_process is mocked in the tests that spawn.
 */
process.env.LAUNCH_SCRIPT = '/opt/agent/docker/start-agent.sh';
process.env.REMOTE_SCRIPT = '/opt/agent/docker/agent-on-vm.sh';
process.env.AGENT_VM_NAME = 'test-agent-vm';
