import 'dotenv/config';
import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const schema = z.object({
  ARI_URL: z.string().url().default('http://127.0.0.1:8088'),
  ARI_USERNAME: z.string().min(1, 'ARI_USERNAME is required'),
  ARI_PASSWORD: z.string().min(1, 'ARI_PASSWORD is required'),
  ARI_APP: z.string().min(1).default('ivr-app'),

  IVR_LANGUAGE: z.string().min(1).default('he'),

  DATA_SOURCE: z.enum(['mock', 'http']).default('mock'),
  // An unset variable in a .env file is an empty STRING, not undefined, so
  // .optional() alone never fires and .url() rejects "". Without this, copying
  // .env.example verbatim - which is what the setup docs tell you to do -
  // crashes the app on startup.
  DATA_HTTP_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  DATA_HTTP_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  DATA_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

  /**
   * How long to let calls in progress finish before exiting on SIGTERM.
   * systemd's TimeoutStopSec must be comfortably larger than this.
   */
  SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(120_000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  CALL_LOG_PATH: z.string().default('./data/calls.jsonl'),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Fail loudly at boot rather than at 3am on a live call.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.DATA_SOURCE === 'http' && !cfg.DATA_HTTP_URL) {
    throw new Error('DATA_SOURCE=http requires DATA_HTTP_URL to be set');
  }
  return cfg;
}

export const config = load();
export type Config = typeof config;
