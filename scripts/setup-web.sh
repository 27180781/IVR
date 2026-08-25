#!/usr/bin/env bash
#
# Puts the dashboard on a domain, with HTTPS.
#
#   sudo ./scripts/setup-web.sh dashboard.example.com
#
# Before running: create a DNS A record for that name pointing at this
# server's public IP, and wait for it to propagate. This script checks that
# first, because a certificate cannot be issued for a name that does not
# resolve here, and the resulting error says very little about why.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="${1:-}"
EMAIL="${LETSENCRYPT_EMAIL:-}"

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    \033[33mwarning:\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo $0 <domain>)"
[[ -n "${DOMAIN}" ]] || die "usage: $0 <domain>   e.g. $0 ivr.example.com"

#-----------------------------------------------------------------------------
step "Checking DNS for ${DOMAIN}"
#-----------------------------------------------------------------------------
command -v dig >/dev/null || apt-get install -y -qq dnsutils >/dev/null

SERVER_IP="$(curl -s --max-time 3 \
  http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || true)"
[[ "${SERVER_IP}" =~ ^[0-9.]+$ ]] || \
  SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || true)"

RESOLVED="$(dig +short A "${DOMAIN}" | tail -1)"
info "${DOMAIN} resolves to: ${RESOLVED:-<nothing>}"
info "this server is:        ${SERVER_IP:-<unknown>}"

if [[ -z "${RESOLVED}" ]]; then
  die "${DOMAIN} does not resolve. Create an A record pointing at ${SERVER_IP}
       and wait for it to propagate, then run this again."
fi
if [[ -n "${SERVER_IP}" && "${RESOLVED}" != "${SERVER_IP}" ]]; then
  die "${DOMAIN} points at ${RESOLVED}, not at this server (${SERVER_IP}).
       Let's Encrypt validates by connecting to that address, so the
       certificate would fail. Fix the A record and run this again."
fi
info "DNS is correct"

#-----------------------------------------------------------------------------
step "Dashboard password"
#-----------------------------------------------------------------------------
APP_ENV="${REPO_ROOT}/.env"
[[ -f "${APP_ENV}" ]] || die ".env not found - run bootstrap-server.sh first"

CURRENT_PW="$(grep -E '^WEB_PASSWORD=' "${APP_ENV}" | cut -d= -f2- || true)"
if [[ -z "${CURRENT_PW}" ]]; then
  GENERATED="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
  if grep -q '^WEB_PASSWORD=' "${APP_ENV}"; then
    sed -i "s|^WEB_PASSWORD=.*|WEB_PASSWORD=${GENERATED}|" "${APP_ENV}"
  else
    echo "WEB_PASSWORD=${GENERATED}" >> "${APP_ENV}"
  fi
  CURRENT_PW="${GENERATED}"
  info "generated a dashboard password"
else
  info "keeping the existing dashboard password"
fi
WEB_USER="$(grep -E '^WEB_USER=' "${APP_ENV}" | cut -d= -f2- || true)"
WEB_USER="${WEB_USER:-admin}"

#-----------------------------------------------------------------------------
step "Installing Caddy"
#-----------------------------------------------------------------------------
if command -v caddy >/dev/null; then
  info "already installed: $(caddy version | head -1)"
else
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
  info "installed $(caddy version | head -1)"
fi

#-----------------------------------------------------------------------------
step "Configuring ${DOMAIN}"
#-----------------------------------------------------------------------------
WEB_PORT="$(grep -E '^WEB_PORT=' "${APP_ENV}" | cut -d= -f2- || true)"
WEB_PORT="${WEB_PORT:-3000}"

cat > /etc/caddy/Caddyfile <<CADDY
# Managed by scripts/setup-web.sh

${DOMAIN} {
$( [[ -n "${EMAIL}" ]] && echo "	tls ${EMAIL}" )
	encode gzip

	header {
		# The dashboard is only ever reached over HTTPS once this is live.
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Frame-Options "DENY"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		# It lists callers' phone numbers. It should never be indexed.
		X-Robots-Tag "noindex, nofollow"
	}

	reverse_proxy 127.0.0.1:${WEB_PORT} {
		# The live view is Server-Sent Events. Any buffering here holds
		# events back until the buffer fills, which turns a live feed into
		# a feed that arrives in bursts minutes late.
		flush_interval -1
	}
}
CADDY

caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
  || die "the generated Caddyfile is invalid - see /etc/caddy/Caddyfile"
info "wrote /etc/caddy/Caddyfile"

#-----------------------------------------------------------------------------
step "Firewall"
#-----------------------------------------------------------------------------
if command -v ufw >/dev/null; then
  ufw allow 80/tcp >/dev/null   # required for the ACME challenge
  ufw allow 443/tcp >/dev/null
  info "opened 80/tcp and 443/tcp"
  warn "a DigitalOcean Cloud Firewall, if attached, must allow them too"
fi

#-----------------------------------------------------------------------------
step "Starting"
#-----------------------------------------------------------------------------
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy
systemctl restart ivr-app
sleep 3

if systemctl is-active --quiet caddy; then
  info "caddy is running"
else
  journalctl -u caddy -n 20 --no-pager
  die "caddy did not start"
fi

cat <<EOF

================================================================
 Dashboard:  https://${DOMAIN}

 username:   ${WEB_USER}
 password:   ${CURRENT_PW}

 The password is in ${APP_ENV} (WEB_PASSWORD). Change it there and
 restart ivr-app to rotate it.

 The certificate is issued on the first request and can take a few
 seconds. If the browser reports a certificate error, wait and retry
 once before investigating:  journalctl -u caddy -f
================================================================
EOF
