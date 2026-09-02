import type { FastifyInstance } from 'fastify';
import {
  listManagedContainers,
  planCleanup,
  removeManagedContainer,
  type ContainerLocation,
} from '../services/docker-management.js';
import { launch, getLaunchStatus, getLaunchers } from '../services/launcher.js';
import { getVmStatusSnapshot } from '../services/vm-discovery.js';

function toLocation(value: string | undefined): ContainerLocation {
  return value === 'vm' ? 'vm' : 'local';
}

export async function dockerRoutes(app: FastifyInstance): Promise<void> {
  // What this installation can start. The dialog renders one button per entry,
  // so an install with no launchers simply has no Start development action —
  // rather than a button that reports a missing env var when pressed.
  app.get('/api/launchers', async () => ({
    launchers: getLaunchers().map(l => ({
      id: l.id,
      label: l.label,
      inputLabel: l.inputLabel ?? null,
      description: l.description ?? null,
      remote: !!l.remote,
    })),
  }));

  app.post('/api/launch', async (request, reply) => {
    const body = (request.body ?? {}) as { tag?: string; launcher?: string };
    if (!body.tag) {
      return reply.status(400).send({ error: 'tag is required' });
    }
    try {
      return reply.send(await launch(body.tag, body.launcher));
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'start failed',
      });
    }
  });

  app.get('/api/launch-status/:tag', async (request, reply) => {
    const { tag } = request.params as { tag: string };
    const { launcher } = request.query as { launcher?: string };
    try {
      return reply.send(await getLaunchStatus(tag, launcher));
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'status failed',
      });
    }
  });

  // Whether the remote VM is configured and reachable, so the UI can enable
  // (or explain away) the "run on VM" option. Reads the last cached probe —
  // never triggers a round trip of its own.
  app.get('/api/vm/status', async () => getVmStatusSnapshot());

  app.get('/api/docker/containers', async () => {
    const containers = await listManagedContainers();
    return { containers };
  });

  // `location` says which daemon the row came from: both sides use the same
  // container names, so the name alone can't tell them apart.
  app.delete('/api/docker/containers/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const { force, location } = request.query as { force?: string; location?: string };
    try {
      await removeManagedContainer(name, toLocation(location), force === 'true');
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'remove failed',
      });
    }
  });

  // Preview cleanup — returns the list of containers that match the criteria
  app.post('/api/docker/cleanup/preview', async (request) => {
    const body = (request.body ?? {}) as {
      olderThanDays?: number;
      onlyHidden?: boolean;
      onlyStopped?: boolean;
    };
    return planCleanup(body);
  });

  // Execute cleanup — removes containers matching the criteria
  app.post('/api/docker/cleanup', async (request, reply) => {
    const body = (request.body ?? {}) as {
      olderThanDays?: number;
      onlyHidden?: boolean;
      onlyStopped?: boolean;
    };
    const plan = await planCleanup(body);
    const removed: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const c of plan.containers) {
      try {
        await removeManagedContainer(c.name, c.location, c.state === 'running');
        removed.push(c.name);
      } catch (err) {
        failed.push({
          name: c.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reply.send({ removed, failed, criteria: plan.criteria });
  });
}
