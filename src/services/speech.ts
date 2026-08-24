import { PROMPTS, type PromptKey } from '../ivr/prompts.js';

/**
 * How spoken output is produced.
 *
 * Phase 1 plays pre-recorded Hebrew files, which is the right call: it is
 * free, has zero latency and sounds better than any synthesiser. But Hebrew
 * has gendered and inflected numerals ("שלוש ימים" vs "שלושה ימים"), so
 * anything beyond digits and fixed phrases cannot be assembled from a sound
 * set - it needs real synthesis.
 *
 * That boundary is exactly this interface. When phase 2 adds Azure / Google /
 * ElevenLabs Hebrew TTS, it implements `say()` and nothing in src/ivr/ changes.
 */
export interface SpeechProvider {
  readonly name: string;
  /** Media URIs for a catalogue prompt. */
  prompt(key: PromptKey): string[];
  /** Media URIs for free-form text. Not every provider can do this. */
  say(text: string): Promise<string[]>;
}

export class StaticFileSpeechProvider implements SpeechProvider {
  readonly name = 'static-files';

  prompt(key: PromptKey): string[] {
    return [`sound:${PROMPTS[key].file}`];
  }

  async say(_text: string): Promise<string[]> {
    throw new Error(
      'StaticFileSpeechProvider cannot synthesise free-form text. ' +
        'Add the phrase to src/ivr/prompts.ts, or plug in a TTS provider.',
    );
  }
}

/** Read a string out one character at a time ("1-2-3"). */
export function spellDigits(value: string): string {
  return `digits:${value}`;
}

/** Read a whole number ("one hundred and twenty three"). */
export function speakNumber(value: number): string {
  return `number:${Math.trunc(value)}`;
}
