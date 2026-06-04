/**
 * lib/webrtc.ts
 * Core WebRTC logic for Swyft Online mode.
 * Direct port of sender.js / receiver.js to React Native using react-native-webrtc.
 */

import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { SIGNAL_SERVER } from './socket';
import { Socket } from 'socket.io-client';

const CHUNK_SIZE   = 256 * 1024;   // 256 KB per chunk
const MAX_BUFFER   = 16 * 1024 * 1024;

// ── react-native-webrtc type patch ────────────────────────────────────────────
// The package's .d.ts omits standard event handler properties and addEventListener.
// This interface fills the gap without touching any runtime behaviour.
interface RNRTCPeerConnection {
  iceGatheringState: RTCIceGatheringState;
  localDescription: RTCSessionDescriptionInit | null;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidate): Promise<void>;
  createDataChannel(label: string, options?: RTCDataChannelInit): any;
  close(): void;
  // Properties the RN package forgets to declare:
  onicecandidate:  ((event: { candidate: RTCIceCandidate | null }) => void) | null;
  ondatachannel:   ((event: { channel: any }) => void) | null;
  addEventListener(type: string, listener: () => void): void;
}

// ── ICE server fetcher ────────────────────────────────────────────────────────
async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch(`${SIGNAL_SERVER}/ice-servers`);
    return await res.json();
  } catch {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDER
// ─────────────────────────────────────────────────────────────────────────────
export interface SenderCallbacks {
  onPINReady:         (pin: string)                                          => void;
  onConnected:        ()                                                     => void;
  onProgress:         (pct: number, speed: number, sent: number, total: number) => void;
  onComplete:         ()                                                     => void;
  onError:            (msg: string)                                          => void;
  onRemoteCancel:     ()                                                     => void;
  onRemoteDisconnect: ()                                                     => void;
}

export class SwyftSender {
  private pc:             RNRTCPeerConnection | null = null;
  private channel:        any                        = null;
  private socket:         Socket;
  private currentPIN:     string | null              = null;
  private isCancelled     = false;
  private isTransferring  = false;

  constructor(socket: Socket, private cb: SenderCallbacks) {
    this.socket = socket;
  }

  async generatePIN(fileInfo: { name: string; size: number }) {
    // Clean up any previous session
    this.cleanup(false);
    this.isCancelled    = false;
    this.isTransferring = false;

    const iceServers = await fetchIceServers();
    this.pc = new RTCPeerConnection({ iceServers }) as unknown as RNRTCPeerConnection;

    this._setupDataChannel();

    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.currentPIN) {
        this.socket.emit('ice-candidate', { pin: this.currentPIN, candidate: e.candidate });
      }
    };

    this.socket.on('ice-candidate', async ({ candidate }: any) => {
      try { if (candidate && this.pc) await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (err) { console.warn('ICE candidate error', err); }
    });

    const offer = await this.pc.createOffer({});
    await this.pc.setLocalDescription(offer);

    // Wait for ICE gathering to complete
    await new Promise<void>((resolve) => {
      if (this.pc?.iceGatheringState === 'complete') { resolve(); return; }
      const check = () => { if (this.pc?.iceGatheringState === 'complete') resolve(); };
      this.pc!.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 5000);
    });

    this.socket.emit('create-room', this.pc.localDescription, (res: any) => {
      if (!res?.success) { this.cb.onError(res?.message || 'Server error'); return; }
      this.currentPIN = res.pin;
      this.cb.onPINReady(res.pin);

      this.socket.on('answer-ready', (data: any) => {
        if (data.pin === this.currentPIN) this._applyAnswer(data.answer);
      });
    });
  }

  private async _applyAnswer(answer: any) {
    try {
      await this.pc!.setRemoteDescription(new RTCSessionDescription(answer) as unknown as RTCSessionDescriptionInit);
    } catch (err: any) {
      this.cb.onError('Connection error: ' + err.message);
    }
  }

  private _setupDataChannel() {
    this.channel = this.pc!.createDataChannel('file');
    this.channel.binaryType = 'arraybuffer';

    this.channel.onopen  = () => this.cb.onConnected();
    this.channel.onclose = () => {};
    this.channel.onerror = () => this.cb.onError('Data channel error');

    this.channel.onmessage = (e: any) => {
      if (e.data === 'CANCEL')     { this.isCancelled = true; this.isTransferring = false; this.cb.onRemoteCancel(); }
      if (e.data === 'DISCONNECT') { this.cb.onRemoteDisconnect(); this.cleanup(false); }
    };
  }

  async sendFile(fileUri: string, fileName: string, fileSize: number) {
    if (!this.channel || this.channel.readyState !== 'open') {
      this.cb.onError('Not connected'); return;
    }
    this.isTransferring = true;
    this.isCancelled    = false;

    const metadata = { type: 'metadata', name: fileName, size: fileSize, mimeType: this._mimeFromName(fileName) };
    this.channel.send(JSON.stringify(metadata));

    // Read file in chunks using expo-file-system
    const FileSystem = require('expo-file-system');
    const base64Full = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
    const binary     = this._base64ToArrayBuffer(base64Full);

    let offset    = 0;
    const t0      = Date.now();

    const sendNext = () => {
      if (this.isCancelled) return;
      if (offset >= binary.byteLength) {
        this.channel.send('EOF');
        this.isTransferring = false;
        this.cb.onComplete();
        return;
      }
      if (this.channel.bufferedAmount > MAX_BUFFER) {
        setTimeout(sendNext, 50); return;
      }
      const chunk = binary.slice(offset, offset + CHUNK_SIZE);
      this.channel.send(chunk);
      offset += chunk.byteLength;

      const elapsed = (Date.now() - t0) / 1000;
      const speed   = elapsed > 0 ? (offset / 1024 / 1024) / elapsed : 0;
      const pct     = Math.round((offset / binary.byteLength) * 100);
      this.cb.onProgress(pct, speed, offset, binary.byteLength);

      setTimeout(sendNext, 0);
    };

    sendNext();
  }

  cancel() {
    this.isCancelled    = true;
    this.isTransferring = false;
    try { this.channel?.send('CANCEL'); } catch (_) {}
  }

  endConnection() {
    try { this.channel?.send('DISCONNECT'); } catch (_) {}
    setTimeout(() => this.cleanup(true), 300);
  }

  cleanup(removeListeners = true) {
    try { this.channel?.close(); } catch (_) {}
    try { (this.pc as any)?.close(); } catch (_) {}
    this.channel = null; this.pc = null; this.currentPIN = null;
    if (removeListeners) {
      this.socket.off('answer-ready');
      this.socket.off('ice-candidate');
    }
  }

  private _base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const buf    = new ArrayBuffer(binary.length);
    const view   = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return buf;
  }

  private _mimeFromName(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
      pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', gif: 'image/gif', mp4: 'video/mp4',
      mp3: 'audio/mpeg', zip: 'application/zip', txt: 'text/plain',
      doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return map[ext] || 'application/octet-stream';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVER
// ─────────────────────────────────────────────────────────────────────────────
export interface ReceiverCallbacks {
  onConnected:        ()                                                          => void;
  onProgress:         (pct: number, speed: number, rx: number, total: number)    => void;
  onComplete:         (fileName: string, data: ArrayBuffer)                      => void;
  onError:            (msg: string)                                              => void;
  onRemoteCancel:     ()                                                          => void;
  onRemoteDisconnect: ()                                                          => void;
}

export class SwyftReceiver {
  private pc:      RNRTCPeerConnection | null = null;
  private channel: any                        = null;
  private socket:  Socket;

  constructor(socket: Socket, private cb: ReceiverCallbacks) {
    this.socket = socket;
  }

  async connectWithPIN(pin: string) {
    this.cleanup(false);

    const iceServers = await fetchIceServers();
    this.pc = new RTCPeerConnection({ iceServers }) as unknown as RNRTCPeerConnection;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('ice-candidate', { pin, candidate: e.candidate });
    };

    this.socket.on('ice-candidate', async ({ candidate }: any) => {
      try { if (candidate && this.pc) await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (err) { console.warn('ICE error', err); }
    });

    this._setupDataChannel();

    this.socket.emit('join-room', pin, async (response: any) => {
      if (!response.success) { this.cb.onError(response.message); return; }

      
      await this.pc!.setRemoteDescription(response.offer as RTCSessionDescriptionInit);
      const answer = await this.pc!.createAnswer();
      await this.pc!.setLocalDescription(answer);

      // Wait for ICE gathering
      await new Promise<void>((resolve) => {
        if (this.pc?.iceGatheringState === 'complete') { resolve(); return; }
        const check = () => { if (this.pc?.iceGatheringState === 'complete') resolve(); };
        this.pc!.addEventListener('icegatheringstatechange', check);
        setTimeout(resolve, 5000);
      });

      this.socket.emit('send-answer', { pin, answer: this.pc!.localDescription }, (res: any) => {
        if (res.success) this.cb.onConnected();
        else this.cb.onError('Answer error: ' + res.message);
      });
    });
  }

  private _setupDataChannel() {
    this.pc!.ondatachannel = (event) => {
      this.channel = event.channel;
      this.channel.binaryType = 'arraybuffer';

      let meta:     any           = null;
      let expected  = 0;
      let received  = 0;
      let startTime = 0;
      let buffers:  ArrayBuffer[] = [];

      this.channel.onopen  = () => {};
      this.channel.onclose = () => {};

      this.channel.onmessage = async (e: any) => {
        // ── Text messages ──────────────────────────────────────
        if (typeof e.data === 'string') {
          if (e.data === 'DISCONNECT') { this.cb.onRemoteDisconnect(); this.cleanup(false); return; }
          if (e.data === 'CANCEL')     { this.cb.onRemoteCancel(); return; }
          if (e.data === 'EOF') {
            if (!meta) return;
            const total = buffers.reduce((s, b) => s + b.byteLength, 0);
            const out   = new Uint8Array(total);
            let pos = 0;
            for (const b of buffers) { out.set(new Uint8Array(b), pos); pos += b.byteLength; }
            this.cb.onComplete(meta.name, out.buffer);
            buffers = []; meta = null;
            return;
          }
          try {
            const data = JSON.parse(e.data);
            if (data.type === 'metadata') {
              meta      = data;
              expected  = data.size;
              received  = 0;
              startTime = Date.now();
              buffers   = [];
            }
          } catch (_) {}
          return;
        }

        // ── Binary chunk ───────────────────────────────────────
        buffers.push(e.data);
        received += e.data.byteLength;
        if (expected > 0) {
          const pct     = Math.round((received / expected) * 100);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed   = elapsed > 0 ? (received / 1024 / 1024) / elapsed : 0;
          this.cb.onProgress(pct, speed, received, expected);
        }
      };
    };
  }

  cancelReceive() {
    try { this.channel?.send('CANCEL'); } catch (_) {}
  }

  cleanup(removeListeners = true) {
    try { this.channel?.close(); } catch (_) {}
    try { (this.pc as any)?.close(); } catch (_) {}
    this.channel = null; this.pc = null;
    if (removeListeners) this.socket.off('ice-candidate');
  }
}