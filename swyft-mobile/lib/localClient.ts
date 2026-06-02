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
 */

import * as FileSystem from 'expo-file-system';
import {
  SWYFT_PORT,
  CONNECT_TIMEOUT_MS,
  PrepareUploadRequest,
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

  async sendFiles(
    peer:  SwyftPeer,
    files: { uri: string; name: string; size: number; mimeType: string }[],
    cb:    SendCallbacks,
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

    // 3. If pending, poll /transfer-status until accepted or declined (35s max)
    if (status === 'pending') {
      const deadline = Date.now() + 35000;
      let decided    = false;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 400));  // BUGFIX: was 1000ms

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

    // 4. Upload each file as base64
    for (const fileEntry of Object.values(fileMap)) {
      const localFile = files.find(f => f.name === fileEntry.fileName);
      if (!localFile) continue;

      const token = tokens[fileEntry.id];
      if (!token) continue;

      await this._uploadFileAsBase64(
        peer.baseUrl,
        sessionId,
        fileEntry.id,
        token,
        localFile,
        cb,
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

  private async _uploadFileAsBase64(
    baseUrl:   string,
    sessionId: string,
    fileId:    string,
    token:     string,
    file:      { uri: string; name: string; size: number; mimeType: string },
    cb:        SendCallbacks,
  ): Promise<void> {
    try {
      cb.onProgress(fileId, 0, file.size);

      const base64 = await FileSystem.readAsStringAsync(file.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const res = await fetch(
        `${baseUrl}/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}`,
        {
          method:  'POST',
          headers: {
            'Content-Type': 'text/plain',
            'X-File-Name':  encodeURIComponent(file.name),
          },
          body: base64,
        }
      );

      if (res.status < 200 || res.status >= 300) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upload failed: HTTP ${res.status} ${text}`);
      }

      cb.onProgress(fileId, file.size, file.size);
      cb.onComplete(fileId);
    } catch (err: any) {
      cb.onError(`Upload error for ${file.name}: ${err.message}`);
      throw err;
    }
  }
}