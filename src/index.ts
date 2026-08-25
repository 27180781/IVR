import type { Channel, Client } from 'ari-client';
import { AriSupervisor } from './ari/client.js';
import { CallChannel } from './ari/channel.js';
import { adoptOutboundChannel } from './ari/dialer.js';
import { config } from './config.js';
import { IvrEngine } from './ivr/engine.js';
import type { CallContext } from './ivr/flow.js';
import { createMainFlow } from './ivr/flows/main.js';
import { callLogger, logger } from './logger.js';
import { createDataSource } from './services/data.js';
import { StaticFileSpeechProvider } from './services/speech.js';
import { recordCall } from './store/calls.js';
import { callEnded, callStarted } from './store/activity.js';
import { startDashboard } from './web/server.js';

const dataSource = createDataSource();
const speech = new StaticFileSpeechProvider();
const flow = createMainFlow(dataSource);
const engine = new IvrEngine(flow, speech);

const activeCalls = new Set<string>();

async function handleCall(ari: Client, channel: Channel, args: string[]): Promise<void> {
  // Legs we originated come back through the same event. They belong to the
  // call that placed them, not to a new one.
  if (args[0] === 'outbound' && adoptOutboundChannel(channel)) return;

  if (draining) {
    logger.info({ channelId: channel.id }, 'draining - handing call back to the dialplan');
    // extensions.conf plays ivr/system-unavailable and hangs up.
    await channel.continueInDialplan().catch(() => channel.hangup().catch(() => {}));
    return;
  }

  // Arguments come from Stasis(ivr-app,${EXTEN},${CALLERID(num)}) in the
  // dialplan; fall back to the channel's own caller id if they are missing.
  // ${CALLERID(num)} expands to an empty string when the caller withholds
  // their number, and "" is not null - ?? would happily keep it.
  const firstOf = (...values: Array<string | undefined>) =>
    values.find((v) => v !== undefined && v !== '') ?? 'unknown';

  const to = firstOf(args[0], channel.dialplan?.exten);
  const from = firstOf(args[1], channel.caller?.number, 'anonymous');

  const ctx: CallContext = {
    callId: channel.id,
    from,
    to,
    startedAt: Date.now(),
    vars: {},
  };

  const log = callLogger(ctx.callId, from, to);
  const call = new CallChannel(ari, channel, log, config.IVR_LANGUAGE);
  activeCalls.add(ctx.callId);
  callStarted({ callId: ctx.callId, from, to, startedAt: ctx.startedAt });

  try {
    log.info({ flow: flow.name }, 'call started');
    await call.answer();

    const outcome = await engine.run(call, ctx);

    log.info(
      {
        reason: outcome.reason,
        lastState: outcome.lastState,
        durationMs: outcome.endedAt - ctx.startedAt,
      },
      'call finished',
    );

    // Make sure the channel is really gone even if the flow ended on an error.
    await call.hangup();
    await recordCall(ctx, outcome);
  } finally {
    activeCalls.delete(ctx.callId);
    callEnded(ctx.callId);
    if (draining && activeCalls.size === 0) drainDone?.();
  }
}

const supervisor = new AriSupervisor(handleCall);

/**
 * Graceful shutdown.
 *
 * A deploy restarts this process, and a restart in the middle of a call cuts
 * the caller off mid-sentence. So on SIGTERM we stop taking new calls, let the
 * ones already in progress run to their natural end, and only then exit.
 *
 * New calls that arrive while draining are handed back to the dialplan, which
 * plays the "system unavailable" prompt - a caller hearing a real message and
 * calling back beats a caller hearing silence.
 */
let draining = false;
let drainDone: (() => void) | undefined;

async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  logger.info({ signal, activeCalls: activeCalls.size }, 'draining before shutdown');

  if (activeCalls.size > 0 && config.SHUTDOWN_DRAIN_TIMEOUT_MS > 0) {
    await new Promise<void>((resolve) => {
      drainDone = resolve;
      const timer = setTimeout(() => {
        logger.warn(
          { remaining: activeCalls.size },
          'drain timeout reached, exiting with calls still active',
        );
        resolve();
      }, config.SHUTDOWN_DRAIN_TIMEOUT_MS);
      // Do not hold the event loop open once draining finishes.
      timer.unref?.();
    });
  }

  logger.info('shutting down');
  await supervisor.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

// Backstop for libraries that throw outside a promise chain. Without this the
// process dies printing a bare stack trace that says nothing about which part
// of the system failed.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception - the process is in an unknown state');
  process.exit(1);
});

await supervisor.start();
startDashboard();
logger.info({ app: config.ARI_APP, dataSource: dataSource.name }, 'IVR application ready');
