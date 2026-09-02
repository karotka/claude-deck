import { capturePane, sendKeys, sendKey } from '../services/tmux-bridge.js';
import {
  dockerExecCapture,
  dockerExecSend,
  dockerExecSendKey,
  readContainerSessionFull,
} from '../services/docker-scanner.js';
import {
  vmCapture,
  vmSend,
  vmSendKey,
  readVmSessionFull,
} from '../services/vm-bridge.js';
import { config } from '../config.js';
import type { SessionTransport } from './types.js';

/**
 * The three transports that ship with the app, each a thin adapter over the
 * bridge module that already knew how to do the work. The adapters exist so the
 * routes address a transport by `target.kind` instead of importing all three
 * and switching on which optional field a Session happens to carry.
 */

/** A tmux session on this machine. `ref` is the tmux session name. */
export const tmuxTransport: SessionTransport = {
  kind: 'tmux',
  capture: (ref, { lines, cols }) => capturePane(ref, lines, cols),
  async send(ref, text, appendEnter) {
    await sendKeys(ref, text, appendEnter);
    return null;
  },
  async sendKey(ref, key) {
    await sendKey(ref, key);
    return null;
  },
};

/** A container on this machine. `ref` is the container name. */
export const dockerTransport: SessionTransport = {
  kind: 'docker',
  capture: (ref, { lines, cols }) => dockerExecCapture(ref, lines, cols),
  async send(ref, text, appendEnter) {
    await dockerExecSend(ref, text, appendEnter);
    return null;
  },
  async sendKey(ref, key) {
    await dockerExecSendKey(ref, key);
    return null;
  },
  readTranscript: (ref, remotePath) => readContainerSessionFull(ref, remotePath),
  keepVisibleWhenRunning: true,
};

/**
 * A container on a remote host, reached through the user's own script. `ref` is
 * the handle that script takes — see the remote provider.
 *
 * This one returns the resulting pane from send/sendKey: the round trip is
 * expensive enough that waiting for the next poll is most of the delay a remote
 * keystroke appears to have, so the pane comes back with the acknowledgement.
 */
export const remoteTransport: SessionTransport = {
  kind: 'remote',
  capture: (ref, { lines, cols }) => vmCapture(ref, lines, cols),
  send: (ref, text, appendEnter) => vmSend(ref, text, appendEnter),
  sendKey: (ref, key) => vmSendKey(ref, key),
  readTranscript: (ref, remotePath) => readVmSessionFull(ref, remotePath),
  // Faster than the default, not slower: remote panes are streamed and served
  // from this process's memory, so a poll is a localhost round trip rather than
  // a tunnel call. The 2s default was most of what made a remote keystroke feel
  // laggy. The UI reads this off /api/config instead of testing the source name.
  get pollIntervalMs() {
    return config.remoteCapturePollMs;
  },
  keepVisibleWhenRunning: true,
};
