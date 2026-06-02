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
  sessionId: string;
  from:      string;
  fromId:    string;
  files:     { id: string; fileName: string; size: number; fileType: string }[];
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
 * Parse query params from expo-http-server RequestEvent.
 *
 * BULLETPROOF VERSION v2 — different expo-http-server versions expose query params
 * in DIFFERENT places. We try every known location in order:
 *   1. req.paramsJson      (string JSON)   — most versions
 *   2. req.params          (object)        — some forks
 *   3. req.cookiesJson     (string JSON)   — misrouted on a few versions
 *   4. manual parse from req.path / req.url / req.originalUrl
 *   5. request headers     (X-Session-Id etc.) — desktop sends these as fallback
 *   6. JSON request body   — desktop sends sessionId in body as last resort
 *
 * The desktop NOW sends sessionId as query param + X-Session-Id header + JSON body
 * so at least one of these paths is guaranteed to work regardless of expo-http-server version.
 */
function parseQueryParams(req: RequestEvent): Record<string, string> {
  const anyReq = req as any;

  // 1. paramsJson (string)
  try {
    const p = JSON.parse(req.paramsJson || '{}');
    if (p && typeof p === 'object' && Object.keys(p).length > 0) return p;
  } catch (_) {}

  // 2. params as a direct object (some forks)
  try {
    if (anyReq.params && typeof anyReq.params === 'object' && Object.keys(anyReq.params).length > 0) {
      return anyReq.params;
    }
  } catch (_) {}

  // 3. cookiesJson (misrouted on a few versions)
  try {
    const c = JSON.parse(req.cookiesJson || '{}');
    if (c && typeof c === 'object' && Object.keys(c).length > 0) return c;
  } catch (_) {}

  // 4. Manual parse from any available URL-ish field
  try {
    const candidates = [anyReq.path, anyReq.url, anyReq.originalUrl, anyReq.uri];
    for (const cand of candidates) {
      if (typeof cand !== 'string') continue;
      const qIdx = cand.indexOf('?');
      if (qIdx === -1) continue;
      const qs = cand.slice(qIdx + 1);
      const out = Object.fromEntries(
        qs.split('&').filter(Boolean).map(pair => {
          const eq = pair.indexOf('=');
          const k  = eq === -1 ? pair : pair.slice(0, eq);
          const v  = eq === -1 ? ''   : pair.slice(eq + 1);
          return [decodeURIComponent(k), decodeURIComponent(v)];
        })
      );
      if (Object.keys(out).length > 0) return out;
    }
  } catch (_) {}

  // 5. Request headers — desktop sends X-Session-Id as a redundant fallback.
  //    Build a partial params object from known header mappings.
  try {
    const headers: Record<string, string> = anyReq.headers || anyReq.requestHeaders || {};
    const result: Record<string, string> = {};
    const sid = headers['x-session-id'] || headers['X-Session-Id'];
    if (sid) result['sessionId'] = sid;
    const fid = headers['x-file-id'] || headers['X-File-Id'];
    if (fid) result['fileId'] = fid;
    const tok = headers['x-token'] || headers['X-Token'];
    if (tok) result['token'] = tok;
    if (Object.keys(result).length > 0) return result;
  } catch (_) {}

  // 6. JSON body — desktop sends { sessionId } in the POST body as a last resort.
  try {
    if (req.body && typeof req.body === 'string' && req.body.trim().startsWith('{')) {
      const parsed = JSON.parse(req.body);
      if (parsed && typeof parsed === 'object') {
        const result: Record<string, string> = {};
        if (parsed.sessionId) result['sessionId'] = String(parsed.sessionId);
        if (parsed.fileId)    result['fileId']    = String(parsed.fileId);
        if (parsed.token)     result['token']     = String(parsed.token);
        if (Object.keys(result).length > 0) return result;
      }
    }
  } catch (_) {}

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
          files.push({
            id:       f.id,
            fileName: f.fileName,
            size:     f.size,
            fileType: f.fileType,
          });
        }

        const session: PendingSession = {
          req: {
            sessionId,
            from:   body.info.alias,
            fromId: body.info.fingerprint,
            files,
          },
          accepted: null,
          tokens,
        };

        this.sessions.set(sessionId, session);

        // Show incoming request UI — user will tap Accept or Decline
        this.cb.onTransferRequest(session.req);

        console.log('[LocalServer] /prepare-upload returning pending for session:', sessionId);
        return json(200, {
          sessionId,
          status: 'pending',
          files: Object.fromEntries(tokens),
        });
      } catch (err: any) {
        console.warn('[LocalServer] /prepare-upload error:', err.message);
        return json(400, { message: err.message });
      }
    });

    // ── GET|POST /transfer-status ─────────────────────────────────
    // Desktop sends sessionId three ways: query param, X-Session-Id header,
    // and JSON body. We accept POST so the body path works too.
    route('/transfer-status', 'POST', async (req: RequestEvent): Promise<HttpResponse> => {
      // DEBUG: confirm where params actually arrive on YOUR expo-http-server version
      console.log('[LocalServer] /transfer-status RAW',
        'paramsJson:', req.paramsJson,
        'cookiesJson:', req.cookiesJson,
        'path:', (req as any).path,
        'url:', (req as any).url);

      const params    = parseQueryParams(req);
      const sessionId = params.sessionId;
      console.log('[LocalServer] /transfer-status parsed sessionId:', sessionId);

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
        const params    = parseQueryParams(req);
        const sessionId = params.sessionId;
        const fileId    = params.fileId;
        const token     = params.token;

        console.log('[LocalServer] /upload sessionId:', sessionId, 'fileId:', fileId);
        console.log('[LocalServer] /upload body length:', req.body?.length ?? 'null');

        if (!sessionId || !fileId || !token) {
          console.warn('[LocalServer] /upload missing params. paramsJson:', req.paramsJson,
                       'path:', (req as any).path);
          return json(400, { message: 'Missing sessionId, fileId or token' });
        }

        const session = this.sessions.get(sessionId);
        if (!session || session.accepted !== true) {
          console.warn('[LocalServer] /upload session not found or not accepted:', sessionId);
          return json(403, { message: 'Session not found or not accepted' });
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
    if (session) {
      session.accepted = accepted;
      console.log('[LocalServer] session', sessionId, accepted ? 'ACCEPTED' : 'DECLINED');
    } else {
      console.warn('[LocalServer] respondToSession — session not found:', sessionId);
    }
  }
}