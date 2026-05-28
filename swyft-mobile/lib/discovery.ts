/**
 * lib/discovery.ts  (MOBILE)
 *
 * Unified UDP multicast discovery — same port 53317, same payload shape
 * as the desktop.  No socket.io, no raw TCP.
 *
 * FIXES applied vs old code:
 *  1. Port changed from 3001/7354 → 53317 (matches desktop + LocalSend spec)
 *  2. Announcement payload now matches SwyftAnnouncement interface
 *  3. Peer expiry increased to 8 s (multicast on Windows/iOS can delay)
 *  4. addMembership called with this.myIP as interface (required on Android)
 *  5. PEER_EXPIRY_MS and ANNOUNCE_INTERVAL_MS imported from shared protocol
 */

import UdpSocket from 'react-native-udp';
import { Platform } from 'react-native';
import * as Network from 'expo-network';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';
import {
  SWYFT_PORT,
  MULTICAST_ADDR,
  MULTICAST_PORT,
  ANNOUNCE_INTERVAL_MS,
  PEER_EXPIRY_MS,
  PROTOCOL_VERSION,
  SwyftAnnouncement,
  SwyftPeer,
  DeviceType,
} from './protocol';

// Re-export so callers don't need to import from shared
export { SwyftPeer };
export type PeerListCallback = (peers: SwyftPeer[]) => void;

// ─── Stable identity helpers ──────────────────────────────────────────────────

async function getFingerprint(): Promise<string> {
  const KEY = 'swyft_device_id_v2';
  let id = await AsyncStorage.getItem(KEY);
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    await AsyncStorage.setItem(KEY, id);
  }
  return id;
}

async function getAlias(): Promise<string> {
  const KEY = 'swyft_device_name_v2';
  let name = await AsyncStorage.getItem(KEY);
  if (!name) {
    const adj  = ['Swift','Bright','Cool','Fast','Sharp','Bold','Clear'];
    const noun = ['Falcon','Tiger','Panda','Eagle','Fox','Wolf','Hawk'];
    name = adj[Math.floor(Math.random()*adj.length)] + ' ' +
           noun[Math.floor(Math.random()*noun.length)];
    await AsyncStorage.setItem(KEY, name);
  }
  return name;
}

function getDeviceType(): DeviceType {
  return 'mobile';
}

function getDeviceModel(): string {
  // Platform.Model is available in react-native 0.64+
  return (Platform as any).constants?.Model || (Platform.OS === 'ios' ? 'iPhone' : 'Android');
}

// ─── DiscoveryService ─────────────────────────────────────────────────────────

export class DiscoveryService {
  private socket:        any                      = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer:   ReturnType<typeof setInterval> | null = null;
  private peers:         Map<string, SwyftPeer>   = new Map();
  private myFingerprint: string = '';
  private myAlias:       string = '';
  private myIP:          string = '';
  private onPeers:       PeerListCallback;
  private running        = false;

  constructor(onPeers: PeerListCallback) {
    this.onPeers = onPeers;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running        = true;
    this.myFingerprint  = await getFingerprint();
    this.myAlias        = await getAlias();
    this.myIP           = await Network.getIpAddressAsync();

    this.socket = UdpSocket.createSocket({ type: 'udp4', reusePort: true });

    this.socket.on('error', (err: any) => {
      console.warn('[Discovery] socket error:', err.message);
    });

    this.socket.on('message', (msg: any, rinfo: any) => {
      try {
        const raw  = typeof msg === 'string' ? msg : Buffer.from(msg).toString('utf8');
        const data = JSON.parse(raw) as SwyftAnnouncement;

        if (data.fingerprint === this.myFingerprint) return;   // ignore self
        if (data.version     !== PROTOCOL_VERSION)  return;   // version mismatch

        const peer: SwyftPeer = {
          ...data,
          ip:       rinfo.address,
          lastSeen: Date.now(),
          baseUrl:  `http://${rinfo.address}:${data.port}`,
        };

        this.peers.set(data.fingerprint, peer);
        this._emit();
      } catch (_) {}
    });

    await new Promise<void>((resolve) => {
      this.socket.bind(MULTICAST_PORT, '0.0.0.0', () => {
        try {
          // Must pass the device's real IP as the interface — passing undefined
          // causes addMembership to silently fail on many Android/iOS devices.
          this.socket.addMembership(MULTICAST_ADDR, this.myIP);
          if (this.socket.setMulticastTTL)      this.socket.setMulticastTTL(128);
          if (this.socket.setMulticastLoopback) this.socket.setMulticastLoopback(true);
          console.log('[Discovery] multicast ready on', this.myIP);
        } catch (e) {
          console.warn('[Discovery] multicast setup failed:', e);
        }
        this._startAnnouncing();
        resolve();
      });
    });

    // Expire stale peers
    this.expiryTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, peer] of this.peers.entries()) {
        if (now - peer.lastSeen > PEER_EXPIRY_MS) {
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) this._emit();
    }, 2000);
  }

  stop(): void {
    this.running = false;
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.expiryTimer)   clearInterval(this.expiryTimer);
    this.announceTimer = null;
    this.expiryTimer   = null;
    try { this.socket?.close(); } catch (_) {}
    this.socket = null;
    this.peers.clear();
    this._emit();
  }

  getAlias():       string { return this.myAlias;       }
  getIP():          string { return this.myIP;           }
  getFingerprint(): string { return this.myFingerprint;  }

  // ── Outbound multicast announcement ───────────────────────────────────────

  private _startAnnouncing(): void {
    const announce = () => {
      if (!this.running || !this.socket) return;

      const payload: SwyftAnnouncement = {
        alias:       this.myAlias,
        version:     PROTOCOL_VERSION,
        deviceModel: getDeviceModel(),
        deviceType:  getDeviceType(),
        fingerprint: this.myFingerprint,
        port:        SWYFT_PORT,      // unified port — always 53317
        protocol:    'http',
        download:    true,
      };

      const buf = Buffer.from(JSON.stringify(payload), 'utf8');
      this.socket.send(buf, 0, buf.length, MULTICAST_PORT, MULTICAST_ADDR, () => {});
    };

    announce();
    this.announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  }

  private _emit(): void {
    this.onPeers(Array.from(this.peers.values()));
  }
}
