import type { FastifyInstance } from 'fastify';
import {
  getCachedSession,
  getCachedSessions,
  getSessionDetail,
  discoverSessions,
} from '../services/session-discovery.js';
import { parseFullSession, parseFullSessionFromContent } from '../services/jsonl-parser.js';
import { transportFor } from '../providers/registry.js';
import { getTracker } from '../trackers/registry.js';
import { sessionWorkItems, type Conversation } from '../services/session-work-items.js';
import type { ParsedMessage, Session } from '../types.js';
import { isHidden, hideSession, unhideSession } from '../services/hidden-sessions.js';
import { planStop } from '../services/stop-session.js';
import { getSessionNote, getSessionNotes, setSessionNote } from '../services/session-notes.js';

/**
 * A session's transcript, wherever it lives.
 *
 * Sessions that run elsewhere have no host JSONL (jsonlPath is empty); theirs
 * is pulled back through the transport on demand. Falls back to an empty
 * transcript on any failure rather than failing the request — a page that can't
 * reach a remote host should still render everything else about the session.
 */
async function loadTranscript(session: Session): Promise<ParsedMessage[]> {
  const messages = session.jsonlPath
    ? await parseFullSession(session.jsonlPath).catch(() => [])
    : [];
  if (messages.length > 0 || session.jsonlPath || !session.remoteJsonlPath) return messages;

  const transport = transportFor(session);
  const content = transport?.readTranscript && session.target
    ? await transport.readTranscript(session.target.ref, session.remoteJsonlPath).catch(() => '')
    : '';
  return content ? parseFullSessionFromContent(content) : [];
}

/**
 * Text a person wrote or Claude said, with tool traffic left out.
 *
 * Tool results carry file listings, greps and command output, which mention
 * every ticket key that happens to be in a repo — so scanning them would report
 * a session as touching a dozen tickets it never discussed.
 */
function conversationText(messages: ParsedMessage[]): Conversation {
  const user: string[] = [];
  const all: string[] = [];
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue;
    for (const block of message.content ?? []) {
      if (block.type !== 'text' || !block.text) continue;
      all.push(block.text);
      if (message.type === 'user') user.push(block.text);
    }
  }
  return { user: user.join('\n'), all: all.join('\n') };
}

export async function sessionsRoutes(app: FastifyInstance): Promise<void> {
  // List all sessions
  app.get('/api/sessions', async (request) => {
    const { status, source, showHidden, recent } = request.query as {
      status?: string;
      source?: string;
      showHidden?: string;
      recent?: string;
    };
    let sessions = recent === 'false'
      ? await discoverSessions({ includeOld: true, writeCache: false })
      : getCachedSessions();

    if (status) {
      sessions = sessions.filter(s => s.status === status);
    }
    if (source) {
      sessions = sessions.filter(s => s.source === source);
    }

    // Mark hidden flag on each session
    const withHidden = sessions.map(s => ({ ...s, hidden: isHidden(s.id) }));

    // Filter out hidden sessions unless showHidden=true — except that a
    // session which is *provably running* is surfaced anyway, dimmed by its
    // hidden flag, with "Show" to bring it back properly.
    //
    // Hiding is how the tab bar's × closes a tab, so it is easy to do by
    // accident; and a live session that vanishes without trace is the one thing
    // this dashboard must not do, since it is burning tokens and the way back
    // is a toggle the user has no reason to look for. `live` comes from Claude
    // Code's own registry, so this is a fact rather than an inference — and the
    // transport's own opinion still covers container sessions, whose processes
    // this machine cannot see.
    const filtered =
      showHidden === 'true'
        ? withHidden
        : withHidden.filter(
            s =>
              !s.hidden ||
              s.live ||
              (s.status === 'running' && !!transportFor(s)?.keepVisibleWhenRunning),
          );

    return { sessions: filtered };
  });

  // Get session detail
  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await getSessionDetail(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return {
      session: {
        ...session,
        hidden: isHidden(session.id),
        note: getSessionNote(session.id) ?? null,
        // What Stop would do, so the dialog can say it without the browser
        // reimplementing the decision.
        stopMethod: session.live ? planStop(session) : null,
      },
    };
  });

  // All session notes, keyed by session id. The tab bar needs the whole map, and
  // it is polled so a note added on another device shows up here.
  app.get('/api/notes', async () => {
    return { notes: getSessionNotes() };
  });

  // Set (or, with a blank note, clear) the note for a session
  app.post('/api/sessions/:id/note', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { note } = (request.body ?? {}) as { note?: unknown };

    if (note !== undefined && typeof note !== 'string') {
      return reply.status(400).send({ error: 'note must be a string' });
    }

    await setSessionNote(id, note ?? '');
    return { ok: true, note: getSessionNote(id) ?? null };
  });

  // Hide a session
  app.post('/api/sessions/:id/hide', async (request) => {
    const { id } = request.params as { id: string };
    await hideSession(id);
    return { ok: true };
  });

  // Unhide a session
  app.post('/api/sessions/:id/unhide', async (request) => {
    const { id } = request.params as { id: string };
    await unhideSession(id);
    return { ok: true };
  });

  // Get session messages (paginated)
  app.get('/api/sessions/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { offset = '0', limit = '50' } = request.query as { offset?: string; limit?: string };

    const session = getCachedSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const messages = await loadTranscript(session);
    // Reverse so newest messages come first. `parseFullSession` hands back its
    // cached array, so copy rather than reversing in place.
    const ordered = [...messages].reverse();
    const start = Number(offset);
    const end = start + Number(limit);

    return {
      messages: ordered.slice(start, end),
      total: ordered.length,
      offset: start,
      limit: Number(limit),
    };
  });

  /**
   * Every tag the conversation mentions, in first-seen order, with the live
   * state of each from the tracker.
   *
   * Distinct from `session.tag`, which is the one piece of work the session was
   * started for. A session routinely touches several tickets — a fix here, a
   * follow-up there — and the sidebar is where that belongs.
   */
  app.get('/api/sessions/:id/tags', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getCachedSession(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return sessionWorkItems(
      session.tag ?? null,
      conversationText(await loadTranscript(session)),
      getTracker(),
    );
  });

  // Get session subagents
  app.get('/api/sessions/:id/subagents', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getCachedSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { subagents: session.subagents };
  });

  // Aggregate stats
  app.get('/api/stats', async () => {
    const sessions = getCachedSessions();
    const visible = sessions.filter(s => !isHidden(s.id));
    const running = visible.filter(s => s.status === 'running').length;
    const totalTokensIn = visible.reduce((sum, s) => sum + s.totalInputTokens, 0);
    const totalTokensOut = visible.reduce((sum, s) => sum + s.totalOutputTokens, 0);
    const totalCost = visible.reduce((sum, s) => sum + s.estimatedCost, 0);

    return {
      totalSessions: visible.length,
      runningSessions: running,
      totalInputTokens: totalTokensIn,
      totalOutputTokens: totalTokensOut,
      totalCost,
    };
  });
}
