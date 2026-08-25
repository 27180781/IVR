import type { PromptKey } from './prompts.js';

/** Everything known about the call in progress. Passed to every state. */
export interface CallContext {
  callId: string;
  from: string;
  to: string;
  startedAt: number;
  vars: Record<string, unknown>;
}

export type Utterance =
  | { kind: 'prompt'; key: PromptKey }
  | { kind: 'digits'; value: string }
  | { kind: 'number'; value: number };

export const say = (key: PromptKey): Utterance => ({ kind: 'prompt', key });
export const spell = (value: string): Utterance => ({ kind: 'digits', value });
export const count = (value: number): Utterance => ({ kind: 'number', value });

/** Either a fixed sequence, or one computed from the call context. */
export type Speech = Utterance[] | ((ctx: CallContext) => Utterance[]);

interface BaseState {
  id: string;
}

/** Say something, then move on. */
export interface PlayState extends BaseState {
  type: 'play';
  speech: Speech;
  bargeIn?: boolean;
  next: string;
}

/** Say something, wait for one digit, branch on it. */
export interface MenuState extends BaseState {
  type: 'menu';
  speech: Speech;
  /** digit -> target state id */
  choices: Record<string, string>;
  onInvalid?: Speech;
  onTimeout?: Speech;
  /** How many times to re-prompt before giving up. Default 3. */
  maxAttempts?: number;
  onExhausted: string;
  firstDigitTimeoutMs?: number;
}

/** Say something, collect a string of digits into a context variable. */
export interface CollectState extends BaseState {
  type: 'collect';
  speech: Speech;
  variable: string;
  minDigits: number;
  maxDigits: number;
  terminator?: string | null;
  validate?: (digits: string) => boolean;
  onInvalid?: Speech;
  maxAttempts?: number;
  onExhausted: string;
  next: string;
  firstDigitTimeoutMs?: number;
  interDigitTimeoutMs?: number;
}

export interface ActionResult {
  next: string;
  vars?: Record<string, unknown>;
}

/** Do something off-channel (an API call, a lookup) and branch on the result. */
export interface ActionState extends BaseState {
  type: 'action';
  run: (ctx: CallContext) => Promise<ActionResult>;
  onError: string;
}

/**
 * Place an outbound call and bridge the caller to it.
 *
 * Every failure mode gets its own target: a caller told "the number is busy"
 * does something different from one told "we could not place the call".
 */
export interface DialState extends BaseState {
  type: 'dial';
  /** The destination in E.164, derived from what the caller entered. */
  destination: (ctx: CallContext) => string;
  /** Played before dialling starts. */
  speech?: Speech;
  onAnswered: string;
  onBusy: string;
  onNoAnswer: string;
  onRejected: string;
  onFailed: string;
}

/** Optionally say goodbye, then end the call. */
export interface HangupState extends BaseState {
  type: 'hangup';
  speech?: Speech;
}

export type State =
  | PlayState
  | MenuState
  | CollectState
  | ActionState
  | DialState
  | HangupState;

export interface Flow {
  name: string;
  start: string;
  states: Record<string, State>;
}

/**
 * Register a flow, checking that every transition points at a real state.
 * This runs at import time, so a typo is a startup crash rather than a caller
 * hearing dead air.
 */
export function defineFlow(flow: Flow): Flow {
  const errors: string[] = [];
  const exists = (id: string) => Object.hasOwn(flow.states, id);

  if (!exists(flow.start)) errors.push(`start state "${flow.start}" does not exist`);

  for (const [id, state] of Object.entries(flow.states)) {
    if (state.id !== id) errors.push(`state "${id}" has mismatched id "${state.id}"`);

    const targets: Array<[string, string]> = [];
    switch (state.type) {
      case 'play':
        targets.push(['next', state.next]);
        break;
      case 'menu':
        for (const [digit, target] of Object.entries(state.choices)) targets.push([`choices.${digit}`, target]);
        targets.push(['onExhausted', state.onExhausted]);
        break;
      case 'collect':
        targets.push(['next', state.next], ['onExhausted', state.onExhausted]);
        break;
      case 'action':
        targets.push(['onError', state.onError]);
        break;
      case 'dial':
        targets.push(
          ['onAnswered', state.onAnswered],
          ['onBusy', state.onBusy],
          ['onNoAnswer', state.onNoAnswer],
          ['onRejected', state.onRejected],
          ['onFailed', state.onFailed],
        );
        break;
      case 'hangup':
        break;
    }

    for (const [field, target] of targets) {
      if (!exists(target)) errors.push(`state "${id}".${field} points at unknown state "${target}"`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid flow "${flow.name}":\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return flow;
}
