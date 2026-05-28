/**
 * lib/localServer.ts  (MOBILE)
 *
 * HTTP server using expo-http-server real API:
 *   setup(port, onStatus)   — configure port
 *   route(path, method, cb) — register a route handler
 *   start()                 — begin listening
 *   stop()                  — shut down
 *
 * RequestEvent fields:
 *   uuid, method, path, body, headersJson, paramsJson, cookiesJson
 *
 * Response fields:
 *   statusCode, statusDescription, contentType, headers, body
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
  accepted: boolean | null;
  tokens:   Map<string, string>;   // fileId → token
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(statusCode: number, data: object): HttpResponse {
  return {
    statusCode,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

function parseQuery(paramsJson: string): Record<string, string> {
  try { return JSON.parse(paramsJson) || {}; } catch { return {}; }
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
      if (event.status === 'ERROR') {
        console.warn('[LocalServer] error:', event.message);
        this.cb.onError(event.message);
      }
    });

    // 2. Register routes — must be done BEFORE calling start()

    // GET /info
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

    // POST /prepare-upload
    route('/prepare-upload', 'POST', async (req: RequestEvent): Promise<HttpResponse> => {
      try {
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
        this.cb.onTransferRequest(session.req);

        // Wait up to 30 s for user to accept or decline
        const accepted = await this._waitForDecision(sessionId, 30000);

        if (!accepted) {
          this.sessions.delete(sessionId);
          return json(403, { message: 'Declined' });
        }

        return json(200, {
          sessionId,
          files: Object.fromEntries(tokens),
        });
      } catch (err: any) {
        return json(400, { message: err.message });
      }
    });

    // POST /upload  — params: sessionId, fileId, token
    route('/upload', 'POST', async (req: RequestEvent): Promise<HttpResponse> => {
      try {
        const params    = parseQuery(req.paramsJson);
        const sessionId = params.sessionId;
        const fileId    = params.fileId;
        const token     = params.token;
        const session   = this.sessions.get(sessionId);

        if (!session || session.accepted !== true)
          return json(403, { message: 'Session not found or not accepted' });

        if (session.tokens.get(fileId) !== token)
          return json(403, { message: 'Invalid token' });

        const fileInfo = session.req.files.find(f => f.id === fileId);
        if (!fileInfo)
          return json(400, { message: 'Unknown file' });

        // Sanitise filename and prefix with sessionId to avoid collisions
        const safeName = fileInfo.fileName.replace(/[^a-zA-Z0-9._\- ]/g, '_');
        const dest     = `${FileSystem.cacheDirectory}${sessionId}_${safeName}`;

        // expo-http-server delivers body as a base64 string
        await FileSystem.writeAsStringAsync(dest, req.body, {
          encoding: FileSystem.EncodingType.Base64,
        });

        // Clean up this file's token
        session.tokens.delete(fileId);
        this.cb.onTransferComplete(sessionId, fileId, dest);

        // Only delete session when ALL files have been received
        if (session.tokens.size === 0) {
          this.sessions.delete(sessionId);
        }

        return json(200, { message: 'received' });
      } catch (err: any) {
        this.cb.onError('Upload error: ' + err.message);
        return json(500, { message: err.message });
      }
    });

    // POST /cancel
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

    // 3. Start listening
    start();
    this.running = true;
    console.log('[LocalServer] listening on port', SWYFT_PORT);
  }

  stop(): void {
    this.running = false;
    try { stop(); } catch (_) {}
    this.sessions.clear();
  }

  respondToSession(sessionId: string, accepted: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) session.accepted = accepted;
  }

  private _waitForDecision(sessionId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        const session = this.sessions.get(sessionId);
        if (!session)               { clearInterval(poll); resolve(false); return; }
        if (session.accepted === true)  { clearInterval(poll); resolve(true);  return; }
        if (session.accepted === false) { clearInterval(poll); resolve(false); return; }
        if (Date.now() > deadline)  { clearInterval(poll); resolve(false); return; }
      }, 100);
    });
  }
}