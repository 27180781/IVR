import pino from 'pino';
import { config } from './config.js';
import { recordLog, type LogLine } from './store/activity.js';

/**
 * Logs go to stdout for journalctl, and to an in-memory ring the dashboard
 * reads. The ring is what lets someone watch the system without an SSH
 * session; it is bounded, so a long-running process cannot grow into it.
 *
 * A failure here must never propagate - losing a dashboard line is nothing,
 * interrupting a call over it is unacceptable.
 */
const ringStream = {
  write(line: string): void {
    try {
      recordLog(JSON.parse(line) as LogLine);
    } catch {
      /* malformed line, or a listener threw - not worth a call */
    }
  },
};

const streams: pino.StreamEntry[] = [
  { level: config.LOG_LEVEL, stream: process.stdout },
  { level: config.LOG_LEVEL, stream: ringStream as NodeJS.WritableStream },
];

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    base: { service: 'ivr' },
  },
  pino.multistream(streams, { dedupe: false }),
);

/** A logger bound to one call, so every line is traceable to a channel. */
export function callLogger(callId: string, from: string, to: string) {
  return logger.child({ callId, from, to });
}

export type CallLogger = ReturnType<typeof callLogger>;
