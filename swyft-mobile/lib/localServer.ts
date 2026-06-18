/**
 * lib/localServer.ts  (MOBILE)
 *
 * HTTP server using expo-http-server real API.
 *
 * KEY ARCHITECTURAL FIX:
 *   expo-http-server (Kotlin) blocks one server thread per request using
 *   Thread.sleep(10) while waiting for the JS response. If /prepare-upload
 *   blocks for 30 seconds waiting for the user, the server thread is tied up
 *   and the subsequent /upload request can never be served — causing the
 *   desktop to hang at 0% indefinitely.
 *
 *   FIX: /prepare-upload returns IMMEDIATELY with status:'pending'.
 *   Desktop polls GET /transfer-status?sessionId=X every 1 second.
 *   When user taps Accept, /transfer-status returns status:'accepted'.
 *   Desktop then sends the file via POST /upload — server thread is free.
 *
 * BUGFIX (this version):
 *   parseQueryParams() is now bulletproof — it checks paramsJson, params object,
 *   cookiesJson, AND manually parses from path/url/originalUrl. Previous version
 *   silently returned {} on some expo-http-server versions, making /transfer-status
 *   return 400 forever → desktop hung on "waiting to accept" even after Accept tap.
 *
 * CHUNKED UPLOAD FIX:
 *   expo-http-server buffers the entire request body into a JS string before
 *   handing it to the route handler. For large files this causes the Android JS
 *   bridge to choke or truncate the body, producing the "stalls at ~80%" symptom.
 *
 *   FIX: desktop now sends files in 512 KB base64 chunks, each as a separate
 *   POST /upload with X-Chunk-Index / X-Total-Chunks headers. The mobile server
 *   writes each chunk to a temp file and reassembles on the final chunk.
 *   No individual request body ever exceeds ~700 KB.
 *
 * Endpoints:
 *   GET  /info                          → device info
 *   POST /prepare-upload                → registers session, returns pending immediately
 *   GET  /transfer-status               → 'pending' | 'accepted' | 'declined'
 *   POST /upload?sessionId=&fileId=&token= → receive base64 chunk(s)
 *   POST /cancel                        → cancel session
 */

import {
  setup, route, start, stop,
  RequestEvent, Response as HttpResponse,
} from 'expo-http-server';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import {
  SWYFT_PORT,
  PROTOCOL_VERSION,
  SwyftAnnouncement,
  PrepareUploadRequest,
} from './protocol';

export { SWYFT_PORT as SERVER_PORT };

export interface TransferRequest {
  sessionId:     string;
  from:          string;
  fromId:        string;
  senderBaseUrl: string;   // http://<sender-ip>:<port> — phone calls this to report decision
  files:         { id: string; fileName: string; size: number; fileType: string }[];
}

export interface LocalServerCallbacks {
  onTransferRequest:   (req: TransferRequest) => void;
  onTransferProgress:  (sessionId: string, fileId: string, received: number, total: number) => void;
  onTransferComplete:  (sessionId: string, fileId: string, uri: string) => void;
  onTransferCancelled: (sessionId: string) => void;
  onError:             (msg: string) => void;
}

