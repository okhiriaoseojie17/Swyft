/**
 * lib/localClient.ts
 *
 * Connects to another Swyft device's local server.
 *
 * Auto-detects which protocol to use:
 *   - If target is a DESKTOP (port 3001, socket.io): uses socket.io-client
 *   - If target is a MOBILE  (port 3002, raw TCP):   uses react-native-tcp-socket
 *
 * This means phone↔desktop and phone↔phone both work transparently.
 */

import TcpSocket from 'react-native-tcp-socket';
import { io, Socket } from 'socket.io-client';
import { MOBILE_SERVER_PORT } from './localServer';

export const DESKTOP_SERVER_PORT = 3001;

export interface LocalClientCallbacks {
  onConnected:        ()                                            => void;
  onDisconnected:     ()                                            => void;
  onError:            (msg: string)                                 => void;
  onPeerList:         (peers: { id: string; name: string }[])      => void;
  onTransferRequest:  (transferId: string, from: string, meta: any) => void;
  onTransferAccepted: (transferId: string)                          => void;
  onTransferDeclined: (transferId: string, reason?: string)         => void;
  onFileMetadata:     (transferId: string, meta: any)               => void;
  onFileChunk:        (transferId: string, chunk: ArrayBuffer)      => void;
  onFileEnd:          (transferId: string)                          => void;
  onFileCancel:       (transferId: string)                          => void;
}

export type PeerType = 'desktop' | 'mobile';

export class LocalClient {
  private tcpSocket:  any    = null;
  private ioSocket:   Socket | null = null;
  private peerType:   PeerType;
  private myId:       string;
  private myName:     string;
  private targetIP:   string;
  private cb:         LocalClientCallbacks;
  private rxBuffer:   Buffer = Buffer.alloc(0);
  private rxMeta:     any    = null;
  private rxBufs:     Buffer[] = [];
  private rxStart     = 0;
  connected           = false;

  constructor(
    myId:    string,
    myName:  string,
    targetIP: string,
    peerType: PeerType,
    cb:      LocalClientCallbacks,
  ) {
    this.myId      = myId;
    this.myName    = myName;
    this.targetIP  = targetIP;
    this.peerType  = peerType;
    this.cb        = cb;
  }

  connect() {
    if (this.peerType === 'desktop') {
      this._connectDesktop();
    } else {
      this._connectMobile();
    }
  }

  disconnect() {
    this.connected = false;
    try { this.tcpSocket?.destroy(); } catch (_) {}
    try { this.ioSocket?.disconnect(); } catch (_) {}
    this.tcpSocket = null; this.ioSocket = null;
  }

  // ── Desktop connection (socket.io to port 3001) ───────────────────────────
  private _connectDesktop() {
    const url = `http://${this.targetIP}:${DESKTOP_SERVER_PORT}`;
    this.ioSocket = io(url, { reconnection: false });

    this.ioSocket.on('connect', () => {
      this.connected = true;
      // Include swyftId so the desktop server can build its UUID→socketId map.
      // Without this the server never learns our Swyft UUID and cannot route
      // incoming transfer requests back to us by UUID.
      this.ioSocket!.emit('announce', { name: this.myName, swyftId: this.myId }, () => {});
      this.cb.onConnected();
    });

    this.ioSocket.on('disconnect', () => {
      this.connected = false;
      this.cb.onDisconnected();
    });

    this.ioSocket.on('connect_error', () => {
      this.cb.onError(`Cannot reach desktop at ${this.targetIP}:${DESKTOP_SERVER_PORT}`);
    });

    this.ioSocket.on('peer-list', (list: any[]) => {
      this.cb.onPeerList(list.filter(p => p.id !== this.ioSocket?.id));
    });

    this.ioSocket.on('incoming-request', ({ transferId, from, meta }: any) => {
      this.cb.onTransferRequest(transferId, from, meta);
    });

    this.ioSocket.on('transfer-response', ({ transferId, accepted, reason }: any) => {
      if (accepted) this.cb.onTransferAccepted(transferId);
      else          this.cb.onTransferDeclined(transferId, reason);
    });

    this.ioSocket.on('file-metadata', ({ transferId, metadata }: any) => {
      this.rxMeta  = metadata;
      this.rxBufs  = [];
      this.rxStart = Date.now();
      this.cb.onFileMetadata(transferId, metadata);
    });

    this.ioSocket.on('file-chunk', ({ transferId, chunk }: any) => {
      this.cb.onFileChunk(transferId, chunk);
    });

    this.ioSocket.on('file-end', ({ transferId }: any) => {
      this.cb.onFileEnd(transferId);
    });

    this.ioSocket.on('file-cancel', ({ transferId }: any) => {
      this.cb.onFileCancel(transferId);
    });
  }

