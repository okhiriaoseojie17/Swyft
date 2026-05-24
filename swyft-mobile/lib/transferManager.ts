/**
 * lib/transferManager.ts
 *
 * Single entry point for all local-mode operations.
 */

import * as FileSystem from 'expo-file-system';
import { DiscoveryService, SwyftPeer, SERVER_PORT } from './discovery';
import { LocalServer, MOBILE_SERVER_PORT, TransferRequest } from './localServer';
import { LocalClient } from './localClient';
import { showTransferNotification, dismissTransferNotification } from './background';

const CHUNK_SIZE = 256 * 1024;

export interface TMCallbacks {
  onPeersChanged:     (peers: SwyftPeer[])                                      => void;
  onIncomingRequest:  (req: TransferRequest)                                     => void;
  onTransferProgress: (pct: number, speed: number, sent: number, total: number) => void;
  onTransferComplete: (fileName: string, uri: string)                            => void;
  onTransferError:    (msg: string)                                              => void;
  onRemoteCancel:     ()                                                         => void;
  onSendComplete:     ()                                                         => void;
}

export class TransferManager {
  private discovery:   DiscoveryService;
  private server:      LocalServer | null = null;
  private client:      LocalClient | null = null;
  private cb:          TMCallbacks;

  private myId         = '';
  private myName       = '';
  private myIP         = '';
  private peers:       SwyftPeer[] = [];

  private currentTid:  string | null = null;
  private rxMeta:      any           = null;
  private rxBufs:      ArrayBuffer[] = [];
  private rxStart      = 0;
  private activePeer:  SwyftPeer | null = null;

  constructor(cb: TMCallbacks) {
    this.cb        = cb;
    this.discovery = new DiscoveryService((peers) => {
      this.peers = peers;
      this.cb.onPeersChanged(peers);
    });
  }

