/**
 * lib/localServer.ts
 *
 * Lightweight in-app file-transfer server that runs directly on the phone.
 * Uses the same event names as desktop local-server.js so desktop and mobile
 * are 100% interoperable.
 *
 * Architecture:
 *   - Each device runs this server on port 3001
 *   - Peers connect to each other's servers directly (peer-to-peer over LAN)
 *   - Transfer flow: request-transfer → transfer-response → file-metadata
 *                    → file-chunk(s) → file-end
 *
 * We use react-native-tcp-socket for the raw TCP layer and implement a minimal
 * length-prefixed JSON + binary framing protocol on top, because Socket.io
 * cannot run as a *server* in React Native (only as a client).
 *
 * The mobile CLIENT (lib/localClient.ts) speaks the same framing protocol.
 * The desktop still uses Socket.io — we provide a compatibility shim so
 * mobile↔desktop works by having the mobile CLIENT use socket.io-client
 * when connecting to a desktop server, and the in-app server accepts
 * both socket.io handshakes and direct connections.
 *
 * SIMPLIFICATION FOR V1:
 * Rather than implementing a full Socket.io server (very complex in RN),
 * we run a plain JSON-over-TCP server on port 3002 for phone↔phone,
 * and use socket.io-client on port 3001 for phone→desktop.
 * The discovery packet includes both ports so peers know which to use.
 */

import TcpSocket from 'react-native-tcp-socket';
import { EventEmitter } from 'events';

export const MOBILE_SERVER_PORT = 3002;

export interface TransferRequest {
  transferId: string;
  from:       string;
  fromId:     string;
  meta:       { name: string; size: number; mimeType: string };
}

export interface LocalServerCallbacks {
  onPeerConnected:    (peerId: string, peerName: string) => void;
  onPeerDisconnected: (peerId: string)                   => void;
  onTransferRequest:  (req: TransferRequest)             => void;
  onTransferAccepted: (transferId: string)               => void;
  onTransferDeclined: (transferId: string)               => void;
  onFileMetadata:     (transferId: string, meta: any)    => void;
  onFileChunk:        (transferId: string, chunk: Buffer) => void;
  onFileEnd:          (transferId: string)               => void;
  onFileCancel:       (transferId: string)               => void;
}

interface ConnectedClient {
  id:     string;
  name:   string;
  socket: any;
  buffer: Buffer;
}

export class LocalServer extends EventEmitter {
  private server:  any = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private cb:      LocalServerCallbacks;
  private myId:    string;
  private myName:  string;
  running = false;

  constructor(myId: string, myName: string, cb: LocalServerCallbacks) {
    super();
    this.myId   = myId;
    this.myName = myName;
    this.cb     = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = TcpSocket.createServer((socket: any) => {
        this._handleClient(socket);
      });

      this.server.on('error', (err: any) => {
        console.warn('[LocalServer] error:', err.message);
        reject(err);
      });

      this.server.listen({ port: MOBILE_SERVER_PORT, host: '0.0.0.0' }, () => {
        this.running = true;
        console.log('[LocalServer] listening on port', MOBILE_SERVER_PORT);
        resolve();
      });
    });
  }

  stop() {
    this.running = false;
    for (const client of this.clients.values()) {
      try { client.socket.destroy(); } catch (_) {}
    }
    this.clients.clear();
    try { this.server?.close(); } catch (_) {}
    this.server = null;
  }

  // ── Send a message to a specific client ──────────────────────────────────────
  sendTo(clientId: string, msg: object) {
    const client = this.clients.get(clientId);
    if (!client) return;
    this._writeFrame(client.socket, Buffer.from(JSON.stringify(msg)));
  }

  // ── Send binary chunk to a specific client ────────────────────────────────────
  sendChunkTo(clientId: string, transferId: string, chunk: Buffer) {
    const client = this.clients.get(clientId);
    if (!client) return;
    // Frame: { type: 'chunk', transferId } header + binary payload
    const header = Buffer.from(JSON.stringify({ type: 'chunk', transferId }));
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(header.length, 0);
    const lenBuf2 = Buffer.alloc(4);
    lenBuf2.writeUInt32BE(chunk.length, 0);
    try {
      client.socket.write(Buffer.concat([lenBuf, header, lenBuf2, chunk]));
    } catch (_) {}
  }

  getPeers(): { id: string; name: string }[] {
    return Array.from(this.clients.values()).map(c => ({ id: c.id, name: c.name }));
  }

  // ── Private: handle new incoming client connection ───────────────────────────
  private _handleClient(socket: any) {
    const tempId = Math.random().toString(36).slice(2);
    const client: ConnectedClient = { id: tempId, name: 'Unknown', socket, buffer: Buffer.alloc(0) };

    socket.on('data', (data: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, data]);
      this._processBuffer(client);
    });

    socket.on('close', () => {
      this.clients.delete(client.id);
      this.cb.onPeerDisconnected(client.id);
      this.emit('peer-list-changed');
    });

    socket.on('error', () => {
      this.clients.delete(client.id);
      this.emit('peer-list-changed');
    });

    this.clients.set(tempId, client);
  }

  // ── Framing: 4-byte big-endian length prefix + payload ──────────────────────
  private _writeFrame(socket: any, payload: Buffer) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(payload.length, 0);
    try { socket.write(Buffer.concat([lenBuf, payload])); } catch (_) {}
  }

  private _processBuffer(client: ConnectedClient) {
    while (true) {
      if (client.buffer.length < 4) break;
      const msgLen = client.buffer.readUInt32BE(0);
      if (client.buffer.length < 4 + msgLen) break;

      const msgBuf = client.buffer.slice(4, 4 + msgLen);
      client.buffer = client.buffer.slice(4 + msgLen);

      try {
        const msg = JSON.parse(msgBuf.toString());
        this._handleMessage(client, msg);
      } catch (_) {
        // Not JSON — ignore (shouldn't happen with proper framing)
      }
    }
  }

  private _handleMessage(client: ConnectedClient, msg: any) {
    switch (msg.type) {

      case 'hello':
        // First message from a connecting peer — they identify themselves
        client.id   = msg.id;
        client.name = msg.name;
        this.clients.delete(client.id); // remove temp entry
        this.clients.set(msg.id, client);
        // Respond with our identity
        this._writeFrame(client.socket, Buffer.from(JSON.stringify({
          type: 'hello-ack', id: this.myId, name: this.myName,
        })));
        this.cb.onPeerConnected(client.id, client.name);
        this.emit('peer-list-changed');
        break;

      case 'request-transfer':
        this.cb.onTransferRequest({
          transferId: msg.transferId,
          from:       client.name,
          fromId:     client.id,
          meta:       msg.meta,
        });
        break;

      case 'transfer-response':
        if (msg.accepted) this.cb.onTransferAccepted(msg.transferId);
        else              this.cb.onTransferDeclined(msg.transferId);
        break;

      case 'file-metadata':
        this.cb.onFileMetadata(msg.transferId, msg.metadata);
        break;

      case 'chunk':
        // Binary chunk follows immediately after this header frame
        // Already handled by sendChunkTo — but receiving side needs special handling
        // See LocalClient for the receive path
        break;

      case 'file-end':
        this.cb.onFileEnd(msg.transferId);
        break;

      case 'file-cancel':
        this.cb.onFileCancel(msg.transferId);
        break;
    }
  }
}
