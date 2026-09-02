import type { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCachedSession } from '../services/session-discovery.js';

/**
 * Files dropped or pasted onto a terminal.
 *
 * Claude Code reads images from a path, and a terminal cannot carry bytes — so
 * dragging a screenshot onto the pane did nothing at all. This writes the file
 * somewhere the session can read and hands back the path, which the panel then
 * types into the prompt. Exactly what you would do by hand, minus finding the
 * file in a picker.
 *
 * The bytes arrive base64 in JSON rather than as multipart: it needs no
 * additional plugin, and a screenshot is small enough that the ~33% encoding
 * overhead is not worth a dependency.
 */

/** Refused above this. A screenshot is well under it; a video is not a paste. */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/**
 * What Fastify will accept as a body for this route.
 *
 * Its default is 1MB, which a phone screenshot clears on its own — and the
 * failure is a reset connection, not a message, because the body is refused
 * before any handler runs. Sized for MAX_ATTACHMENT_BYTES after base64's ~33% and JSON's
 * overhead, so the limit users actually meet is the one with an explanation
 * attached.
 */
const BODY_LIMIT = Math.ceil(MAX_ATTACHMENT_BYTES * 1.4);

/** Where dropped files land. One directory per server run, cleaned at exit. */
const ATTACHMENT_ROOT = path.join(os.tmpdir(), `claude-deck-drops-${process.pid}`);

/**
 * A filename that cannot escape the directory it is written into, and cannot
 * surprise a shell that later sees it. Everything outside this set becomes an
 * underscore; the extension matters because it is how Claude Code knows what
 * kind of file it is being handed.
 */
export function safeAttachmentName(raw: string): string {
  const base = path.basename(raw).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : 'dropped-file';
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/sessions/:id/attachments', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { name, data } = (request.body ?? {}) as { name?: unknown; data?: unknown };

    if (!getCachedSession(id)) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    if (typeof data !== 'string' || !data) {
      return reply.status(400).send({ error: 'data (base64) is required' });
    }

    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0) {
      return reply.status(400).send({ error: 'data is not valid base64' });
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return reply.status(413).send({
        error: `File is ${Math.round(bytes.length / 1024 / 1024)}MB; the limit is `
          + `${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB.`,
      });
    }

    // A directory per drop, so two files of the same name don't collide and a
    // path is never guessable from the name alone.
    const dir = path.join(ATTACHMENT_ROOT, randomUUID());
    const file = path.join(dir, safeAttachmentName(typeof name === 'string' ? name : ''));
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(file, bytes);
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'could not save the file',
      });
    }
    return { path: file, bytes: bytes.length };
  });
}

/**
 * Drop everything this run wrote. Registered from the server entry point; the
 * files are scratch for one session's benefit and have no reason to outlive it.
 */
export function cleanupAttachments(): void {
  try {
    // Synchronous: this runs from an `exit` handler, where nothing async does.
    rmSync(ATTACHMENT_ROOT, { recursive: true, force: true });
  } catch { /* nothing written, or already gone */ }
}
