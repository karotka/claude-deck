import type { FastifyInstance } from 'fastify';
import type { WebSocket, RawData } from 'ws';
import { onSessionsUpdated, getCachedSessions } from '../services/session-discovery.js';
import type { Session } from '../types.js';
import { isAllowedOrigin } from '../services/cors.js';

interface WsClient {
  socket: WebSocket;
  subscribedSessions: Set<string>;
  subscribeAll: boolean;
}

const clients = new Set<WsClient>();

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // WebSocket upgrades bypass CORS entirely, so the same-origin check the
    // HTTP routes get from @fastify/cors has to be made here by hand —
    // otherwise any page could open this socket and watch every session.
    if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
      socket.close(1008, 'origin not allowed');
      return;
    }

    const client: WsClient = {
      socket,
      subscribedSessions: new Set(),
      subscribeAll: false,
    };
    clients.add(client);

    socket.on('message', (raw: RawData) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'subscribe' && msg.sessionId) {
          client.subscribedSessions.add(msg.sessionId);
        } else if (msg.type === 'unsubscribe' && msg.sessionId) {
          client.subscribedSessions.delete(msg.sessionId);
        } else if (msg.type === 'subscribe_all') {
          client.subscribeAll = true;
        }
      } catch { /* ignore malformed messages */ }
    });

    socket.on('close', () => {
      clients.delete(client);
    });
  });
}

let previousSessionIds = new Set<string>();

export function startBroadcasting(): () => void {
  return onSessionsUpdated((sessions) => {
    const currentIds = new Set(sessions.map(s => s.id));

    // Detect new sessions
    for (const session of sessions) {
      if (!previousSessionIds.has(session.id)) {
        broadcast({ type: 'session_new', session }, session.id);
      }
    }

    // Detect stopped sessions
    for (const oldId of previousSessionIds) {
      if (!currentIds.has(oldId)) {
        broadcast({ type: 'session_stopped', sessionId: oldId }, oldId);
      }
    }

    // Send updates for all current sessions
    for (const session of sessions) {
      broadcast({ type: 'session_updated', session }, session.id);
    }

    previousSessionIds = currentIds;
  });
}

function broadcast(data: unknown, sessionId: string): void {
  const msg = JSON.stringify(data);

  for (const client of clients) {
    if (client.socket.readyState !== 1) continue; // WebSocket.OPEN = 1

    if (client.subscribeAll || client.subscribedSessions.has(sessionId)) {
      client.socket.send(msg);
    }
  }
}