  async start() {
    await this.discovery.start();
    this.myId   = this.discovery.getMyId();
    this.myName = this.discovery.getMyName();
    this.myIP   = this.discovery.getMyIP();

    this.server = new LocalServer(this.myId, this.myName, {
      onPeerConnected:    (id, name) => console.log('[TM] peer connected:', name),
      onPeerDisconnected: (id)       => console.log('[TM] peer disconnected:', id),

      onTransferRequest: (req) => {
        this.currentTid = req.transferId;
        this.cb.onIncomingRequest(req);
      },
      onTransferAccepted: (_tid) => {},
      onTransferDeclined: (_tid) => {},

      onFileMetadata: (_tid, meta) => {
        this.rxMeta  = meta;
        this.rxBufs  = [];
        this.rxStart = Date.now();
      },
      onFileChunk: (_tid, chunk) => {
        this.rxBufs.push(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
        const rx      = this.rxBufs.reduce((s, b) => s + b.byteLength, 0);
        const total   = this.rxMeta?.size || 1;
        const elapsed = (Date.now() - this.rxStart) / 1000;
        const speed   = elapsed > 0 ? (rx / 1024 / 1024) / elapsed : 0;
        this.cb.onTransferProgress(Math.round((rx / total) * 100), speed, rx, total);
        showTransferNotification(this.rxMeta?.name || 'file', Math.round((rx / total) * 100));
      },
      onFileEnd: async (_tid) => {
        dismissTransferNotification();
        await this._assembleAndSave();
      },
      onFileCancel: (_tid) => {
        this.rxBufs = []; this.rxMeta = null; this.currentTid = null;
        this.cb.onRemoteCancel();
      },
    });

    try {
      await this.server.start();
    } catch (e: any) {
      console.warn('[TM] Server start failed (may already be running):', e.message);
    }
  }

  stop() {
    this.discovery.stop();
    this.server?.stop();
    this.client?.disconnect();
    this.server = null; this.client = null;
  }

  getMyName()  { return this.myName; }
  getMyIP()    { return this.myIP;   }
  getPeers()   { return this.peers;  }

  // ── Connect to a peer ──────────────────────────────────────────────────────
  connectToPeer(peer: SwyftPeer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client?.disconnect();
      this.activePeer = peer;

      const peerType = (
        peer.platform === 'windows' ||
        peer.platform === 'mac'     ||
        peer.platform === 'linux'
      ) ? 'desktop' : 'mobile';

      this.client = new LocalClient(this.myId, this.myName, peer.ip, peerType, {
        onConnected:    () => resolve(),
        onDisconnected: () => {},
        onError:        (msg) => reject(new Error(msg)),
        onPeerList:     (_list) => {},   // informational; not needed for transfer routing

        onTransferRequest: (tid, from, meta) => {
          this.currentTid = tid;
          this.cb.onIncomingRequest({ transferId: tid, from, fromId: peer.id, meta });
        },
        onTransferAccepted: (tid) => {
          if (this._pendingSendFile) {
            this._doSend(tid, this._pendingSendFile);
            this._pendingSendFile = null;
          }
        },
        onTransferDeclined: (_tid) => {
          this.cb.onTransferError('Transfer declined');
          this._pendingSendFile = null;
        },
        onFileMetadata: (_tid, meta) => {
          this.rxMeta  = meta;
          this.rxBufs  = [];
          this.rxStart = Date.now();
        },
        onFileChunk: (_tid, chunk) => {
          this.rxBufs.push(chunk);
          const rx      = this.rxBufs.reduce((s, b) => s + b.byteLength, 0);
          const total   = this.rxMeta?.size || 1;
          const elapsed = (Date.now() - this.rxStart) / 1000;
          const speed   = elapsed > 0 ? (rx / 1024 / 1024) / elapsed : 0;
          this.cb.onTransferProgress(Math.round((rx / total) * 100), speed, rx, total);
          showTransferNotification(this.rxMeta?.name || 'file', Math.round((rx / total) * 100));
        },
        onFileEnd: async (_tid) => {
          dismissTransferNotification();
          await this._assembleAndSave();
        },
        onFileCancel: (_tid) => {
          this.rxBufs = []; this.rxMeta = null; this.currentTid = null;
          this.cb.onRemoteCancel();
        },
      });

      this.client.connect();

      setTimeout(() => {
        if (!this.client?.connected) reject(new Error(`Cannot reach ${peer.name} at ${peer.ip}`));
      }, 8000);
    });
  }

  // ── Send a file to the connected peer ─────────────────────────────────────
  private _pendingSendFile: { uri: string; name: string; size: number } | null = null;

  async sendFile(file: { uri: string; name: string; size: number }) {
    if (!this.client?.connected) {
      this.cb.onTransferError('Not connected to a peer'); return;
    }
    this._pendingSendFile = file;
    const meta = { name: file.name, size: file.size, mimeType: 'application/octet-stream' };

    // ── FIX: use activePeer.id (Swyft UUID) as targetId ──────────────────
    // For desktop targets: local-server.js resolves Swyft UUID → socket.id via
    // its peersBySwyftId map (populated when desktop UI announces with swyftId).
    // For mobile targets: the TCP path ignores targetId entirely (direct TCP).
    const targetId = this.activePeer?.id ?? '';

    this.client.requestTransfer(targetId, meta, (res: any) => {
      if (!res.success) {
        this.cb.onTransferError('Request failed: ' + (res.message || 'unknown error'));
        this._pendingSendFile = null;
      }
      // On success, wait for onTransferAccepted to start the actual send
    });
  }

  respondToTransfer(accepted: boolean) {
    if (!this.currentTid) return;
    const tid = this.currentTid;

    if (this.client?.connected) {
      // Request arrived via our outbound client connection
      this.client.respondToTransfer(tid, accepted);
    } else if (this.server) {
      // Request arrived via our inbound server — respond to the connecting peer.
      // tid format is "${senderSwyftId}::${timestamp}"; first segment is their ID.
      const senderId = tid.split('::')[0];

      // ── FIX: pass a plain object — sendTo() calls JSON.stringify internally ──
      // (was: JSON.stringify({...}) passed to sendTo which double-encoded it)
      this.server.sendTo(senderId, {
        type: 'transfer-response',
        transferId: tid,
        accepted,
      });
    }

    if (!accepted) this.currentTid = null;
  }

  cancelTransfer() {
    if (!this.currentTid) return;
    this.client?.sendCancel(this.currentTid);
    this.currentTid = null; this.rxBufs = []; this.rxMeta = null;
  }

  // ── Private: perform the actual file send ─────────────────────────────────
  private async _doSend(transferId: string, file: { uri: string; name: string; size: number }) {
    try {
      const meta = { name: file.name, size: file.size, mimeType: 'application/octet-stream' };
      this.client!.sendMetadata(transferId, meta);

      const base64 = await FileSystem.readAsStringAsync(file.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const binary = atob(base64);
      const buf    = new ArrayBuffer(binary.length);
      const u8     = new Uint8Array(buf);
      for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);

      let offset = 0;
      const t0   = Date.now();

      const sendNext = () => {
        if (offset >= buf.byteLength) {
          this.client!.sendEnd(transferId);
          this.currentTid = null;
          this.cb.onSendComplete();
          return;
        }
        const chunk = buf.slice(offset, offset + CHUNK_SIZE);
        this.client!.sendChunk(transferId, chunk);
        offset += chunk.byteLength;

        const elapsed = (Date.now() - t0) / 1000;
        const speed   = elapsed > 0 ? (offset / 1024 / 1024) / elapsed : 0;
        this.cb.onTransferProgress(
          Math.round((offset / buf.byteLength) * 100), speed, offset, buf.byteLength,
        );
        showTransferNotification(file.name, Math.round((offset / buf.byteLength) * 100));
        setTimeout(sendNext, 0);
      };
      sendNext();
    } catch (err: any) {
      this.cb.onTransferError('Send error: ' + err.message);
    }
  }

  // ── Private: assemble received chunks and save to cache ───────────────────
  private async _assembleAndSave() {
    try {
      const total = this.rxBufs.reduce((s, b) => s + b.byteLength, 0);
      const out   = new Uint8Array(total);
      let pos = 0;
      for (const b of this.rxBufs) { out.set(new Uint8Array(b), pos); pos += b.byteLength; }

      const fileName = this.rxMeta?.name || 'received_file';
      const dest     = FileSystem.cacheDirectory + fileName;

      let b64 = '';
      const chunkSz = 8192;
      for (let i = 0; i < out.length; i += chunkSz) {
        b64 += String.fromCharCode(...out.subarray(i, i + chunkSz));
      }
      await FileSystem.writeAsStringAsync(dest, btoa(b64), {
        encoding: FileSystem.EncodingType.Base64,
      });

      this.rxBufs = []; this.rxMeta = null; this.currentTid = null;
      dismissTransferNotification();
      this.cb.onTransferComplete(fileName, dest);
    } catch (err: any) {
      this.cb.onTransferError('Save error: ' + err.message);
    }
  }
}
