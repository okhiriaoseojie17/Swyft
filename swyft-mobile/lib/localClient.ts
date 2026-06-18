/**
 * lib/localClient.ts  (MOBILE)
 *
 * Sends files to a Swyft peer (mobile or desktop) using HTTP REST.
 *
 * FIXES vs previous version:
 *  1. /prepare-upload now returns status:'pending' immediately — client must
 *     poll GET /transfer-status until 'accepted' or 'declined' before uploading
 *  2. File upload changed from BINARY_CONTENT uploadAsync → base64 fetch POST
 *  3. Timeout on prepare-upload reduced to 10s (it returns instantly now)
 *  4. BUGFIX: poll interval reduced 1000ms → 400ms so acceptance is detected
 *     in <0.5s instead of up to ~1s (removes part of the 20-30s lag)
 *  5. FIX: _uploadFileAsBase64 now sends file in 512 KB chunks instead of one
 *     giant body — prevents HTTP 413 on large/ZIP files. Each chunk is sent as
 *     a separate POST with X-Chunk-Index / X-Total-Chunks headers so the mobile
 *     server (localServer.ts) can reassemble them. onProgress fires per chunk so
 *     the progress bar advances smoothly during actual upload instead of stalling.
 */

import * as FileSystem from 'expo-file-system';
import {
  SWYFT_PORT,
  CONNECT_TIMEOUT_MS,
  PrepareUploadRequest,
  SwyftPeer,
  PROTOCOL_VERSION,
} from './protocol';

// 512 KB raw per chunk → ~700 KB base64 per HTTP request body.
// Well within expo-http-server's safe buffer limit on Android.
const CHUNK_BYTES = 512 * 1024;

export interface SendCallbacks {
  onProgress:  (fileId: string, sent: number, total: number) => void;
  onComplete:  (fileId: string) => void;
  onError:     (msg: string)    => void;
  onSessionId: (sessionId: string) => void;  // called as soon as sessionId is known
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

  async sendFiles(
    peer:  SwyftPeer,
    files: { uri: string; name: string; size: number; mimeType: string }[],
    cb:    SendCallbacks,
    cancelFlag?: { cancelled: boolean },
  ): Promise<void> {

    // 1. Build prepare-upload body
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

    // 2. POST /prepare-upload — returns immediately with status:'pending'
    let prepareData: any;
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res   = await fetch(`${peer.baseUrl}/prepare-upload`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(prepareBody),
        signal:  ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status === 403) throw new Error('Transfer declined by receiver');
      if (!res.ok)            throw new Error(`Prepare-upload failed: HTTP ${res.status}`);

      prepareData = await res.json();
    } catch (err: any) {
      throw new Error(`Cannot reach ${peer.alias} at ${peer.ip}: ${err.message}`);
    }

    const { sessionId, files: tokens, status } = prepareData;
    // Notify caller immediately so it can cancel if needed
    cb.onSessionId(sessionId);

    // 3. If pending, poll /transfer-status until accepted or declined (35s max)
    if (status === 'pending') {
      const deadline = Date.now() + 35000;
      let decided    = false;

      while (Date.now() < deadline) {
        if (cancelFlag?.cancelled) throw new Error('Cancelled by user');
        await new Promise(r => setTimeout(r, 400));  // was 1000ms

        try {
          const ctrl   = new AbortController();
          const t      = setTimeout(() => ctrl.abort(), 5000);
          const res    = await fetch(
            `${peer.baseUrl}/transfer-status?sessionId=${encodeURIComponent(sessionId)}`,
            { signal: ctrl.signal }
          );
          clearTimeout(t);
          const data   = await res.json();

          if (data.status === 'accepted') { decided = true; break; }
          if (data.status === 'declined') throw new Error('Transfer declined by receiver');
          // status === 'pending' — keep polling
        } catch (err: any) {
          if (err.message === 'Transfer declined by receiver') throw err;
          // network blip — keep polling
        }
      }

      if (!decided) throw new Error(`${peer.alias} did not respond in time`);
    }

