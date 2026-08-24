#!/usr/bin/env bash
#
# Renders asterisk/*.conf with the values from asterisk/asterisk.env and
# installs them into /etc/asterisk, then reloads Asterisk.
#
# Run this ON the Asterisk server, from the repository root:
#   sudo ./scripts/deploy-asterisk.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${REPO_ROOT}/asterisk"
DST_DIR="${ASTERISK_CONF_DIR:-/etc/asterisk}"
ENV_FILE="${SRC_DIR}/asterisk.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "error: ${ENV_FILE} not found. Copy asterisk.env.example and fill it in." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

: "${PUBLIC_IP:?PUBLIC_IP must be set in asterisk.env}"
: "${ARI_PASSWORD:?ARI_PASSWORD must be set in asterisk.env}"
: "${IVR_LANGUAGE:=he}"
: "${TWILIO_TERMINATION_DOMAIN:=unused.pstn.twilio.com}"

BACKUP_DIR="${DST_DIR}/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${BACKUP_DIR}"

render() {
  sed \
    -e "s|{{PUBLIC_IP}}|${PUBLIC_IP}|g" \
    -e "s|{{ARI_PASSWORD}}|${ARI_PASSWORD}|g" \
    -e "s|{{IVR_LANGUAGE}}|${IVR_LANGUAGE}|g" \
    -e "s|{{TWILIO_TERMINATION_DOMAIN}}|${TWILIO_TERMINATION_DOMAIN}|g" \
    "$1"
}

# Asterisk drops privileges to its own user, so it must be able to READ these
# files - but nothing else should. Owner root keeps the config out of reach of
# the service account itself; group asterisk lets the daemon read it.
# Getting this wrong is quiet: Asterisk logs "Unable to load config file
# 'ari.conf'" and every ARI module then declines to load.
ASTERISK_USER="${ASTERISK_USER:-root}"
ASTERISK_GROUP="${ASTERISK_GROUP:-asterisk}"

if ! getent group "${ASTERISK_GROUP}" >/dev/null; then
  echo "error: group '${ASTERISK_GROUP}' does not exist. Is Asterisk installed?" >&2
  echo "       override with ASTERISK_GROUP=<group> ./scripts/deploy-asterisk.sh" >&2
  exit 1
fi

for file in pjsip.conf extensions.conf http.conf ari.conf rtp.conf logger.conf; do
  src="${SRC_DIR}/${file}"
  dst="${DST_DIR}/${file}"
  [[ -f "${dst}" ]] && cp -a "${dst}" "${BACKUP_DIR}/${file}"
  render "${src}" > "${dst}"
  chown "${ASTERISK_USER}:${ASTERISK_GROUP}" "${dst}"
  # 640 throughout: ari.conf carries the ARI password and pjsip.conf can carry
  # trunk credentials. Neither belongs in a world-readable file.
  chmod 640 "${dst}"
  echo "installed ${dst}"
done

chmod 700 "${BACKUP_DIR}"

echo "previous config backed up to ${BACKUP_DIR}"

if command -v asterisk >/dev/null 2>&1 && asterisk -rx 'core show version' >/dev/null 2>&1; then
  # A targeted reload avoids dropping calls that are in progress.
  asterisk -rx 'module reload res_pjsip.so'
  asterisk -rx 'dialplan reload'
  asterisk -rx 'module reload res_rtp_asterisk.so'

  # http.conf drives the built-in HTTP server, which is the transport ARI runs
  # over. Reloading pjsip and ari without it leaves the server on whatever it
  # read at startup - and the packaged default is enabled=no, so ARI ends up
  # with nowhere to listen while every other reload reports success.
  asterisk -rx 'module reload http'

  # A module that declined to load at startup cannot be reloaded - it has to be
  # loaded. That is the state Asterisk lands in when ari.conf was unreadable,
  # which is exactly what this script may have just fixed.
  if asterisk -rx 'module show like res_ari' | grep -q 'Not Running'; then
    echo "res_ari was not running, loading it"
    asterisk -rx 'module load res_ari.so'
  else
    asterisk -rx 'module reload res_ari.so'
  fi
  # Confirm the thing that actually matters, rather than trusting the reloads.
  if asterisk -rx 'http show status' | grep -qi 'Server Enabled'; then
    echo "asterisk reloaded; HTTP server is up"
  else
    echo
    echo "warning: the HTTP server is still disabled, so ARI has no transport." >&2
    echo "         check /etc/asterisk/http.conf, then: systemctl restart asterisk" >&2
  fi
else
  echo "asterisk is not running - start it with: systemctl start asterisk"
fi
