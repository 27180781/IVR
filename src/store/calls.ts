import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { CallOutcome } from '../ivr/engine.js';
import type { CallContext } from '../ivr/flow.js';

export interface CallRecord {
  callId: string;
  from: string;
  to: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  reason: CallOutcome['reason'];
  lastState: string;
  path: string[];
  vars: Record<string, unknown>;
  error?: string;
}

/**
 * Append-only call log, one JSON object per line.
 *
 * Deliberately a file and not a database: phase 1 has no query requirements,
 * and JSONL is trivially greppable and trivially importable into Postgres
 * later. `recordCall` never throws - losing a log line must not affect a call.
 */
export async function recordCall(ctx: CallContext, outcome: CallOutcome): Promise<void> {
  const record: CallRecord = {
    callId: ctx.callId,
    from: ctx.from,
    to: ctx.to,
    startedAt: new Date(ctx.startedAt).toISOString(),
    endedAt: new Date(outcome.endedAt).toISOString(),
    durationMs: outcome.endedAt - ctx.startedAt,
    reason: outcome.reason,
    lastState: outcome.lastState,
    path: outcome.path,
    vars: outcome.vars,
    ...(outcome.error ? { error: outcome.error } : {}),
  };

  try {
    await mkdir(dirname(config.CALL_LOG_PATH), { recursive: true });
    await appendFile(config.CALL_LOG_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    logger.error({ err, callId: ctx.callId }, 'failed to persist call record');
  }
}
