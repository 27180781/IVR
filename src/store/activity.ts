import { config } from '../config.js';

/**
 * What the dashboard shows.
 *
 * Everything here is in-memory and deliberately bounded. This process answers
 * phone calls; it must not accumulate state that grows with uptime, and it
 * must not do disk work on the request path of a live call.
 */

export interface ActiveCall {
  callId: string;
  from: string;
  to: string;
  startedAt: number;
  state: string;
}

export interface LogLine {
  time: number;
  level: number;
  msg: string;
  callId?: string;
  [key: string]: unknown;
}

/** Fixed-size ring. Old entries fall off the end rather than growing forever. */
class Ring<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  toArray(): T[] {
    return [...this.items];
  }
}

const active = new Map<string, ActiveCall>();
const logs = new Ring<LogLine>(config.WEB_LOG_BUFFER);
const listeners = new Set<(event: { type: string; data: unknown }) => void>();

function emit(type: string, data: unknown): void {
  for (const listener of [...listeners]) {
    try {
      listener({ type, data });
    } catch {
      // A broken dashboard connection must never disturb a call.
    }
  }
}

/** Subscribe to live events. Returns an unsubscribe function. */
export function subscribe(listener: (event: { type: string; data: unknown }) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function callStarted(call: Omit<ActiveCall, 'state'>): void {
  const entry: ActiveCall = { ...call, state: 'starting' };
  active.set(call.callId, entry);
  emit('call-started', entry);
}

export function callStateChanged(callId: string, state: string): void {
  const entry = active.get(callId);
  if (!entry) return;
  entry.state = state;
  emit('call-state', { callId, state });
}

export function callEnded(callId: string): void {
  active.delete(callId);
  emit('call-ended', { callId });
}

export function getActiveCalls(): ActiveCall[] {
  return [...active.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function recordLog(line: LogLine): void {
  logs.push(line);
  emit('log', line);
}

export function getRecentLogs(): LogLine[] {
  return logs.toArray();
}

export const startedAt = Date.now();
