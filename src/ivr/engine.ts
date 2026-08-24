import type { CallChannel } from '../ari/channel.js';
import type { SpeechProvider } from '../services/speech.js';
import { speakNumber, spellDigits } from '../services/speech.js';
import type { CallContext, Flow, Speech, State, Utterance } from './flow.js';

/** Safety net against a flow that loops forever without touching the channel. */
const MAX_TRANSITIONS = 200;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface CallOutcome {
  endedAt: number;
  lastState: string;
  reason: 'completed' | 'caller-hangup' | 'error' | 'transition-limit';
  path: string[];
  vars: Record<string, unknown>;
  error?: string;
}

export class IvrEngine {
  constructor(
    private readonly flow: Flow,
    private readonly speech: SpeechProvider,
  ) {}

  private resolve(speech: Speech, ctx: CallContext): string[] {
    const utterances: Utterance[] = typeof speech === 'function' ? speech(ctx) : speech;
    return utterances.map((u) => {
      switch (u.kind) {
        case 'prompt':
          return this.speech.prompt(u.key);
        case 'digits':
          return [spellDigits(u.value)];
        case 'number':
          return [speakNumber(u.value)];
      }
    }).flat();
  }

  async run(call: CallChannel, ctx: CallContext): Promise<CallOutcome> {
    const path: string[] = [];
    let stateId = this.flow.start;
    let transitions = 0;

    const outcome = (reason: CallOutcome['reason'], error?: string): CallOutcome => ({
      endedAt: Date.now(),
      lastState: stateId,
      reason,
      path,
      vars: ctx.vars,
      ...(error ? { error } : {}),
    });

    try {
      while (true) {
        if (call.hungUp) return outcome('caller-hangup');
        if (++transitions > MAX_TRANSITIONS) {
          call.log.error({ path }, 'transition limit reached - flow is looping');
          return outcome('transition-limit');
        }

        const state = this.flow.states[stateId];
        if (!state) {
          // defineFlow() makes this unreachable, but a runtime guard is cheap.
          return outcome('error', `unknown state "${stateId}"`);
        }

        path.push(stateId);
        call.log.info({ state: stateId, type: state.type }, 'entering state');

        const next = await this.runState(state, call, ctx);
        if (next === null) return outcome(call.hungUp ? 'caller-hangup' : 'completed');
        stateId = next;
      }
    } catch (err) {
      call.log.error({ err, state: stateId }, 'unhandled error in flow');
      return outcome('error', err instanceof Error ? err.message : String(err));
    }
  }

  /** Returns the next state id, or null when the call is finished. */
  private async runState(state: State, call: CallChannel, ctx: CallContext): Promise<string | null> {
    switch (state.type) {
      case 'play': {
        const outcome = await call.play(this.resolve(state.speech, ctx), {
          bargeIn: state.bargeIn ?? false,
        });
        return outcome === 'hangup' ? null : state.next;
      }

      case 'menu': {
        const maxAttempts = state.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const result = await call.gather({
            media: this.resolve(state.speech, ctx),
            maxDigits: 1,
            terminator: null,
            bargeIn: true,
            firstDigitTimeoutMs: state.firstDigitTimeoutMs ?? 5000,
          });

          if (result.reason === 'hangup') return null;

          const target = state.choices[result.digits];
          if (target) return target;

          const retry = result.reason === 'timeout' ? state.onTimeout : state.onInvalid;
          call.log.info(
            { attempt, digits: result.digits, reason: result.reason },
            'menu input not accepted',
          );
          if (retry && attempt < maxAttempts) {
            if ((await call.play(this.resolve(retry, ctx))) === 'hangup') return null;
          }
        }
        return state.onExhausted;
      }

      case 'collect': {
        const maxAttempts = state.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const result = await call.gather({
            media: this.resolve(state.speech, ctx),
            maxDigits: state.maxDigits,
            terminator: state.terminator === undefined ? '#' : state.terminator,
            bargeIn: true,
            firstDigitTimeoutMs: state.firstDigitTimeoutMs ?? 7000,
            interDigitTimeoutMs: state.interDigitTimeoutMs ?? 3000,
          });

          if (result.reason === 'hangup') return null;

          const valid =
            result.digits.length >= state.minDigits &&
            result.digits.length <= state.maxDigits &&
            (state.validate?.(result.digits) ?? true);

          if (valid) {
            ctx.vars[state.variable] = result.digits;
            return state.next;
          }

          call.log.info({ attempt, digits: result.digits }, 'collected input rejected');
          if (state.onInvalid && attempt < maxAttempts) {
            if ((await call.play(this.resolve(state.onInvalid, ctx))) === 'hangup') return null;
          }
        }
        return state.onExhausted;
      }

      case 'action': {
        try {
          const result = await state.run(ctx);
          if (result.vars) Object.assign(ctx.vars, result.vars);
          return result.next;
        } catch (err) {
          call.log.error({ err, state: state.id }, 'action failed');
          return state.onError;
        }
      }

      case 'hangup': {
        if (state.speech) await call.play(this.resolve(state.speech, ctx));
        await call.hangup();
        return null;
      }
    }
  }
}
