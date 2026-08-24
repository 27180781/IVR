/**
 * Prints the recording sheet: every prompt the flow can play, the file it
 * must be saved as, and the Hebrew text to read.
 *
 *   npm run prompts:list
 */
import { PROMPTS } from '../src/ivr/prompts.js';

const SOUNDS_ROOT = '/var/lib/asterisk/sounds/he';

console.log('IVR prompt recording sheet');
console.log('==========================');
console.log();
console.log(`Save each file under ${SOUNDS_ROOT}/ as 8 kHz mono.`);
console.log('Recommended format: .wav (16-bit PCM, 8000 Hz) or .gsm.');
console.log();

for (const [key, prompt] of Object.entries(PROMPTS)) {
  console.log(`${key}`);
  console.log(`  file: ${SOUNDS_ROOT}/${prompt.file}.wav`);
  console.log(`  text: ${prompt.text}`);
  console.log();
}

console.log(`Total: ${Object.keys(PROMPTS).length} prompts.`);
