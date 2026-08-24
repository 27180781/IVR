import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'ivr' },
  ...(config.LOG_PRETTY
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
    : {}),
});

/** A logger bound to one call, so every line is traceable to a channel. */
export function callLogger(callId: string, from: string, to: string) {
  return logger.child({ callId, from, to });
}

export type CallLogger = ReturnType<typeof callLogger>;
