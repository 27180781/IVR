#!/usr/bin/env bash
#
# One-shot provisioning for a fresh Ubuntu 24.04 / Debian 12 server.
#
#   ssh root@<droplet-ip>
#   apt update && apt install -y git
#   git clone https://github.com/27180781/IVR.git /opt/ivr
#   cd /opt/ivr && ./scripts/bootstrap-server.sh
#
# Safe to re-run: it never overwrites an existing .env or asterisk.env, and
# every step checks before acting.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="ivr"
NODE_MAJOR=22
PUBLIC_IP=""
SKIP_FIREWALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-ip) PUBLIC_IP="$2"; shift 2 ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    \033[33mwarning:\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

#-----------------------------------------------------------------------------
step "Preflight"
#-----------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "run as root (sudo ./scripts/bootstrap-server.sh)"
command -v apt-get >/dev/null || die "this script targets Debian/Ubuntu"

. /etc/os-release
info "OS: ${PRETTY_NAME}"

HAS_SYSTEMD=0
[[ -d /run/systemd/system ]] && HAS_SYSTEMD=1
(( HAS_SYSTEMD )) || warn "systemd is not running - services will be configured but not started"

#-----------------------------------------------------------------------------
step "Determining the public IP"
#-----------------------------------------------------------------------------
if [[ -z "${PUBLIC_IP}" ]]; then
  # DigitalOcean droplet metadata, link-local so it never leaves the host.
  PUBLIC_IP="$(curl -s --max-time 3 \
    http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || true)"
fi
if [[ ! "${PUBLIC_IP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || true)"
fi
[[ "${PUBLIC_IP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "could not determine the public IP - pass it with --public-ip <address>"
info "public IP: ${PUBLIC_IP}"
info "this address goes into the Twilio Origination URI"

case "${PUBLIC_IP}" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
    warn "that looks like a private address."
    warn "if this droplet uses a DigitalOcean Reserved IP, pass the PUBLIC one"
    warn "with --public-ip: Asterisk must advertise the address Twilio sees." ;;
esac

#-----------------------------------------------------------------------------
step "Firewall"
#-----------------------------------------------------------------------------
if (( SKIP_FIREWALL )); then
  info "skipped (--skip-firewall)"
else
  apt-get update -qq
  apt-get install -y -qq ufw >/dev/null
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null

  # Twilio SIP signalling. Verify against Twilio's current published list -
  # these ranges do change, and a stale ACL silently drops calls.
  for net in 54.172.60.0/30 54.244.51.0/30 54.171.127.192/30 35.156.191.128/30 \
             54.169.127.128/30 54.65.63.192/30 54.252.254.64/30 177.71.206.192/30; do
    ufw allow from "${net}" to any port 5060 proto udp >/dev/null
  done
  # Twilio media addresses span a much wider range than signalling.
  ufw allow from 168.86.128.0/18 to any port 10000:20000 proto udp >/dev/null

  ufw --force enable >/dev/null
  info "SIP restricted to Twilio networks; RTP open on 10000-20000/udp"
  warn "a DigitalOcean Cloud Firewall, if attached, must allow the same ports"
fi

#-----------------------------------------------------------------------------
step "Installing Asterisk"
#-----------------------------------------------------------------------------
if command -v asterisk >/dev/null; then
  info "already installed: $(asterisk -V 2>/dev/null || echo present)"
else
  # Ubuntu ships Asterisk in universe.
  if [[ "${ID}" == "ubuntu" ]]; then
    add-apt-repository -y universe >/dev/null 2>&1 || true
    apt-get update -qq
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq asterisk >/dev/null
  info "installed $(asterisk -V 2>/dev/null)"
fi

#-----------------------------------------------------------------------------
step "Installing Node.js"
#-----------------------------------------------------------------------------
CURRENT_NODE="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)"
if [[ "${CURRENT_NODE}" -ge 20 ]] 2>/dev/null; then
  info "already installed: $(node --version)"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  info "installed $(node --version)"
fi

#-----------------------------------------------------------------------------
step "Generating configuration"
#-----------------------------------------------------------------------------
ASTERISK_ENV="${REPO_ROOT}/asterisk/asterisk.env"
APP_ENV="${REPO_ROOT}/.env"

if [[ -f "${ASTERISK_ENV}" ]]; then
  info "asterisk/asterisk.env exists, leaving it alone"
  ARI_PASSWORD="$(grep -E '^ARI_PASSWORD=' "${ASTERISK_ENV}" | cut -d= -f2-)"
else
  ARI_PASSWORD="$(openssl rand -hex 24)"
  cat > "${ASTERISK_ENV}" <<EOF
PUBLIC_IP=${PUBLIC_IP}
IVR_LANGUAGE=he
ARI_PASSWORD=${ARI_PASSWORD}
TWILIO_TERMINATION_DOMAIN=unused.pstn.twilio.com
EOF
  chmod 600 "${ASTERISK_ENV}"
  info "wrote asterisk/asterisk.env with a generated ARI password"
fi

if [[ -f "${APP_ENV}" ]]; then
  info ".env exists, leaving it alone"
else
  sed -e "s|^ARI_PASSWORD=.*|ARI_PASSWORD=${ARI_PASSWORD}|" \
      "${REPO_ROOT}/.env.example" > "${APP_ENV}"
  chmod 600 "${APP_ENV}"
  info "wrote .env (ARI password matched to Asterisk)"
fi

#-----------------------------------------------------------------------------
step "Deploying the Asterisk configuration"
#-----------------------------------------------------------------------------
"${REPO_ROOT}/scripts/deploy-asterisk.sh"

#-----------------------------------------------------------------------------
step "Preparing the sounds directory"
#-----------------------------------------------------------------------------
# Asterisk resolves sounds under astdatadir, NOT /var/lib/asterisk.
DATA_DIR="$(sed -n 's/^[[:space:]]*astdatadir[[:space:]]*=>[[:space:]]*\(.*\)/\1/p' \
  /etc/asterisk/asterisk.conf 2>/dev/null | head -1)"
DATA_DIR="${DATA_DIR:-/usr/share/asterisk}"
LANG_CODE="$(grep -E '^IVR_LANGUAGE=' "${ASTERISK_ENV}" | cut -d= -f2- || echo he)"
SOUND_DIR="${DATA_DIR}/sounds/${LANG_CODE:-he}"

mkdir -p "${SOUND_DIR}/ivr" "${SOUND_DIR}/digits"
chown -R asterisk:asterisk "${SOUND_DIR}"
info "created ${SOUND_DIR}/{ivr,digits}"
warn "these are empty - the IVR will be silent until you record the prompts"
warn "run 'npm run prompts:list' for the recording sheet"

#-----------------------------------------------------------------------------
step "Building the application"
#-----------------------------------------------------------------------------
cd "${REPO_ROOT}"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npm run build

#-----------------------------------------------------------------------------
step "Installing the service"
#-----------------------------------------------------------------------------
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home "${REPO_ROOT}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  info "created system user '${SERVICE_USER}'"
fi
mkdir -p "${REPO_ROOT}/data"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${REPO_ROOT}"
chmod 600 "${APP_ENV}" "${ASTERISK_ENV}"

# The shipped unit assumes /opt/ivr; point it at wherever this checkout lives.
sed -e "s|/opt/ivr|${REPO_ROOT}|g" \
    "${REPO_ROOT}/deploy/ivr-app.service" > /etc/systemd/system/ivr-app.service
info "installed /etc/systemd/system/ivr-app.service (WorkingDirectory=${REPO_ROOT})"

if (( HAS_SYSTEMD )); then
  systemctl daemon-reload
  systemctl enable --now asterisk >/dev/null 2>&1 || true
  systemctl enable --now ivr-app
  sleep 3
  systemctl --no-pager --lines=0 status ivr-app || true
else
  warn "systemd not running - start manually with: systemctl enable --now ivr-app"
fi

#-----------------------------------------------------------------------------
step "Verifying"
#-----------------------------------------------------------------------------
"${REPO_ROOT}/scripts/verify-asterisk.sh" || true

cat <<EOF

================================================================
 Done. What is left, in order:

 1. Record the Hebrew prompts.       npm run prompts:list
    Place them under ${SOUND_DIR}/ivr/
    Digits 0-9 go in ${SOUND_DIR}/digits/

 2. In the Twilio console, point the trunk's Origination URI at:
        sip:${PUBLIC_IP}:5060;transport=udp
    and set the phone number's Voice Configuration to that trunk.

 3. Test without Twilio:
        asterisk -rx 'channel originate Local/+972500000000@from-twilio application Wait 40'
        journalctl -u ivr-app -f

 Subsequent deploys:  ./scripts/deploy.sh
================================================================
EOF
