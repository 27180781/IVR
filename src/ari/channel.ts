import type { Channel, Client, DtmfEvent, Playback, PlaybackEvent } from 'ari-client';
import type { CallLogger } from '../logger.js';

export type PlayOutcome = 'finished' | 'interrupted' | 'hangup';
export type GatherReason = 'terminator' | 'maxDigits' | 'timeout' | 'hangup';

export interface GatherResult {
  digits: string;
  reason: GatherReason;
}

export interface GatherOptions {
  /** Media URIs played while waiting. Empty array = listen immediately. */
  media?: string[];
  maxDigits: number;
  /** Digit that ends input early. Set to null to disable. */
  terminator?: string | null;
  /** Whether a keypress stops the prompt. Almost always yes. */
  bargeIn?: boolean;
  /** Time to wait for the FIRST digit, measured from the end of the prompt. */
  firstDigitTimeoutMs?: number;
  /** Time to wait between digits once input has started. */
  interDigitTimeoutMs?: number;
}

/**
 * A thin, promise-shaped wrapper over one ARI channel.
 *
 * Everything above this layer (the flow engine) should never touch the raw
 * ari-client objects - it deals in "play this", "collect that", "hang up".
 */
export class CallChannel {
  private ended = false;
  private readonly endListeners = new Set<() => void>();

  constructor(
    private readonly ari: Client,
    readonly channel: Channel,
    readonly log: CallLogger,
    private readonly language: string,
  ) {
    this.channel.once('StasisEnd', () => {
      this.ended = true;
      for (const listener of this.endListeners) listener();
      this.endListeners.clear();
    });
  }

  get id(): string {
    return this.channel.id;
  }

  get hungUp(): boolean {
    return this.ended;
  }

  private onEnd(listener: () => void): () => void {
    if (this.ended) {
      listener();
      return () => {};
    }
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  async answer(): Promise<void> {
    if (this.ended) return;
    await this.channel.answer();
    this.log.debug('channel answered');
  }

  async hangup(): Promise<void> {
    if (this.ended) return;
    try {
      await this.channel.hangup();
    } catch (err) {
      // The caller may have hung up between our check and this call - benign.
      this.log.debug({ err }, 'hangup raced with remote hangup');
    }
  }

  /** Play a sequence of media URIs. Resolves when done, interrupted or hung up. */
  async play(media: string[], opts: { bargeIn?: boolean } = {}): Promise<PlayOutcome> {
    if (this.ended) return 'hangup';
    if (media.length === 0) return 'finished';

    return new Promise<PlayOutcome>((resolve) => {
      let settled = false;
      const cleanupFns: Array<() => void> = [];

      const finish = (outcome: PlayOutcome) => {
        if (settled) return;
        settled = true;
        for (const fn of cleanupFns) fn();
        resolve(outcome);
      };

      const playback: Playback = this.ari.Playback();

      // Asterisk emits PlaybackFinished even when the file could not be
      // opened, so "finished" alone does not mean the caller heard anything.
      // A missing or misnamed sound file is otherwise completely silent - the
      // caller gets dead air and the flow marches on. Say it loudly.
      const onFinished = (event: PlaybackEvent) => {
        const state = event?.playback?.state;
        if (state && state !== 'done') {
          this.log.error(
            { media, state },
            'playback did not complete - check that the sound file exists for this language',
          );
        }
        finish('finished');
      };
      playback.once('PlaybackFinished', onFinished);
      cleanupFns.push(() => playback.removeListener('PlaybackFinished', onFinished));

      cleanupFns.push(this.onEnd(() => finish('hangup')));

      if (opts.bargeIn) {
        const onDtmf = () => {
          playback.stop().catch(() => {
            /* already finished */
          });
          finish('interrupted');
        };
        this.channel.once('ChannelDtmfReceived', onDtmf);
        cleanupFns.push(() => this.channel.removeListener('ChannelDtmfReceived', onDtmf));
      }

      this.channel
        // ARI takes a playlist as a single comma-separated value; the files
        // play back-to-back and PlaybackFinished fires once, at the end.
        .play({ media: media.join(','), lang: this.language }, playback)
        .catch((err: unknown) => {
          this.log.warn({ err, media }, 'playback failed');
          finish(this.ended ? 'hangup' : 'finished');
        });
    });
  }

  /**
   * Play an optional prompt and collect DTMF.
   *
   * Timing follows normal telephony convention: the first-digit timer starts
   * when the prompt ends (or when the caller barges in), and the inter-digit
   * timer restarts after every keypress.
   */
  async gather(opts: GatherOptions): Promise<GatherResult> {
    const {
      media = [],
      maxDigits,
      terminator = '#',
      bargeIn = true,
      firstDigitTimeoutMs = 5000,
      interDigitTimeoutMs = 3000,
    } = opts;

    if (this.ended) return { digits: '', reason: 'hangup' };

    return new Promise<GatherResult>((resolve) => {
      let digits = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const cleanupFns: Array<() => void> = [];

      const finish = (reason: GatherReason) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        for (const fn of cleanupFns) fn();
        this.log.debug({ digits, reason }, 'gather complete');
        resolve({ digits, reason });
      };

      const armTimer = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish('timeout'), ms);
      };

      const onDtmf = (event: DtmfEvent) => {
        if (settled) return;
        if (timer) clearTimeout(timer);

        if (terminator !== null && event.digit === terminator) {
          finish('terminator');
          return;
        }

        digits += event.digit;
        if (digits.length >= maxDigits) {
          finish('maxDigits');
          return;
        }
        armTimer(interDigitTimeoutMs);
      };

      this.channel.on('ChannelDtmfReceived', onDtmf);
      cleanupFns.push(() => this.channel.removeListener('ChannelDtmfReceived', onDtmf));
      cleanupFns.push(this.onEnd(() => finish('hangup')));

      void this.play(media, { bargeIn }).then((outcome) => {
        if (settled) return;
        if (outcome === 'hangup') {
          finish('hangup');
          return;
        }
        // Only start the clock once the caller has actually heard the prompt.
        armTimer(digits.length === 0 ? firstDigitTimeoutMs : interDigitTimeoutMs);
      });
    });
  }
}
