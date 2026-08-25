import { timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import { destinationAllowed, normaliseDestination } from '../../ari/dialer.js';
import type { DataSource, OrderRecord, OrderStatus } from '../../services/data.js';
import { defineFlow, say, spell, type Flow, type Utterance } from '../flow.js';
import type { PromptKey } from '../prompts.js';

const STATUS_PROMPT: Record<OrderStatus, PromptKey> = {
  new: 'statusNew',
  processing: 'statusProcessing',
  shipped: 'statusShipped',
  delivered: 'statusDelivered',
  cancelled: 'statusCancelled',
};

const REFERENCE_LENGTH = 6;

/** A wrong PIN three times is someone guessing, not someone fumbling. */
const MAX_PIN_ATTEMPTS = 3;

function pinMatches(entered: string): boolean {
  const expected = config.OUTBOUND_PIN ?? '';
  if (!expected) return false;
  const a = Buffer.from(entered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Phase 1 flow: greet, offer a menu, look an order up by reference, read the
 * status back.
 *
 * Intentionally small. The point of this file is that it reads like a
 * description of the call - if a new branch is hard to express here, the
 * missing piece belongs in the engine, not in a pile of conditionals.
 */
export function createMainFlow(data: DataSource): Flow {
  return defineFlow({
    name: 'main',
    start: 'welcome',
    states: {
      welcome: {
        id: 'welcome',
        type: 'play',
        speech: [say('welcome')],
        next: 'mainMenu',
      },

      mainMenu: {
        id: 'mainMenu',
        type: 'menu',
        speech: [say('mainMenu')],
        choices: {
          '1': 'askReference',
          '2': 'officeHours',
          '3': 'outboundGate',
          '9': 'mainMenu',
        },
        onInvalid: [say('invalidChoice')],
        onTimeout: [say('noInput')],
        maxAttempts: 3,
        onExhausted: 'tooManyRetries',
      },

      askReference: {
        id: 'askReference',
        type: 'collect',
        speech: [say('askReference')],
        variable: 'reference',
        minDigits: REFERENCE_LENGTH,
        maxDigits: REFERENCE_LENGTH,
        terminator: '#',
        validate: (digits) => new RegExp(`^\\d{${REFERENCE_LENGTH}}$`).test(digits),
        onInvalid: [say('invalidReference')],
        maxAttempts: 3,
        onExhausted: 'tooManyRetries',
        next: 'lookupOrder',
      },

      lookupOrder: {
        id: 'lookupOrder',
        type: 'action',
        run: async (ctx) => {
          const reference = String(ctx.vars.reference ?? '');
          const order = await data.lookupOrder(reference);
          if (!order) return { next: 'notFound', vars: { found: false } };
          return { next: 'playResult', vars: { found: true, order } };
        },
        onError: 'lookupError',
      },

      playResult: {
        id: 'playResult',
        type: 'play',
        speech: (ctx): Utterance[] => {
          const order = ctx.vars.order as OrderRecord;
          return [
            say('orderNumberIs'),
            spell(order.reference),
            say('statusIs'),
            say(STATUS_PROMPT[order.status]),
          ];
        },
        next: 'anythingElse',
      },

      notFound: {
        id: 'notFound',
        type: 'play',
        speech: [say('notFound')],
        next: 'anythingElse',
      },

      lookupError: {
        id: 'lookupError',
        type: 'play',
        speech: [say('lookupError')],
        next: 'anythingElse',
      },

      officeHours: {
        id: 'officeHours',
        type: 'play',
        speech: [say('officeHours')],
        bargeIn: true,
        next: 'anythingElse',
      },

      anythingElse: {
        id: 'anythingElse',
        type: 'menu',
        speech: [say('anythingElse')],
        choices: {
          '1': 'mainMenu',
          '2': 'goodbye',
        },
        onInvalid: [say('invalidChoice')],
        maxAttempts: 2,
        onExhausted: 'goodbye',
      },

      // ---- Outbound dialling ----------------------------------------------
      // Gated three ways: switched off unless enabled, behind a PIN, and
      // limited to allowed prefixes. Any one of them missing turns this into
      // a service that dials the world at the account holder's expense.

      outboundGate: {
        id: 'outboundGate',
        type: 'action',
        run: async () => ({
          next: config.OUTBOUND_ENABLED ? 'askPin' : 'outboundDisabled',
        }),
        onError: 'outboundDisabled',
      },

      outboundDisabled: {
        id: 'outboundDisabled',
        type: 'play',
        speech: [say('outboundDisabled')],
        next: 'mainMenu',
      },

      askPin: {
        id: 'askPin',
        type: 'collect',
        speech: [say('askPin')],
        variable: 'pin',
        minDigits: 4,
        maxDigits: 12,
        terminator: '#',
        maxAttempts: 2,
        onExhausted: 'tooManyRetries',
        next: 'checkPin',
      },

      checkPin: {
        id: 'checkPin',
        type: 'action',
        run: async (ctx) => {
          const attempts = Number(ctx.vars.pinAttempts ?? 0) + 1;
          if (pinMatches(String(ctx.vars.pin ?? ''))) {
            return { next: 'askDestination', vars: { pinAttempts: 0, pin: undefined } };
          }
          // Never keep the entered PIN around; it ends up in the call log.
          return {
            next: attempts >= MAX_PIN_ATTEMPTS ? 'tooManyRetries' : 'pinRejected',
            vars: { pinAttempts: attempts, pin: undefined },
          };
        },
        onError: 'outboundDisabled',
      },

      pinRejected: {
        id: 'pinRejected',
        type: 'play',
        speech: [say('pinRejected')],
        next: 'askPin',
      },

      askDestination: {
        id: 'askDestination',
        type: 'collect',
        speech: [say('askDestination')],
        variable: 'destinationInput',
        minDigits: 8,
        maxDigits: 18,
        terminator: '#',
        interDigitTimeoutMs: 5000,
        onInvalid: [say('invalidDestination')],
        maxAttempts: 3,
        onExhausted: 'tooManyRetries',
        next: 'validateDestination',
      },

      validateDestination: {
        id: 'validateDestination',
        type: 'action',
        run: async (ctx) => {
          const e164 = normaliseDestination(String(ctx.vars.destinationInput ?? ''));
          if (!e164) return { next: 'invalidDestination' };
          if (!destinationAllowed(e164)) {
            return { next: 'destinationNotAllowed', vars: { destination: e164 } };
          }
          return { next: 'placeCall', vars: { destination: e164 } };
        },
        onError: 'dialFailed',
      },

      invalidDestination: {
        id: 'invalidDestination',
        type: 'play',
        speech: [say('invalidDestination')],
        next: 'askDestination',
      },

      destinationNotAllowed: {
        id: 'destinationNotAllowed',
        type: 'play',
        speech: [say('destinationNotAllowed')],
        next: 'askDestination',
      },

      placeCall: {
        id: 'placeCall',
        type: 'dial',
        speech: [say('dialing')],
        destination: (ctx) => String(ctx.vars.destination ?? ''),
        onAnswered: 'goodbye',
        onBusy: 'dialBusy',
        onNoAnswer: 'dialNoAnswer',
        onRejected: 'dialFailed',
        onFailed: 'dialFailed',
      },

      dialBusy: {
        id: 'dialBusy',
        type: 'play',
        speech: [say('dialBusy')],
        next: 'askDestination',
      },

      dialNoAnswer: {
        id: 'dialNoAnswer',
        type: 'play',
        speech: [say('dialNoAnswer')],
        next: 'askDestination',
      },

      dialFailed: {
        id: 'dialFailed',
        type: 'play',
        speech: [say('dialFailed')],
        next: 'askDestination',
      },

      tooManyRetries: {
        id: 'tooManyRetries',
        type: 'hangup',
        speech: [say('tooManyRetries')],
      },

      goodbye: {
        id: 'goodbye',
        type: 'hangup',
        speech: [say('goodbye')],
      },
    },
  });
}
