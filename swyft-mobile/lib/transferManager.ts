/**
 * lib/transferManager.ts  (MOBILE)
 *
 * Single entry-point for all local-mode operations.
 *
 * FIXES vs old code:
 *  1. Uses new HTTP-based LocalClient + LocalServer — no TCP/socket.io
 *  2. Peer type detection removed — all peers speak HTTP now
 *  3. No more desktopSocketId hack
 *  4. Progress events come from uploadAsync (native streaming)
 *  5. Receive path: server calls onTransferComplete with saved URI directly
 */

import * as FileSystem from 'expo-file-system';
import { DiscoveryService, SwyftPeer } from './discovery';
import { LocalServer, TransferRequest } from './localServer';
import { LocalClient } from './localClient';
import { showTransferNotification, dismissTransferNotification } from './background';
import { SWYFT_PORT } from './protocol';

export { SwyftPeer };

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
  private discovery:    DiscoveryService;
  private server:       LocalServer | null = null;
  private client:       LocalClient | null = null;
  private cb:           TMCallbacks;
  private myAlias       = '';
  private myFingerprint = '';
  private myIP          = '';
  private peers:        SwyftPeer[] = [];
  private activePeer:   SwyftPeer | null = null;
  private activeSession: string | null   = null;
  private sendStart     = 0;
  // Lets cancelTransfer() stop an in-flight send even before the real
  // sessionId comes back from /prepare-upload (see sendFiles/cancelTransfer).
  private cancelFlag: { cancelled: boolean } = { cancelled: false };

  constructor(cb: TMCallbacks) {
    this.cb        = cb;
    this.discovery = new DiscoveryService((peers) => {
      this.peers = peers;
      this.cb.onPeersChanged(peers);
    });
  }

  async start(): Promise<void> {
    await this.discovery.start();
    this.myAlias       = this.discovery.getAlias();
    this.myFingerprint = this.discovery.getFingerprint();
    this.myIP          = this.discovery.getIP();

    this.client = new LocalClient(this.myAlias, this.myFingerprint, this.myIP);

    // Only create server if not already running
    if (!this.server?.running) {
      this.server = new LocalServer(this.myAlias, this.myFingerprint, {
        onTransferRequest: (req) => {
          this.cb.onIncomingRequest(req);
        },
        onTransferProgress: (_sid, _fid, received, total) => {
          const elapsed = (Date.now() - this.sendStart) / 1000 || 0.001;
          const speed   = (received / 1024 / 1024) / elapsed;
          this.cb.onTransferProgress(Math.round((received / total) * 100), speed, received, total);
          showTransferNotification('file', Math.round((received / total) * 100));
        },
        onTransferComplete: (_sid, _fid, uri) => {
          dismissTransferNotification();
          const parts   = uri.split('/');
          const fileName = parts[parts.length - 1];
          this.cb.onTransferComplete(fileName, uri);
        },
        onTransferCancelled: (_sid) => {
          this.cb.onRemoteCancel();
        },
        onError: (msg) => {
          this.cb.onTransferError(msg);
        },
      });

      try {
        await this.server.start();
      } catch (e: any) {
        // May already be running — not fatal
        console.warn('[TM] Server start warning:', e.message);
      }
    }
  }

  stop(): void {
    this.discovery.stop();
    this.server?.stop();
    this.server  = null;
    this.client  = null;
  }

  getAlias():       string      { return this.myAlias;       }
  getIP():          string      { return this.myIP;           }
  getFingerprint(): string      { return this.myFingerprint;  }
  getPeers():       SwyftPeer[] { return this.peers;          }

  // ── Outbound: send file(s) to a peer ────────────────────────────────────

  async sendFiles(
    peer:  SwyftPeer,
    files: { uri: string; name: string; size: number; mimeType?: string }[],
  ): Promise<void> {
    if (!this.client) throw new Error('TransferManager not started');

    this.activePeer = peer;
    this.sendStart  = Date.now();
    // Generate a client-side sessionId so we can cancel before /prepare-upload returns.
    // The real sessionId comes back from /prepare-upload — we overwrite it then.
    this.activeSession = '__pending__';
    this.cancelFlag     = { cancelled: false };  // fresh flag for this send

    const totalSize = files.reduce((s, f) => s + f.size, 0);
    let   sentTotal = 0;

    await this.client.sendFiles(
      peer,
      files.map(f => ({ ...f, mimeType: f.mimeType || 'application/octet-stream' })),
      {
        onSessionId: (sid) => {
          this.activeSession = sid;  // now cancelTransfer() can POST /cancel for real
          // If Cancel was already tapped while we were still waiting on
          // /prepare-upload (activeSession was '__pending__'), it never
          // reached the peer because we had no real id yet. Cancel it now
          // so their session is invalidated even if they tap Accept after this.
          if (this.cancelFlag.cancelled) {
            this.client?.cancelSession(peer, sid);
          }
        },
        onProgress: (_fileId, sent, total) => {
          sentTotal = sent;   // single-file simple tracking
          const elapsed = (Date.now() - this.sendStart) / 1000 || 0.001;
          const speed   = (sent / 1024 / 1024) / elapsed;
          this.cb.onTransferProgress(Math.round((sent / total) * 100), speed, sent, total);
          showTransferNotification(files[0]?.name || 'file', Math.round((sent / total) * 100));
        },
        onComplete: (_fileId) => {
          // Handled after all files below
        },
        onError: (msg) => {
          this.cb.onTransferError(msg);
        },
      },
      this.cancelFlag,
    );

    dismissTransferNotification();
    this.cb.onSendComplete();
    this.activePeer   = null;
    this.activeSession = null;
  }

  // ── Inbound: user accepts or declines an incoming request ────────────────

  respondToTransfer(sessionId: string, accepted: boolean): void {
    this.server?.respondToSession(sessionId, accepted);
    if (!accepted) {
      this.activeSession = null;
    } else {
      this.activeSession = sessionId;
      this.sendStart     = Date.now();
    }
  }

  // ── Cancel active outbound transfer ──────────────────────────────────────

  async cancelTransfer(): Promise<void> {
    // Stop our own polling/upload loop right away, even if the real
    // sessionId hasn't come back yet. Previously this whole method did
    // nothing when activeSession was still '__pending__', which is why
    // Cancel appeared to do nothing if tapped right after starting a send —
    // the local polling/upload loop kept running, and if the real sessionId
    // arrived afterward it silently revived activeSession with no idea a
    // cancel had already been requested.
    this.cancelFlag.cancelled = true;

    // Cancel outbound (we are the sender)
    if (this.activePeer && this.activeSession && this.activeSession !== '__pending__') {
      await this.client?.cancelSession(this.activePeer, this.activeSession);
    }
    // Cancel inbound (we are the receiver — notify sender via their /cancel endpoint)
    if (this.activeSession && !this.activePeer) {
      // activeSession is set by respondToTransfer() when we accepted.
      // We don't have a direct reference to the sender here, so just delete the session
      // so any subsequent upload chunks get 403'd.
      this.server?.cancelSession(this.activeSession);
    }
    this.activePeer    = null;
    this.activeSession = null;
  }
}