import { randomUUID } from 'node:crypto';
import type { Bridge, Channel, ChannelDestroyedEvent, Client } from 'ari-client';
import { config } from '../config.js';
import type { CallLogger } from '../logger.js';
import type { CallChannel } from './channel.js';

export type DialOutcome = 'answered' | 'busy' | 'no-answer' | 'rejected' | 'failed';

/**
 * Channels we originated and are waiting to see enter Stasis.
 *
 * Registered before the originate call, not after: the outbound leg can enter
 * Stasis before the HTTP response comes back, and a leg that arrives
 * unclaimed would be treated as a new inbound call.
 */
const pendingOutbound = new Map<string, (channel: Channel) => void>();

/** Returns true if this channel is an outbound leg we are waiting for. */
export function adoptOutboundChannel(channel: Channel): boolean {
  const waiting = pendingOutbound.get(channel.id);
  if (!waiting) return false;
  pendingOutbound.delete(channel.id);
  waiting(channel);
  return true;
}

/**
 * Q.850 causes, mapped to something a caller can be told.
 *
 * Distinguishing these matters: "the number is busy" and "we could not place
 * the call" send the caller to do completely different things.
 */
function outcomeFromCause(cause: number): DialOutcome {
  switch (cause) {
    case 17:
      return 'busy';
    case 18:
    case 19:
      return 'no-answer';
    case 21:
    case 38:
      return 'rejected';
    default:
      return 'failed';
  }
}

/**
 * Normalise whatever the caller typed into E.164.
 *
 * Callers dial the international prefix the way their country writes it - 00
 * in most of the world, 011 from North America - and neither belongs in the
 * number handed to a carrier.
 */
export function normaliseDestination(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('011')) digits = digits.slice(3);
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Empty allowlist means anywhere, which is a standing invitation. */
export function destinationAllowed(e164: string): boolean {
  const prefixes = config.OUTBOUND_ALLOWED_PREFIXES.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => e164.startsWith(prefix));
}

/**
 * What the destination sees.
 *
 * 'original' is what most people want and what carriers restrict. Twilio
 * accepts a From only when the number is owned by the account or listed as a
 * Verified Caller ID; anything else is rejected or replaced. So it is
 * attempted, and falls back rather than failing the call outright.
 */
function resolveCallerId(inboundFrom: string, inboundTo: string): string | undefined {
  // The number the caller dialled to reach us is, by definition, one this
  // account owns - so it is always an acceptable From, with nothing to
  // configure. That makes it the right fallback everywhere.
  const owned = config.OUTBOUND_CALLERID_NUMBER ?? (inboundTo.startsWith('+') ? inboundTo : undefined);

  switch (config.OUTBOUND_CALLERID_MODE) {
    case 'original': {
      const usable =
        inboundFrom.startsWith('+') && inboundFrom !== 'anonymous' && inboundFrom !== 'unknown';
      return usable ? inboundFrom : owned;
    }
    case 'fixed':
      return config.OUTBOUND_CALLERID_NUMBER;
    case 'trunk':
      return owned;
  }
}

/**
 * Place a call and bridge it to the caller already on the line.
 *
 * Resolves once the outbound leg fails, or once a connected call has ended.
 */
export interface DialRequest {
  destination: string;
  /** The inbound caller's number, for OUTBOUND_CALLERID_MODE=original. */
  from: string;
  /** The number they dialled to reach us - always a number this account owns. */
  to: string;
}

export async function dialOut(
  ari: Client,
  inbound: CallChannel,
  request: DialRequest,
  log: CallLogger,
): Promise<DialOutcome> {
  const { destination, from, to } = request;
  const channelId = randomUUID();
  const callerId = resolveCallerId(from, to);
  const endpoint = `PJSIP/${destination}@${config.OUTBOUND_TRUNK_ENDPOINT}`;

  log.info(
    { destination, endpoint, callerId: callerId ?? '(none)', mode: config.OUTBOUND_CALLERID_MODE },
    'dialling out',
  );
  if (!callerId) {
    // Without a From the carrier decides, and what it decides is rarely what
    // anyone wanted the destination to see.
    log.warn('no caller ID could be resolved - set OUTBOUND_CALLERID_NUMBER');
  }

  let bridge: Bridge | undefined;
  let outbound: Channel | undefined;
  const cleanups: Array<() => void> = [];

  const settle = await new Promise<DialOutcome>((resolve) => {
    let done = false;
    const finish = (outcome: DialOutcome) => {
      if (done) return;
      done = true;
      resolve(outcome);
    };

    pendingOutbound.set(channelId, (channel) => {
      // The destination answered and the leg is now ours to control.
      void (async () => {
        try {
          await channel.answer().catch(() => {
            /* already up */
          });
          bridge = await ari.bridges.create({ type: 'mixing' });
          await bridge.addChannel({ channel: [inbound.id, channel.id] });
          log.info({ destination, bridge: bridge.id }, 'outbound call connected');

          const endCall = () => finish('answered');
          channel.once('StasisEnd', endCall);
          cleanups.push(() => channel.removeListener('StasisEnd', endCall));

          // The caller hanging up ends it just the same.
          cleanups.push(inbound.onHangup(endCall));

          // A connected call that never ends bills until someone notices.
          const cap = setTimeout(() => {
            log.warn({ destination }, 'outbound call hit the duration cap');
            finish('answered');
          }, config.OUTBOUND_MAX_DURATION_SEC * 1000);
          cleanups.push(() => clearTimeout(cap));
        } catch (err) {
          log.error({ err, destination }, 'failed to bridge the outbound call');
          finish('failed');
        }
      })();
    });
    cleanups.push(() => pendingOutbound.delete(channelId));

    ari.channels
      .originate({
        endpoint,
        app: config.ARI_APP,
        appArgs: 'outbound',
        channelId,
        // Links the two legs and lets the new one inherit the media format,
        // which avoids a needless transcode.
        originator: inbound.id,
        timeout: config.OUTBOUND_TIMEOUT_SEC,
        ...(callerId ? { callerId } : {}),
      })
      .then((channel) => {
        outbound = channel;
        const onDestroyed = (event: ChannelDestroyedEvent) => {
          // Only meaningful before the bridge exists; afterwards StasisEnd
          // has already settled this.
          const outcome = outcomeFromCause(event.cause);
          log.info(
            { destination, cause: event.cause, causeText: event.cause_txt, outcome },
            'outbound leg ended',
          );
          finish(bridge ? 'answered' : outcome);
        };
        channel.once('ChannelDestroyed', onDestroyed);
        cleanups.push(() => channel.removeListener('ChannelDestroyed', onDestroyed));
      })
      .catch((err: unknown) => {
        log.error({ err, endpoint }, 'originate failed');
        finish('failed');
      });

    // The caller may give up while it is still ringing.
    cleanups.push(inbound.onHangup(() => finish('failed')));
  });

  for (const cleanup of cleanups) cleanup();
  try {
    if (outbound && settle !== 'answered') await outbound.hangup().catch(() => {});
    if (bridge) {
      await outbound?.hangup().catch(() => {});
      await bridge.destroy().catch(() => {});
    }
  } catch (err) {
    log.debug({ err }, 'error tearing down the outbound call');
  }

  return settle;
}
