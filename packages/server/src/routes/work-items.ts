import type { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { scanArtifacts, readArtifacts } from '../services/workflow-artifacts.js';
import { getTracker } from '../trackers/registry.js';
import { parseTags } from '../services/tagging.js';
import type { WorkItem } from '../trackers/types.js';

/**
 * Everything about the work a tag names: its live state from the tracker, and
 * the artifacts a workflow left on disk. Both halves are optional and report
 * their own absence, so the UI hides a column rather than showing errors.
 */
export async function workItemRoutes(app: FastifyInstance): Promise<void> {
  // Live state for a batch of tags. `?tags=PROJ-1,PROJ-2`.
  app.get('/api/work-items', async (request) => {
    const { tags } = request.query as { tags?: string };
    const tracker = getTracker();
    if (!tracker) {
      return { enabled: false, tracker: null, items: {} as Record<string, WorkItem> };
    }
    const found = await tracker.lookup(parseTags(tags ?? ''));
    const items: Record<string, WorkItem> = {};
    for (const [tag, item] of found) items[tag] = item;
    return { enabled: true, tracker: { id: tracker.id, label: tracker.label }, items };
  });

  // Workflow progress read off SESSIONS_DIR. `enabled:false` distinguishes "no
  // workflow configured" from "configured but nothing has run yet", which look
  // identical from an empty list.
  app.get('/api/artifacts', async () => {
    const enabled = !!config.issueSessionsDir && !!config.workflow;
    return { enabled, items: enabled ? await scanArtifacts() : [] };
  });

  app.get('/api/artifacts/:tag', async (request, reply) => {
    const { tag } = request.params as { tag: string };
    if (!config.issueSessionsDir || !config.workflow) {
      return reply.status(404).send({ error: 'No workflow is configured' });
    }
    const dir = path.join(config.issueSessionsDir, tag);
    try {
      return { item: await readArtifacts(dir, tag.toUpperCase(), config.workflow) };
    } catch {
      return reply.status(404).send({ error: 'Not found' });
    }
  });

  // One artifact file, for the detail view.
  app.get('/api/artifacts/:tag/files/*', async (request, reply) => {
    const { tag } = request.params as { tag: string };
    const filePath = (request.params as Record<string, string>)['*'];
    const sessionsDir = config.issueSessionsDir;
    if (!sessionsDir || !filePath) {
      return reply.status(404).send({ error: 'Not found' });
    }

    // Contain the read to the item's own directory: `filePath` is a wildcard
    // straight off the URL, so without this a `..` walks the filesystem.
    const itemRoot = path.resolve(sessionsDir, tag);
    const resolved = path.resolve(itemRoot, filePath);
    if (resolved !== itemRoot && !resolved.startsWith(itemRoot + path.sep)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    try {
      return { content: await fsp.readFile(resolved, 'utf-8'), path: filePath };
    } catch {
      return reply.status(404).send({ error: 'File not found' });
    }
  });
}
