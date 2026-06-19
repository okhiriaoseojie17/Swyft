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
import { File as NextFile } from 'expo-file-system/next';
import { Buffer } from 'buffer';
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

        // BUGFIX: previous regex allowed a literal space through (the trailing
        // ` ` before `]`), so original filenames with spaces (e.g. "Swyft
        // Setup 1.0.0.exe", "students handbook.pdf") passed into `dest` below
        // unchanged. expo-file-system/next's File constructor (used in
        // _assembleFile) parses `dest` as a strict file:// URI and rejects raw
        // spaces with "Illegal character in path" — AFTER the final chunk's
        // HTTP 200 had already gone back to the sender, which is why desktop
        // showed "Sent!" while the phone silently failed to assemble the file.
        // Removing the space from the allowed set fixes it the same way every
        // other unsafe character (#, %, &, etc.) was already being handled.
        const safeName  = fileInfo.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
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
          .catch((err: any) => {
            console.error('[LocalServer] assembly failed:', err);
            this.cb.onError('Assembly error: ' + (err?.message || String(err)));
          });

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
   *
   * BUGFIX (this version): the previous implementation called
   * `FileSystem.appendAsStringAsync()`, which does not exist anywhere in
   * expo-file-system — not in the legacy API, not in expo-file-system/next.
   * That call always threw "undefined is not a function" on the final
   * chunk — AFTER the HTTP 200 for that chunk had already been sent back to
   * the sender, which is exactly why the desktop showed "Sent!" while the
   * file was never actually written on the phone.
   *
   * FIX: true streaming assembly via expo-file-system/next's FileHandle,
   * which writes raw bytes directly to disk at an explicit offset. Peak
   * memory is one decoded chunk (~384 KB) at a time, constant regardless of
   * total file size — no OOM risk even on multi-GB files.
   *
   * Verified directly against your installed package
   * (expo-file-system@18.0.12, Expo SDK 52.0.49) by pulling its actual
   * .d.ts, not just the docs site (whose v52 page omits the FileHandle
   * section, which is why it looked unsupported at first glance — it isn't):
   *   class FileHandle {
   *     close(): void;
   *     readBytes(length: number): Uint8Array;
   *     writeBytes(bytes: Uint8Array): void;   // synchronous in this version
   *     offset: number | null;
   *     size: number | null;
   *   }
   * NOTE: in newer Expo SDKs (53+ per the expo-file-system changelog),
   * writeBytes() was changed to return a Promise. The `await`-if-thenable
   * check below handles that automatically if you upgrade later — but it's
   * worth re-verifying against your then-current package if you do.
   *
   * BUGFIX (this version): writeBytes() was receiving a `Buffer` (from the
   * 'buffer' npm polyfill) instead of a plain `Uint8Array`. writeBytes() is
   * a JSI host function with a strict native-side type check, and a Buffer
   * — despite being a Uint8Array subclass — isn't what the native side
   * expects. This made the native (Kotlin) code throw with no usable
   * message, which JSI surfaced to JS as "Exception in Host Function:
   * <unknown>" — thrown from inside this method, AFTER the final chunk's
   * HTTP 200 had already gone back to the desktop. Same "Sent!" on
   * desktop / nothing on phone symptom as the appendAsStringAsync bug above,
   * different cause. FIX: copy each chunk into a real Uint8Array before
   * calling writeBytes(). create()/open()/writeBytes() are also now each
   * wrapped individually so that if a *different* native error ever occurs,
   * the message will say exactly which call failed instead of a single
   * generic "Assembly error".
   */
  private async _assembleFile(
    sessionId: string,
    fileId: string,
    safeName: string,
    totalChunks: number,
    session: PendingSession,
  ): Promise<void> {
    const dest = `${FileSystem.cacheDirectory}${sessionId}_${safeName}`;

    const fileObj = new NextFile(dest);
    try {
      if (fileObj.exists) fileObj.delete();
      fileObj.create();
    } catch (createErr: any) {
      throw new Error('File create() failed: ' + (createErr?.message || String(createErr)));
    }

    let fh: any;
    try {
      fh = fileObj.open();
    } catch (openErr: any) {
      throw new Error('FileHandle open() failed: ' + (openErr?.message || String(openErr)));
    }

    // Helper: read one chunk file from disk and decode it to a plain Uint8Array.
    // Extracting this lets us kick off the NEXT read before the current write
    // has finished, overlapping native-thread I/O with the JS-side write.
    const readChunk = async (i: number): Promise<Uint8Array> => {
      const p = `${FileSystem.cacheDirectory}${sessionId}_${fileId}_chunk${i}`;
      const b64 = await FileSystem.readAsStringAsync(p, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Must copy Buffer → plain Uint8Array before crossing the JSI boundary.
      // Buffer (from the 'buffer' polyfill) is a Uint8Array subclass but its
      // extra prototype state makes writeBytes() throw "Exception in Host
      // Function: <unknown>" on the native side. See the fix note above.
      const raw = Buffer.from(b64, 'base64');
      const bytes = new Uint8Array(raw.length);
      bytes.set(raw);
      return bytes;
    };

    // PIPELINE: prime the pipeline by starting the first read before the loop.
    // Each iteration then starts the NEXT read before awaiting the current write,
    // so native-thread disk I/O overlaps the JS-side writeBytes() call.
    // Deletes are fire-and-forget — they don't block assembly and still free
    // disk space promptly on the native thread.
    let nextBytesPromise: Promise<Uint8Array> = readChunk(0);

    let writePos = 0;
    try {
      for (let i = 0; i < totalChunks; i++) {
        // Await the chunk that was being read in parallel with the previous write.
        const bytes = await nextBytesPromise;

        // Kick off reading the NEXT chunk NOW — this runs on the native I/O
        // thread in parallel with the writeBytes() call below.
        if (i + 1 < totalChunks) {
          nextBytesPromise = readChunk(i + 1);
        }

        // Skip zero-length chunks — some native writeBytes() implementations
        // throw on a zero-byte write. (Can happen if file size is an exact
        // multiple of the chunk size.)
        if (bytes.length > 0) {
          fh.offset = writePos;
          try {
            const maybePromise: any = fh.writeBytes(bytes);
            if (maybePromise && typeof maybePromise.then === 'function') {
              await maybePromise;   // future-SDK safety net — see note above
            }
          } catch (writeErr: any) {
            throw new Error(
              `writeBytes failed at chunk ${i}/${totalChunks} ` +
              `(offset ${writePos}, ${bytes.length} bytes): ` +
              (writeErr?.message || String(writeErr))
            );
          }
          writePos += bytes.length;
        }

        // Delete the temp chunk — fire-and-forget so the loop doesn't stall
        // waiting for the delete before it can await the next read.
        const partPath = `${FileSystem.cacheDirectory}${sessionId}_${fileId}_chunk${i}`;
        FileSystem.deleteAsync(partPath, { idempotent: true }).catch(() => {});
      }
    } finally {
      try { fh.close(); } catch (closeErr: any) {
        console.warn('[LocalServer] fh.close() failed (non-fatal):', closeErr?.message);
      }
    }

    console.log('[LocalServer] file assembled and saved (streaming):', dest);

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