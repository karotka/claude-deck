import type { FastifyInstance } from 'fastify';
import { getCachedSession } from '../services/session-discovery.js';
import { stopSession } from '../services/stop-session.js';
import { transportFor } from '../providers/registry.js';

export async function interactRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/sessions/:id/send', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { text, key, noEnter } = request.body as { text?: string; key?: string; noEnter?: boolean };

    if (!text && !key) {
      return reply.status(400).send({ error: 'text or key is required' });
    }

    const session = getCachedSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const transport = transportFor(session);
    if (!transport || !session.target) {
      return reply.status(400).send({
        error: 'This session is observe-only — nothing registered can drive it.',
      });
    }

    try {
      // A transport may hand back the resulting pane in the same round trip.
      // The remote one does: waiting for the next poll instead would be most of
      // the delay a remote keystroke appears to have. Null means "poll as usual".
      const content = key
        ? await transport.sendKey(session.target.ref, key)
        : await transport.send(session.target.ref, text!, !noEnter);
      return content === null ? { ok: true } : { ok: true, content };
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'Failed to send',
      });
    }
  });

  /**
   * Stop a live session.
   *
   * Three cases, and they are genuinely different rather than three ways of
   * saying "kill":
   *
   * - **Background** (`claude --bg`) — `claude stop <id>` is Claude Code's own
   *   command for it. The conversation is kept and the session can be resumed,
   *   which makes this the cheap, reversible one.
   * - **A tmux session this app launched** — killing the window is what closing
   *   that terminal would do. The transcript survives, so Reopen here brings it
   *   back.
   * - **Anything else with a live process** — a plain SIGTERM, the same signal
   *   closing its terminal would send. Claude Code writes its transcript as it
   *   goes, so nothing is lost but an answer already in flight.
   *
   * No SIGKILL and no `claude rm`. A stop that cannot be undone is a different
   * feature and should be asked for by name.
   */
  app.post('/api/sessions/:id/stop', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getCachedSession(id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (!session.live) {
      return reply.status(400).send({ error: 'This session is not running.' });
    }

    try {
      const how = await stopSession(session);
      return { ok: true, how };
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'Failed to stop',
      });
    }
  });

  app.get('/api/sessions/:id/capture', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { lines: linesQ, cols: colsQ, rows: rowsQ } = request.query as {
      lines?: string; cols?: string; rows?: string;
    };
    const linesNum = Number(linesQ);
    const lines = Number.isFinite(linesNum) && linesNum > 0
      ? Math.min(Math.floor(linesNum), 100000)
      : undefined;
    const colsNum = Number(colsQ);
    const cols = Number.isFinite(colsNum) && colsNum > 0
      ? Math.min(Math.max(Math.floor(colsNum), 40), 500)
      : undefined;
    const rowsNum = Number(rowsQ);
    // Floored well above a usable panel: a TUI given ten rows redraws into
    // something unreadable, and a scrollbar on an over-tall pane is a far
    // better outcome than a squashed one.
    const rows = Number.isFinite(rowsNum) && rowsNum > 0
      ? Math.min(Math.max(Math.floor(rowsNum), 20), 200)
      : undefined;

    const session = getCachedSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const transport = transportFor(session);
    if (!transport || !session.target) {
      return reply.status(400).send({ error: 'This session is observe-only.' });
    }

    try {
      const content = await transport.capture(session.target.ref, { lines, cols, rows });
      return { content };
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'Failed to capture',
      });
    }
  });
}
