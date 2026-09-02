import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { isAllowedOrigin } from './services/cors.js';
import { sessionsRoutes } from './routes/sessions.js';
import { workItemRoutes } from './routes/work-items.js';
import { interactRoutes } from './routes/interact.js';
import { dockerRoutes } from './routes/docker.js';
import { claudeRoutes } from './routes/claude.js';
import { configRoutes } from './routes/config.js';
import { attachmentRoutes, cleanupAttachments } from './routes/attachments.js';
import { registerWebSocket, startBroadcasting } from './ws/session-stream.js';
import { startDiscoveryLoop, stopDiscoveryLoop } from './services/session-discovery.js';
import { registerBuiltins } from './providers/builtin.js';
import { getProviders } from './providers/registry.js';
import { loadHiddenSessions } from './services/hidden-sessions.js';
import { loadLaunchedSessions } from './services/launched-sessions.js';
import { loadSessionNotes } from './services/session-notes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  // Before anything else: nothing can discover or drive a session until the
  // providers and transports for this installation exist.
  registerBuiltins();

  const app = Fastify({ logger: true });

  // Same-origin, or a page served from this machine (the UI dev server on its
  // own port). See isAllowedOrigin — `origin: true` would reflect any origin,
  // and this API needs no credentials to read transcripts or type into
  // sessions. The delegator form is what gives the check the request's own host.
  await app.register(fastifyCors, {
    delegator: (req, cb) => {
      cb(null, { origin: isAllowedOrigin(req.headers.origin, req.headers.host) });
    },
  });
  await app.register(fastifyWebSocket);

  // API routes
  await app.register(sessionsRoutes);
  await app.register(workItemRoutes);
  await app.register(interactRoutes);
  await app.register(dockerRoutes);
  await app.register(claudeRoutes);
  await app.register(configRoutes);
  await app.register(attachmentRoutes);

  // WebSocket
  await registerWebSocket(app);

  // Serve static UI in production
  const uiDist = path.resolve(__dirname, '../../ui/dist');
  try {
    // No `wildcard: false`: that indexes the directory once, at registration,
    // so a bundle built while the server is running is never served. Its hashed
    // name doesn't exist yet at startup, the request 404s, and the SPA fallback
    // below answers it with index.html — the browser gets HTML where it asked
    // for JavaScript, the script fails to parse, and the page renders blank with
    // a 200 and nothing in the console. Resolving per request costs a stat.
    await app.register(fastifyStatic, {
      root: uiDist,
      prefix: '/',
    });

    /**
     * SPA fallback — for navigations only.
     *
     * A path that looks like a file, or an API call, has no business being
     * answered with the app shell: doing so turns "this asset is missing" into
     * a silent blank page, and "no such endpoint" into HTML that a fetch will
     * fail to parse. Those get an honest 404.
     */
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = request.url.split('?')[0];
      const isApi = pathname.startsWith('/api/') || pathname.startsWith('/ws');
      if (request.method !== 'GET' || isApi || path.extname(pathname)) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } catch {
    app.log.info('UI dist not found — running in API-only mode');
  }

  // Load persisted state
  await loadHiddenSessions();
  await loadLaunchedSessions();
  await loadSessionNotes();

  // Start session discovery, then let each provider bring up whatever it needs.
  // A provider with its own loop starts it here; the main loop only ever merges
  // that loop's last result, so a provider reaching across a slow link can't
  // hold up startup or a scan tick.
  await startDiscoveryLoop();
  for (const provider of getProviders()) {
    try {
      await provider.start?.();
    } catch (err) {
      app.log.error({ err }, `Provider "${provider.id}" failed to start`);
    }
  }
  const stopBroadcast = startBroadcasting();

  // Graceful shutdown
  const stopProviders = () => {
    for (const provider of getProviders()) {
      try {
        provider.stop?.();
      } catch { /* shutting down; a provider that can't clean up is not fatal */ }
    }
  };

  const shutdown = async () => {
    stopDiscoveryLoop();
    stopProviders();
    stopBroadcast();
    await app.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // A provider may hold long-lived children — the remote one keeps ssh
  // processes holding a tunnel open. If the process goes away without the async
  // shutdown completing — a dev-server reload, a hard kill — they are orphaned
  // and accumulate. `exit` handlers must be synchronous, which is why
  // SessionProvider.stop is not allowed to be async.
  process.on('exit', stopProviders);
  // Files dropped onto a terminal are scratch for one run; don't leave them in
  // the user's temp directory afterwards.
  process.on('exit', cleanupAttachments);

  await app.listen({ port: config.port, host: config.host });
  console.log(`Claude Deck running at http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
