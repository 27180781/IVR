import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { open, stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getActiveCalls, getRecentLogs, startedAt, subscribe } from '../store/activity.js';
import type { CallRecord } from '../store/calls.js';
import { DASHBOARD_HTML } from './dashboard.js';

/** Only ever read the tail of the call log; it grows without bound. */
const TAIL_BYTES = 512 * 1024;

async function readRecentCalls(limit: number): Promise<CallRecord[]> {
  let handle;
  try {
    handle = await open(config.CALL_LOG_PATH, 'r');
    const { size } = await stat(config.CALL_LOG_PATH);
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);

    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
    // A partial first line is expected whenever the file is larger than the
    // window we read.
    if (start > 0) lines.shift();

    const records: CallRecord[] = [];
    for (const line of lines.slice(-limit).reverse()) {
      try {
        records.push(JSON.parse(line) as CallRecord);
      } catch {
        /* a torn final line while a call is being written */
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

/** Constant-time comparison, so the response time cannot leak the password. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function authorised(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return secretsMatch(user, config.WEB_USER) && secretsMatch(password, config.WEB_PASSWORD ?? '');
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(body);
}

const json = (res: ServerResponse, data: unknown) =>
  send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8');

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorised(req)) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="IVR dashboard", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end('unauthorised');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  switch (url.pathname) {
    case '/':
      send(res, 200, DASHBOARD_HTML, 'text/html; charset=utf-8');
      return;

    case '/api/summary':
      json(res, {
        uptimeMs: Date.now() - startedAt,
        activeCalls: getActiveCalls().length,
        dataSource: config.DATA_SOURCE,
        language: config.IVR_LANGUAGE,
        ariApp: config.ARI_APP,
      });
      return;

    case '/api/active':
      json(res, getActiveCalls());
      return;

    case '/api/logs':
      json(res, getRecentLogs());
      return;

    case '/api/calls': {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);
      json(res, await readRecentCalls(limit));
      return;
    }

    case '/api/stream': {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');

      const unsubscribe = subscribe((event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      });
      // Proxies close idle connections; a comment costs nothing and keeps it up.
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    default:
      send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

/**
 * Starts the dashboard, or explains why it did not start.
 *
 * Never throws: this process exists to answer phone calls, and a dashboard
 * that cannot start is not a reason to stop answering them.
 */
export function startDashboard(): void {
  if (!config.WEB_ENABLED) {
    logger.info('dashboard disabled (WEB_ENABLED=false)');
    return;
  }

  if (!config.WEB_PASSWORD) {
    // Fail closed. Call records contain callers' phone numbers; serving them
    // without authentication is a data leak, not a convenience.
    logger.error(
      'dashboard NOT started: WEB_PASSWORD is not set. ' +
        'Set it in .env (at least 8 characters) and restart.',
    );
    return;
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger.error({ err, url: req.url }, 'dashboard request failed');
      if (!res.headersSent) send(res, 500, 'internal error', 'text/plain; charset=utf-8');
    });
  });

  server.on('error', (err) => {
    logger.error({ err, port: config.WEB_PORT }, 'dashboard server error');
  });

  server.listen(config.WEB_PORT, config.WEB_BIND, () => {
    logger.info(
      { bind: config.WEB_BIND, port: config.WEB_PORT },
      'dashboard listening (put a TLS reverse proxy in front of it)',
    );
  });
}
