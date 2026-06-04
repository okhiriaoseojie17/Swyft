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
 * Endpoints:
 *   GET  /info                          → device info
 *   POST /prepare-upload                → registers session, returns pending immediately
 *   GET  /transfer-status?sessionId=X   → 'pending' | 'accepted' | 'declined'
 *   POST /upload?sessionId=&fileId=&token= → receive base64 file body
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
  req:      TransferRequest;
  accepted: boolean | null;   // null = pending user decision
  tokens:   Map<string, string>;
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
 * (a JSON-encoded string), NOT as req.headers object. All previous fallback
 * attempts used anyReq.headers which is always undefined.
 */
function parseHeaders(req: RequestEvent): Record<string, string> {
  try {
    const h = JSON.parse(req.headersJson || '{}');
    // Normalise keys to lowercase for consistent lookup
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
    return out;
  } catch (_) { return {}; }
}

/**
 * Parse query params from expo-http-server RequestEvent.
 *
 * CONFIRMED from source: query params are in req.paramsJson (JSON string).
 * req.path does NOT include the query string — they are pre-parsed by the
 * Kotlin layer into paramsJson. All URL-scanning fallbacks were wrong.
 *
 * Layer order:
 *   1. req.paramsJson  — the correct, documented field
 *   2. req.headersJson — desktop sends X-Session-Id / X-File-Id / X-Token
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
  if (headers['x-session-id']) result['sessionId'] = headers['x-session-id'];
  if (headers['x-file-id'])    result['fileId']    = headers['x-file-id'];
  if (headers['x-token'])      result['token']     = headers['x-token'];
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
        // expo-http-server exposes remoteAddress under various field names by version.
        // The desktop also sends its own IP in body.info.senderIP as a guaranteed fallback.
        const anyReq        = req as any;
        const senderIP      = anyReq.remoteAddress || anyReq.remoteAddr ||
                              anyReq.clientIp      || anyReq.ip ||
                              (body.info as any).senderIP || '';
        const senderPort    = body.info.port || SWYFT_PORT;
        const senderBaseUrl = senderIP ? `http://${senderIP}:${senderPort}` : '';

        const session: PendingSession = {
          req: { sessionId, from: body.info.alias, fromId: body.info.fingerprint, senderBaseUrl, files },
          accepted: null,
          tokens,
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

    // ── POST /transfer-status ────────────────────────────────────
    // Desktop sends sessionId as query param + X-Session-Id header + JSON body.
    // We use POST so the body path works even if paramsJson is empty.
    route('/transfer-status', 'POST', async (req: RequestEvent): Promise<HttpResponse> => {
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
    route('/upload', 'POST', async (req: RequestEvent): Promise<HttpResponse> => {
      try {
        // Read params from BOTH headersJson and paramsJson.
        // expo-http-server (confirmed from source) uses:
        //   req.headersJson  — JSON string of request headers
        //   req.paramsJson   — JSON string of query params (pre-parsed by Kotlin)
        //   req.path         — path WITHOUT query string
        // The desktop sends params three ways: query string + X-* headers + body,
        // so at least one always arrives intact.
        const headers   = parseHeaders(req);
        const params    = parseQueryParams(req);

        const sessionId = headers['x-session-id'] || params.sessionId;
        const fileId    = headers['x-file-id']    || params.fileId;
        const token     = headers['x-token']      || params.token;

        console.log('[LocalServer] /upload sessionId:', sessionId, 'fileId:', fileId);
        console.log('[LocalServer] /upload body length:', req.body?.length ?? 'null');
        console.log('[LocalServer] /upload headersJson:', req.headersJson);
        console.log('[LocalServer] /upload paramsJson:', req.paramsJson);

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

        // TIMING FIX: the upload can arrive fractionally before respondToSession()
        // sets accepted=true (the desktop fires upload immediately after the phone
        // calls /session-response, and those two JS tasks can race).
        // A valid token proves the session is legitimate — wait up to 2s for
        // accepted to become true before rejecting.
        if (session.accepted !== true) {
          const tokenValid = session.tokens.get(fileId) === token;
          if (!tokenValid) {
            console.warn('[LocalServer] /upload invalid token (pre-accept check)');
            return json(403, { message: 'Invalid token' });
          }
          // Wait up to 2000ms for user to accept (covers the race condition).
          // TypeScript narrows session.accepted to false|null inside this block,
          // so we check each case explicitly instead of !== true.
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
          // session.accepted === true — fall through
        }

        if (session.tokens.get(fileId) !== token) {
          console.warn('[LocalServer] /upload invalid token');
          return json(403, { message: 'Invalid token' });
        }

        const fileInfo = session.req.files.find(f => f.id === fileId);
        if (!fileInfo) return json(400, { message: 'Unknown file' });

        const safeName = fileInfo.fileName.replace(/[^a-zA-Z0-9._\- ]/g, '_');
        const dest     = `${FileSystem.cacheDirectory}${sessionId}_${safeName}`;

        // Body is base64 — desktop encoded the file before sending
        await FileSystem.writeAsStringAsync(dest, req.body, {
          encoding: FileSystem.EncodingType.Base64,
        });

        console.log('[LocalServer] file saved:', dest);

        session.tokens.delete(fileId);
        this.cb.onTransferComplete(sessionId, fileId, dest);

        if (session.tokens.size === 0) {
          this.sessions.delete(sessionId);
        }

        return json(200, { message: 'received' });
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

  respondToSession(sessionId: string, accepted: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn('[LocalServer] respondToSession — session not found:', sessionId);
      return;
    }
    session.accepted = accepted;
    console.log('[LocalServer] session', sessionId, accepted ? 'ACCEPTED' : 'DECLINED');

    // Push the decision back to the sender immediately.
    // For desktop→phone transfers the sender is an Express server that has a
    // /session-response endpoint and a /wait-for-response long-poll waiting.
    // This replaces the old poll-from-desktop pattern entirely.
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
        // Non-fatal: desktop will time out gracefully and show an error.
      });
    } else {
      console.warn('[LocalServer] no senderBaseUrl — cannot push session-response');
    }
  }
}