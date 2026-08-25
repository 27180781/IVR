#!/usr/bin/env bash
#
# Generates temporary tone files for every prompt the flow can play.
#
#   sudo ./scripts/make-placeholder-sounds.sh
#
# These are NOT recordings - they are beeps. Their only job is to make the
# first real call prove something a silent call cannot: that audio actually
# flows from Asterisk to the caller, that the playback path works, and that
# DTMF comes back. A silent call tells you the call connected and nothing more.
#
# Each prompt gets its own pitch and a length that tracks its Hebrew text, so
# the call sounds roughly like the real thing and you can tell the prompts
# apart by ear. Replace them with real recordings before going live:
# scripts/list-prompts.ts prints what to record.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $EUID -eq 0 ]] || { echo "run as root (sudo $0)" >&2; exit 1; }

# Asterisk resolves sounds under astdatadir, not /var/lib/asterisk.
DATA_DIR="$(sed -n 's/^[[:space:]]*astdatadir[[:space:]]*=>[[:space:]]*\(.*\)/\1/p' \
  /etc/asterisk/asterisk.conf 2>/dev/null | head -1)"
DATA_DIR="${DATA_DIR:-/usr/share/asterisk}"
LANG_CODE="${IVR_LANGUAGE:-he}"
SOUND_DIR="${DATA_DIR}/sounds/${LANG_CODE}"

if ! command -v sox >/dev/null; then
  echo "installing sox to synthesise the tones"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sox >/dev/null
fi

[[ -f "${REPO_ROOT}/dist/ivr/prompts.js" ]] || { \
  echo "run 'npm run build' first" >&2; exit 1; }

mkdir -p "${SOUND_DIR}/ivr" "${SOUND_DIR}/digits"

# Ask the application itself which prompts exist, so this can never drift out
# of step with the flow.
node -e "
import('${REPO_ROOT}/dist/ivr/prompts.js').then(m => {
  Object.values(m.PROMPTS).forEach((p, i) => {
    console.log([p.file, p.text.length].join('|'));
  });
});" | while IFS='|' read -r file len; do
  [[ -z "${file}" ]] && continue
  # Pitch spreads the prompts apart by ear; duration tracks the real script so
  # the pacing of the call resembles what a caller will actually experience.
  idx=$(( ${#file} % 8 ))
  freq=$(( 420 + idx * 55 ))
  dur=$(awk "BEGIN { d = ${len} / 14; if (d < 1) d = 1; if (d > 6) d = 6; print d }")
  sox -n -r 8000 -c 1 -b 16 "${SOUND_DIR}/${file}.wav" \
    synth "${dur}" sine "${freq}" vol 0.25 2>/dev/null
  printf '  %-34s %ss @ %sHz\n' "${file}.wav" "${dur}" "${freq}"
done

# Digits are read back one at a time, so each needs its own recognisable pitch.
for d in 0 1 2 3 4 5 6 7 8 9; do
  sox -n -r 8000 -c 1 -b 16 "${SOUND_DIR}/digits/${d}.wav" \
    synth 0.35 sine $(( 500 + d * 70 )) vol 0.25 2>/dev/null
done
echo "  digits/0-9.wav"

chown -R asterisk:asterisk "${SOUND_DIR}"

cat <<EOF

Placeholder tones written to ${SOUND_DIR}

These are beeps, not speech. They exist so a test call proves audio flows.
Before going live, replace them with real recordings:  npm run prompts:list
EOF
