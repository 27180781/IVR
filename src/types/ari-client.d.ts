/**
 * Minimal ambient types for the `ari-client` package, which ships without
 * TypeScript definitions. Only the surface this project actually uses is
 * declared - extend it as the IVR grows rather than reaching for `any`.
 */
declare module 'ari-client' {
  import type { EventEmitter } from 'node:events';

  export interface AriEvent {
    type: string;
    application: string;
    timestamp: string;
    [key: string]: unknown;
  }

  export interface StasisStartEvent extends AriEvent {
    type: 'StasisStart';
    args: string[];
  }

  export interface DtmfEvent extends AriEvent {
    type: 'ChannelDtmfReceived';
    digit: string;
    duration_ms: number;
  }

  export interface PlaybackEvent extends AriEvent {
    playback: Playback;
  }

  export interface CallerId {
    name: string;
    number: string;
  }

  export interface Playback extends EventEmitter {
    id: string;
    /** 'queued' | 'playing' | 'continuing' | 'done' | 'failed' */
    state?: string;
    stop(): Promise<void>;
  }

  export interface Channel extends EventEmitter {
    id: string;
    name: string;
    state: string;
    caller: CallerId;
    connected: CallerId;
    dialplan: { context: string; exten: string; priority: number };

    answer(): Promise<void>;
    hangup(opts?: { reason?: string }): Promise<void>;
    ring(): Promise<void>;
    play(opts: { media: string; lang?: string; offsetms?: number; skipms?: number }, playback?: Playback): Promise<Playback>;
    setChannelVar(opts: { variable: string; value: string }): Promise<void>;
    continueInDialplan(opts?: { context?: string; extension?: string; priority?: number }): Promise<void>;
  }

  export interface Client extends EventEmitter {
    /** Opens the event websocket. Rejects if the retry budget is exhausted. */
    start(apps: string | string[], subscribeAll?: boolean): Promise<void>;
    stop(): void;
    ping(): void;
    Playback(): Playback;
    channels: {
      get(opts: { channelId: string }): Promise<Channel>;
      hangup(opts: { channelId: string; reason?: string }): Promise<void>;
    };
    asterisk: {
      getInfo(): Promise<{ system?: { version?: string }; [key: string]: unknown }>;
    };
  }

  export function connect(url: string, username: string, password: string): Promise<Client>;
}
