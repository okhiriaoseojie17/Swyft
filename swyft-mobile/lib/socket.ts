import { io, Socket } from 'socket.io-client';

export const SIGNAL_SERVER = 'https://swyft-q8lf.onrender.com';
export const LOCAL_PORT     = 3001;

let _socket: Socket | null = null;

/** Returns a connected socket to the online signaling server. */
export function getOnlineSocket(): Socket {
  if (_socket?.connected) return _socket;
  _socket = io(SIGNAL_SERVER, { reconnection: true, reconnectionDelay: 2000 });
  return _socket;
}

/** Creates a fresh socket to a local server IP. Always returns a new instance. */
export function getLocalSocket(ip: string): Socket {
  const url = `http://${ip}:${LOCAL_PORT}`;
  return io(url, { reconnection: true, reconnectionDelay: 2000 });
}

export function disconnectOnline() {
  _socket?.disconnect();
  _socket = null;
}