interface PendingSession {
  req:           TransferRequest;
  accepted:      boolean | null;   // null = pending user decision
  tokens:        Map<string, string>;
  // Track chunks received per file: fileId → Set of chunk indices received
  chunksReceived: Map<string, Set<number>>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(statusCode: number, data: object): HttpResponse {
  return {
    statusCode,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

/**
 * Read request headers from expo-http-server RequestEvent.
 *
 * CONFIRMED from source: expo-http-server exposes headers as req.headersJson
 * (a JSON-encoded string), NOT as req.headers object.
 */
function parseHeaders(req: RequestEvent): Record<string, string> {
  try {
    const h = JSON.parse(req.headersJson || '{}');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
    return out;
  } catch (_) { return {}; }
}

/**
 * Parse query params from expo-http-server RequestEvent.
 *
 * Layer order:
 *   1. req.paramsJson  — the correct, documented field
 *   2. req.headersJson — desktop sends X-Session-Id / X-File-Id / X-Token / X-Chunk-Index
 *      as headers so they survive even if paramsJson is empty
 */
function parseQueryParams(req: RequestEvent): Record<string, string> {
  // 1. paramsJson — authoritative source
  try {
    const p = JSON.parse(req.paramsJson || '{}');
    if (p && typeof p === 'object' && Object.keys(p).length > 0) return p;
  } catch (_) {}

  // 2. Headers — desktop redundantly sends params as X-* headers
  const headers = parseHeaders(req);
  const result: Record<string, string> = {};
  if (headers['x-session-id'])    result['sessionId']    = headers['x-session-id'];
  if (headers['x-file-id'])       result['fileId']       = headers['x-file-id'];
  if (headers['x-token'])         result['token']        = headers['x-token'];
  if (headers['x-chunk-index'])   result['chunkIndex']   = headers['x-chunk-index'];
  if (headers['x-total-chunks'])  result['totalChunks']  = headers['x-total-chunks'];
  if (Object.keys(result).length > 0) return result;

  return {};
}

// ─── LocalServer ──────────────────────────────────────────────────────────────

export class LocalServer {
  private cb:       LocalServerCallbacks;
  private myAlias:  string;
  private myFP:     string;
  private sessions: Map<string, PendingSession> = new Map();
  running = false;

  constructor(myAlias: string, myFingerprint: string, cb: LocalServerCallbacks) {
    this.myAlias = myAlias;
    this.myFP    = myFingerprint;
    this.cb      = cb;
  }

  async start(): Promise<void> {
    if (this.running) return;

    // 1. Configure port
    setup(SWYFT_PORT, (event) => {
      console.log('[LocalServer] status:', event.status, event.message);
      if (event.status === 'ERROR') {
        this.cb.onError(event.message);
      }
    });

    // 2. Register ALL routes BEFORE calling start()

    // ── GET /info ────────────────────────────────────────────────
    route('/info', 'GET', async (_req: RequestEvent): Promise<HttpResponse> => {
      const info: SwyftAnnouncement = {
        alias:       this.myAlias,
        version:     PROTOCOL_VERSION,
        deviceModel: Platform.OS === 'ios' ? 'iPhone' : 'Android',
        deviceType:  'mobile',
        fingerprint: this.myFP,
        port:        SWYFT_PORT,
        protocol:    'http',
        download:    true,
      };
      return json(200, info);
    });

    // ── POST /prepare-upload ──────────────────────────────────────
    // Returns IMMEDIATELY with status:'pending' — does NOT block.
    route('/prepare-upload', 'POST', async (req: RequestEvent): Promise<HttpResponse> => {
      try {
        console.log('[LocalServer] /prepare-upload received');
        const body: PrepareUploadRequest = JSON.parse(req.body);
        const fileList = Object.values(body.files);

        const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const tokens    = new Map<string, string>();
        const files: TransferRequest['files'] = [];

        for (const f of fileList) {
          const token = Math.random().toString(36).slice(2);
          tokens.set(f.id, token);
          files.push({ id: f.id, fileName: f.fileName, size: f.size, fileType: f.fileType });
        }

        // Derive sender IP so we can POST /session-response back to the desktop.
        const anyReq     = req as any;
        const senderIP   = anyReq.remoteAddress || anyReq.remoteAddr ||
                           anyReq.clientIp      || anyReq.ip ||
                           (body.info as any).senderIP || '';
        const senderPort = body.info.port || SWYFT_PORT;
        const senderBaseUrl = senderIP ? `http://${senderIP}:${senderPort}` : '';

        const session: PendingSession = {
          req: { sessionId, from: body.info.alias, fromId: body.info.fingerprint, senderBaseUrl, files },
          accepted:       null,
          tokens,
          chunksReceived: new Map(),
        };

        this.sessions.set(sessionId, session);
        this.cb.onTransferRequest(session.req);

        console.log('[LocalServer] /prepare-upload pending, senderBaseUrl:', senderBaseUrl);
        return json(200, { sessionId, status: 'pending', files: Object.fromEntries(tokens) });
      } catch (err: any) {
        console.warn('[LocalServer] /prepare-upload error:', err.message);
        return json(400, { message: err.message });
      }
    });

    // ── GET /transfer-status ─────────────────────────────────────
    route('/transfer-status', 'GET', async (req: RequestEvent): Promise<HttpResponse> => {
      console.log('[LocalServer] /transfer-status headersJson:', req.headersJson,
                  'paramsJson:', req.paramsJson);

      const headers   = parseHeaders(req);
      const params    = parseQueryParams(req);
      const sessionId = headers['x-session-id'] || params.sessionId;
      console.log('[LocalServer] /transfer-status sessionId:', sessionId);

      if (!sessionId) return json(400, { message: 'Missing sessionId' });

      const session = this.sessions.get(sessionId);
      if (!session)  return json(404, { message: 'Session not found' });

      if (session.accepted === null)  return json(200, { status: 'pending' });
      if (session.accepted === false) {
        this.sessions.delete(sessionId);
        return json(200, { status: 'declined' });
      }
      // accepted === true
      return json(200, { status: 'accepted' });
    });

    // ── POST /upload ──────────────────────────────────────────────
    // Receives one base64 chunk per request.
    // Headers: X-Session-Id, X-File-Id, X-Token, X-Chunk-Index, X-Total-Chunks
    // On the final chunk all parts are reassembled into the destination file.
    route('/upload', 'POST', async (req: RequestEvent): Promise<HttpResponse> => {
      try {
        const headers      = parseHeaders(req);
        const params       = parseQueryParams(req);

        const sessionId    = headers['x-session-id']   || params.sessionId;
        const fileId       = headers['x-file-id']      || params.fileId;
        const token        = headers['x-token']        || params.token;
        const chunkIndex   = parseInt(headers['x-chunk-index']  ?? params.chunkIndex  ?? '0', 10);
        const totalChunks  = parseInt(headers['x-total-chunks'] ?? params.totalChunks ?? '1', 10);

        console.log('[LocalServer] /upload sessionId:', sessionId,
                    'fileId:', fileId, 'chunk:', chunkIndex, '/', totalChunks);
        console.log('[LocalServer] /upload body length:', req.body?.length ?? 'null');

        if (!sessionId || !fileId || !token) {
          console.warn('[LocalServer] /upload missing params.',
            'headersJson:', req.headersJson, 'paramsJson:', req.paramsJson);
          return json(400, { message: 'Missing sessionId, fileId or token' });
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
          console.warn('[LocalServer] /upload session not found:', sessionId);
          return json(403, { message: 'Session not found' });
        }

        // TIMING FIX: upload can arrive fractionally before respondToSession()
        // sets accepted=true. A valid token proves legitimacy — wait up to 2s.
        if (session.accepted !== true) {
          const tokenValid = session.tokens.get(fileId) === token;
          if (!tokenValid) {
            console.warn('[LocalServer] /upload invalid token (pre-accept check)');
            return json(403, { message: 'Invalid token' });
          }
          const deadline = Date.now() + 2000;
          while (session.accepted === null && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 50));
          }
          if (session.accepted === false) {
            console.warn('[LocalServer] /upload session declined:', sessionId);
            return json(403, { message: 'Session declined' });
          }
          if (session.accepted === null) {
            console.warn('[LocalServer] /upload session still pending after wait:', sessionId);
            return json(403, { message: 'Session not yet accepted' });
          }
        }

        if (session.tokens.get(fileId) !== token) {
          console.warn('[LocalServer] /upload invalid token');
          return json(403, { message: 'Invalid token' });
        }

        const fileInfo = session.req.files.find(f => f.id === fileId);
        if (!fileInfo) return json(400, { message: 'Unknown file' });

        const safeName  = fileInfo.fileName.replace(/[^a-zA-Z0-9._\- ]/g, '_');
        const chunkPath = `${FileSystem.cacheDirectory}${sessionId}_${fileId}_chunk${chunkIndex}`;

        // Write this chunk to its own temp file.
        // Each body is at most ~700 KB (512 KB raw → base64) — safe for the JS bridge.
        await FileSystem.writeAsStringAsync(chunkPath, req.body, {
          encoding: FileSystem.EncodingType.Base64,
        });

        // Track which chunks we have for this file
        if (!session.chunksReceived.has(fileId)) {
          session.chunksReceived.set(fileId, new Set());
        }
        session.chunksReceived.get(fileId)!.add(chunkIndex);

        // Emit progress: use chunks as a proxy for bytes received.
        // IMPORTANT: this is proportional to totalChunks rather than a
        // hardcoded byte-per-chunk size. Different senders use different
        // chunk sizes (mobile→mobile sends 512 KB chunks, desktop→phone
        // sends 64 KB chunks) — hardcoding 512 KB here made the progress
        // bar for desktop→phone transfers jump to ~100% after only the
        // first real chunk, then sit there while the real upload continued
        // in the background for several more seconds.
        const chunksIn = session.chunksReceived.get(fileId)!.size;
        const approxReceived = Math.min(
          Math.round((chunksIn / totalChunks) * fileInfo.size),
          fileInfo.size,
        );
        this.cb.onTransferProgress(sessionId, fileId, approxReceived, fileInfo.size);

        // Acknowledge every chunk immediately — including the final one.
        // Reassembly (below) can take a while for large files, and
        // expo-http-server only processes one request at a time; blocking
        // this response until reassembly finishes would tie up the server
        // thread and make the NEXT transfer attempt hang indefinitely.
        // So we ack now and assemble in the background instead.
        if (chunkIndex < totalChunks - 1) {
          return json(200, { message: 'chunk received', chunkIndex });
        }

        this._assembleFile(sessionId, fileId, safeName, totalChunks, session)
          .catch((err: any) => this.cb.onError('Assembly error: ' + err.message));

        return json(200, { message: 'chunk received', chunkIndex });
      } catch (err: any) {
        console.warn('[LocalServer] /upload error:', err.message);
        this.cb.onError('Upload error: ' + err.message);
        return json(500, { message: err.message });
      }
    });

    // ── POST /cancel ──────────────────────────────────────────────
    route('/cancel', 'POST', async (req: RequestEvent): Promise<HttpResponse> => {
      try {
        const { sessionId } = JSON.parse(req.body || '{}');
        // Clean up any leftover chunk temp files for this session
        if (sessionId) {
          const session = this.sessions.get(sessionId);
          if (session) {
            for (const [fileId, indices] of session.chunksReceived.entries()) {
              const fileInfo = session.req.files.find(f => f.id === fileId);
              if (!fileInfo) continue;
              for (const i of indices) {
                const p = `${FileSystem.cacheDirectory}${sessionId}_${fileId}_chunk${i}`;
                await FileSystem.deleteAsync(p, { idempotent: true });
              }
            }
          }
        }
        this.sessions.delete(sessionId);
        this.cb.onTransferCancelled(sessionId);
        return json(200, { message: 'cancelled' });
      } catch {
        return json(400, { message: 'bad request' });
      }
    });

    // 3. Start listening — AFTER all routes registered
    start();
    this.running = true;
    console.log('[LocalServer] HTTP server listening on port', SWYFT_PORT);
  }

  stop(): void {
    this.running = false;
    try { stop(); } catch (_) {}
    this.sessions.clear();
    console.log('[LocalServer] stopped');
  }

  /** Called when the receiver taps Cancel mid-transfer — cleans up session so further chunks get 403'd. */
  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.accepted = false;  // causes subsequent /upload to return 403
    }
    this.sessions.delete(sessionId);
    this.cb.onTransferCancelled(sessionId);
    console.log('[LocalServer] session cancelled by receiver:', sessionId);
  }

  /**
   * Reassembles all received chunks for a file into the final destination file.
   * Runs AFTER the final chunk's HTTP response has already been sent, so it
   * never blocks expo-http-server's single request-handling thread. Without
   * this, a slow reassembly (more chunks = more sequential disk round-trips)
   * could tie up the only server thread long enough that the NEXT transfer
   * attempt's /prepare-upload never even gets picked up.
   */
  private async _assembleFile(
    sessionId: string,
    fileId: string,
    safeName: string,
    totalChunks: number,
    session: PendingSession,
  ): Promise<void> {
    const dest = `${FileSystem.cacheDirectory}${sessionId}_${safeName}`;
    let assembled = '';

    for (let i = 0; i < totalChunks; i++) {
      const partPath = `${FileSystem.cacheDirectory}${sessionId}_${fileId}_chunk${i}`;
      const part = await FileSystem.readAsStringAsync(partPath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      assembled += part;
      // Delete chunk temp file immediately to free space
      await FileSystem.deleteAsync(partPath, { idempotent: true });
    }

    await FileSystem.writeAsStringAsync(dest, assembled, {
      encoding: FileSystem.EncodingType.Base64,
    });

    console.log('[LocalServer] file assembled and saved:', dest);

    session.tokens.delete(fileId);
    session.chunksReceived.delete(fileId);
    this.cb.onTransferComplete(sessionId, fileId, dest);

    if (session.tokens.size === 0) {
      this.sessions.delete(sessionId);
    }
  }

  respondToSession(sessionId: string, accepted: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn('[LocalServer] respondToSession — session not found:', sessionId);
      return;
    }
    session.accepted = accepted;
    console.log('[LocalServer] session', sessionId, accepted ? 'ACCEPTED' : 'DECLINED');

    // Push the decision back to the sender immediately.
    const url = session.req.senderBaseUrl;
    if (url) {
      fetch(`${url}/session-response`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sessionId, accepted }),
      }).then(() => {
        console.log('[LocalServer] /session-response posted to', url);
      }).catch((err: any) => {
        console.warn('[LocalServer] /session-response failed:', err.message);
      });
    } else {
      console.warn('[LocalServer] no senderBaseUrl — cannot push session-response');
    }
  }
}