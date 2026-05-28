/**
 * shared/protocol.ts
 *
 * Single source of truth for all Swyft Local protocol constants.
 * Import this on BOTH mobile and desktop — never hardcode ports elsewhere.
 *
 * Based on the LocalSend protocol (LocalSend/protocol v1).
 * All platforms speak the same language:
 *   Discovery  → UDP multicast  224.0.0.167 : 53317
 *   Negotiate  → HTTP POST      /prepare-upload
 *   Transfer   → HTTP POST      /upload      (streaming)
 *   Cancel     → HTTP POST      /cancel
 *   Info       → HTTP GET       /info
 */

export const SWYFT_PORT          = 53317;          // ONE port, everywhere
export const MULTICAST_ADDR      = '224.0.0.167';  // LocalSend multicast group
export const MULTICAST_PORT      = SWYFT_PORT;
export const ANNOUNCE_INTERVAL_MS = 2000;
export const PEER_EXPIRY_MS       = 8000;          // generous — multicast can delay
export const PROTOCOL_VERSION     = '2.0';         // Swyft unified protocol version
export const CONNECT_TIMEOUT_MS   = 10000;

/** Shape of a UDP discovery announcement (broadcast + received). */
export interface SwyftAnnouncement {
  alias:       string;       // friendly device name
  version:     string;       // PROTOCOL_VERSION
  deviceModel: string;       // e.g. "iPhone 14", "HP EliteBook"
  deviceType:  DeviceType;
  fingerprint: string;       // stable UUID
  port:        number;       // always SWYFT_PORT
  protocol:    'http';
  download:    boolean;      // always true — we can receive
}

export type DeviceType = 'mobile' | 'desktop' | 'web' | 'headless' | 'server';

/** Shape stored in the peer map after discovery. */
export interface SwyftPeer extends SwyftAnnouncement {
  ip:       string;
  lastSeen: number;
  baseUrl:  string;   // http://<ip>:<port>
}

/** POST /prepare-upload  →  { sessionId } or error */
export interface PrepareUploadRequest {
  info: {
    alias:    string;
    version:  string;
    deviceModel: string;
    deviceType:  DeviceType;
    fingerprint: string;
    port:     number;
    protocol: 'http';
    download: boolean;
  };
  files: {
    [fileId: string]: {
      id:       string;
      fileName: string;
      size:     number;
      fileType: string;
      sha256?:  string;
      preview?: string;
    };
  };
}

export interface PrepareUploadResponse {
  sessionId: string;
  files: {
    [fileId: string]: string;   // fileId → token
  };
}

/** GET /info  →  SwyftAnnouncement */
export type InfoResponse = SwyftAnnouncement;
