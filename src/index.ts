import type { Channel, Client } from 'ari-client';
import { AriSupervisor } from './ari/client.js';
import { CallChannel } from './ari/channel.js';
import { config } from './config.js';
import { IvrEngine } from './ivr/engine.js';
import type { CallContext } from './ivr/flow.js';
import { createMainFlow } from './ivr/flows/main.js';
import { callLogger, logger } from './logger.js';
import { createDataSource } from './services/data.js';
import { StaticFileSpeechProvider } from './services/speech.js';
import { recordCall } from './store/calls.js';

const dataSource = createDataSource();
const speech = new StaticFileSpeechProvider();
const flow = createMainFlow(dataSource);
const engine = new IvrEngine(flow, speech);

async function handleCall(ari: Client, channel: Channel, args: string[]): Promise<void> {
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

  log.info({ flow: flow.name }, 'call started');
  await call.answer();

  const outcome = await engine.run(call, ctx);

  log.info(
    { reason: outcome.reason, lastState: outcome.lastState, durationMs: outcome.endedAt - ctx.startedAt },
    'call finished',
  );

  // Make sure the channel is really gone even if the flow ended on an error.
  await call.hangup();
  await recordCall(ctx, outcome);
}

const supervisor = new AriSupervisor(handleCall);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await supervisor.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

await supervisor.start();
logger.info({ app: config.ARI_APP, dataSource: dataSource.name }, 'IVR application ready');
