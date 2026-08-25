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

  // ---- Outbound dialling (DISA) ----
  /**
   * Off unless deliberately turned on.
   *
   * A dial-through lets whoever reaches the menu place calls billed to this
   * account, which is the single most exploited feature in telephony. It is
   * opt-in, and refuses to run without a PIN.
   */
  OUTBOUND_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  OUTBOUND_PIN: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4,12}$/).optional()),
  /** PJSIP endpoint to route outbound calls through. */
  OUTBOUND_TRUNK_ENDPOINT: z.string().default('twilio'),
  /**
   * Whose number the destination sees.
   *
   * 'original' presents the inbound caller's own number. Carriers restrict
   * this: Twilio accepts a From only if the number is owned by the account or
   * listed as a Verified Caller ID, so this works for known callers and is
   * rejected for arbitrary ones. 'trunk' always works.
   */
  OUTBOUND_CALLERID_MODE: z.enum(['original', 'trunk', 'fixed']).default('trunk'),
  /** Used for 'fixed', and as the fallback when 'original' has nothing to use. */
  OUTBOUND_CALLERID_NUMBER: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Comma-separated E.164 prefixes. Empty means anywhere, which is a liability. */
  OUTBOUND_ALLOWED_PREFIXES: z.string().default(''),
  /** Seconds to ring before giving up. */
  OUTBOUND_TIMEOUT_SEC: z.coerce.number().int().positive().default(45),
  /** Hard cap on a connected call, so a stuck one cannot bill indefinitely. */
  OUTBOUND_MAX_DURATION_SEC: z.coerce.number().int().positive().default(600),

  // ---- Dashboard ----
  WEB_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Loopback by default. The dashboard is meant to sit behind a reverse proxy
   * that terminates TLS - binding it to a public interface would serve call
   * records, and the phone numbers in them, over plain HTTP.
   */
  WEB_BIND: z.string().default('127.0.0.1'),
  WEB_USER: z.string().default('admin'),
  WEB_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  /** How many recent log lines the dashboard keeps in memory. */
  WEB_LOG_BUFFER: z.coerce.number().int().positive().default(500),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
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
  if (cfg.OUTBOUND_ENABLED && !cfg.OUTBOUND_PIN) {
    // Fail closed. An unauthenticated dial-through is an open relay for
    // international calls charged to this account, and it is found by
    // scanners within days.
    throw new Error(
      'OUTBOUND_ENABLED=true requires OUTBOUND_PIN (4-12 digits). ' +
        'A dial-through without one lets any caller dial anywhere at your expense.',
    );
  }
  if (cfg.OUTBOUND_ENABLED && cfg.OUTBOUND_CALLERID_MODE === 'fixed' && !cfg.OUTBOUND_CALLERID_NUMBER) {
    throw new Error('OUTBOUND_CALLERID_MODE=fixed requires OUTBOUND_CALLERID_NUMBER');
  }
  return cfg;
}

export const config = load();
export type Config = typeof config;
