/**
 * Prints the recording sheet: every prompt the flow can play, the file it
 * must be saved as, and the Hebrew text to read.
 *
 *   npm run prompts:list
 */
import { readFileSync } from 'node:fs';
import { PROMPTS } from '../src/ivr/prompts.js';

/**
 * Asterisk resolves sound files under `astdatadir`, NOT under /var/lib/asterisk
 * as is often assumed. On Debian and Ubuntu that is /usr/share/asterisk. Read
 * the real value when we are running on the server, so the sheet always prints
 * a path that actually works.
 */
function soundsRoot(language: string): string {
  try {
    const conf = readFileSync('/etc/asterisk/asterisk.conf', 'utf8');
    const match = /^\s*astdatadir\s*=>\s*(\S+)/m.exec(conf);
    if (match?.[1]) return `${match[1]}/sounds/${language}`;
  } catch {
    // Not on the Asterisk host - fall through to the common default.
  }
  return `/usr/share/asterisk/sounds/${language}`;
}

const SOUNDS_ROOT = soundsRoot(process.env.IVR_LANGUAGE ?? 'he');

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
