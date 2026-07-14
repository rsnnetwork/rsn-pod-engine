import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { SOCKET_BASE_URL } from '@/lib/runtimeEndpoints';

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: TypedSocket | null = null;

export function getSocket(): TypedSocket {
  if (!socket) {
    socket = io(SOCKET_BASE_URL, {
      autoConnect: false,
      // A4 (27 May audit) — the server deliberately pins websocket-only
      // (Tier-1 A6); offering an HTTP long-poll fallback here made a
      // WS-blocked client fall back to a transport the server refuses:
      // registered in the DB but never socket-connected = a ghost that
      // fails SILENTLY. One aligned transport → connection failures are
      // immediate and visible (reconnection banner), not half-joined limbo.
      transports: ['websocket'],
      auth: () => ({
        token: useAuthStore.getState().accessToken,
      }),
      reconnection: true,
      // 14 Jul (Ali live test — alihammza's reconnect storm on a slow mobile) —
      // a flapping connection EXHAUSTED the previous 20-attempt cap in ~3 min,
      // fired `reconnect_failed`, and dead-ended the user at "please refresh"
      // — and refresh couldn't outrun the drops. A live event must NEVER stop
      // trying to reconnect on the client's behalf: with Infinity the socket
      // keeps retrying (capped at reconnectionDelayMax apart) and self-heals
      // the instant the network steadies, no refresh, nobody permanently stuck.
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
  }
  return socket;
}

export function connectSocket(token?: string): void {
  const s = getSocket();
  if (token) {
    s.auth = { token };
  }
  if (!s.connected) s.connect();
}

/**
 * Force a fresh handshake with a new token.
 *
 * Bug 32 (19 May Ali) — `connectSocket` is a no-op when the socket is in
 * its reconnection-retry state (a stale/dead token at cold-open puts it
 * there). When `refreshAccessToken` rotates the token, the only way to
 * cut the retry loop and re-handshake with the new auth is to explicitly
 * disconnect then reconnect. Use this whenever the token CHANGES while
 * the socket already exists.
 */
export function reconnectSocket(token: string): void {
  const s = getSocket();
  s.auth = { token };
  // disconnect() is safe whether connected, connecting, or in retry-backoff
  // — it cancels pending retries and resets the engine's internal state.
  s.disconnect();
  s.connect();
}

export function disconnectSocket(): void {
  if (socket?.connected) socket.disconnect();
}

export function resetSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
