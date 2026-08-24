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
if [[ -d /var/lib/asterisk/sounds/he/ivr ]]; then
  pass "$(find /var/lib/asterisk/sounds/he/ivr -type f | wc -l) file(s) in /var/lib/asterisk/sounds/he/ivr"
else
  fail "/var/lib/asterisk/sounds/he/ivr does not exist - run 'npm run prompts:list'"
fi

echo
exit "${FAILED}"
