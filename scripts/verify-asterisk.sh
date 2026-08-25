#!/usr/bin/env bash
#
# Quick health check for the Asterisk side of the system.
#   ./scripts/verify-asterisk.sh
#
set -uo pipefail

pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
info() { printf '       %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

echo "Asterisk"
if asterisk -rx 'core show version' >/dev/null 2>&1; then
  pass "running: $(asterisk -rx 'core show version')"
  # Uptime matters when reading everything below: a process that restarted
  # seconds ago is still loading modules, and a half-loaded Asterisk answers
  # these questions differently every time you ask.
  UPTIME_LINE=$(asterisk -rx 'core show uptime' 2>/dev/null | head -2 | tr '\n' ' ')
  info "${UPTIME_LINE}"
else
  fail "not running or CLI not reachable"
  exit 1
fi

echo
echo "Twilio trunk"
ENDPOINT=$(asterisk -rx 'pjsip show endpoint twilio' 2>/dev/null)
if [[ -z "${ENDPOINT}" ]]; then
  fail "could not query PJSIP endpoints"
elif echo "${ENDPOINT}" | grep -q 'Endpoint:'; then
  pass "endpoint 'twilio' is configured"
else
  fail "endpoint 'twilio' missing - check /etc/asterisk/pjsip.conf"
fi
asterisk -rx 'pjsip show identifies' 2>/dev/null | sed 's/^/    /'

echo
echo "Dialplan"
DIALPLAN=$(asterisk -rx 'dialplan show from-twilio' 2>/dev/null)
if [[ -z "${DIALPLAN}" ]]; then
  fail "could not query the dialplan"
elif echo "${DIALPLAN}" | grep -q 'Stasis'; then
  pass "context 'from-twilio' hands calls to Stasis"
else
  fail "context 'from-twilio' missing or not calling Stasis"
fi

echo
echo "ARI"
# 'module show like' takes a regex, so keep the pattern plain.
ARI_MODULES=$(asterisk -rx 'module show like res_ari' 2>/dev/null)
if [[ -z "${ARI_MODULES}" ]]; then
  fail "could not query Asterisk for modules"
elif echo "${ARI_MODULES}" | grep -q '[0-9] *Running'; then
  pass "res_ari is running"
elif echo "${ARI_MODULES}" | grep -q 'Not Running'; then
  fail "res_ari declined to load"
  echo "      Usually ari.conf is unreadable by the asterisk user."
  echo "      Check:  ls -l /etc/asterisk/ari.conf   (want root:asterisk 640)"
  echo "      Then:   sudo asterisk -rx 'module load res_ari.so'"
else
  fail "res_ari not present or Asterisk is still starting"
  echo "${ARI_MODULES}" | sed 's/^/      /'
fi
# Ask Asterisk once and judge THAT answer. Querying separately for the verdict
# and for the display can print "disabled" directly above "Server Enabled",
# which is how a working system gets reported as broken.
ARI_STATUS=$(asterisk -rx 'ari show status' 2>/dev/null)
if [[ -z "${ARI_STATUS}" ]]; then
  fail "could not query ARI status"
elif echo "${ARI_STATUS}" | grep -qiE 'Enabled:[[:space:]]*Yes'; then
  pass "ARI enabled in ari.conf"
else
  fail "ARI not enabled - check /etc/asterisk/ari.conf"
  echo "${ARI_STATUS}" | sed 's/^/      /'
fi

# ARI being "enabled" means nothing without the HTTP server it runs over.
# These are two separate switches and they fail independently.
HTTP_STATUS=$(asterisk -rx 'http show status' 2>/dev/null)
if [[ -z "${HTTP_STATUS}" ]]; then
  fail "could not query the HTTP server"
elif echo "${HTTP_STATUS}" | grep -qiE 'Server[[:space:]]+Enabled'; then
  pass "HTTP server is listening"
else
  fail "HTTP server disabled - ARI has no transport"
  echo "      /etc/asterisk/http.conf needs enabled=yes, then:"
  echo "      sudo asterisk -rx 'module reload http'"
fi
echo "${HTTP_STATUS}" | grep -iE 'bound|Server' | sed 's/^/    /'

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

# An empty directory is not a pass. Reporting "OK 0 files" is worse than
# saying nothing: it tells you the one thing standing between a working
# system and a silent one is fine, when it is not.
PROMPT_COUNT=$(find "${SOUND_DIR}/ivr" -type f 2>/dev/null | wc -l)
if [[ "${PROMPT_COUNT}" -gt 0 ]]; then
  pass "${PROMPT_COUNT} prompt file(s) in ${SOUND_DIR}/ivr"
else
  fail "no prompt files in ${SOUND_DIR}/ivr - the IVR will be silent"
  echo "      run 'npm run prompts:list' for the recording sheet"
fi

DIGIT_COUNT=$(find "${SOUND_DIR}/digits" -type f 2>/dev/null | wc -l)
if [[ "${DIGIT_COUNT}" -ge 10 ]]; then
  pass "${DIGIT_COUNT} digit file(s) in ${SOUND_DIR}/digits"
else
  fail "${DIGIT_COUNT}/10 digit files in ${SOUND_DIR}/digits - numbers will not be read out"
fi

echo
exit "${FAILED}"
