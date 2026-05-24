import UdpSocket from 'react-native-udp';
import { Platform } from 'react-native';
import * as Network from 'expo-network';
import AsyncStorage from '@react-native-async-storage/async-storage';
// 1. Import the polyfill Buffer explicitely
import { Buffer } from 'buffer'; 

export const MULTICAST_ADDR   = '224.0.0.167';
export const MULTICAST_PORT   = 7354;
export const SERVER_PORT      = 3001;
export const ANNOUNCE_INTERVAL_MS = 2000;
export const PEER_EXPIRY_MS       = 6000;
export const PROTOCOL_VERSION     = 1;

export interface SwyftPeer {
  id:        string;
  name:      string;
  ip:        string;
  port:      number;
  platform:  'android' | 'ios' | 'windows' | 'mac' | 'linux';
  version:   number;
  lastSeen:  number;
  serverUrl: string;
}

export type PeerListCallback = (peers: SwyftPeer[]) => void;

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

export class DiscoveryService {
  private socket:       any                    = null;
  private announceTimer: any                   = null;
  private expiryTimer:   any                   = null;
  private peers:          Map<string, SwyftPeer> = new Map();
  private myId:          string               = '';
  private myName:        string               = '';
  private myIP:          string               = '';
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

    // 2. Change type here to a safe instance or Uint8Array/any
    this.socket.on('message', (msg: any, rinfo: any) => { 
      try {
        // 3. Explicitly transform the incoming message to a string safely
        const dataString = typeof msg === 'string' ? msg : Buffer.from(msg).toString('utf8');
        const peer = JSON.parse(dataString) as Omit<SwyftPeer, 'lastSeen' | 'serverUrl'>;
        
        if (peer.id === this.myId) return;
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

    this.socket.bind(
      MULTICAST_PORT,
      '0.0.0.0',
      () => {
        try {
          // Pass the device's actual IP as the multicast interface.
          // react-native-udp on Android/iOS requires a specific interface address —
          // passing undefined or '0.0.0.0' causes addMembership to silently fail
          // on many devices, which means the socket never receives any packets.
          this.socket.addMembership(MULTICAST_ADDR, this.myIP);

          if (this.socket.setMulticastTTL) {
            this.socket.setMulticastTTL(128);
          }

          if (this.socket.setMulticastLoopback) {
            this.socket.setMulticastLoopback(true);
          }

          console.log('[Discovery] multicast ready on', this.myIP);
        } catch (e) {
          console.warn('[Discovery] multicast setup:', e);
        }

        this._startAnnouncing();
      }
    );

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
      
      // Send from the correct interface so recipients see our real LAN IP.
      const buf = Buffer.from(payload, 'utf8');
      this.socket.send(buf, 0, buf.length, MULTICAST_PORT, MULTICAST_ADDR, () => {});
    };
    announce();
    this.announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  }

  private _emit() {
    this.onPeers(Array.from(this.peers.values()));
  }
}