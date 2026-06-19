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
// STICKINESS FIX: was 8000ms — only 4 missed broadcasts (out of
// ANNOUNCE_INTERVAL_MS) before a still-connected peer silently vanished from
// the list. Multicast on Android/iOS routinely misses several beats in a row
// (screen-off throttling, WiFi power save, brief congestion), so peers
// flickered in and out every few seconds even while still on the network.
// 90s makes a peer "stick" once discovered — short dropouts no longer remove
// it — while still eventually clearing a peer that has genuinely left
// (closed the app / left the network), rather than keeping dead entries
// forever. Mirrored manually in desktop/local-server.js's PEER_EXPIRY, since
// that file is plain JS and doesn't import this module directly.
export const PEER_EXPIRY_MS       = 90000;
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
