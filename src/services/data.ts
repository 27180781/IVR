import { config } from '../config.js';
import { logger } from '../logger.js';

export const ORDER_STATUSES = ['new', 'processing', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderRecord {
  reference: string;
  status: OrderStatus;
  /** ISO date. Not spoken yet - see the note in services/speech.ts. */
  etaDate?: string;
}

/**
 * The system the IVR reads from.
 *
 * Kept behind an interface so the flow never knows whether the answer came
 * from a fixture, an internal API or a database. Swapping the backend is a
 * config change, not a code change.
 */
export interface DataSource {
  readonly name: string;
  lookupOrder(reference: string): Promise<OrderRecord | null>;
}

/** Fixtures for local development, so a flow can be tested without a backend. */
export class MockDataSource implements DataSource {
  readonly name = 'mock';

  private readonly orders = new Map<string, OrderRecord>([
    ['100001', { reference: '100001', status: 'new' }],
    ['100002', { reference: '100002', status: 'processing' }],
    ['100003', { reference: '100003', status: 'shipped', etaDate: '2026-09-01' }],
    ['100004', { reference: '100004', status: 'delivered' }],
    ['100005', { reference: '100005', status: 'cancelled' }],
  ]);

  async lookupOrder(reference: string): Promise<OrderRecord | null> {
    return this.orders.get(reference) ?? null;
  }
}

/**
 * Calls an external HTTP API.
 *
 * The timeout is not optional: a backend that hangs would otherwise leave the
 * caller listening to silence with no way out. Better to fail fast and play
 * the error prompt.
 */
export class HttpDataSource implements DataSource {
  readonly name = 'http';

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  async lookupOrder(reference: string): Promise<OrderRecord | null> {
    const url = new URL(`orders/${encodeURIComponent(reference)}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        signal: controller.signal,
      });

      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`lookup failed with HTTP ${res.status}`);

      const body = (await res.json()) as Partial<OrderRecord>;
      if (!body.status || !ORDER_STATUSES.includes(body.status as OrderStatus)) {
        throw new Error(`unexpected status "${String(body.status)}" from backend`);
      }
      return {
        reference,
        status: body.status as OrderStatus,
        ...(body.etaDate ? { etaDate: body.etaDate } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createDataSource(): DataSource {
  if (config.DATA_SOURCE === 'http') {
    logger.info({ url: config.DATA_HTTP_URL }, 'using HTTP data source');
    return new HttpDataSource(config.DATA_HTTP_URL!, config.DATA_HTTP_TOKEN, config.DATA_HTTP_TIMEOUT_MS);
  }
  logger.info('using mock data source - set DATA_SOURCE=http for a real backend');
  return new MockDataSource();
}
