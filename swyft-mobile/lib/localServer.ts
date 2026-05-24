/**
 * lib/localServer.ts
 *
 * Lightweight in-app TCP server for phone↔phone local transfers (port 3002).
 * Mobile→desktop uses socket.io-client (see localClient.ts).
 *
 * Framing: every message is [4-byte big-endian length][payload].
 * Binary file chunks are sent as two consecutive frames:
 *   Frame 1: JSON  { type:'chunk', transferId }
 *   Frame 2: binary payload
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
  id:             string;
  name:           string;
  socket:         any;
  buffer:         Buffer;
  // FIX: track whether the next frame is a binary chunk (not JSON)
  awaitingBinaryForTid: string | null;
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

  sendTo(clientId: string, msg: object) {
    const client = this.clients.get(clientId);
    if (!client) return;
    this._writeFrame(client.socket, Buffer.from(JSON.stringify(msg)));
  }

  sendChunkTo(clientId: string, transferId: string, chunk: Buffer) {
    const client = this.clients.get(clientId);
    if (!client) return;
    const header  = Buffer.from(JSON.stringify({ type: 'chunk', transferId }));
    const lenBuf1 = Buffer.alloc(4); lenBuf1.writeUInt32BE(header.length, 0);
    const lenBuf2 = Buffer.alloc(4); lenBuf2.writeUInt32BE(chunk.length,  0);
    try { client.socket.write(Buffer.concat([lenBuf1, header, lenBuf2, chunk])); } catch (_) {}
  }

  getPeers(): { id: string; name: string }[] {
    return Array.from(this.clients.values()).map(c => ({ id: c.id, name: c.name }));
  }

  private _handleClient(socket: any) {
    const tempId = Math.random().toString(36).slice(2);
    const client: ConnectedClient = {
      id:     tempId,
      name:   'Unknown',
      socket,
      buffer: Buffer.alloc(0),
      awaitingBinaryForTid: null,   // FIX: initialise per-client binary tracking
    };

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

  private _writeFrame(socket: any, payload: Buffer) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(payload.length, 0);
    try { socket.write(Buffer.concat([lenBuf, payload])); } catch (_) {}
  }

  private _processBuffer(client: ConnectedClient) {
    while (true) {
      if (client.buffer.length < 4) break;
      const msgLen = client.buffer.readUInt32BE(0);
      // Guard against corrupted frames that would cause the buffer to grow unbounded
      if (msgLen > 100 * 1024 * 1024) {
        client.buffer = Buffer.alloc(0);
        break;
      }
      if (client.buffer.length < 4 + msgLen) break;

      const msgBuf      = client.buffer.slice(4, 4 + msgLen);
      client.buffer     = client.buffer.slice(4 + msgLen);

      // ── FIX: if we're waiting for a binary payload, deliver it directly ──
      if (client.awaitingBinaryForTid !== null) {
        const tid = client.awaitingBinaryForTid;
        client.awaitingBinaryForTid = null;
        this.cb.onFileChunk(tid, msgBuf);
        continue;
      }

      try {
        const msg = JSON.parse(msgBuf.toString());
        this._handleMessage(client, msg);
      } catch (_) {
        // Unexpected non-JSON frame — ignore
      }
    }
  }

  private _handleMessage(client: ConnectedClient, msg: any) {
    switch (msg.type) {

      case 'hello': {
        // ── FIX: delete the old TEMP id, not the new one ──
        const oldId = client.id;
        client.id   = msg.id;
        client.name = msg.name;
        this.clients.delete(oldId);       // was: this.clients.delete(client.id) — wrong!
        this.clients.set(msg.id, client);
        this._writeFrame(client.socket, Buffer.from(JSON.stringify({
          type: 'hello-ack', id: this.myId, name: this.myName,
        })));
        this.cb.onPeerConnected(client.id, client.name);
        this.emit('peer-list-changed');
        break;
      }

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
        // ── FIX: mark that the very next frame is the binary payload ──
        client.awaitingBinaryForTid = msg.transferId;
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