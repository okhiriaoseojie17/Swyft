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

// 384 KB raw per chunk → exactly 512 KB base64 per HTTP request body.
//
// TWO reasons this value matters:
//   1. Divisible by 3: 384 * 1024 = 393 216 = 131 072 × 3. When a positional
//      read of exactly 393 216 bytes is base64-encoded independently, the result
//      is 524 288 chars with NO trailing '=' padding. The receiver concatenates
//      per-chunk base64 strings to rebuild the file; any intermediate '='
//      causes Android's base64 decoder to stop there and silently truncate the
//      file. Only the final (possibly shorter) chunk may legitimately end with '='.
//   2. Body size: 512 KB base64 per POST stays well within expo-http-server's
//      safe buffer limit on Android (previous 512 KB raw → 683 KB base64 was
//      borderline; 384 KB raw → 512 KB base64 is comfortably under it).
const CHUNK_BYTES = 384 * 1024;   // 393 216 — must remain divisible by 3

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
   * Uploads a file to a peer in 384 KB base64 chunks using positional reads.
   *
   * ── Why positional reads? ────────────────────────────────────────────────────
   * The old code called readAsStringAsync(file.uri, {encoding:'base64'}) once,
   * loading the ENTIRE file into the JS heap as a base64 string before splitting.
   * A 124 MB file requires a ~167 MB string allocation → OOM on Android
   * (java.lang.OutOfMemoryError: Failed to allocate N bytes).
   *
   * readAsStringAsync supports optional { position, length } options that read
   * only a byte range from disk. Peak memory per iteration is one 512 KB base64
   * string (~384 KB raw), independent of total file size. This lets files of
   * any size — 5 GB, 50 GB — transfer without OOM.
   *
   * ── Why CHUNK_BYTES must be divisible by 3 ──────────────────────────────────
   * When a slice of N raw bytes is encoded to base64 independently, the result
   * has trailing '=' padding if N % 3 ≠ 0. The receiver concatenates each
   * chunk's re-encoded base64 to rebuild the file; any '=' in the MIDDLE of
   * that string causes Android's decoder to stop there and silently drop every
   * byte after it, corrupting the file. CHUNK_BYTES = 384 * 1024 = 393 216 = 131
   * 072 × 3, so every chunk except the last encodes with zero padding.
   *
   * ── Why 384 KB not 512 KB? ───────────────────────────────────────────────────
   * 384 KB raw → 512 KB base64. 512 KB raw → 683 KB base64, which is over
   * expo-http-server's safe body limit on some Android devices (causes HTTP 413).
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

      // Calculate total chunks from raw file size (not base64 length).
      const totalChunks = Math.ceil(file.size / CHUNK_BYTES) || 1;

      for (let i = 0; i < totalChunks; i++) {
        if (cancelFlag?.cancelled) throw new Error('Cancelled by user');

        const position = i * CHUNK_BYTES;
        const length   = Math.min(CHUNK_BYTES, file.size - position);

        // Read ONLY this slice from disk — never the whole file at once.
        // { position, length } is a byte range; the result is base64-encoded.
        const chunk = await FileSystem.readAsStringAsync(file.uri, {
          encoding: FileSystem.EncodingType.Base64,
          position,
          length,
        });

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

        const bytesSent = Math.min((i + 1) * CHUNK_BYTES, file.size);
        cb.onProgress(fileId, bytesSent, file.size);
      }

      cb.onProgress(fileId, file.size, file.size);
      cb.onComplete(fileId);
    } catch (err: any) {
      cb.onError(`Upload error for ${file.name}: ${err.message}`);
      throw err;
    }
  }
}
