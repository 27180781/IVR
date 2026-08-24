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