    // 4. Upload each file in chunks
    for (const fileEntry of Object.values(fileMap)) {
      const localFile = files.find(f => f.name === fileEntry.fileName);
      if (!localFile) continue;

      const token = tokens[fileEntry.id];
      if (!token) continue;

      await this._uploadFileInChunks(
        peer.baseUrl,
        sessionId,
        fileEntry.id,
        token,
        localFile,
        cb,
        cancelFlag,
      );
    }
  }

  async cancelSession(peer: SwyftPeer, sessionId: string): Promise<void> {
    try {
      await fetch(`${peer.baseUrl}/cancel`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sessionId }),
      });
    } catch (_) {}
  }

  /**
   * Uploads a file in 512 KB base64 chunks.
   *
   * Why chunking? expo-http-server (and the React Native JS bridge) buffers the
   * entire request body before surfacing it. A single large body can exceed the
   * bridge's internal limit and causes the server to reply with HTTP 413 (body
   * too large) or silently drop the connection, producing the "Chunk 1/N failed:
   * HTTP 413" error seen with ZIP files and large attachments.
   *
   * Sending 512 KB slices keeps each individual POST body under ~700 KB base64,
   * which is well within the safe limit. The mobile server (localServer.ts) writes
   * each chunk to a temp file and reassembles them when the final chunk arrives.
   *
   * onProgress fires after every chunk so the progress bar advances in real-time
   * instead of jumping from 0% to 100% at the end.
   */
  private async _uploadFileInChunks(
    baseUrl:   string,
    sessionId: string,
    fileId:    string,
    token:     string,
    file:      { uri: string; name: string; size: number; mimeType: string },
    cb:        SendCallbacks,
    cancelFlag?: { cancelled: boolean },
  ): Promise<void> {
    try {
      cb.onProgress(fileId, 0, file.size);

      // Read the full file as base64 once — FileSystem.readAsStringAsync is the
      // only reliable way to get file contents in Expo (no streaming read API).
      const fullBase64 = await FileSystem.readAsStringAsync(file.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Split into 512 KB (raw) slices.
      // Each raw byte becomes 4/3 base64 chars, so the base64 chunk size is:
      //   ceil(512 * 1024 * 4 / 3) = 699 051 characters ≈ 683 KB per POST body.
      const b64ChunkSize = Math.ceil(CHUNK_BYTES * 4 / 3);
      const totalChunks  = Math.ceil(fullBase64.length / b64ChunkSize) || 1;

      for (let i = 0; i < totalChunks; i++) {
        if (cancelFlag?.cancelled) throw new Error('Cancelled by user');
        const chunk = fullBase64.slice(i * b64ChunkSize, (i + 1) * b64ChunkSize);

        const res = await fetch(
          `${baseUrl}/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}`,
          {
            method:  'POST',
            headers: {
              'Content-Type':   'text/plain',
              'X-File-Name':    encodeURIComponent(file.name),
              'X-Chunk-Index':  String(i),
              'X-Total-Chunks': String(totalChunks),
            },
            body: chunk,
          }
        );

        if (res.status < 200 || res.status >= 300) {
          const text = await res.text().catch(() => '');
          throw new Error(`Chunk ${i + 1}/${totalChunks} failed: HTTP ${res.status} ${text}`);
        }

        // Report real progress based on chunks delivered so far.
        // Use min() to never exceed file.size due to base64 overhead.
        const bytesSent = Math.min((i + 1) * CHUNK_BYTES, file.size);
        cb.onProgress(fileId, bytesSent, file.size);
      }

      // Final progress snap to 100%
      cb.onProgress(fileId, file.size, file.size);
      cb.onComplete(fileId);
    } catch (err: any) {
      cb.onError(`Upload error for ${file.name}: ${err.message}`);
      throw err;
    }
  }
}
