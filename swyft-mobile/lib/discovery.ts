/**
 * lib/discovery.ts
 *
 * UDP multicast peer discovery — identical protocol used by both
 * the mobile app and the desktop local-server.js.
 *
 * Every device on the same WiFi:
 *   1. Joins multicast group 224.0.0.167 port 7354
 *   2. Broadcasts an announcement every 2 seconds
 *   3. Listens for announcements from others
 *   4. Builds a live peer list that expires stale entries
 *
 * Announcement packet (JSON):
 *   { id, name, ip, port, platform, version }
 *
 * Uses react-native-udp (wraps the native UDP socket API).
 */

import UdpSocket from 'react-native-udp';
import { Platform } from 'react-native';
import * as Network from 'expo-network';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const MULTICAST_ADDR  = '224.0.0.167';
export const MULTICAST_PORT  = 7354;
export const SERVER_PORT     = 3001;
export const ANNOUNCE_INTERVAL_MS = 2000;
export const PEER_EXPIRY_MS       = 6000;   // remove peer if silent for 6s
export const PROTOCOL_VERSION     = 1;

export interface SwyftPeer {
  id:        string;
  name:      string;
  ip:        string;
  port:      number;
  platform:  'android' | 'ios' | 'windows' | 'mac' | 'linux';
  version:   number;
  lastSeen:  number;  // Date.now()
  serverUrl: string;  // http://ip:port
}

export type PeerListCallback = (peers: SwyftPeer[]) => void;

// ─── Stable device ID ─────────────────────────────────────────────────────────
async function getDeviceId(): Promise<string> {
  const key = 'swyft_device_id';
  let id = await AsyncStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    await AsyncStorage.setItem(key, id);
  }
  return id;
}

async function getDeviceName(): Promise<string> {
  const key = 'swyft_device_name';
  let name = await AsyncStorage.getItem(key);
  if (!name) {
    const adj  = ['Swift','Bright','Cool','Fast','Sharp','Bold','Clear'];
    const noun = ['Falcon','Tiger','Panda','Eagle','Fox','Wolf','Hawk'];
    name = adj[Math.floor(Math.random()*adj.length)] + ' ' +
           noun[Math.floor(Math.random()*noun.length)];
    await AsyncStorage.setItem(key, name);
  }
  return name;
}

// ─── Discovery service ────────────────────────────────────────────────────────
export class DiscoveryService {
  private socket:       any           = null;
  private announceTimer: any          = null;
  private expiryTimer:   any          = null;
  private peers:         Map<string, SwyftPeer> = new Map();
  private myId:          string       = '';
  private myName:        string       = '';
  private myIP:          string       = '';
  private myPlatform:    SwyftPeer['platform'];
  private onPeers:       PeerListCallback;
  private running        = false;

  constructor(onPeers: PeerListCallback) {
    this.onPeers    = onPeers;
    this.myPlatform = (Platform.OS === 'ios' ? 'ios' : 'android') as SwyftPeer['platform'];
  }

  async start() {
    if (this.running) return;
    this.running = true;

    this.myId   = await getDeviceId();
    this.myName = await getDeviceName();
    this.myIP   = await Network.getIpAddressAsync();

    this.socket = UdpSocket.createSocket({ type: 'udp4', reusePort: true });

    this.socket.on('error', (err: any) => {
      console.warn('[Discovery] socket error:', err.message);
    });

    this.socket.on('message', (msg: Buffer, rinfo: any) => {
      try {
        const peer = JSON.parse(msg.toString()) as Omit<SwyftPeer, 'lastSeen' | 'serverUrl'>;
        if (peer.id === this.myId) return;       // ignore own announcements
        if (peer.version !== PROTOCOL_VERSION) return;

        const full: SwyftPeer = {
          ...peer,
          lastSeen:  Date.now(),
          serverUrl: `http://${peer.ip}:${peer.port}`,
        };
        this.peers.set(peer.id, full);
        this._emit();
      } catch (_) {}
    });

    this.socket.bind(MULTICAST_PORT, () => {
      try {
        this.socket.addMembership(MULTICAST_ADDR);
        this.socket.setMulticastTTL(8);
        this.socket.setMulticastLoopback(false);
      } catch (e) {
        console.warn('[Discovery] multicast setup:', e);
      }
      this._startAnnouncing();
    });

    // Expire stale peers every 2 seconds
    this.expiryTimer = setInterval(() => {
      const now    = Date.now();
      let changed  = false;
      for (const [id, peer] of this.peers.entries()) {
        if (now - peer.lastSeen > PEER_EXPIRY_MS) {
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) this._emit();
    }, 2000);
  }

  stop() {
    this.running = false;
    clearInterval(this.announceTimer);
    clearInterval(this.expiryTimer);
    try { this.socket?.close(); } catch (_) {}
    this.socket = null;
    this.peers.clear();
    this._emit();
  }

  getMyName() { return this.myName; }
  getMyIP()   { return this.myIP;   }
  getMyId()   { return this.myId;   }

  private _startAnnouncing() {
    const announce = () => {
      if (!this.running || !this.socket) return;
      const payload = JSON.stringify({
        id:       this.myId,
        name:     this.myName,
        ip:       this.myIP,
        port:     SERVER_PORT,
        platform: this.myPlatform,
        version:  PROTOCOL_VERSION,
      });
      const buf = Buffer.from(payload);
      this.socket.send(buf, 0, buf.length, MULTICAST_PORT, MULTICAST_ADDR, () => {});
    };
    announce();
    this.announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  }

  private _emit() {
    this.onPeers(Array.from(this.peers.values()));
  }
}
