import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  killLaunchedSession,
  launchClaudeSession,
  resumeSessionInTmux,
} from '../services/claude-launcher.js';
import { getLaunchedSessions } from '../services/launched-sessions.js';
import { cacheLaunchedSession, getCachedSession } from '../services/session-discovery.js';

export async function claudeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/claude/launch-defaults', async () => {
    return { defaultCwd: config.spawnDefaultCwd };
  });

  app.get('/api/claude/launched', async () => {
    return { launched: getLaunchedSessions() };
  });

  app.post('/api/claude/launch', async (request, reply) => {
    const body = (request.body ?? {}) as { cwd?: string };
    const cwd = body.cwd?.trim() || config.spawnDefaultCwd;
    try {
      const session = await launchClaudeSession(cwd);
      // Resolvable by the time the client navigates to it, rather than on the
      // next discovery tick.
      cacheLaunchedSession(session);
      return reply.send(session);
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'launch failed',
      });
    }
  });

  /**
   * Reopen an existing session under tmux so it can be typed into.
   *
   * The only way to make a session that someone started in their own terminal
   * interactive here: Claude Code offers no external write channel, and tmux
   * has to be in place from the start. This runs `claude --resume <id>` in a
   * tmux session this app owns — the same command the user would type — and
   * the card for that id becomes interactive because the launched-session
   * registry binds the two.
   */
  app.post('/api/sessions/:sessionId/resume', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = getCachedSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    // Resume in the directory the session was working in, so relative paths in
    // the conversation still mean what they meant.
    const cwd = session.cwd || session.projectPath;
    if (!cwd) {
      return reply.status(400).send({
        error: 'This session records no working directory, so it cannot be reopened.',
      });
    }
    // Refusing this is the whole point. `claude --resume` on a session that is
    // already running does not attach to it — Claude Code starts a second
    // process on the same transcript, each with its own conversation state, and
    // they diverge: the same message gets two different answers, one visible in
    // the terminal and the other in the browser. It does not refuse, so this
    // has to.
    if (session.live) {
      return reply.status(409).send({
        error:
          'This session is running somewhere else. Reopening it would start a '
          + 'second Claude Code on the same conversation, and the two would '
          + 'answer independently. Exit it where it is running first.',
      });
    }

    try {
      // Resume under the *resolved* id: a container session's id can have been
      // retired, and resuming the retired one would open the wrong transcript.
      const entry = await resumeSessionInTmux(session.id, cwd);
      cacheLaunchedSession(entry);
      return reply.send(entry);
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'resume failed',
      });
    }
  });

  app.delete('/api/claude/launched/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    try {
      await killLaunchedSession(sessionId);
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'kill failed',
      });
    }
  });
}
