#!/usr/bin/env bash
#
# Quick health check for the Asterisk side of the system.
#   ./scripts/verify-asterisk.sh
#
set -uo pipefail

pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

echo "Asterisk"
if asterisk -rx 'core show version' >/dev/null 2>&1; then
  pass "running: $(asterisk -rx 'core show version')"
else
  fail "not running or CLI not reachable"
  exit 1
fi

echo
echo "Twilio trunk"
if asterisk -rx 'pjsip show endpoint twilio' 2>/dev/null | grep -q 'Endpoint:'; then
  pass "endpoint 'twilio' is configured"
else
  fail "endpoint 'twilio' missing - check /etc/asterisk/pjsip.conf"
fi
asterisk -rx 'pjsip show identifies' 2>/dev/null | sed 's/^/    /'

echo
echo "Dialplan"
if asterisk -rx 'dialplan show from-twilio' 2>/dev/null | grep -q 'Stasis'; then
  pass "context 'from-twilio' hands calls to Stasis"
else
  fail "context 'from-twilio' missing or not calling Stasis"
fi

echo
echo "ARI"
if asterisk -rx 'module show like res_ari.so' 2>/dev/null | grep -q 'Running'; then
  pass "res_ari is running"
elif asterisk -rx 'module show like res_ari.so' 2>/dev/null | grep -q 'Not Running'; then
  fail "res_ari declined to load"
  echo "      Usually ari.conf is unreadable by the asterisk user."
  echo "      Check:  ls -l /etc/asterisk/ari.conf   (want root:asterisk 640)"
  echo "      Then:   sudo asterisk -rx 'module load res_ari.so'"
else
  fail "res_ari not present - is asterisk-modules installed?"
fi
if asterisk -rx 'ari show status' 2>/dev/null | grep -qi 'enabled'; then
  pass "ARI enabled"
else
  fail "ARI not enabled - check /etc/asterisk/ari.conf and http.conf"
fi
asterisk -rx 'http show status' 2>/dev/null | grep -i 'bound\|Server' | sed 's/^/    /'

echo
echo "Registered Stasis applications"
APPS=$(asterisk -rx 'ari show apps' 2>/dev/null)
echo "${APPS}" | sed 's/^/    /'
if echo "${APPS}" | grep -q 'ivr-app'; then
  pass "'ivr-app' is connected - the Node application is up"
else
  fail "'ivr-app' not registered - the Node application is not connected"
fi

echo
echo "Sound files"
# Asterisk resolves sounds under astdatadir, which is /usr/share/asterisk on
# Debian and Ubuntu - NOT /var/lib/asterisk. Putting them in the wrong place
# fails silently: the call connects and the caller hears nothing at all.
DATA_DIR=$(sed -n 's/^[[:space:]]*astdatadir[[:space:]]*=>[[:space:]]*\(.*\)/\1/p' \
  /etc/asterisk/asterisk.conf 2>/dev/null | head -1)
DATA_DIR="${DATA_DIR:-/usr/share/asterisk}"
SOUND_DIR="${DATA_DIR}/sounds/${IVR_LANGUAGE:-he}"
echo "    resolved sounds directory: ${SOUND_DIR}"

if [[ -d "${SOUND_DIR}/ivr" ]]; then
  pass "$(find "${SOUND_DIR}/ivr" -type f | wc -l) prompt file(s) in ${SOUND_DIR}/ivr"
else
  fail "${SOUND_DIR}/ivr does not exist - run 'npm run prompts:list'"
fi

if [[ -d "${SOUND_DIR}/digits" ]]; then
  pass "$(find "${SOUND_DIR}/digits" -type f | wc -l) digit file(s) in ${SOUND_DIR}/digits"
else
  fail "${SOUND_DIR}/digits missing - numbers will not be read out"
fi

echo
exit "${FAILED}"
