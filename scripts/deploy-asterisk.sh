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

for file in pjsip.conf extensions.conf http.conf ari.conf rtp.conf logger.conf; do
  src="${SRC_DIR}/${file}"
  dst="${DST_DIR}/${file}"
  [[ -f "${dst}" ]] && cp -a "${dst}" "${BACKUP_DIR}/${file}"
  render "${src}" > "${dst}"
  chown root:root "${dst}"
  # ari.conf holds a password; keep it off other users' eyes.
  if [[ "${file}" == "ari.conf" ]]; then chmod 640 "${dst}"; else chmod 644 "${dst}"; fi
  echo "installed ${dst}"
done

echo "previous config backed up to ${BACKUP_DIR}"

if command -v asterisk >/dev/null 2>&1 && asterisk -rx 'core show version' >/dev/null 2>&1; then
  # A targeted reload avoids dropping calls that are in progress.
  asterisk -rx 'module reload res_pjsip.so'
  asterisk -rx 'dialplan reload'
  asterisk -rx 'module reload res_ari.so'
  asterisk -rx 'module reload res_rtp_asterisk.so'
  echo "asterisk reloaded"
else
  echo "asterisk is not running - start it with: systemctl start asterisk"
fi