  // ── Mobile connection (raw TCP to port 3002) ──────────────────────────────
  private _connectMobile() {
    this.tcpSocket = TcpSocket.createConnection(
      { host: this.targetIP, port: MOBILE_SERVER_PORT },
      () => {
        this.connected = true;
        // Send hello frame
        this._writeFrame(Buffer.from(JSON.stringify({
          type: 'hello', id: this.myId, name: this.myName,
        })));
      },
    );

    this.tcpSocket.on('data', (data: Buffer) => {
      this.rxBuffer = Buffer.concat([this.rxBuffer, data]);
      this._processBuffer();
    });

    this.tcpSocket.on('close',  () => { this.connected = false; this.cb.onDisconnected(); });
    this.tcpSocket.on('error',  (err: any) => this.cb.onError(err.message));
    this.tcpSocket.on('timeout', () => this.cb.onError('Connection timed out'));
  }

  // ── Framing helpers ───────────────────────────────────────────────────────
  private _writeFrame(payload: Buffer) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(payload.length, 0);
    try { this.tcpSocket?.write(Buffer.concat([lenBuf, payload])); } catch (_) {}
  }

  private _processBuffer() {
    while (true) {
      if (this.rxBuffer.length < 4) break;
      const msgLen = this.rxBuffer.readUInt32BE(0);
      if (this.rxBuffer.length < 4 + msgLen) break;
      const msgBuf    = this.rxBuffer.slice(4, 4 + msgLen);
      this.rxBuffer   = this.rxBuffer.slice(4 + msgLen);
      try {
        const msg = JSON.parse(msgBuf.toString());
        this._handleMessage(msg);
      } catch (_) {}
    }
  }

  private _handleMessage(msg: any) {
    switch (msg.type) {
      case 'hello-ack':
        this.cb.onConnected();
        break;
      case 'request-transfer':
        this.cb.onTransferRequest(msg.transferId, msg.from, msg.meta);
        break;
      case 'transfer-response':
        if (msg.accepted) this.cb.onTransferAccepted(msg.transferId);
        else              this.cb.onTransferDeclined(msg.transferId);
        break;
      case 'file-metadata':
        this.rxMeta  = msg.metadata;
        this.rxBufs  = [];
        this.rxStart = Date.now();
        this.cb.onFileMetadata(msg.transferId, msg.metadata);
        break;
      case 'chunk':
        // Chunk arrives as two frames: header JSON then binary
        // Already merged by sendChunkTo — handle binary payload
        break;
      case 'file-end':
        this.cb.onFileEnd(msg.transferId);
        break;
      case 'file-cancel':
        this.cb.onFileCancel(msg.transferId);
        break;
    }
  }

  // ── Public send methods ───────────────────────────────────────────────────

  requestTransfer(targetId: string, meta: any, cb: (res: any) => void) {
    const transferId = `${this.myId}::${Date.now()}`;
    if (this.ioSocket) {
      this.ioSocket.emit('request-transfer', { targetId, meta }, cb);
    } else {
      this._writeFrame(Buffer.from(JSON.stringify({ type: 'request-transfer', transferId, meta })));
      cb({ success: true, transferId });
    }
  }

  respondToTransfer(transferId: string, accepted: boolean) {
    if (this.ioSocket) {
      this.ioSocket.emit('transfer-response', { transferId, accepted });
    } else {
      this._writeFrame(Buffer.from(JSON.stringify({ type: 'transfer-response', transferId, accepted })));
    }
  }

  sendMetadata(transferId: string, metadata: any) {
    if (this.ioSocket) {
      this.ioSocket.emit('file-metadata', { transferId, metadata });
    } else {
      this._writeFrame(Buffer.from(JSON.stringify({ type: 'file-metadata', transferId, metadata })));
    }
  }

  sendChunk(transferId: string, chunk: ArrayBuffer) {
    if (this.ioSocket) {
      this.ioSocket.emit('file-chunk', { transferId, chunk });
    } else {
      const header  = Buffer.from(JSON.stringify({ type: 'chunk', transferId }));
      const payload = Buffer.from(chunk);
      const h1 = Buffer.alloc(4); h1.writeUInt32BE(header.length, 0);
      const h2 = Buffer.alloc(4); h2.writeUInt32BE(payload.length, 0);
      try { this.tcpSocket?.write(Buffer.concat([h1, header, h2, payload])); } catch (_) {}
    }
  }

  sendEnd(transferId: string) {
    if (this.ioSocket) {
      this.ioSocket.emit('file-end', { transferId });
    } else {
      this._writeFrame(Buffer.from(JSON.stringify({ type: 'file-end', transferId })));
    }
  }

  sendCancel(transferId: string) {
    if (this.ioSocket) {
      this.ioSocket.emit('file-cancel', { transferId });
    } else {
      this._writeFrame(Buffer.from(JSON.stringify({ type: 'file-cancel', transferId })));
    }
  }
}