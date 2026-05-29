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
 * Tries paramsJson, then cookiesJson, then manual path parsing —
 * because different expo-http-server versions route query params differently.
 */
function parseQueryParams(req: RequestEvent): Record<string, string> {
  try {
    const p = JSON.parse(req.paramsJson || '{}');
    if (p && Object.keys(p).length > 0) return p;
  } catch (_) {}

  try {
    const c = JSON.parse(req.cookiesJson || '{}');
    if (c && Object.keys(c).length > 0) return c;
  } catch (_) {}

  try {
    const qIdx = req.path.indexOf('?');
    if (qIdx !== -1) {
      const qs = req.path.slice(qIdx + 1);
      return Object.fromEntries(
        qs.split('&').map(pair => {
          const [k, v] = pair.split('=');
          return [decodeURIComponent(k || ''), decodeURIComponent(v || '')];
        })
      );
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
    // This keeps the server thread free for the subsequent /upload request.
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

        // Return immediately — desktop polls /transfer-status
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

    // ── GET /transfer-status ──────────────────────────────────────
    // Desktop polls this after receiving status:'pending' from /prepare-upload.
    // Returns instantly — no blocking.
    route('/transfer-status', 'GET', async (req: RequestEvent): Promise<HttpResponse> => {
      const params    = parseQueryParams(req);
      const sessionId = params.sessionId;
      console.log('[LocalServer] /transfer-status polled for session:', sessionId);

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
    // Desktop sends file as base64-encoded text/plain body.
    // Received as a clean string by Kotlin's request.content().
    // Query params: sessionId, fileId, token
    route('/upload', 'POST', async (req: RequestEvent): Promise<HttpResponse> => {
      try {
        const params    = parseQueryParams(req);
        const sessionId = params.sessionId;
        const fileId    = params.fileId;
        const token     = params.token;

        console.log('[LocalServer] /upload sessionId:', sessionId, 'fileId:', fileId);
        console.log('[LocalServer] /upload body length:', req.body?.length ?? 'null');

        if (!sessionId || !fileId || !token) {
          console.warn('[LocalServer] /upload missing params. paramsJson:', req.paramsJson);
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

        // Sanitise filename and prefix with sessionId to prevent collisions
        const safeName = fileInfo.fileName.replace(/[^a-zA-Z0-9._\- ]/g, '_');
        const dest     = `${FileSystem.cacheDirectory}${sessionId}_${safeName}`;

        // Body is base64 — desktop encoded the file before sending
        await FileSystem.writeAsStringAsync(dest, req.body, {
          encoding: FileSystem.EncodingType.Base64,
        });

        console.log('[LocalServer] file saved:', dest);

        // Clean up token for this file
        session.tokens.delete(fileId);
        this.cb.onTransferComplete(sessionId, fileId, dest);

        // Delete session only when ALL files received
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