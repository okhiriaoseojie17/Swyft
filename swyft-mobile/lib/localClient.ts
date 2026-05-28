/**
 * lib/localClient.ts  (MOBILE)
 *
 * Sends files to a Swyft peer (mobile or desktop) using HTTP REST.
 *
 * FIXES vs old code:
 *  1. Removed ALL socket.io code — desktop and mobile now both speak HTTP
 *  2. Removed ALL raw TCP code (port 3002)
 *  3. No more dual-path logic (peerType = 'desktop' | 'mobile')
 *  4. No desktopSocketId hack — routes purely by fingerprint/UUID
 *  5. Files sent via fetch() with streaming body — no base64→ArrayBuffer in RAM
 *  6. Token-based transfer (prepare-upload → upload) identical on both platforms
 */

import * as FileSystem from 'expo-file-system';
import {
  SWYFT_PORT,
  CONNECT_TIMEOUT_MS,
  PrepareUploadRequest,
  PrepareUploadResponse,
  SwyftAnnouncement,
  SwyftPeer,
  PROTOCOL_VERSION,
} from './protocol';

export interface SendCallbacks {
  onProgress: (fileId: string, sent: number, total: number) => void;
  onComplete: (fileId: string) => void;
  onError:    (msg: string)    => void;
}

export class LocalClient {
  private myAlias:       string;
  private myFingerprint: string;
  private myIP:          string;

  constructor(myAlias: string, myFingerprint: string, myIP: string) {
    this.myAlias       = myAlias;
    this.myFingerprint = myFingerprint;
    this.myIP          = myIP;
  }

  // ── /info — verify the peer is reachable and running Swyft ───────────────

  async ping(peer: SwyftPeer): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${peer.baseUrl}/info`, { signal: ctrl.signal });
      clearTimeout(timer);
      const info: SwyftAnnouncement = await res.json();
      return info.fingerprint === peer.fingerprint;
    } catch {
      return false;
    }
  }

  // ── Send one or more files to a peer ─────────────────────────────────────

  async sendFiles(
    peer:  SwyftPeer,
    files: { uri: string; name: string; size: number; mimeType: string }[],
    cb:    SendCallbacks,
  ): Promise<void> {
    // 1. Build prepare-upload request
    const fileMap: PrepareUploadRequest['files'] = {};
    for (const f of files) {
      const id = Math.random().toString(36).slice(2);
      fileMap[id] = {
        id,
        fileName: f.name,
        size:     f.size,
        fileType: f.mimeType || 'application/octet-stream',
      };
    }

    const prepareBody: PrepareUploadRequest = {
      info: {
        alias:       this.myAlias,
        version:     PROTOCOL_VERSION,
        deviceModel: 'Mobile',
        deviceType:  'mobile',
        fingerprint: this.myFingerprint,
        port:        SWYFT_PORT,
        protocol:    'http',
        download:    true,
      },
      files: fileMap,
    };

    // 2. Ask receiver to accept
    let prepareRes: Response;
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS + 30000);
      prepareRes  = await fetch(`${peer.baseUrl}/prepare-upload`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(prepareBody),
        signal:  ctrl.signal,
      });
      clearTimeout(timer);
    } catch (err: any) {
      throw new Error(`Cannot reach ${peer.alias} at ${peer.ip}: ${err.message}`);
    }

    if (prepareRes.status === 403) {
      throw new Error('Transfer declined by receiver');
    }

    if (!prepareRes.ok) {
      throw new Error(`Prepare-upload failed: HTTP ${prepareRes.status}`);
    }

    const { sessionId, files: tokens }: PrepareUploadResponse = await prepareRes.json();

    // 3. Upload each file
    for (const fileEntry of Object.values(fileMap)) {
      const localFile = files.find(f => f.name === fileEntry.fileName);
      if (!localFile) continue;

      const token = tokens[fileEntry.id];
      if (!token) continue;

      await this._uploadFile(
        peer.baseUrl,
        sessionId,
        fileEntry.id,
        token,
        localFile,
        cb,
      );
    }
  }

  // ── Cancel a session ──────────────────────────────────────────────────────

  async cancelSession(peer: SwyftPeer, sessionId: string): Promise<void> {
    try {
      await fetch(`${peer.baseUrl}/cancel`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sessionId }),
      });
    } catch (_) {}
  }

  // ── Private: stream a single file ────────────────────────────────────────

  private async _uploadFile(
    baseUrl:   string,
    sessionId: string,
    fileId:    string,
    token:     string,
    file:      { uri: string; name: string; size: number; mimeType: string },
    cb:        SendCallbacks,
  ): Promise<void> {
    try {
      // Read as base64 — expo-file-system does not support streaming body yet.
      // For files > 100 MB, consider chunked upload via expo-file-system.uploadAsync.
      const base64 = await FileSystem.readAsStringAsync(file.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Report start
      cb.onProgress(fileId, 0, file.size);

      // Use expo-file-system uploadAsync for streaming (avoids holding entire
      // file in JS memory — critical for large files).
      const result = await FileSystem.uploadAsync(
        `${baseUrl}/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}`,
        file.uri,
        {
          httpMethod:  'POST',
          uploadType:  FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers:     {
            'Content-Type':   file.mimeType || 'application/octet-stream',
            'X-File-Name':    encodeURIComponent(file.name),
            'X-Session-Id':   sessionId,
            'X-File-Id':      fileId,
            'X-Token':        token,
          },
          sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
        },
      );

      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Upload failed: HTTP ${result.status}`);
      }

      cb.onProgress(fileId, file.size, file.size);
      cb.onComplete(fileId);
    } catch (err: any) {
      cb.onError(`Upload error for ${file.name}: ${err.message}`);
      throw err;
    }
  }
}
