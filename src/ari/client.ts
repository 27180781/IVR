import ari, { type Channel, type Client, type StasisStartEvent } from 'ari-client';
import { config } from '../config.js';
import { logger } from '../logger.js';

export type StasisHandler = (ari: Client, channel: Channel, args: string[]) => Promise<void>;

/** ARI rejected our credentials - a configuration fault, not a network one. */
class AriAuthError extends Error {
  override readonly name = 'AriAuthError';
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Owns the connection to Asterisk and keeps it alive.
 *
 * ARI is one HTTP client plus one long-lived WebSocket. The WebSocket is the
 * part that matters: if it drops, Asterisk has no application to hand calls
 * to, and every inbound call falls through the dialplan to the "system
 * unavailable" prompt. So reconnection is not a nicety - it is the difference
 * between a blip and an outage.
 *
 * ari-client reconnects the socket on its own with a short backoff, but it
 * gives up after a bounded number of attempts and emits WebSocketMaxRetries.
 * That inner loop only survives a restart of Asterisk that finishes quickly;
 * this outer loop survives one that does not.
 */
export class AriSupervisor {
  private client: Client | undefined;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;

  constructor(private readonly handler: StasisHandler) {}

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try {
      this.client?.stop();
    } catch (err) {
      logger.debug({ err }, 'error while stopping ARI client');
    }
    this.client = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt += 1;
    logger.warn({ delayMs: delay, attempt: this.attempt }, 'scheduling ARI reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  /** Drop the current client so a fresh one can be built from scratch. */
  private teardown(): void {
    try {
      this.client?.stop();
    } catch {
      /* socket already gone */
    }
    this.client = undefined;
  }

  /**
   * Check the ARI endpoint with a plain HTTP request before handing over to
   * ari-client.
   *
   * This is not belt-and-braces. ari-client's swagger layer throws a bare
   * string from inside a callback when authentication fails, outside any
   * promise chain - so the try/catch below never sees it and the process dies
   * with an unhandled exception. Under systemd's Restart=always that is an
   * infinite crash loop, hammering Asterisk with 401s, and all the operator
   * sees is a swagger stack trace.
   *
   * Catching it here turns a mismatched password into a clear, retrying error,
   * which matters because the fix usually happens while the service is up.
   */
  private async preflight(): Promise<void> {
    const url = new URL('/ari/asterisk/info', config.ARI_URL);
    const credentials = Buffer.from(`${config.ARI_USERNAME}:${config.ARI_PASSWORD}`).toString('base64');

    const res = await fetch(url, {
      headers: { authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new AriAuthError(
        `ARI rejected user "${config.ARI_USERNAME}" (HTTP ${res.status}). ` +
          'ARI_PASSWORD in .env must match the password for that user in ' +
          '/etc/asterisk/ari.conf.',
      );
    }
    if (!res.ok) {
      throw new Error(`ARI preflight failed with HTTP ${res.status}`);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;

    try {
      await this.preflight();
      const client = await ari.connect(config.ARI_URL, config.ARI_USERNAME, config.ARI_PASSWORD);
      this.client = client;

      const info = await client.asterisk.getInfo();
      logger.info(
        { url: config.ARI_URL, app: config.ARI_APP, asterisk: info.system?.version },
        'connected to Asterisk',
      );

      client.on('StasisStart', (event: StasisStartEvent, channel: Channel) => {
        // Errors are handled inside the handler; this guard is for the
        // pathological case, so one bad call cannot take the process down.
        void this.handler(client, channel, event.args ?? []).catch((err: unknown) => {
          logger.error({ err, channelId: channel.id }, 'unhandled error in call handler');
        });
      });

      client.on('APILoadError', (err: unknown) => {
        logger.error({ err }, 'failed to load the ARI API definition');
      });

      client.on('WebSocketConnected', () => {
        this.attempt = 0;
        logger.info({ app: config.ARI_APP }, 'ARI websocket connected');
      });

      client.on('WebSocketReconnecting', (err: unknown) => {
        logger.warn({ err }, 'ARI websocket dropped, client is retrying');
      });

      client.on('WebSocketMaxRetries', (err: unknown) => {
        if (this.stopping) return;
        logger.error({ err }, 'ARI websocket gave up retrying, rebuilding the client');
        this.teardown();
        this.scheduleReconnect();
      });

      // Rejects when the socket cannot be established at all, and when the
      // client's own retry budget is exhausted.
      await client.start(config.ARI_APP);
    } catch (err) {
      if (err instanceof AriAuthError) {
        // Retrying will not fix this on its own, but exiting would only make
        // systemd restart us into the same wall. Keep saying exactly what is
        // wrong until somebody corrects the password.
        logger.error({ url: config.ARI_URL }, err.message);
      } else {
        logger.error({ err, url: config.ARI_URL }, 'failed to connect to ARI');
      }
      this.teardown();
      this.scheduleReconnect();
    }
  }
}
